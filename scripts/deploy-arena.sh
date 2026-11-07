#!/usr/bin/env bash
# Dedicated Linux host deployment. Default mode only reads local files.
# Provision the dedicated account, unit, runtime, HTTPS vhost and DNS separately.
# A migration receipt is an operator attestation, not proof that another host is offline.
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: bash scripts/deploy-arena.sh ARCHIVE MANIFEST COMMIT NODE_BINARY MIGRATION_RECEIPT [--apply]

Run on the target Linux x64 host with Node.js 24.19.0 installed under
/opt/strategy-arena/. Default mode validates files and prints the proposed switch.
--apply requires root and changes only strategy-arena.service and /srv/strategy-arena.
It never provisions DNS, certificates, nginx, firewall rules, users or another project.

Before migration, stop every source paid entrypoint and take consistent SQLite
backups. Copy the existing application database and unique billing ledger to
/srv/strategy-arena/data/{arena,billing}.sqlite without creating a fresh ledger.
Create a private regular 0600 JSON receipt outside the release directory with
  sourcePaidEntrypointsStopped: true
  stoppedAt: ISO timestamp
  databaseSha256: SHA256 of the migrated, checkpointed arena.sqlite
  billingSha256: SHA256 of the migrated, checkpointed billing.sqlite
  environmentSha256: SHA256 of /etc/strategy-arena/arena.env
  unitSha256: SHA256 of /etc/systemd/system/strategy-arena.service
Hashes bind reviewed files. The operator must keep all source entrypoints stopped.
Both databases must have no nonempty WAL and the destination service must be stopped.
Every upgrade requires a new stopped-state receipt and a schema-compatible rollback.
USAGE
}
if [[ ${1:-} == --help ]]; then usage; exit 0; fi
if [[ $# -lt 5 || $# -gt 6 || ( $# -eq 6 && $6 != --apply ) ]]; then
  usage >&2; exit 2
fi
archive=$(realpath "$1")
manifest=$(realpath "$2")
commit=$3
node_bin=$(realpath "$4")
receipt=$(realpath "$5")
apply=${6:-}
root=/srv/strategy-arena
env_file=/etc/strategy-arena/arena.env
unit=/etc/systemd/system/strategy-arena.service
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ $apply == --apply ]]; then
  [[ $EUID -eq 0 ]] || { echo 'Apply requires root.' >&2; exit 1; }
  [[ -d $root && ! -L $root && $(realpath "$root") == "$root" ]] || { echo 'Create the dedicated project directory first.' >&2; exit 1; }
  [[ ! -L $root/deploy.lock && ( ! -e $root/deploy.lock || -f $root/deploy.lock ) ]] || { echo 'Deployment lock must be a regular file.' >&2; exit 1; }
  command -v flock >/dev/null
  exec 9>"$root/deploy.lock"
  flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
fi
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Target must be Linux x64.' >&2; exit 1; }
[[ $commit =~ ^[a-f0-9]{40}$ ]] || { echo 'A full approved commit is required.' >&2; exit 1; }
[[ $node_bin == /opt/strategy-arena/*/bin/node && -x $node_bin ]] || { echo 'Use the dedicated application Node binary.' >&2; exit 1; }
[[ $($node_bin --version) == v24.19.0 ]] || { echo 'Node.js 24.19.0 is required.' >&2; exit 1; }
for command in systemctl curl python3 flock runuser; do command -v "$command" >/dev/null; done
[[ $(systemctl show strategy-arena.service -p ActiveState --value) == inactive ]] || { echo 'Stop the destination strategy-arena service first.' >&2; exit 1; }
[[ -z $(systemctl show strategy-arena.service -p DropInPaths --value) ]] || { echo 'Review service drop-ins before deploying.' >&2; exit 1; }
[[ $(systemctl show strategy-arena.service -p NeedDaemonReload --value) == no ]] || { echo 'Load the reviewed systemd unit before deploying.' >&2; exit 1; }

# Nothing below executes or prints environment file values.
"$node_bin" --input-type=module - "$root" "$receipt" "$env_file" "$unit" "$node_bin" "$script_dir/deployment-unit.mjs" <<'JS'
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
const [root, receipt, env, unit, node, unitValidator] = process.argv.slice(2);
const { assertDeploymentUnit } = await import(unitValidator);
const fail = (message) => { throw new Error(message); };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
for (const directory of [root, root + '/data', '/etc/strategy-arena', root + '/releases', root + '/backups']) {
  if (!existsSync(directory) && [root + '/releases', root + '/backups'].includes(directory)) continue;
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
    fail('Deployment directories must be dedicated real directories.');
}
for (const path of [receipt, env, unit, root + '/data/arena.sqlite', root + '/data/billing.sqlite']) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Deployment inputs must be regular files.');
  if (path !== unit && (stat.mode & 0o777) !== 0o600) fail('Private deployment files require 0600 permissions.');
}
if (lstatSync(env).uid !== 0 || lstatSync(unit).uid !== 0) fail('Environment and unit must be root owned.');
const record = JSON.parse(readFileSync(receipt, 'utf8'));
if (record.sourcePaidEntrypointsStopped !== true || !Number.isFinite(Date.parse(record.stoppedAt)) || Date.parse(record.stoppedAt) > Date.now())
  fail('A dated source-stop attestation is required.');
for (const [key, path] of Object.entries({
  databaseSha256: root + '/data/arena.sqlite', billingSha256: root + '/data/billing.sqlite',
  environmentSha256: env, unitSha256: unit,
})) if (!/^[a-f0-9]{64}$/.test(record[key] ?? '') || record[key] !== hash(path))
  fail('A reviewed deployment input changed after the receipt was prepared.');
const unitText = readFileSync(unit, 'utf8');
assertDeploymentUnit(unitText, node);
for (const path of [root + '/data/arena.sqlite', root + '/data/billing.sqlite']) {
  for (const suffix of ['-wal', '-journal'])
    if (existsSync(path + suffix) && lstatSync(path + suffix).size) fail('Checkpoint stopped databases before preparing the migration receipt.');
  const db = new DatabaseSync('file:' + path + '?immutable=1', { readOnly: true });
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('SQLite integrity check failed.'); }
  finally { db.close(); }
}
const ledger = new DatabaseSync('file:' + root + '/data/billing.sqlite?immutable=1', { readOnly: true });
let settings;
try {
  settings = ledger.prepare('SELECT usd_limit_micros,request_limit,token_limit FROM billing_settings WHERE id=1').get();
  const audit = ledger.prepare('SELECT usd_limit_micros,request_limit,token_limit FROM billing_limit_audit ORDER BY revision DESC LIMIT 1').get();
  if (!settings || !audit || JSON.stringify(settings) !== JSON.stringify(audit)) fail('Existing audited billing limits are required.');
} finally { ledger.close(); }
// Parse configuration as data. Never source it or execute Node with its NODE_OPTIONS.
const configuration = parseEnv(readFileSync(env, 'utf8'));
if (configuration.NODE_OPTIONS || configuration.LD_PRELOAD ||
  (configuration.NODE_ENV && configuration.NODE_ENV !== 'production') ||
  (configuration.HOSTNAME && configuration.HOSTNAME !== '127.0.0.1') ||
  (configuration.PORT && configuration.PORT !== '3100') ||
  configuration.ARENA_DATABASE_PATH !== '/srv/strategy-arena/data/arena.sqlite' ||
  configuration.ARENA_BILLING_DATABASE_PATH !== '/srv/strategy-arena/data/billing.sqlite' ||
  configuration.ARENA_PUBLIC_ORIGIN !== 'https://arena.songyu00yo.fun' ||
  configuration.ARENA_PUBLIC_DEMO !== 'false' || configuration.ARENA_WORKER_ENABLED !== 'false' ||
  !(configuration.DEEPSEEK_API_KEY || configuration.MODEL_API_KEY)?.trim() ||
  !configuration.OPENAI_API_KEY?.trim() ||
  (configuration.ARENA_ACCESS_CODE?.trim().length ?? 0) < 20 ||
  (configuration.ARENA_SESSION_SECRET?.trim().length ?? 0) < 32 ||
  Number(configuration.ARENA_BILLING_USD_LIMIT) * 1000000 !== settings.usd_limit_micros ||
  Number(configuration.ARENA_BILLING_REQUEST_LIMIT) !== settings.request_limit ||
  Number(configuration.ARENA_BILLING_TOKEN_LIMIT) !== settings.token_limit)
  fail('Production authentication, origin, worker or audited billing configuration is invalid.');
JS
runuser -u strategy-arena -- test -r "$root/data/arena.sqlite"
runuser -u strategy-arena -- test -w "$root/data/arena.sqlite"
runuser -u strategy-arena -- test -r "$root/data/billing.sqlite"
runuser -u strategy-arena -- test -w "$root/data/billing.sqlite"
runuser -u strategy-arena -- test -w "$root/data"
runuser -u strategy-arena -- test -x "$root"
"$node_bin" "$script_dir/verify-release.mjs" "$manifest" "$archive" "$commit"
release="$root/releases/$commit"
[[ ! -e $release && ! -L $release ]] || { echo 'Release already exists. Do not overwrite it.' >&2; exit 1; }
previous=
if [[ -L $root/current ]]; then
  previous=$(realpath "$root/current")
  [[ $previous =~ ^/srv/strategy-arena/releases/[a-f0-9]{40}$ && -f $previous/server.js ]] || { echo 'Previous release is outside the project.' >&2; exit 1; }
elif [[ -e $root/current ]]; then echo 'Current must be a release symlink.' >&2; exit 1; fi
if [[ $apply != --apply ]]; then
  printf 'Dry run passed. Proposed release %s on 127.0.0.1:3100. No files or services changed.\n' "$commit"
  exit 0
fi
[[ ! -e $root/current.next && ! -L $root/current.next ]] || { echo 'Review stale current.next before deploying.' >&2; exit 1; }
backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$commit"
mkdir -p "$root/releases" "$backup"
chmod 0755 "$root/releases"
"$node_bin" --input-type=module - "$root/data" "$backup" <<'JS'
import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync } from 'node:fs';
const [source, destination] = process.argv.slice(2);
for (const name of ['arena.sqlite', 'billing.sqlite']) {
  const db = new DatabaseSync(source + '/' + name, { readOnly: true });
  try { await backup(db, destination + '/' + name); chmodSync(destination + '/' + name, 0o600); }
  finally { db.close(); }
}
JS
cp "$receipt" "$backup/migration-receipt.json"
switched=false
rollback() {
  local result=$?
  [[ $result -ne 0 ]] || result=1
  trap - ERR INT TERM
  systemctl stop strategy-arena.service || true
  if [[ $(systemctl show strategy-arena.service -p ActiveState --value) != inactive ]]; then
    echo 'Deployment failed and the service stop could not be confirmed. Inspect this service before changing links or restarting.' >&2
    exit "$result"
  fi
  if [[ $switched == true && -n $previous ]]; then
    ln -s "$previous" "$root/current.next"
    mv -Tf "$root/current.next" "$root/current"
  elif [[ $switched == true ]]; then rm -- "$root/current"; fi
  echo "Deployment failed. Service remains stopped. Consistent backups are in $backup. Review schema compatibility before restarting the previous release." >&2
  exit "${result:-1}"
}
trap rollback ERR INT TERM
mkdir -m 0755 "$release"
# Write ordinary files before creating links, including on older system Python.
python3 - "$archive" "$release" <<'PY'
import os, posixpath, shutil, sys, tarfile
from pathlib import Path, PurePosixPath
root = Path(sys.argv[2]).resolve()
def inside(path):
    return os.path.commonpath([root, path]) == str(root)
def member_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Unsafe archive path')
    return root.joinpath(*path.parts)
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    seen = set()
    for member in members:
        path = member_path(member.name)
        if path == root and member.isdir():
            continue
        if path in seen or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError('Duplicate path or unsupported archive member')
        seen.add(path)
        if member.isdir():
            path.mkdir(parents=True, exist_ok=True)
        elif member.isfile():
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, path.open('xb') as destination:
                shutil.copyfileobj(source, destination)
            path.chmod(member.mode & 0o777)
    # Hard links may reference later regular files, but never a symbolic link.
    pending = [member for member in members if member.islnk()]
    while pending:
        remaining = []
        for member in pending:
            path, target = member_path(member.name), member_path(member.linkname)
            if not target.is_file() or target.is_symlink():
                remaining.append(member)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            os.link(target, path, follow_symlinks=False)
        if len(remaining) == len(pending):
            raise ValueError('Unresolved archive hard link')
        pending = remaining
    links = [member for member in members if member.issym()]
    for member in links:
        path = member_path(member.name)
        if posixpath.isabs(member.linkname) or not inside(os.path.normpath(path.parent / member.linkname)):
            raise ValueError('Escaping archive symbolic link')
        path.parent.mkdir(parents=True, exist_ok=True)
        # Earlier links must never become parents of later link destinations.
        if any(parent.is_symlink() for parent in path.parents if parent != root):
            raise ValueError('Symbolic link parent in archive')
        path.symlink_to(member.linkname)
    for member in links:
        if not inside(os.path.realpath(member_path(member.name))):
            raise ValueError('Escaping archive link chain')
PY
[[ -f $release/server.js && -f $release/release-info.json ]]
"$node_bin" --input-type=module - "$script_dir/release-safety.mjs" "$release" <<'JS'
const { assertReleaseSafe } = await import(process.argv[2]);
assertReleaseSafe(process.argv[3]);
JS
cp "$manifest" "$release/manifest.json"
chmod -R a+rX,go-w "$release"
ln -s "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
switched=true
systemctl start strategy-arena.service
curl -q --noproxy '*' --fail --silent --retry 10 --retry-delay 1 --retry-connrefused --max-time 10 \
  http://127.0.0.1:3100/api/health | "$node_bin" -e '
let body=""; process.stdin.on("data", chunk => body+=chunk); process.stdin.on("end", () => {
try { const health=JSON.parse(body); if (health.status!=="ok" || health.commit!==process.argv[1] || health.requiresAccessCode!==true || health.accessGranted!==false) process.exitCode=1; }
catch { process.exitCode=1; }
});' "$commit"
trap - ERR INT TERM
echo "Loopback release/authentication check passed. Public HTTPS, identity isolation, desktop/mobile and real-model acceptance remain pending."
