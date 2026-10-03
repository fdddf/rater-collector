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

配置 secrets（`NOTIFY_WEBHOOK_URL`、`BARK_*` 可选）：
```bash
npx wrangler secret put ADMIN_TOKEN && npx wrangler secret put UPLOAD_HMAC_SECRET
```

把 `PUBLIC_BASE_URL` 设成部署后的地址 —— 通知里那条「查看详情」链接就是拿它拼的，所以得填对外地址，末尾不要斜杠：

```bash
npx wrangler secret put PUBLIC_BASE_URL   # https://rater-collector.<你>.workers.dev
```

然后：
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

可选的 `X-Rater-Reporter` 头会让这条反馈成为该设备的一个[会话](#会话)。格式不对的头会被忽略而不是拒绝 —— 丢掉用户写的内容比丢掉后续追问更糟。

### `PUT /v1/feedback/:id/attachments/:idx`

第二步。头带 `Authorization: Bearer <upload_token>`，body 是图片原始字节。

走 Worker 代理而不是 R2 预签名 URL：截图本来就压到 2MB 以内，代理一趟省掉了在客户端维护 S3 凭证的麻烦，也让体积/类型校验有个统一的卡点。同一个 `idx` 重传会覆盖，支持断点重试。

### `POST /v1/feedback/:id/complete`

第三步。标记完成、统计附件数，并异步推送 webhook 通知。重复调用不会重复推送。

### `POST /v1/telemetry`

批量上报 `shown` / `positive` / `negative` / `dismissed` / `submitted` 事件，用来在后台算转化漏斗。不含任何用户标识。

### 会话

设备发出的每条反馈都会成为一个会话：用户能在 app 里接着看、接着回，后台的回复也发到这里。这些接口除了 app key，还要带 `X-Rater-Reporter: <token>`。

App key 是公开的，分辨不出"是谁在问"。reporter token 可以：SDK 每次安装生成一次的 32 字节随机数，存在 Keychain 里，随每条反馈一起发送。D1 只存它的 SHA-256。会话归属于发送时用的那个 token，别人的会话一律返回 `404`。标成 spam 的不显示，没走完提交流程的反馈也不算会话。

| 接口 | |
|---|---|
| `GET /v1/threads?before=` | 调用方自己的会话，按最近活动倒序：`{ id, status, category, preview, last_author, last_message_at, unread_count }`。`status` 只有 `open` 和 `resolved`。 |
| `GET /v1/threads/:id?after=<seq>` | 会话头加全部消息，或只返回 `after` 之后的 —— 会话页打开时客户端轮询的就是它。 |
| `POST /v1/threads/:id/messages` | `{ idempotency_key, body }` → `201 { message }`。和提交一样幂等；用户回复会把已解决的会话重新打开，并推送一条 "New reply" 通知。 |
| `POST /v1/threads/:id/read` | `{ seq }` 推进已读位置。只进不退，也不会超过最新一条。 |
| `GET /v1/inbox` | `{ unread_count, unread_threads }`，给 app 里的角标用。 |
| `DELETE /v1/threads` | 删除这个 token 发过的一切 —— 反馈、消息、截图。 |

传输方式是轮询。RaterKit 在会话页打开时每 5 秒拉一次，列表页每 15 秒，app 回到前台时拉一次 `/v1/inbox`。时间戳是 Unix 毫秒；`seq` 只增不减，所以 `after=` 不会漏消息。

## 管理后台

`GET /admin` 是一个 React + TypeScript + Tailwind 写的控制台：反馈列表与筛选（包括待回复的会话）、详情与截图预览、状态与备注、在 app 内会话或邮件里回复用户、单条或批量删除（连同 R2 里的截图一起清掉）、转化漏斗统计与按应用重置、**在线改文案**及多语言翻译、应用注册与停用。明暗主题跟随系统，也可以手动切换。

用 `ADMIN_TOKEN` 登录换一个 7 天的 HttpOnly cookie。生产环境建议在 `/admin*` 前再叠一层 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)。

对应的 REST 接口在 `/admin/api/*`，用 `Authorization: Bearer <ADMIN_TOKEN>` 调用，可以接自己的工具。

### 文案多语言

新增文案时**语言可以多选**，每种语言各写一行，内容就是你填的那份，之后再逐个改或翻译。已有的行也能直接复制成新语言的行，加第二种语言不用把十几个字段重敲一遍。

配好翻译密钥后，每行会多一个**翻译**动作，一次最多译 12 种语言。分类的 `id` 是客户端匹配用的键，全程不动，只翻 label；结果只作为草稿列出来给你过目，**在你按保存之前不会写库**。

支持两种服务商，都用 secret 配置。Anthropic：

```bash
npx wrangler secret put TRANSLATE_API_KEY     # sk-ant-...
# 可选：TRANSLATE_MODEL（默认 claude-opus-5）
```

或者任何 OpenAI 兼容接口 —— DeepSeek、Moonshot、通义千问、OpenRouter、本地起的服务都行：

```bash
npx wrangler secret put TRANSLATE_PROVIDER    # openai
npx wrangler secret put TRANSLATE_API_KEY
npx wrangler secret put TRANSLATE_MODEL       # 必填 —— 各家模型名都不一样，没法给默认值
npx wrangler secret put TRANSLATE_BASE_URL    # 例如 https://api.deepseek.com/v1
```

不设 `TRANSLATE_API_KEY` 的话翻译按钮不会出现，后台其余功能照常。

### 回复用户

反馈详情里有会话记录和撰写框。消息默认发到 app 内 —— 用户下次打开会话就能看到。弹窗打开期间每 5 秒刷新一次，并把用户新写的内容标为已读；用户打开过你的消息后会显示 "Seen"。

来自不支持会话的旧版本 app 的反馈（没有 reporter token）只能用邮件回复。配好 [Resend](https://resend.com) 之后，任何消息都可以勾选 **Also email it** 同时发邮件。收件地址取自这条反馈本身，不接受请求里传入；发信失败什么都不存，所以标着已发邮件的消息一定被服务商接收了。

```bash
npx wrangler secret put RESEND_API_KEY        # re_...
npx wrangler secret put RESEND_FROM           # "Support <support@your-domain.com>" —— 域名需在 Resend 验证过
npx wrangler secret put RESEND_REPLY_TO       # 可选；用户回信落到哪个邮箱
```

有两点要注意。`RESEND_FROM` 的域名必须在 Resend 里验证过（SPF/DKIM），否则发信会返回 502 并带上服务商的原话。另外 Resend 只负责发信：用户点回复是寄到 `RESEND_REPLY_TO`，不会回到后台里 —— 所以填一个你真的会看的邮箱，比如用 [Email Routing](https://developers.cloudflare.com/email-routing/) 转发到自己私人邮箱的地址。

不设 `RESEND_API_KEY` 的话，app 内消息照常可用；只能走邮件的反馈仍是原来那个 `mailto:` 按钮。

### 改后台界面

源码在 [`admin-ui/`](admin-ui)。Vite 会把它打成一个自包含的 HTML 文件，再由 `scripts/build-admin.mjs` 内联进 `src/admin/dashboard.ts` —— 所以仍然是「部署 Worker 即部署后台」，不需要第二条流水线，也不需要静态资源绑定。生成的那个文件是提交进仓库的，因此纯 `wrangler deploy` 不需要前端工具链。

```bash
npm run admin:install            # 装一次依赖
npm run admin:dev                # Vite 起在 :5173，/admin/api 代理到 :8787 的 wrangler dev
npm run admin:build              # 重新构建并内联 —— 改完界面提交前跑一次
```

## 通知

每条新反馈 —— 以及用户在会话里的每条回复（标题为 "New reply"）—— 会往所有已配置的通道各推一次。两个通道互相独立，都配就都推。

### Bark

```bash
npx wrangler secret put BARK_SERVER_URL    # https://api.day.app，或你自建的服务器
npx wrangler secret put BARK_DEVICE_KEY
```

往 `<BARK_SERVER_URL>/<BARK_DEVICE_KEY>` POST `{ title, body, url, group, isArchive }`。Bark 单独占两个变量、不走 `NOTIFY_WEBHOOK_URL`，是因为自建服务器的域名认不出来：`m.example.com` 和任何别的 endpoint 长得一样，靠下面那套域名嗅探只会推成通用 JSON，Bark 那边就什么都不显示。

### Webhook

设置了 `NOTIFY_WEBHOOK_URL` 后，按域名自动挑报文格式：

| 域名 | 格式 |
|---|---|
| `*.slack.com` | `{ text }` |
| `*.discord.com` | `{ content }` |
| 含 `bark` / `day.app` | `{ title, body, url, group }` |
| 其它 | 通用 JSON（含全部字段 + `kind`（`feedback` 或 `reply`）+ `detailURL` + `summary`） |

推送失败只记日志，不会影响客户端提交。

## 防刷

客户端 API Key 会随 app 二进制分发，本身不算机密 —— 它的作用是把流量归属到某个 app，并且让被滥用的 key 可以随时停用。真正挡刷子的是这几层：

1. Key 必须在 `apps` 表里且 `enabled = 1`
2. `SUBMIT_LIMIT` 按 `IP + app_id` 限流，提交 5 次/分钟；`READ_LIMIT` 读接口 60 次/分钟；`MESSAGE_LIMIT` 会话消息 20 条/分钟。会话接口的限流 key 里还带上 reporter，同一个运营商 NAT 后面的用户不会共用额度
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

反馈里会包含用户主动填写的邮箱和自动采集的设备信息，并关联一个每次安装随机生成的标识（reporter token），用户才能在 app 里看回自己的会话。上线前记得在 app 的隐私政策里说明 —— 在 App Store 隐私标签里这个 token 算标识符 —— 并提供 `DELETE /v1/threads`（RaterKit 的 `deleteConversationHistory()`）作为一键删除的入口，并按需要设置 R2 的生命周期规则自动清理旧截图：

```bash
npx wrangler r2 bucket lifecycle add rater-attachments --name expire-old --expire-days 365
```
