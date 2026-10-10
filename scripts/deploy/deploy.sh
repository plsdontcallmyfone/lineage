#!/usr/bin/env bash
# Lineage public devnet site: deploy from this machine to one Linux server. docs/DEPLOY-SITE.md.
#
#   scripts/deploy/deploy.sh <host> [mode]
#
# Modes:
#   full (default)  provision (idempotent) + code + keys + fund + chain + activate. Safe to re-run.
#   code            ship HEAD and activate it (no provisioning, no keys, no funding)
#   provision       provision.sh only
#   keys            copy the keys the server needs from ~/.config/lineage/devnet (public keys checked first)
#   fund            fund the site's devnet accounts from here (fund-site.ts), then register and bond the
#                   site's verifiers on the server (site-chain.ts)
#   status          read only: units, memory, Core health, chain balances, verifiers, faucet, disk
#   rollback        previous release (code only); `rollback --with-data` also restores its data backup
#   stop | start    stop and disable every lineage unit and Caddy, or start them again
#   wipe-keys       remove the keys copied from here (before destroying the server)
#   backup          copy the server's newest Core snapshot and newest secrets+state parts (state,
#                   identity; age-encrypted) off the machine to BACKUP_DIR (default
#                   ~/.lineage/site-backups/<host>, mode 700) and verify them here (Core: checksum,
#                   archive, integrity, table counts; secrets: checksum, decrypts with BACKUP_AGE_KEY,
#                   every file against its SHA256SUMS); keeps the newest BACKUP_KEEP (default 3) of each
#                   kind, or with BACKUP_KEEP_DAYS=<n> every copy younger than n days (the newest always)
#   restore-test    on the server: restore the newest Core snapshot into a scratch Core and check what it
#                   serves; then here: decrypt the newest secrets+state parts with BACKUP_AGE_KEY and check
#                   their keys equal the live ones by public key (and the identity key file and records)
#   restore-secrets [state file] [identity file]   disaster recovery: decrypt the newest local parts (or
#                   the given ones) here and write them into place on <host> (refuses to overwrite a
#                   differing file; RESTORE_REPLACE=1 keeps the old ones aside). Run before `full` on a
#                   new server so the site keeps its keys (docs/DEPLOY-SITE.md "Disaster recovery");
#                   RESTORE_PARTS limits the parts, RESTORE_ROOT writes under another directory (tests)
#   restore-core [file]   disaster recovery: copy a local Core snapshot (default the newest) to <host> and
#                   restore it (on a server with no release yet it only places the data for `full`)
#   monitor         on the server: run the monitor now and print every check
#
# Environment:
#   SSH_KEY (default ~/.ssh/lineage_site), SSH_PORT (22), SSH_USER (root)
#   DOMAIN          optional real domain (its A record must point at the server) served next to <ip>.sslip.io
#   ACME_EMAIL      optional email for Let's Encrypt
#   LINEAGE_RECIPES recipes to serve (default fixture-b58,base58-py,minbpe), re-pinned to the server's arch
#   WITH_RUNTIME=1  also copy the runtime authority key, model.env and providers.env (modes full, keys and code) and run
#                   lineage-runtime (real model spend, capped per UTC day in runtime.json by site-config.ts);
#                   e2b.env too when it holds a key (agent desktops' E2B overflow, capped per UTC day)
#   WITH_AUTHOR=1   also copy the TEST author agent keys and run lineage-author@<name> (scripted candidates)
#   AUTHORS         recipes whose TEST author runs (default minbpe); launch their agents first with
#                   scripts/deploy/site-authors.ts --recipes <same list> (keys agent-<name>.json here)
#   KEEP_SITE_ENV   1 (default): LINEAGE_RECIPES, AUTHORS, WITH_RUNTIME, WITH_AUTHOR and EXTRA_ORIGINS left
#                   unset keep the server's current site.env values; 0 falls back to the defaults
#   DEPLOY_REF      commit to deploy (default HEAD; must be HEAD or an ancestor)
#   DEPLOY_DRAIN_WAIT  seconds activate waits for background units (verifiers, authors, runtime) to finish
#                   draining before it returns and names the ones still draining (default 120)
#   DEPLOY_HEALTH_WAIT seconds each public unit has to answer after its restart before the release is
#                   rolled back (default 90)
#   BACKUP_AGE_KEY  the owner's age identity for secrets+state snapshots (default
#                   ~/.config/lineage/backup-age.key, mode 600, never copied anywhere); its public
#                   recipient goes to the server's /etc/lineage/backup-recipient.txt on every code ship
#                   (a different recipient already there is kept unless BACKUP_RECIPIENT_REPLACE=1)
#   DRY_RUN=1       test mode (scripts/deploy/dryrun.sh): no Docker, no keys from here, nothing sent on chain,
#                   Caddy with internal TLS for SITE_NAMES (default localhost)
#
# The code shipped is HEAD as a git bundle (commit first; the working tree is never shipped). Secrets
# are never printed: keys are compared and reported by public key only.
set -euo pipefail
HOST="${1:-}"; MODE="${2:-full}"; EXTRA="${3:-}"
[ -n "$HOST" ] || { sed -n '2,56p' "$0"; exit 2; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/lineage_site}"
SSH_PORT="${SSH_PORT:-22}"
SSH_USER="${SSH_USER:-root}"
DRY_RUN="${DRY_RUN:-0}"
KEYS_LOCAL="$HOME/.config/lineage/devnet"
SSH_OPTS=(-i "$SSH_KEY" -p "$SSH_PORT" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)
[ "${SSH_INSECURE_TEST:-0}" = 1 ] && SSH_OPTS+=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
SCP_OPTS=("${SSH_OPTS[@]/#-p/-P}")
r() { env -u LC_CTYPE -u LC_ALL ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }
say() { printf '\n== %s\n' "$*"; }
cd "$REPO"

# Settings left unset keep the server's current values (a deploy without them must not switch the
# runtime, authors, recipes or extra origins back to the defaults). KEEP_SITE_ENV=0 uses the defaults.
if [ "${KEEP_SITE_ENV:-1}" = 1 ] && [ "$DRY_RUN" != 1 ]; then
  CUR="$(r 'cat /etc/lineage/site.env 2>/dev/null' 2>/dev/null || true)"
  cur() { printf '%s\n' "$CUR" | sed -n "s/^$1=//p" | tail -1; }
  if [ -n "$CUR" ]; then
    : "${LINEAGE_RECIPES:=$(cur LINEAGE_RECIPES)}" "${AUTHORS:=$(cur AUTHORS)}"
    : "${WITH_RUNTIME:=$(cur WITH_RUNTIME)}" "${WITH_AUTHOR:=$(cur WITH_AUTHOR)}"
    if [ -z "${EXTRA_ORIGINS:-}" ]; then
      EXTRA_ORIGINS="$(cur GATE_ORIGINS | tr ',' '\n' | grep -vxF "$(printf 'https://%s\n' $(cur SITE_NAMES | tr ',' ' '))" | paste -sd, - || true)"
    fi
    echo "kept from the server's site.env where unset: recipes, authors, WITH_RUNTIME=${WITH_RUNTIME:-0}, WITH_AUTHOR=${WITH_AUTHOR:-0}, extra origins"
  fi
fi
LINEAGE_RECIPES="${LINEAGE_RECIPES:-fixture-b58,base58-py,minbpe}"
AUTHORS="${AUTHORS:-minbpe}"

if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SSLIP="${HOST//./-}.sslip.io"; else SSLIP=""; fi
if [ "$DRY_RUN" = 1 ]; then SITE_NAMES="${SITE_NAMES:-localhost}"; else SITE_NAMES="${SITE_NAMES:-$SSLIP${DOMAIN:+,$DOMAIN}}"; fi
SITE_NAMES="${SITE_NAMES#,}"
[ -n "$SITE_NAMES" ] || { echo "no site name: give the server's IPv4 address as <host>, or SITE_NAMES / DOMAIN" >&2; exit 2; }
ORIGINS="$(echo "$SITE_NAMES" | tr ',' '\n' | sed 's|^|https://|' | paste -sd, -)"
[ "$DRY_RUN" = 1 ] && [ -n "${DRY_RUN_ORIGIN:-}" ] && ORIGINS="$ORIGINS,$DRY_RUN_ORIGIN"
# other front ends that proxy to this site (e.g. Vercel rewrites forward the browser's Origin)
if [ -n "${EXTRA_ORIGINS:-}" ]; then
  echo "$EXTRA_ORIGINS" | tr ',' '\n' | grep -qvE '^https://[A-Za-z0-9.-]+$' && { echo "EXTRA_ORIGINS must be comma-separated https://host origins" >&2; exit 2; }
  ORIGINS="$ORIGINS,$EXTRA_ORIGINS"
fi
SHA="$(git rev-parse "${DEPLOY_REF:-HEAD}^{commit}")"
git merge-base --is-ancestor "$SHA" HEAD || { echo "DEPLOY_REF must be HEAD or one of its ancestors" >&2; exit 2; }

write_env() {
  r "install -d -m 755 /etc/lineage && (umask 077; cat > /etc/lineage/site.env) && chmod 600 /etc/lineage/site.env && chown root:root /etc/lineage/site.env" <<EOF
# written by scripts/deploy/deploy.sh; read by remote.sh and the lineage units
SITE_NAMES=$SITE_NAMES
GATE_ORIGINS=$ORIGINS
LINEAGE_RECIPES=$LINEAGE_RECIPES
DRY_RUN=$DRY_RUN
WITH_RUNTIME=${WITH_RUNTIME:-0}
WITH_AUTHOR=${WITH_AUTHOR:-0}
AUTHORS=$AUTHORS
# Core's public base URL (identity links name it in their proof text); LINEAGE_LINK_HTTP_HOSTS stays unset
LINEAGE_SITE_URL=https://${SITE_NAMES%%,*}
ACME_EMAIL=${ACME_EMAIL:-}
EOF
}

# The two server scripts are copied, then run (a script piped to `bash -s` can lose lines to any
# command in it that reads stdin).
put_tools() {
  r "install -d -m 700 /root/lineage-deploy"
  env -u LC_CTYPE -u LC_ALL scp -q "${SCP_OPTS[@]}" "$REPO/scripts/deploy/provision.sh" "$REPO/scripts/deploy/remote.sh" "$REPO/scripts/deploy/backup.sh" "$SSH_USER@$HOST:/root/lineage-deploy/"
}
do_provision() {
  say "provision $HOST"
  put_tools
  r "bash /root/lineage-deploy/provision.sh $([ "$DRY_RUN" = 1 ] && echo --no-docker) < /dev/null"
  write_env
}

do_ship() {
  say "ship $SHA as a git bundle of HEAD"
  if [ -n "$(git status --porcelain -- scripts/deploy)" ]; then echo "note: scripts/deploy has uncommitted changes; only HEAD ships"; fi
  local t; t="$(mktemp -d)"
  git bundle create -q "$t/lineage.bundle" HEAD
  echo "bundle $(du -h "$t/lineage.bundle" | cut -f1)"
  env -u LC_CTYPE -u LC_ALL scp -q "${SCP_OPTS[@]}" "$t/lineage.bundle" "$SSH_USER@$HOST:/opt/lineage/incoming.bundle"
  rm -rf "$t"
  write_env
  put_tools
  put_recipient
  r "bash /root/lineage-deploy/remote.sh install $SHA < /dev/null" | tee "${TMPDIR:-/tmp}/lineage-deploy-install.$$" | grep -v '^PUBKEYS '
  PUBKEYS="$(grep '^PUBKEYS ' "${TMPDIR:-/tmp}/lineage-deploy-install.$$" | sed 's/^PUBKEYS //')"
  rm -f "${TMPDIR:-/tmp}/lineage-deploy-install.$$"
  [ -n "$PUBKEYS" ] || { echo "install did not report the site's public keys" >&2; exit 1; }
  echo "site keys (public): $(echo "$PUBKEYS" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(Object.entries(j.site).map(([k,v])=>k+" "+v).join(", "))')"
}

pub_local() { bun "$REPO/scripts/deploy/site-keys.ts" pub "$1" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(Object.values(j)[0] ?? "")'; }
# pub_remote <path> [owner]: a relative path is under ~lineage/.config/lineage (owner lineage)
pub_remote() {
  local f="$1" o="${2:-lineage}"
  [[ "$f" = /* ]] || f="/home/lineage/.config/lineage/$f"
  r "if [ -f $f ]; then runuser -u $o -- env HOME=/tmp BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /usr/local/bin/bun /opt/lineage/releases/$SHA/scripts/deploy/site-keys.ts pub $f; else echo '{}'; fi" | bun -e 'const j=JSON.parse(await Bun.stdin.text()); console.log(Object.values(j)[0] ?? "")'
}
# put_key <local file> <remote path> <expected pubkey or empty> [owner]: a relative remote path is under
# ~lineage/.config/lineage; an absolute one belongs to a service user (remote.sh users_setup), e.g. the
# Core authority key in /etc/lineage-core (owner lineage-core) and the faucet in lineage-web's home
put_key() {
  local src="$1" dst="$2" want="$3" owner="${4:-lineage}" have there abs
  [ -f "$src" ] || { echo "missing $src" >&2; return 1; }
  have="$(pub_local "$src")"
  if [ -n "$want" ] && [ "$have" != "$want" ]; then echo "$src holds $have, expected $want; not copied" >&2; return 1; fi
  there="$(pub_remote "$dst" "$owner")"
  if [ "$there" = "$have" ]; then echo "key $dst: already on the server ($have)"; return 0; fi
  if [ -n "$there" ]; then echo "key $dst: the server holds a different key ($there); not replaced" >&2; return 1; fi
  abs="$dst"; [[ "$abs" = /* ]] || abs="/home/lineage/.config/lineage/$dst"
  r "umask 077; install -d -m 700 -o $owner -g $owner \$(dirname $abs); cat > $abs.tmp && chown $owner:$owner $abs.tmp && chmod 600 $abs.tmp && mv $abs.tmp $abs" < "$src"
  echo "key $dst: copied ($have)"
}
# put_secret <local file> <remote path>: env files with no public half; content never shown
put_secret() {
  [ -f "$1" ] || { echo "missing $1" >&2; return 1; }
  r "umask 077; cat > /home/lineage/.config/lineage/$2.tmp && chown lineage:lineage /home/lineage/.config/lineage/$2.tmp && chmod 600 /home/lineage/.config/lineage/$2.tmp && mv /home/lineage/.config/lineage/$2.tmp /home/lineage/.config/lineage/$2" < "$1"
  echo "secret $2: copied ($(wc -c < "$1" | tr -d ' ') bytes)"
}

do_keys() {
  if [ "$DRY_RUN" = 1 ]; then say "keys: dry run, nothing copied from this machine (Core reads the chain only, faucet off)"; return; fi
  say "keys"
  local dj="$REPO/scripts/devnet/devnet.json" ca rt
  ca="$(bun -e "console.log(JSON.parse(await Bun.file('$dj').text()).core_authority)")"
  rt="$(bun -e "console.log(JSON.parse(await Bun.file('$dj').text()).runtime_authority)")"
  # Core's and the faucet's keys go to their service users, never to lineage (audit OFF-D10)
  put_key "$KEYS_LOCAL/core-authority.json" /etc/lineage-core/core-authority.json "$ca" lineage-core
  put_key "$KEYS_LOCAL/faucet.json" /var/lib/lineage/web/.config/lineage/devnet/faucet.json "" lineage-web
  [ -f "$HOME/.config/lineage/rpc.env" ] && put_secret "$HOME/.config/lineage/rpc.env" rpc.env
  [ "${WITH_RUNTIME:-0}" = 1 ] && do_runtime_secrets
  if [ "${WITH_AUTHOR:-0}" = 1 ]; then
    local ma n; ma="$(bun -e "console.log(JSON.parse(await Bun.file('$dj').text()).agents.minbpe.agent)")"
    for n in ${AUTHORS//,/ }; do
      # minbpe's agent is the one scripts/devnet/setup.ts launched; the others site-authors.ts launched
      put_key "$KEYS_LOCAL/agent-$n.json" "devnet/agent-$n.json" "$([ "$n" = minbpe ] && echo "$ma")"
    done
  fi
}

# The hosted runtime's secrets (WITH_RUNTIME=1): the runtime authority key (checked against
# devnet.json's runtime_authority, which must equal LaunchConfig.runtime_authority on chain) and the
# model key file. Both land owned by lineage (the runtime's user), mode 600, in mode 700 directories;
# their content goes over ssh stdin and is never printed (only the public key and a byte count).
do_runtime_secrets() {
  [ "$DRY_RUN" = 1 ] && { echo "runtime secrets: dry run, nothing copied"; return; }
  local rt; rt="$(bun -e "console.log(JSON.parse(await Bun.file('$REPO/scripts/devnet/devnet.json').text()).runtime_authority)")"
  put_key "$KEYS_LOCAL/runtime-authority.json" devnet/runtime-authority.json "$rt"
  grep -qE '^[[:space:]]*ANTHROPIC_(API_KEY|AUTH_TOKEN)[[:space:]]*=' "$HOME/.config/lineage/model.env" || { echo "model.env holds no ANTHROPIC_API_KEY; not copied" >&2; return 1; }
  put_secret "$HOME/.config/lineage/model.env" model.env
  # other model providers and OpenRouter (plan MODELS-AND-SELF-FUNDING): providers.env when it holds any key;
  # the runtime re-reads it every minute, so a key added later only needs this copy (no restart, no code)
  if grep -qE '^[[:space:]]*[A-Z0-9_]+_(API_KEY|MANAGEMENT_KEY)[[:space:]]*=[[:space:]]*[^[:space:]]' "$HOME/.config/lineage/providers.env" 2>/dev/null; then
    put_secret "$HOME/.config/lineage/providers.env" providers.env
  else
    echo "providers.env holds no key; not copied (Anthropic only, from model.env)"
  fi
  # agent desktops' E2B overflow (SPEC 17.7): only when the file holds a key; without it E2B stays off
  if grep -qE '^[[:space:]]*E2B_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$HOME/.config/lineage/e2b.env" 2>/dev/null; then
    put_secret "$HOME/.config/lineage/e2b.env" e2b.env
  else
    echo "e2b.env holds no E2B_API_KEY; not copied (E2B desktops off)"
  fi
}

site_pub() { r "cat /var/lib/lineage/site/pubkeys.json" | bun -e "const j=JSON.parse(await Bun.stdin.text()); console.log(j.site['$1'])"; }

do_fund() {
  local owner verifiers plan=""
  owner="$(site_pub owner)"
  verifiers="$(site_pub verifier-ref),$(site_pub verifier-v1),$(site_pub verifier-v2)"
  [ "$DRY_RUN" = 1 ] && plan="--plan"
  say "fund (local, deployer key stays here)${plan:+: plan only}"
  bun "$REPO/scripts/deploy/fund-site.ts" --owner "$owner" --verifiers "$verifiers" $plan
  say "chain: register and bond the site's verifiers (on the server)${plan:+: plan only}"
  r "bash /opt/lineage/releases/$SHA/scripts/deploy/remote.sh chain $SHA $([ -n "$plan" ] && echo plan) < /dev/null"
  if [ -z "$plan" ]; then
    # site-chain.ts transactions, appended to the local record
    local md="$REPO/scripts/deploy/SITE-DEVNET.md"
    r "cat /var/lib/lineage/site/tx-log.jsonl 2>/dev/null || true" | while read -r l; do
      sig="$(echo "$l" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).signature)')"
      [ -f "$md" ] && grep -q "$sig" "$md" && continue
      echo "$l" | bun -e "const j=JSON.parse(await Bun.stdin.text()); const fs=require('fs'); const md='$md'; if(!fs.existsSync(md)) fs.writeFileSync(md,'# Site devnet transactions\n\nEvery devnet transaction the site deploy kit sent (scripts/deploy/fund-site.ts locally, scripts/deploy/site-chain.ts on the server). Fee in lamports as returned by the RPC.\n\n| When (UTC) | Step | What | Fee | Signature |\n|---|---|---|---|---|\n'); fs.appendFileSync(md, '| '+j.at.replace('T',' ').slice(0,19)+' | server | '+j.what+' | '+(j.fee??'?')+' | \`'+j.signature+'\` |\n')"
    done
  fi
}

do_activate() {
  say "activate $SHA"
  # the public units restart one by one (health-checked, rollback on a failure); background units drain
  # without holding them, and activate waits at most DEPLOY_DRAIN_WAIT s for them (docs/DEPLOY-SITE.md
  # "Zero-downtime activate")
  r "DRAIN_WAIT=${DEPLOY_DRAIN_WAIT:-120} HEALTH_WAIT=${DEPLOY_HEALTH_WAIT:-90} bash /opt/lineage/releases/$SHA/scripts/deploy/remote.sh activate $SHA"
  say "health"
  local ok=0
  for i in $(seq 1 60); do
    if r "curl -fsS -m 5 http://127.0.0.1:9660/v1/health >/dev/null && curl -fsS -m 5 http://127.0.0.1:9662/gate/health >/dev/null"; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "Core or the gate did not come up; journalctl -u lineage-core -u lineage-gate on the server" >&2; exit 1; }
  local first="${SITE_NAMES%%,*}"
  if [ "$DRY_RUN" = 1 ]; then
    r "curl -fsS -m 10 --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt https://$first/v1/health" && echo
  else
    for i in $(seq 1 30); do curl -fsS -m 10 "https://$first/v1/health" && { echo; break; }; sleep 5; done || true
  fi
  echo "site: $(echo "$SITE_NAMES" | tr ',' '\n' | sed 's|^|https://|' | paste -sd' ' -)"
  draining_now
}
# draining_now: the background units still finishing their work on the old release (each starts on the
# new one by itself when its old process exits; systemd's TimeoutStopSec bounds the wait)
draining_now() {
  local d
  d="$(r 'for u in $(systemctl list-units --all --plain --no-legend "lineage-*" | awk "{print \$1}"); do [ "$(systemctl is-active "$u")" = deactivating ] && printf "%s since %s (stop timeout %s)\n" "${u%.service}" "$(systemctl show -p StateChangeTimestamp --value "$u")" "$(systemctl show -p TimeoutStopUSec --value "$u")"; done; true' 2>/dev/null || true)"
  if [ -n "$d" ]; then echo "still draining (they start on $(echo "${SHA:-the new release}" | cut -c1-7) when done):"; printf '%s\n' "$d" | sed 's/^/  /'
  else echo "still draining: none"; fi
}

# Off-machine copies (docs/DEPLOY-SITE.md "Backups"). Core snapshots hold unrevealed epoch secrets and
# the secrets+state parts hold signing keys (encrypted): the directory is mode 700 and nothing is printed
# from them.
BACKUP_KEY="${BACKUP_AGE_KEY:-$HOME/.config/lineage/backup-age.key}"
BACKUP_LOCAL="${BACKUP_DIR:-$HOME/.lineage/site-backups/$HOST}"

# The public half of the owner's age identity, to the server (the private half never leaves here).
put_recipient() {
  local rc have
  if [ -n "${BACKUP_RECIPIENT:-}" ]; then rc="$BACKUP_RECIPIENT"
  elif [ -f "$BACKUP_KEY" ] && command -v age-keygen >/dev/null; then rc="$(age-keygen -y "$BACKUP_KEY")"
  else echo "backup recipient: no $BACKUP_KEY here (or no age-keygen); secrets+state snapshots stay off"; return 0; fi
  [[ "$rc" =~ ^age1[0-9a-z]{58}$ ]] || { echo "backup recipient: not an age public key; not copied" >&2; return 1; }
  have="$(r 'cat /etc/lineage/backup-recipient.txt 2>/dev/null' || true)"
  if [ "$have" = "$rc" ]; then echo "backup recipient: already on the server (${rc:0:12}...)"; return 0; fi
  if [ -n "$have" ] && [ "${BACKUP_RECIPIENT_REPLACE:-0}" != 1 ]; then
    echo "backup recipient: the server holds a different one (${have:0:12}...); kept (BACKUP_RECIPIENT_REPLACE=1 replaces it)" >&2; return 0
  fi
  r "install -d -m 755 /etc/lineage && printf '%s\n' '$rc' > /etc/lineage/backup-recipient.txt.tmp && chmod 644 /etc/lineage/backup-recipient.txt.tmp && mv /etc/lineage/backup-recipient.txt.tmp /etc/lineage/backup-recipient.txt"
  echo "backup recipient: copied (${rc:0:12}...)"
}

# pull_newest <remote dir> <name glob>: the newest matching file and its .sha256 into BACKUP_LOCAL (kept
# when already here, mtime preserved); sets PULLED to the local path, empty when the server has none
pull_newest() {
  local f
  PULLED=""
  f="$(r "ls -1t $1/$2 2>/dev/null | head -1" || true)"
  [ -n "$f" ] || return 0
  PULLED="$BACKUP_LOCAL/$(basename "$f")"
  if [ -f "$PULLED" ]; then echo "already here: $(basename "$f")"
  else
    env -u LC_CTYPE -u LC_ALL scp -q -p "${SCP_OPTS[@]}" "$SSH_USER@$HOST:$f" "$SSH_USER@$HOST:$f.sha256" "$BACKUP_LOCAL/"
    chmod 600 "$PULLED" "$PULLED.sha256"
    echo "copied $(basename "$f") ($(du -h "$PULLED" | cut -f1)) to $BACKUP_LOCAL"
  fi
}

# prune <name glob>: retention for one kind; the newest copy always stays
prune() {
  local list
  list="$(ls -1t "$BACKUP_LOCAL"/$1 2>/dev/null | tail -n +2 || true)"
  [ -n "$list" ] || return 0
  if [ -n "${BACKUP_KEEP_DAYS:-}" ]; then
    echo "$list" | while read -r old; do
      if [ -n "$(find "$old" -mtime +"$BACKUP_KEEP_DAYS" 2>/dev/null)" ]; then rm -f "$old" "$old.sha256"; fi
    done
  else
    echo "$list" | tail -n +"${BACKUP_KEEP:-3}" | while read -r old; do rm -f "$old" "$old.sha256"; done
  fi
  return 0
}

verify_secrets() { # verify_secrets <file> [facts out]
  if [ -f "$BACKUP_KEY" ]; then
    bash "$REPO/scripts/deploy/backup.sh" verify-secrets "$1" --identity "$BACKUP_KEY" ${2:+--facts "$2"}
  else
    local h; h="$(shasum -a 256 "$1" | cut -c1-64)"
    [ "$h" = "$(cat "$1.sha256")" ] || { echo "sha256 mismatch for $1" >&2; return 1; }
    echo "checksum ok for $(basename "$1"); not decrypted (no $BACKUP_KEY here)"
  fi
}

do_backup_pull() {
  local f size free rc=0 p n
  f="$(r "ls -1t /var/lib/lineage/core-backups/core-*.tar.zst 2>/dev/null | head -1")"
  [ -n "$f" ] || { echo "no snapshot on the server yet (lineage-backup.timer runs hourly; 'remote.sh backup' makes one now)" >&2; exit 1; }
  size="$(r "stat -c %s $f")"
  install -d -m 700 "$BACKUP_LOCAL"
  free="$(df -Pk "$BACKUP_LOCAL" | awk 'NR==2 {printf "%d", $4 * 1024}')"
  # the copy, plus the verify step's temporary extract (the database is several times the archive)
  if [ "$free" -lt $((size * 10 + 2 * 1024 * 1024 * 1024)) ]; then echo "not enough free disk here for $(basename "$f") ($size bytes)" >&2; exit 1; fi
  say "Core snapshot"
  pull_newest /var/lib/lineage/core-backups 'core-*.tar.zst'
  bash "$REPO/scripts/deploy/backup.sh" verify "$PULLED" || rc=1
  prune 'core-*.tar.zst'
  for p in state identity; do
    say "secrets+state: $p"
    pull_newest "/var/lib/lineage/$p-backups" "$p-*.tar.zst.age"
    if [ -z "$PULLED" ]; then
      if r "test -s /etc/lineage/backup-recipient.txt"; then echo "no $p snapshot on the server yet" >&2; rc=1
      else echo "the server has no backup recipient: no $p snapshots (deploy.sh <host> code copies it)"; fi
      continue
    fi
    verify_secrets "$PULLED" || rc=1
    prune "$p-*.tar.zst.age"
  done
  say "kept in $BACKUP_LOCAL"
  for p in core state identity; do
    n="$(ls -1 "$BACKUP_LOCAL"/$p-*.tar.zst* 2>/dev/null | grep -v '\.sha256$' | wc -l | tr -d ' ')"
    echo "$p: $n snapshot(s), $(du -ch $(ls -1 "$BACKUP_LOCAL"/$p-*.tar.zst* 2>/dev/null | grep -v '\.sha256$') /dev/null 2>/dev/null | tail -1 | cut -f1)"
  done
  return $rc
}

# restore-test, local half: the newest secrets+state parts decrypt here, and the keys in them equal the
# live ones by public key (the identity part: the same key file by sha256, every record authenticates)
do_secrets_proof() {
  local p t rc=0
  [ -f "$BACKUP_KEY" ] || { echo "no $BACKUP_KEY here: the secrets+state parts cannot be decrypted (keep that file safe)" >&2; return 1; }
  install -d -m 700 "$BACKUP_LOCAL"
  t="$(mktemp -d)"; chmod 700 "$t"
  for p in state identity; do
    say "secrets+state restore proof: $p"
    pull_newest "/var/lib/lineage/$p-backups" "$p-*.tar.zst.age"
    [ -n "$PULLED" ] || { echo "FAIL no $p snapshot on the server"; rc=1; continue; }
    if ! verify_secrets "$PULLED" "$t/snap-$p.json"; then rc=1; continue; fi
    r "bash /opt/lineage/current/scripts/deploy/remote.sh secrets-facts $p" > "$t/live-$p.json" || { echo "FAIL could not read the live $p facts"; rc=1; continue; }
    bun "$REPO/scripts/deploy/backup-facts.ts" compare "$t/snap-$p.json" "$t/live-$p.json" || rc=1
  done
  rm -rf "$t"
  echo "secrets+state restore proof: $([ $rc = 0 ] && echo PASS || echo FAIL)"
  return $rc
}

# disaster recovery: decrypt here, send each part's files over ssh to remote.sh restore-secrets
do_restore_secrets() {
  local p f t rc=0
  [ -f "$BACKUP_KEY" ] || { echo "no $BACKUP_KEY here: nothing can be decrypted" >&2; exit 1; }
  put_tools
  for p in ${RESTORE_PARTS:-state identity}; do
    if [ "$p" = state ]; then f="${EXTRA:-}"; else f="${4:-}"; fi
    [ -n "$f" ] || f="$(ls -1t "$BACKUP_LOCAL"/$p-*.tar.zst.age 2>/dev/null | head -1)"
    [ -f "$f" ] || { echo "no local $p snapshot in $BACKUP_LOCAL" >&2; rc=1; continue; }
    say "restore $p from $(basename "$f")"
    t="$(mktemp -d)"; chmod 700 "$t"; rmdir "$t"
    bash "$REPO/scripts/deploy/backup.sh" extract-secrets "$f" "$t" --identity "$BACKUP_KEY" >/dev/null
    COPYFILE_DISABLE=1 tar -C "$t" -cf - . | r "bash /root/lineage-deploy/remote.sh restore-secrets $p $([ "${RESTORE_REPLACE:-0}" = 1 ] && echo --replace) ${RESTORE_ROOT:+--root $RESTORE_ROOT}" || rc=1
    rm -rf "$t"
  done
  return $rc
}

do_restore_core() {
  local f="${EXTRA:-}"
  [ -n "$f" ] || f="$(ls -1t "$BACKUP_LOCAL"/core-*.tar.zst 2>/dev/null | head -1)"
  [ -f "$f" ] || { echo "no local Core snapshot in $BACKUP_LOCAL" >&2; exit 1; }
  bash "$REPO/scripts/deploy/backup.sh" verify "$f"
  put_tools
  r "install -d -m 0750 /var/lib/lineage/core-backups"
  env -u LC_CTYPE -u LC_ALL scp -q -p "${SCP_OPTS[@]}" "$f" "$f.sha256" "$SSH_USER@$HOST:/var/lib/lineage/core-backups/"
  r "chmod 600 /var/lib/lineage/core-backups/$(basename "$f")*; bash /root/lineage-deploy/remote.sh restore /var/lib/lineage/core-backups/$(basename "$f") < /dev/null"
}

case "$MODE" in
  full)
    do_provision; do_ship; do_keys; do_fund; do_activate
    [ "$DRY_RUN" = 1 ] || echo "lineages are being calibrated by lineage-bootstrap (minutes per recipe): scripts/deploy/deploy.sh $HOST status" ;;
  provision) do_provision ;;
  code) do_ship; [ "${WITH_RUNTIME:-0}" = 1 ] && { say "runtime secrets"; do_runtime_secrets; }; do_activate ;;
  keys) do_ship; do_keys ;;
  fund) do_fund ;;
  status) r "bash /opt/lineage/current/scripts/deploy/remote.sh status" ;;
  rollback) r "bash /opt/lineage/current/scripts/deploy/remote.sh rollback $EXTRA" ;;
  stop|start|wipe-keys|monitor) r "bash /opt/lineage/current/scripts/deploy/remote.sh $MODE" ;;
  restore-test)
    rt=0
    r "bash /opt/lineage/current/scripts/deploy/remote.sh restore-test $EXTRA" || rt=1
    do_secrets_proof || rt=1
    exit $rt ;;
  backup) do_backup_pull ;;
  restore-secrets) do_restore_secrets "$@" ;;
  restore-core) do_restore_core ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
