#!/usr/bin/env bash
# Deploys the docs site (apps/docs), a web site of its own, to our server. Independent of app
# deploys: it builds the static site here, copies it to its own directory on the server and gives
# Caddy a site block of its own. No app unit is touched and none restarts. docs/DEPLOY-SITE.md
# "Docs site".
#
#   scripts/docs/deploy.sh <host> [deploy|status|rollback]
#   (also: scripts/deploy/deploy.sh <host> docs)
#
#   deploy (default)  build (exits on any build problem), copy, switch, reload Caddy, check
#   status            what is served now, the releases kept, the certificates' state
#   rollback          serve the previous release again
#
# Hosts served: docs.units.gg (always: the docs' one canonical origin) and, for a server given by its
# IPv4 address, the temporary host docs-<ip-with-dashes>.sslip.io. Caddy obtains the certificate of
# docs.units.gg by itself once its DNS record points at the server:
#
#   A   docs.units.gg   ->   <the server's IPv4 address>
#
# Until then only the temporary host answers; Caddy keeps retrying the certificate in the background
# (with growing pauses, for up to 30 days; running this script again asks at once).
#
# Environment:
#   SSH_KEY (default ~/.ssh/lineage_site), SSH_PORT (22), SSH_USER (root)
#   DOCS_HOSTS      the host names to serve, comma separated (default docs.units.gg plus the temporary host)
#   UNITS_APP_URL   the app the docs link to and read live figures from (default config/sites.json app_url)
#   DOCS_TLS_INTERNAL=1   Caddy's own test certificates instead of Let's Encrypt (dry runs)
#
# On the server: /var/www/units-docs/releases/<time>-<commit> (the newest 5 are kept),
# /var/www/units-docs/current (a link to the one served), /etc/caddy/sites.d/units-docs.caddy
# (rendered from scripts/deploy/caddy/docs.caddy.tmpl; the previous one is restored when Caddy
# refuses the new one).
set -euo pipefail
HOST="${1:-}"; MODE="${2:-deploy}"
[ -n "$HOST" ] || { sed -n '2,33p' "$0"; exit 2; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/lineage_site}"
SSH_PORT="${SSH_PORT:-22}"
SSH_USER="${SSH_USER:-root}"
SSH_OPTS=(-i "$SSH_KEY" -p "$SSH_PORT" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)
[ "${SSH_INSECURE_TEST:-0}" = 1 ] && SSH_OPTS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
r() { env -u LC_CTYPE -u LC_ALL ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }
say() { printf '\n== %s\n' "$*"; }
cd "$REPO"

CANONICAL_HOST="$(bun -e 'console.log(new URL(require("./config/sites.json").docs_canonical).host)')"
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then TEMP_HOST="docs-${HOST//./-}.sslip.io"; else TEMP_HOST=""; fi
DOCS_HOSTS="${DOCS_HOSTS:-$CANONICAL_HOST${TEMP_HOST:+,$TEMP_HOST}}"
echo "$DOCS_HOSTS" | tr ',' '\n' | grep -qvE '^[A-Za-z0-9.-]+$' && { echo "DOCS_HOSTS must be comma-separated host names" >&2; exit 2; }
WWW=/var/www/units-docs
SITE_FILE=/etc/caddy/sites.d/units-docs.caddy

# the server side of one step, run as root there
remote() {
  r "bash -s -- $(printf '%q ' "$@")" <<'REMOTE'
set -euo pipefail
WWW=/var/www/units-docs; SITE_FILE=/etc/caddy/sites.d/units-docs.caddy
CMD="$1"; shift
reload() {
  grep -qF 'import /etc/caddy/sites.d/*.caddy' /etc/caddy/Caddyfile || { echo "the main Caddyfile does not import /etc/caddy/sites.d (deploy the app once with scripts/deploy/deploy.sh)" >&2; return 1; }
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/units-docs-validate.log 2>&1; then cat /tmp/units-docs-validate.log >&2; return 1; fi
  # `caddy validate` ran as root and may have created the log file
  install -d -o caddy -g caddy /var/log/caddy; [ -e /var/log/caddy/units-docs-access.log ] && chown caddy:caddy /var/log/caddy/units-docs-access.log
  systemctl reload caddy
}
case "$CMD" in
activate)
  REL="$1"
  [ -f "$WWW/releases/$REL/index.html" ] && [ -f "$WWW/releases/$REL/404.html" ] || { echo "release $REL is not complete" >&2; exit 1; }
  chown -R root:root "$WWW/releases/$REL"; chmod -R u=rwX,go=rX "$WWW/releases/$REL"
  PREV="$(readlink "$WWW/current" 2>/dev/null || true)"
  install -d -m 755 /etc/caddy/sites.d
  [ -f "$SITE_FILE" ] && cp -p "$SITE_FILE" "$SITE_FILE.prev-keep" || rm -f "$SITE_FILE.prev-keep"
  [ -s "$WWW/site.caddy.new" ] || { echo "no rendered site block at $WWW/site.caddy.new" >&2; exit 1; }
  install -m 644 -o root -g root "$WWW/site.caddy.new" "$SITE_FILE" && rm -f "$WWW/site.caddy.new"
  ln -sfn "$WWW/releases/$REL" "$WWW/current.new" && mv -Tf "$WWW/current.new" "$WWW/current"
  if ! reload; then
    echo "Caddy refused the new docs site block; putting the previous state back" >&2
    if [ -f "$SITE_FILE.prev-keep" ]; then mv "$SITE_FILE.prev-keep" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
    if [ -n "$PREV" ]; then ln -sfn "$PREV" "$WWW/current.new" && mv -Tf "$WWW/current.new" "$WWW/current"; fi
    exit 1
  fi
  rm -f "$SITE_FILE.prev-keep"
  [ -n "$PREV" ] && [ "$PREV" != "$WWW/releases/$REL" ] && echo "$PREV" > "$WWW/previous"
  ls -1dt "$WWW"/releases/*/ | tail -n +6 | while read -r d; do [ "${d%/}" = "$(readlink "$WWW/current")" ] || [ "${d%/}" = "$(cat "$WWW/previous" 2>/dev/null)" ] || rm -rf "$d"; done
  echo "serving $(basename "$(readlink "$WWW/current")")"
  ;;
rollback)
  PREV="$(cat "$WWW/previous" 2>/dev/null || true)"
  [ -n "$PREV" ] && [ -f "$PREV/index.html" ] || { echo "no previous docs release to go back to" >&2; exit 1; }
  NOW="$(readlink "$WWW/current")"
  ln -sfn "$PREV" "$WWW/current.new" && mv -Tf "$WWW/current.new" "$WWW/current"
  echo "$NOW" > "$WWW/previous"
  echo "serving $(basename "$PREV") (was $(basename "$NOW")); the files are read per request, Caddy needs no reload"
  ;;
status)
  echo "serving: $(basename "$(readlink "$WWW/current" 2>/dev/null || echo none)")"
  echo "previous: $(basename "$(cat "$WWW/previous" 2>/dev/null || echo none)")"
  echo "releases: $(ls -1t "$WWW/releases" 2>/dev/null | tr '\n' ' ')"
  echo "site block: $([ -f "$SITE_FILE" ] && sed -n 's/^\([A-Za-z0-9., -]*\) {$/\1/p' "$SITE_FILE" | tail -1 || echo none)"
  for h in "$@"; do
    c="$(find /var/lib/caddy/.local/share/caddy/certificates -path "*/$h/$h.crt" 2>/dev/null | head -1)"
    if [ -n "$c" ]; then echo "certificate $h: $(openssl x509 -in "$c" -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')"; else echo "certificate $h: none yet (Caddy obtains it once the name's DNS record points here)"; fi
  done
  ;;
esac
REMOTE
}

case "$MODE" in
status)
  # shellcheck disable=SC2086
  remote status ${DOCS_HOSTS//,/ }
  ;;
rollback)
  remote rollback
  ;;
deploy)
  OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
  say "build the docs site"
  bun scripts/docs/build.ts --out "$OUT/site"
  CSP="$(bun scripts/docs/build.ts --print-csp)"
  SHA="$(git rev-parse --short=12 HEAD)"
  [ -z "$(git status --porcelain -- apps/docs scripts/docs config/sites.json)" ] || { SHA="$SHA-dirty"; echo "note: apps/docs, scripts/docs or config/sites.json have uncommitted changes; the working tree is what ships"; }
  REL="$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
  printf '%s\n' "$REL" > "$OUT/site/.release"
  say "copy $(find "$OUT/site" -type f | wc -l | tr -d ' ') files ($(du -sh "$OUT/site" | cut -f1)) to $HOST:$WWW/releases/$REL"
  r "install -d -m 755 $WWW/releases/$REL"
  COPYFILE_DISABLE=1 tar -C "$OUT/site" -czf - . | r "tar -C $WWW/releases/$REL -xzf - --no-same-owner"
  say "switch and reload Caddy (hosts: ${DOCS_HOSTS//,/, })"
  TLS=""; [ "${DOCS_TLS_INTERNAL:-0}" = 1 ] && TLS="	tls internal"
  export T_SITES="${DOCS_HOSTS//,/, }" T_TLS="$TLS" T_ROOT="$WWW/current" T_CSP="$CSP"
  bun -e 'const t = await Bun.file("scripts/deploy/caddy/docs.caddy.tmpl").text(); const e = process.env; process.stdout.write(t.replaceAll("@SITES@", e.T_SITES).replaceAll("@TLS@", e.T_TLS).replaceAll("@ROOT@", e.T_ROOT).replaceAll("@CSP@", e.T_CSP));' > "$OUT/site.caddy"
  grep -q '@[A-Z]*@' "$OUT/site.caddy" && { echo "the site block still holds a placeholder" >&2; exit 1; }
  r "cat > $WWW/site.caddy.new" < "$OUT/site.caddy"
  remote activate "$REL"
  [ "${DOCS_SKIP_CHECK:-0}" = 1 ] && exit 0
  say "check"
  FAIL=0
  for h in ${DOCS_HOSTS//,/ }; do
    if ! addr="$(dig +short "$h" 2>/dev/null | tail -1)" || [ "$addr" != "$HOST" ]; then
      echo "$h: its DNS record does not point at $HOST yet (${addr:-no record}); add  A  $h -> $HOST  and Caddy obtains its certificate by itself"
      continue
    fi
    ok=0
    for i in $(seq 1 30); do
      [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$h/.release" || true)" = 200 ] && [ "$(curl -s -m 10 "https://$h/.release")" = "$REL" ] && { ok=1; break; }
      sleep 4   # a first certificate takes a few seconds
    done
    [ "$ok" = 1 ] || { echo "$h: FAIL, https://$h/.release does not answer $REL"; FAIL=1; continue; }
    page="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$h/launch-quickstart")"
    miss="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://$h/no-such-page")"
    css="$(curl -s -m 15 "https://$h/" | sed -n 's/.*href="\(\/assets\/docs\.[0-9a-f]*\.css\)".*/\1/p' | head -1)"
    cache="$(curl -s -o /dev/null -m 15 -D - "https://$h$css" | tr -d '\r' | sed -n 's/^[Cc]ache-[Cc]ontrol: //p')"
    echo "$h: release $REL, /launch-quickstart $page, unknown path $miss, $css cache-control \"$cache\""
    [ "$page" = 200 ] && [ "$miss" = 404 ] && [[ "$cache" == *immutable* ]] || FAIL=1
  done
  # the live figures: the app's API must answer the docs origins across origins
  APP="$(bun -e 'console.log((process.env.UNITS_APP_URL || require("./config/sites.json").app_url).replace(/\/+$/, ""))')"
  for h in ${DOCS_HOSTS//,/ }; do
    for p in /v1/config "/market/tokens?limit=1"; do
      allow="$(curl -s -o /dev/null -m 20 -D - -H "Origin: https://$h" "$APP$p" | tr -d '\r' | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p' | head -1)"
      if [ "$allow" = "*" ] || [ "$allow" = "https://$h" ]; then echo "CORS $APP$p for https://$h: allowed ($allow)"; else echo "CORS $APP$p for https://$h: NOT allowed (\"$allow\"); add the origin to the app's allowed origins (scripts/deploy/deploy.sh, CORS_ORIGINS)"; FAIL=1; fi
    done
  done
  [ "$FAIL" = 0 ] || { echo "docs deploy: a check failed" >&2; exit 1; }
  echo "docs deployed: $REL"
  ;;
*)
  echo "unknown mode $MODE (deploy, status, rollback)" >&2; exit 2
  ;;
esac
