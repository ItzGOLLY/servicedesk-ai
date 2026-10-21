#!/usr/bin/env bash
#
# Two tenants, one webhook: posts correctly signed Meta payloads at the
# platform webhook and shows that routing, deduplication and signature
# verification all behave. See docs/PLATFORM_DEMO.md for what to expect.
#
# Requires: the API running locally, and two tenants each owning a number
# (pn-demo and pn-globex).
set -e
API=http://localhost:4000
# Must match META_APP_SECRET on the running API.
SECRET=${META_APP_SECRET:-local-demo-app-secret}
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1; }
send() {
  BODY=$1
  curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST $API/api/webhooks/meta \
    -H "Content-Type: application/json" \
    -H "X-Hub-Signature-256: sha256=$(sign "$BODY")" \
    --data-binary "$BODY"
}
mk() { # phone_number_id, from, text, msgid
cat <<JSON
{"object":"whatsapp_business_account","entry":[{"id":"e1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"$1","display_phone_number":"+1555000"},"contacts":[{"wa_id":"${2#+}","profile":{"name":"Shared Shopper"}}],"messages":[{"id":"$4","from":"${2#+}","type":"text","timestamp":"1","text":{"body":"$3"}}]}}]}]}
JSON
}
echo "ACME  -> $(send "$(mk pn-demo   +919000012345 'My payment was taken twice this morning.' wamid.DEMO1)")"
echo "GLOBEX-> $(send "$(mk pn-globex +919000012345 'My parcel never arrived at all.'          wamid.DEMO2)")"
echo "replay-> $(send "$(mk pn-demo   +919000012345 'My payment was taken twice this morning.' wamid.DEMO1)")"
echo "unknown number -> $(send "$(mk pn-nope +919000012345 'Hello is anyone there' wamid.DEMO3)")"
echo "unsigned -> $(curl -s -m 20 -o /dev/null -w '%{http_code}' -X POST $API/api/webhooks/meta -H 'Content-Type: application/json' --data-binary "$(mk pn-demo +919000012345 'forged' wamid.DEMO4)")"
