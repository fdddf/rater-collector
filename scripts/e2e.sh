#!/usr/bin/env bash
# End-to-end run against a live `wrangler dev`, exercising the same call sequence the
# client makes — every acceptance check that does not require tapping a screen.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE=${RATER_BASE:-http://localhost:8787}
# Read the password from .dev.vars so it can't drift out of sync with the running
# server. Override with RATER_ADMIN_TOKEN to point this at a deployed environment.
ADMIN=${RATER_ADMIN_TOKEN:-$(sed -n "s/^ADMIN_TOKEN[[:space:]]*=[[:space:]]*\"\{0,1\}\([^\"]*\)\"\{0,1\}.*/\1/p" "$ROOT/.dev.vars" 2>/dev/null)}
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s — %s\n' "$1" "$2"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }
die()  { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

# Fail with a sentence rather than letting an empty or non-JSON response reach python
# as a decoder traceback further down.
[ -n "$ADMIN" ] || die "No admin password. Put ADMIN_TOKEN in $ROOT/.dev.vars, or set RATER_ADMIN_TOKEN."
curl -sf "$BASE/health" >/dev/null 2>&1 \
  || die "Cannot reach $BASE — start the dev server first:  npx wrangler dev"

echo "== register a fresh app =="
APP_ID="e2e-$(date +%s)"
REG=$(curl -s -X POST "$BASE/admin/api/apps" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E App\",\"id\":\"$APP_ID\",\"app_store_id\":\"123456789\"}")
KEY=$(printf '%s' "$REG" | python3 -c 'import json,sys
raw = sys.stdin.read()
try:
    print(json.loads(raw).get("api_key", ""))
except ValueError:
    sys.stderr.write("  server replied with non-JSON: %s\n" % (raw[:200] or "<empty>"))
')
[ -n "$KEY" ] || die "Registration failed. Is ADMIN_TOKEN correct? Server said: ${REG:-<empty response>}"
ok "registered $APP_ID, got API key"

echo
echo "== 1. config: built-in fallback for a brand-new app =="
CFG=$(curl -s "$BASE/v1/config?version=1.0.0&locale=en-US" -H "X-Rater-Key: $KEY")
check "enabled"        "$(echo "$CFG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["enabled"])')" "True"
check "fallback title" "$(echo "$CFG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["prompt"]["title"])')" "Enjoying this app?"
check "app_store_id"   "$(echo "$CFG" | python3 -c 'import json,sys;print(json.load(sys.stdin)["app_store_id"])')" "123456789"

echo
echo "== 2. ETag: unchanged copy costs one 304 =="
ETAG=$(curl -s -D- -o /dev/null "$BASE/v1/config?version=1.0.0" -H "X-Rater-Key: $KEY" | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/config?version=1.0.0" -H "X-Rater-Key: $KEY" -H "If-None-Match: $ETAG")
check "304 on matching ETag" "$CODE" "304"

echo
echo "== 3. console copy edit reaches the client (no app release) =="
curl -s -X PUT "$BASE/admin/api/apps/$APP_ID/prompts" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"locale":"*","min_app_version":"0","title":"Edited from the console","message":"m",
       "positive_label":"Yes","negative_label":"No","later_label":"Later",
       "categories":[{"id":"bug","label":"Bug"}],"rules":{"min_launch_count":3}}' > /dev/null
CFG2=$(curl -s "$BASE/v1/config?version=1.0.0&locale=en-US" -H "X-Rater-Key: $KEY")
check "new title served"   "$(echo "$CFG2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["prompt"]["title"])')" "Edited from the console"
check "rule override sent" "$(echo "$CFG2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["rules"]["min_launch_count"])')" "3"

echo
echo "== 4. full submission: body + screenshot + complete =="
IDEM="e2e-idem-$(date +%s)"
SUB=$(curl -s -X POST "$BASE/v1/feedback" -H "X-Rater-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"idempotency_key\":\"$IDEM\",\"message\":\"Export crashes on large albums\",
       \"category\":\"bug\",\"email\":\"e2e@example.com\",\"attachment_count\":1,
       \"device\":{\"app_version\":\"1.0.0\",\"build\":\"42\",\"bundle_id\":\"com.example.demo\",
       \"os_version\":\"iOS 18.2\",\"device_model\":\"iPhone 16 Pro\",\"locale\":\"en-US\",
       \"region\":\"US\",\"timezone\":\"America/Los_Angeles\",\"install_days\":12,\"launch_count\":38},
       \"metadata\":{\"plan\":\"pro\"}}")
FID=$(echo "$SUB" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
TOKEN=$(echo "$SUB" | python3 -c 'import json,sys;print(json.load(sys.stdin)["upload_token"])')
[ -n "$FID" ] && ok "feedback created: $FID" || bad "create" "$SUB"
[ "$TOKEN" != "None" ] && ok "upload token issued" || bad "upload token" "$SUB"

printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > /tmp/e2e-shot.png
UP=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/feedback/$FID/attachments/0" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: image/png' --data-binary @/tmp/e2e-shot.png)
check "screenshot uploaded" "$UP" "200"

DONE=$(curl -s -X POST "$BASE/v1/feedback/$FID/complete" -H "X-Rater-Key: $KEY")
check "attachment counted" "$(echo "$DONE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["attachment_count"])')" "1"

echo
echo "== 5. idempotency: a retried submit does not duplicate =="
RETRY=$(curl -s -w '\n%{http_code}' -X POST "$BASE/v1/feedback" -H "X-Rater-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"idempotency_key\":\"$IDEM\",\"message\":\"Export crashes on large albums\",\"attachment_count\":0}")
check "retry returns 200 not 201" "$(echo "$RETRY" | tail -1)" "200"
check "same feedback id"          "$(echo "$RETRY" | head -1 | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')" "$FID"
check "flagged duplicate"         "$(echo "$RETRY" | head -1 | python3 -c 'import json,sys;print(json.load(sys.stdin)["duplicate"])')" "True"

echo
echo "== 6. console sees the record, the screenshot and the metadata =="
DET=$(curl -s "$BASE/admin/api/feedback/$FID" -H "Authorization: Bearer $ADMIN")
check "message stored"    "$(echo "$DET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["feedback"]["message"])')" "Export crashes on large albums"
check "device stored"     "$(echo "$DET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["feedback"]["device_model"])')" "iPhone 16 Pro"
check "metadata parsed"   "$(echo "$DET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["feedback"]["metadata"]["plan"])')" "pro"
check "1 attachment"      "$(echo "$DET" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["attachments"]))')" "1"

R2KEY=$(echo "$DET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["attachments"][0]["r2_key"])')
IMG=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$BASE/admin/api/attachments/$R2KEY" -H "Authorization: Bearer $ADMIN")
check "screenshot served from R2" "$IMG" "200 image/png"

LIST=$(curl -s "$BASE/admin/api/feedback?app_id=$APP_ID" -H "Authorization: Bearer $ADMIN")
check "exactly one row (idempotent)" "$(echo "$LIST" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["items"]))')" "1"

echo
echo "== 7. telemetry funnel =="
curl -s -X POST "$BASE/v1/telemetry" -H "X-Rater-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"events":[{"kind":"shown"},{"kind":"shown"},{"kind":"shown"},{"kind":"shown"},
                 {"kind":"positive"},{"kind":"negative"},{"kind":"submitted"}]}' > /dev/null
ST=$(curl -s "$BASE/admin/api/stats?app_id=$APP_ID" -H "Authorization: Bearer $ADMIN")
check "shown=4"          "$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["funnel"]["shown"])')" "4"
check "positive=1"       "$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["funnel"]["positive"])')" "1"
check "positive_rate=25%" "$(echo "$ST" | python3 -c 'import json,sys;print(round(json.load(sys.stdin)["funnel"]["positive_rate"],2))')" "0.25"
check "1 open feedback"  "$(echo "$ST" | python3 -c 'import json,sys;print(json.load(sys.stdin)["feedback_by_status"]["open"])')" "1"

echo
echo "== 8. the console HTML is served and is English =="
HTML=$(curl -s "$BASE/admin")
echo "$HTML" | grep -q 'Rater Feedback Console' && ok "console title present" || bad "console title" "missing"
# BSD grep has no -P, so the CJK scan goes through python rather than a \x{...} class.
CJK=$(echo "$HTML" | python3 -c 'import re,sys;print(len(re.findall(r"[一-鿿]", sys.stdin.read())))')
check "console has no CJK characters" "$CJK" "0"

echo
echo "== 9. auth and kill switch =="
check "no key → 401"     "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/config")" "401"
check "bad key → 401"    "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/config" -H 'X-Rater-Key: rtr_pub_nope')" "401"
curl -s -X PATCH "$BASE/admin/api/apps/$APP_ID" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' > /dev/null
check "disabled app → 403" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/config" -H "X-Rater-Key: $KEY")" "403"

echo
printf '\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
exit $((FAIL > 0))
