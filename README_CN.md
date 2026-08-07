# rater-collector

[English](README.md)

App 评分引导 + 用户反馈收集的服务端：Cloudflare Worker + D1（sqlite）+ R2，自带管理后台。

客户端是一个独立仓库：**[RaterKit](https://github.com/fdddf/RaterKit)**（iOS 17+ Swift Package）。典型接入顺序是先部署这里、注册 app 拿到 API Key，再去接客户端。

```
   你的 App ──▶ 预询问弹窗 ──「不喜欢」──▶ 反馈表单
                    ▲                          │
          文案/触发阈值下发                     │ 正文 + 截图 + 设备信息
                    │                          ▼
                    └────────── rater-collector（本仓库）
                                  D1 + R2 + webhook + /admin
```

## 部署

```bash
npm install
```

创建 D1 数据库，把返回的 `database_id` 填进 `wrangler.jsonc`：
```bash
npx wrangler d1 create rater
```

创建 R2 桶：
```bash
npx wrangler r2 bucket create rater-attachments
```

建表：
```bash
npx wrangler d1 migrations apply rater --remote
```

配置 secrets（`NOTIFY_WEBHOOK_URL` 可选）：
```bash
npx wrangler secret put ADMIN_TOKEN && npx wrangler secret put UPLOAD_HMAC_SECRET
```

把 `wrangler.jsonc` 里的 `PUBLIC_BASE_URL` 改成部署后的地址，然后：
```bash
npx wrangler deploy
```

### 用 GitHub 自动部署

不想每次手动 `wrangler deploy` 的话，在 **Workers & Pages → 你的 Worker → Settings → Builds**
里接上仓库，之后推到 `main` 就自动构建部署。三个要点：

- 面板里 Worker 的名字必须和 `wrangler.jsonc` 里的 `name` 一致（`rater-collector`），否则构建失败。
- **Root directory** 留空 —— Worker 就在仓库根目录。
- **Deploy command** 填 `npm run deploy`。它会先跑 D1 migration 再部署，保证改了表结构的代码
  和表结构一起上线。migration 有记录，已经应用过的会跳过。

非生产分支默认是 `npx wrangler versions upload`，只构建预览版本不提升为正式部署，
**也刻意不跑 migration** —— 免得一个功能分支把生产库给迁移了。

用 `wrangler secret put` 设的 secret 存在 Worker 上，部署不会清掉，不需要加到构建里。
Build variables 是另一回事，只在构建期可见。

注册一个 app，拿到客户端要用的 API Key：
```bash
npm run register-app -- --url https://rater-collector.<你的-cf-子域>.workers.dev --name "My App" --app-store-id 123456789
```
也可以直接在 `/admin` 的「应用」页点注册。**API Key 只显示一次**，库里只存 SHA-256。

## 本地开发

```bash
cp .dev.vars.example .dev.vars && npx wrangler d1 migrations apply rater --local && npx wrangler dev
```
```bash
npm run register-app -- --name "Demo App" --id demo-app
```

后台在 http://localhost:8787/admin，口令是 `.dev.vars` 里的 `ADMIN_TOKEN`。

单元测试（跑在真 workerd 里，用真 D1 和真 R2，不是 mock）：
```bash
npm test
```

端到端（需要另开一个终端跑着 `npx wrangler dev`）：
```bash
npm run e2e
```
`scripts/e2e.sh` 打真实 HTTP，29 项断言覆盖：兜底文案下发、ETag 304、后台改文案立刻生效、三段式提交 + 截图落 R2、幂等重试不产生重复、漏斗计数、鉴权与停用开关。每次跑会注册一个带时间戳的新 app（`e2e-<epoch>`），不污染已有数据。

## 客户端 API

全部需要 `X-Rater-Key: <API Key>` 头。

### `GET /v1/config?version=&locale=`

返回预询问弹窗的文案、反馈分类和可选的触发规则覆盖。带 `ETag` 和 `Cache-Control: max-age=900`，客户端应缓存并在下次带 `If-None-Match`。

```json
{
  "enabled": true,
  "variant": "default",
  "app_store_id": "123456789",
  "prompt": { "title": "…", "message": "…", "positive_label": "…", "negative_label": "…", "later_label": "…" },
  "feedback": { "title": null, "message": null, "categories": [{"id":"bug","label":"遇到问题"}], "email_required": false },
  "rules": { "min_launch_count": 3 }
}
```

匹配顺序：先按 locale 精确度（`zh-Hans-CN` → `zh-Hans` → `zh` → `*`），同精确度取 `min_app_version` 最高且不超过客户端版本的那条。**一条文案都没配时**返回内置兜底，保证新接入的 app 立刻能跑；**配了但当前版本/语言都不匹配**时返回 `enabled: false`，因为这属于刻意下线。

### `POST /v1/feedback`

三段式提交的第一步。先把正文落库，再签发一个 15 分钟有效的上传令牌。这样用户在传截图时断网，正文也已经安全落地了。

```json
{
  "idempotency_key": "客户端生成的 UUID",
  "message": "正文，4–4000 字",
  "category": "bug",
  "email": "user@example.com",
  "attachment_count": 2,
  "device": { "app_version": "1.0.0", "build": "42", "os_version": "18.2", "device_model": "iPhone 16 Pro", "…": "…" },
  "metadata": { "plan": "pro" }
}
```
→ `201 { "id": "fb_…", "upload_token": "…", "expires_at": 1735689600, "max_attachment_bytes": 5242880, "duplicate": false }`

同一个 `(app_id, idempotency_key)` 重复提交返回 `200` 和同一条记录（`duplicate: true`），配合客户端的离线重试队列，网络抖动不会产生重复反馈。

### `PUT /v1/feedback/:id/attachments/:idx`

第二步。头带 `Authorization: Bearer <upload_token>`，body 是图片原始字节。

走 Worker 代理而不是 R2 预签名 URL：截图本来就压到 2MB 以内，代理一趟省掉了在客户端维护 S3 凭证的麻烦，也让体积/类型校验有个统一的卡点。同一个 `idx` 重传会覆盖，支持断点重试。

### `POST /v1/feedback/:id/complete`

第三步。标记完成、统计附件数，并异步推送 webhook 通知。重复调用不会重复推送。

### `POST /v1/telemetry`

批量上报 `shown` / `positive` / `negative` / `dismissed` / `submitted` 事件，用来在后台算转化漏斗。不含任何用户标识。

## 管理后台

`GET /admin` 是一个 React + TypeScript + Tailwind 写的控制台：反馈列表与筛选、详情与截图预览、状态与备注、转化漏斗统计、**在线改文案**、应用注册与停用。明暗主题跟随系统，也可以手动切换。

用 `ADMIN_TOKEN` 登录换一个 7 天的 HttpOnly cookie。生产环境建议在 `/admin*` 前再叠一层 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)。

对应的 REST 接口在 `/admin/api/*`，用 `Authorization: Bearer <ADMIN_TOKEN>` 调用，可以接自己的工具。

### 改后台界面

源码在 [`admin-ui/`](admin-ui)。Vite 会把它打成一个自包含的 HTML 文件，再由 `scripts/build-admin.mjs` 内联进 `src/admin/dashboard.ts` —— 所以仍然是「部署 Worker 即部署后台」，不需要第二条流水线，也不需要静态资源绑定。生成的那个文件是提交进仓库的，因此纯 `wrangler deploy` 不需要前端工具链。

```bash
npm run admin:install            # 装一次依赖
npm run admin:dev                # Vite 起在 :5173，/admin/api 代理到 :8787 的 wrangler dev
npm run admin:build              # 重新构建并内联 —— 改完界面提交前跑一次
```

## 通知

设置了 `NOTIFY_WEBHOOK_URL` 后，每条新反馈会推一次。按域名自动挑报文格式：

| 域名 | 格式 |
|---|---|
| `*.slack.com` | `{ text }` |
| `*.discord.com` | `{ content }` |
| 含 `bark` / `day.app` | `{ title, body, url, group }` |
| 其它 | 通用 JSON（含全部字段 + `detailURL` + `summary`） |

## 防刷

客户端 API Key 会随 app 二进制分发，本身不算机密 —— 它的作用是把流量归属到某个 app，并且让被滥用的 key 可以随时停用。真正挡刷子的是这几层：

1. Key 必须在 `apps` 表里且 `enabled = 1`
2. `SUBMIT_LIMIT` 按 `IP + app_id` 限流，提交 5 次/分钟；`READ_LIMIT` 读接口 60 次/分钟
3. 体积上限：JSON body 64KB、单张截图 5MB、每条反馈最多 3 张
4. Zod 严格校验，正文限 4–4000 字，metadata 最多 20 组键值
5. `(app_id, idempotency_key)` 唯一索引挡重放
6. 记录 `cf.country`，后台可按来源国家甄别垃圾

## ⚠️ 与客户端的契约

`src/routes/config.ts` 里的 `FALLBACK` 兜底文案，必须和 RaterKit 仓库 `Sources/RaterKit/Configuration/RaterConfiguration.swift` 里的 `RaterCopy.default` **逐字一致** —— 一个是服务端没配文案时的兜底，一个是客户端离线时的兜底，用户可能在两次启动间分别看到这两份，不一致会显得很奇怪。

当前双方一致的内容：

| 字段 | 文案 |
|---|---|
| title | `Enjoying this app?` |
| message | `Your opinion matters to us — it only takes a few seconds.` |
| positive | `I like it` |
| negative | `Not quite` |
| later | `Maybe later` |
| categories | `Something's broken` / `Feature request` / `Something else` |

改任何一边都要同步改另一边。这是拆成两个仓库后唯一需要人工看住的地方。

## 数据与隐私

反馈里会包含用户主动填写的邮箱和自动采集的设备信息。上线前记得在 app 的隐私政策里说明，并按需要设置 R2 的生命周期规则自动清理旧截图：

```bash
npx wrangler r2 bucket lifecycle add rater-attachments --name expire-old --expire-days 365
```
