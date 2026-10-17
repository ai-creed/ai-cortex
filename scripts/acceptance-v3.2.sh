#!/usr/bin/env bash
# Release gate for index contract v3.2: runs the consumer's section 11 checks
# against a real ai-14all worktree. Exits non-zero on any failed check.
set -euo pipefail

WT="${1:-}"
if [[ -z "$WT" || ! -d "$WT/.git" && ! -f "$WT/.git" ]]; then
  echo "usage: scripts/acceptance-v3.2.sh <path-to-ai-14all-worktree>" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/dist/src/cli.js"
SVC="electron/code-nav/cortex-index-service.ts"

# Always rebuild: a stale dist would let the gate certify code it never ran.
(cd "$ROOT" && pnpm build >/dev/null)

# All cache state (stores, sequence files) goes to a throwaway cache home so the
# gate never touches ~/.cache/ai-cortex; the disposable clone lives here too.
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
export AI_CORTEX_CACHE_HOME="$SCRATCH/cache"
mkdir -p "$AI_CORTEX_CACHE_HOME"

# Snapshot the real worktree, ignored paths included, before any step runs so the
# final check proves no step (indexing or the consumer probe) wrote into it.
WT_STATUS_BEFORE="$(git -C "$WT" status --porcelain --ignored=matching --untracked-files=all)"

echo "== index --refresh (1/2)"
ONE="$($CLI index --refresh --json "$WT")"
echo "== index --refresh (2/2)"
TWO="$($CLI index --refresh --json "$WT")"
DB="$(node -e 'console.log(JSON.parse(process.argv[1]).dbPath)' "$TWO")"
SEQ1="$(node -e 'console.log(JSON.parse(process.argv[1]).indexSeq)' "$ONE")"
SEQ2="$(node -e 'console.log(JSON.parse(process.argv[1]).indexSeq)' "$TWO")"

fail=0
check() { # name, expression (0/1 from sqlite or node)
  if [[ "$2" == "1" ]]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi
}
# Read-only scalar query through better-sqlite3. The sqlite3 CLI cannot open a
# WAL store read-only before its -shm file exists, and the gate must not write.
qdb() {
  node -e '
const Database=require(process.argv[1]+"/node_modules/better-sqlite3");const db=new Database(process.argv[2],{readonly:true});
const row=db.prepare(process.argv[3]).raw().get();db.close();console.log(row?String(row[0]):"")' "$ROOT" "$1" "$2"
}
q() { qdb "$DB" "$1"; }

check "consecutive index --refresh increments indexSeq ($SEQ1 -> $SEQ2)" "$(( SEQ2 == SEQ1 + 1 ? 1 : 0 ))"
check "symbols has interface rows" "$(q "SELECT count(*)>0 FROM symbols WHERE kind='interface'")"
check "WorktreeStatus name range on declaration line, after its start" "$(q "SELECT count(*)=1 FROM symbols WHERE file='$SVC' AND name='WorktreeStatus' AND name_line=line AND name_col>col")"
check "CortexIndexService.findDefinitions row shape" "$(q "SELECT count(*)>=1 FROM symbols m JOIN symbols c ON c.key=m.container_key WHERE m.file='$SVC' AND m.kind='method' AND m.name='findDefinitions' AND m.qualified_name='CortexIndexService.findDefinitions' AND c.qualified_name='CortexIndexService'")"
check "every functions row has a matching symbols row (key + declaration range)" "$(q "SELECT count(*)=0 FROM functions f LEFT JOIN symbols s ON s.key=f.file||'::'||f.qualified_name AND s.line=f.line AND s.col=f.col AND s.end_line=f.end_line AND s.end_col=f.end_col WHERE s.key IS NULL")"
check "refs has type rows" "$(q "SELECT count(*)>0 FROM refs WHERE kind='type'")"
# Resolution is measured over call/new/type/import refs whose name is defined as
# a symbol in the indexed repo. The raw metric over all such refs counts test
# globals, matchers, DOM helpers, array methods, and package types that the
# contract defines as unresolvable (externals stay NULL), so it measures the
# repo's test density rather than the resolver: on ai-14all the raw ceiling is
# about 32 percent even with a perfect resolver. The raw ratio is printed as info.
RAW_TOTAL="$(q "SELECT count(*) FROM refs WHERE kind IN ('call','new','type','import')")"
RAW_RESOLVED="$(q "SELECT count(*) FROM refs WHERE kind IN ('call','new','type','import') AND to_key IS NOT NULL")"
RAW_RATIO="$(node -e 'console.log((Number(process.argv[1])/Math.max(1,Number(process.argv[2]))*100).toFixed(1))' "$RAW_RESOLVED" "$RAW_TOTAL")"
echo "info  raw resolved refs (all call/new/type/import): $RAW_RESOLVED/$RAW_TOTAL = ${RAW_RATIO}%"
TOTAL="$(q "SELECT count(*) FROM refs WHERE kind IN ('call','new','type','import') AND name IN (SELECT DISTINCT name FROM symbols)")"
RESOLVED="$(q "SELECT count(*) FROM refs WHERE kind IN ('call','new','type','import') AND name IN (SELECT DISTINCT name FROM symbols) AND to_key IS NOT NULL")"
RATIO="$(node -e 'console.log((Number(process.argv[1])/Math.max(1,Number(process.argv[2]))*100).toFixed(1))' "$RESOLVED" "$TOTAL")"
check "resolved refs >= 50% of call/new/type/import refs naming repo-defined symbols ($RESOLVED/$TOTAL = ${RATIO}%)" "$(node -e 'const r=Number(process.argv[1]),t=Number(process.argv[2]);console.log(t>0&&r>=0.5*t?1:0)' "$RESOLVED" "$TOTAL")"
check "this.open(keys) in findDefinitions resolves in refs" "$(q "SELECT count(*)>=1 FROM refs WHERE kind='call' AND name='open' AND from_key='$SVC::CortexIndexService.findDefinitions' AND to_key='$SVC::CortexIndexService.open'")"
check "this.open(keys) in findDefinitions resolves in calls" "$(q "SELECT count(*)>=1 FROM calls WHERE from_key='$SVC::CortexIndexService.findDefinitions' AND to_key='$SVC::CortexIndexService.open'")"
check "navCapabilities parses and covers emitted kinds" "$(node -e '
const Database=require(process.argv[1]+"/node_modules/better-sqlite3");const db=new Database(process.argv[2],{readonly:true});
const caps=JSON.parse(db.prepare("SELECT value FROM meta WHERE key=\x27navCapabilities\x27").get().value);
const sk=db.prepare("SELECT DISTINCT kind FROM symbols").all().map(r=>r.kind);const rk=db.prepare("SELECT DISTINCT kind FROM refs").all().map(r=>r.kind);
console.log(caps.referencesTable==="refs"&&sk.every(k=>caps.symbolKinds.includes(k))&&rk.every(k=>caps.referenceKinds.includes(k))?1:0)' "$ROOT" "$DB")"

CALLS_TOTAL="$(q "SELECT count(*) FROM calls")"
CALLS_RESOLVED="$(q "SELECT count(*) FROM calls WHERE to_key NOT LIKE '::%'")"
echo "info  calls resolution: $CALLS_RESOLVED/$CALLS_TOTAL"

echo "== dirty-worktree reindex (in a disposable local clone; the real worktree is never written)"
CLONE="$SCRATCH/ai-14all-clone"
git clone -q --local --no-hardlinks "$WT" "$CLONE"
BASE_JSON="$($CLI index --refresh --json "$CLONE")"
# Edit a tracked file (the spec's "after editing a tracked file") and add an untracked one.
echo "// acceptance-v3.2 tracked edit" >> "$CLONE/$SVC"
echo "export const acceptanceTouch = 1;" > "$CLONE/.ai-cortex-acceptance-touch.ts"
DIRTY_JSON="$($CLI rehydrate --json "$CLONE")"
check "dirty reindex changes indexSeq and contentFingerprint while fingerprint stays" "$(node -e '
const a=JSON.parse(process.argv[1]),b=JSON.parse(process.argv[2]);
console.log(b.indexSeq>a.indexSeq&&b.contentFingerprint!==a.contentFingerprint&&b.fingerprint===a.fingerprint&&b.dirtyAtIndex===true?1:0)' "$BASE_JSON" "$DIRTY_JSON")"

echo "== consumer ingestion path: ai-14all ingestCortexStore over the 3.1 fixture and the fresh 3.2 store"
OLD="$ROOT/tests/fixtures/stores/v3.1-nav-acceptance.db"
[[ -x "$WT/node_modules/.bin/tsx" ]] || { echo "ai-14all worktree has no node_modules/.bin/tsx; run pnpm install there first" >&2; exit 2; }
INGEST="$(cd "$WT" && NODE_NO_WARNINGS=1 node_modules/.bin/tsx "$ROOT/scripts/consumer-ingest-probe.mts" "$OLD" "$DB")"
echo "info  consumer ingest: $INGEST"
check "3.1 fixture ingests through the consumer fallback (functions-only) with CortexIndexService.findDefinitions present" "$(node -e '
const r=JSON.parse(process.argv[1])[0]; console.log(!r.unavailable&&r.schemaVersion==="3.1"&&r.functionsCount>0&&r.hasFindDefinitions===true?1:0)' "$INGEST")"
check "fresh 3.2 store is accepted by the consumer ingest (schema gate admits 3.2)" "$(node -e '
const r=JSON.parse(process.argv[1])[1]; console.log(!r.unavailable&&r.schemaVersion==="3.2"&&r.functionsCount>0&&r.hasFindDefinitions===true?1:0)' "$INGEST")"
check "3.1 fixture has no navCapabilities (feature detection falls back)" "$(qdb "$OLD" "SELECT count(*)=0 FROM meta WHERE key='navCapabilities'")"

WT_STATUS_AFTER="$(git -C "$WT" status --porcelain --ignored=matching --untracked-files=all)"
check "real worktree unchanged across every step (git status --porcelain --ignored=matching --untracked-files=all matches the snapshot)" "$([[ "$WT_STATUS_BEFORE" == "$WT_STATUS_AFTER" ]] && echo 1 || echo 0)"

if [[ "$fail" -ne 0 ]]; then echo "acceptance-v3.2: FAILED"; exit 1; fi
echo "acceptance-v3.2: OK (resolved refs naming repo symbols ${RATIO}%, raw resolved refs ${RAW_RATIO}%, calls $CALLS_RESOLVED/$CALLS_TOTAL)"
