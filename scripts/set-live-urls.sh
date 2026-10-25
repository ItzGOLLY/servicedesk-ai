#!/usr/bin/env bash
#
# Point every document at a new deployment, and prove it works first.
#
# A new Render account means a new API URL, and that URL appears in the README
# and several documents. Editing them by hand is how a dead link survives into
# a submission, so this does it in one pass — but only after verifying the
# deployment actually responds.
#
#   ./scripts/set-live-urls.sh <API_URL> <SITE_URL>
#
# Example:
#   ./scripts/set-live-urls.sh \
#       https://servicedesk-api-abcd.onrender.com \
#       https://servicedesk-ai-xyz.vercel.app
#
set -euo pipefail

API="${1:-}"
SITE="${2:-}"

if [[ -z "$API" || -z "$SITE" ]]; then
  echo "usage: $0 <API_URL> <SITE_URL>" >&2
  echo "   eg: $0 https://servicedesk-api-abcd.onrender.com https://servicedesk-ai-xyz.vercel.app" >&2
  exit 1
fi

# Strip trailing slashes; a doubled slash in a URL looks like a typo in a report.
API="${API%/}"
SITE="${SITE%/}"

cd "$(dirname "$0")/.."

echo "Verifying the deployment before touching any document…"
echo

fail=0

check() { # label, expected, actual
  if [[ "$3" == "$2" ]]; then
    printf "  ok    %-34s %s\n" "$1" "$3"
  else
    printf "  FAIL  %-34s got %s, wanted %s\n" "$1" "$3" "$2"
    fail=1
  fi
}

# 1. The API is up and can reach its database.
health=$(curl -s -m 90 "$API/api/health" 2>/dev/null || true)
if grep -q '"database":"connected"' <<<"$health"; then
  echo "  ok    api health                         database connected"
else
  echo "  FAIL  api health                         $health"
  echo "        (a free Render instance can take ~50s to wake — try once more)"
  fail=1
fi

# 2. The site is served.
check "site reachable" "200" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$SITE" 2>/dev/null || echo 000)"

# 3. CORS allows the site — the usual cause of "cannot reach the server".
# `|| true` on the whole pipeline: with pipefail set, a curl timeout would
# otherwise abort the script before it could print the summary below.
origin=$({ curl -s -m 30 -o /dev/null -D - -X OPTIONS "$API/api/auth/login" \
             -H "Origin: $SITE" -H "Access-Control-Request-Method: POST" 2>/dev/null \
           | tr -d '\r' \
           | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}'; } || true)
check "CORS allows the site" "$SITE" "${origin:-<none>}"

# 4. The deployed frontend actually targets this API.
#
# Vite bakes VITE_API_BASE_URL in at build time, so changing it in the
# dashboard without redeploying leaves the old address in the bundle. The site
# then loads perfectly and fails on the first request — which looks like a
# backend fault and is not one.
bundle=$({ curl -s -m 30 "$SITE" 2>/dev/null \
           | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1; } || true)
if [[ -n "$bundle" ]]; then
  referenced=$({ curl -s -m 60 "$SITE/$bundle" 2>/dev/null \
                 | grep -o 'https://[a-z0-9.-]*\.onrender\.com' | sort -u | head -1; } || true)
  check "frontend targets this API" "$API" "${referenced:-<none found>}"
  if [[ -n "$referenced" && "$referenced" != "$API" ]]; then
    echo "        the site is serving an older build: set VITE_API_BASE_URL to"
    echo "        $API/api in Vercel, then REDEPLOY (a variable change alone does nothing)"
  fi
else
  echo "  warn  frontend bundle                   could not be located; skipped"
fi

# 5. Every credential printed in the report actually works.
for cred in \
  "admin@servicedesk.ai:Admin@12345" \
  "priya.agent@servicedesk.ai:Agent@12345" \
  "rohan@example.com:Customer@12345"
do
  email="${cred%%:*}"; password="${cred#*:}"
  code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$API/api/auth/login" \
           -H 'Content-Type: application/json' \
           -d "{\"email\":\"$email\",\"password\":\"$password\"}" 2>/dev/null || echo 000)
  check "login $email" "200" "$code"
done

echo
if [[ "$fail" -ne 0 ]]; then
  echo "Deployment is not healthy. No documents were changed."
  echo "Fix the failures above, then run this again."
  exit 1
fi

echo "Deployment verified. Updating documents…"
echo

# Replace any previously recorded deployment, whatever it was.
OLD_API_RE='https://servicedesk-api-[a-z0-9-]*\.onrender\.com'
OLD_SITE_RE='https://servicedesk-ai-[a-z0-9-]*\.vercel\.app'

files=$(grep -rl -E "$OLD_API_RE|$OLD_SITE_RE" \
          --include='*.md' --include='*.yaml' --include='*.yml' \
          . 2>/dev/null | grep -v node_modules || true)

if [[ -z "$files" ]]; then
  echo "  nothing to update"
else
  for f in $files; do
    # macOS and GNU sed disagree about -i; this form works on both.
    sed -i.bak -E -e "s#$OLD_API_RE#$API#g" -e "s#$OLD_SITE_RE#$SITE#g" "$f"
    rm -f "$f.bak"
    echo "  updated $f"
  done
fi

echo
echo "Done. Review the diff, then commit:"
echo "  git diff --stat"
echo "  git commit -am 'docs: record the current deployment URLs'"
echo
echo "Submission values:"
echo "  Live URL    $SITE"
echo "  API         $API/api"
echo "  API docs    $API/api/docs"
echo "  Repository  https://github.com/ItzGOLLY/servicedesk-ai"
