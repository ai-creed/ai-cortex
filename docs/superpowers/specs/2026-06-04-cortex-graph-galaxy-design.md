# cortex graph — Interactive Memory and Codebase Galaxy

**Status:** Design approved, pending spec review
**Date:** 2026-06-04
**Owner:** Vu Phan

## Goal

Ship `cortex graph`: a read-only, terminal-aesthetic "galaxy" that visualizes ai-cortex's
knowledge (memories) and indexed codebases as one interactive, pannable, zoomable graph in
the browser. Cross-project by default. The primary purpose is a showcase: the flat
"whole-repo galaxy" view is the screenshot that makes people want to try ai-cortex.

## Non-Goals (v1)

- Creating or editing `memory_links` from the UI (read-only viewer; link creation is a follow-up).
- Editing memories from the graph.
- Live file watching / live re-index while the viewer is open.
- Hosted or multi-user serving. The server is a local, ephemeral, single-user process.

## Key Constraints

- ai-cortex never writes into the target repository. The server reads only from `~/.cache/ai-cortex`.
- The graph builder is a pure, independently testable unit: SQLite in, `{nodes, edges}` out. No
  rendering or server concerns leak into it.
- The data and server layers are renderer-agnostic, so the WebGL frontend can be swapped later
  without touching them.

## Architecture

Three layers, each a separable unit with one responsibility:

```
SQLite stores ─► graph builder ─► graph server ─► WebGL galaxy (browser)
(~/.cache only)   {nodes,edges}    cortex graph    Cosmograph + CSS overlay
```

### Layer 1: Graph builder (pure)

Reads the per-project code index (`files`, `imports`, `functions`, `calls`) and the memory
store (`memories`, `memory_scope`, `memory_links`, plus the memory vector sidecar), and emits a
graph payload for a requested mode, scope, and level. Adaptive detail and edge derivation live
here.

Public interface:

```ts
type NodeKind = "project" | "dir" | "file" | "symbol" | "memory";

type GraphNode = {
  id: string;              // stable + store-namespaced. See "Node ID Namespacing".
                           // e.g. "project:<repoKey>", "file:<repoKey>:<path>",
                           //      "symbol:<repoKey>:<file>::<qualifiedName>",
                           //      "memory:<repoKey>:<id>", "memory:global:<id>"
  kind: NodeKind;
  label: string;
  cluster: string;         // project key (or dir) — drives color
  meta?: Record<string, unknown>; // path, line/col range, type, severity, status, etc.
};

type EdgeRel =
  | "imports"   // file -> file
  | "calls"     // symbol -> symbol
  | "contains"  // project -> dir -> file -> symbol
  | "link"      // explicit memory_links (supports/contradicts/refines/depends_on)
  | "scope"     // derived: memories sharing a tag/file
  | "semantic"  // derived: memory <-> memory cosine neighbor
  | "anchor";   // bridge: memory -> file/symbol via scope.files

type GraphEdge = {
  source: string;
  target: string;
  rel: EdgeRel;
  weight?: number;         // e.g. cosine for semantic, link rel_type carried in meta
  meta?: Record<string, unknown>;
};

type GraphPayload = {
  mode: "code" | "memory" | "bridge";
  scope: "all" | { project: string };
  level: "project" | "dir" | "file" | "symbol";
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type BuildOpts = {
  mode: "code" | "memory" | "bridge";
  scope: "all" | { project: string };
  focus?: string;          // node id to expand (drill-down)
  flat?: boolean;          // bypass aggregation: emit all file nodes at once
  semantic?: boolean;      // include derived semantic memory edges
  semanticTopK?: number;   // neighbors per memory (default 4)
  semanticThreshold?: number; // cosine floor (default 0.55)
};

function buildGraph(repoStores: RepoStores, opts: BuildOpts): GraphPayload;
```

#### Node ID Namespacing (cross-project safety)

Every node id MUST be namespaced by its origin store. This is load-bearing for the cross-project
default view, not a cosmetic choice.

Memory ids are only unique within a single store: they are generated with a 6-hex random suffix
(`src/lib/memory/id.ts`) and uniqueness is enforced per `MemoryIndex` at creation
(`src/lib/memory/lifecycle.ts`), never across stores. In an all-projects graph, two different
projects can legitimately hold the same raw memory id. Likewise, file paths and symbol keys repeat
across repos. Without a store prefix, the builder would merge distinct nodes and attach edges
(scope, semantic, anchor, link) to the wrong target.

The builder therefore prefixes every node id with the origin store key:

- Project-store nodes: `<kind>:<repoKey>:<localId>` (e.g. `memory:<repoKey>:<id>`,
  `file:<repoKey>:<path>`, `symbol:<repoKey>:<file>::<qualifiedName>`, `project:<repoKey>`).
- Global-tier memories: the literal `global` stands in for `repoKey`, giving `memory:global:<id>`.

Edges reference these fully-namespaced ids on both ends, so cross-project payloads cannot collide.
Bridge `anchor` edges connect a memory to a file/symbol in the same store (a memory's `scope.files`
point into its own repo), so both endpoints share one `repoKey`. The builder unit tests assert
that a fixture with two stores sharing a raw memory id produces two distinct namespaced nodes.

(The memory vector sidecar's internal `memory:<id>` entry key is a per-store storage detail and is
unaffected: vectors are loaded within a store, then the resulting node is namespaced on emit.)

### Layer 2: Graph server

`cortex graph` starts an ephemeral `localhost` HTTP server, serves the static frontend bundle
and a JSON data endpoint, opens the browser, and shuts down cleanly on Ctrl-C or process exit.

Endpoints:

- `GET /` serves the frontend bundle.
- `GET /graph?mode=&scope=&focus=&flat=&semantic=` returns a `GraphPayload`.
- `GET /node/:id` returns detail for a node (memory card fields, or file/symbol info).
- `GET /open?path=&line=` opens the file in `$EDITOR` (best-effort; no-op if unset).

The server reads from `~/.cache/ai-cortex` only. It discovers projects by enumerating repoKey
directories in the cache (the same store layout `rehydrate`/`stats` already use).

### Layer 3: WebGL frontend

- Cosmograph (`@cosmograph/cosmos`): GPU force simulation and additive-blend point rendering.
  Additive blending is the phosphor bloom, so the aesthetic and the performance come from the
  same place.
- A thin CSS/DOM overlay: faint grid, scanlines, a `$ cortex graph` prompt line with a blinking
  cursor, a control bar (mode, scope, filter, search), and a node-detail card.
- Fallback path noted for the plan: sigma.js v3 if a heavier interaction framework is needed.
  Not used in v1.

## Edge Providers

Composable functions, each `(stores, ctx) => GraphEdge[]`, so providers can be added without
touching the builder core.

- **Code:** `imports` (file to file), `calls` (symbol to symbol), `contains` (project to dir to
  file to symbol). Direct reads of existing tables; `calls` is the same relation `blast_radius`
  walks.
- **Explicit memory links:** `memory_links` typed edges. Zero exist today; rendered whenever
  present. The graph becomes a reason to start creating them.
- **Derived scope:** two memories sharing a `scope` tag or file get a light edge. This is what
  makes the memory-only graph connected on day one without anyone having linked anything.
- **Derived semantic (v1 toggle):** for each memory, compute cosine against other memory vectors
  (loaded once via the existing vector sidecar), keep the top-K neighbors above a threshold, emit
  `semantic` edges with the cosine as `weight`. Computed on the fly for the graph; nothing is
  persisted, so it stays read-only and avoids the O(n squared) persistence concern. Bounded to
  O(n times K) emitted edges.
- **Bridge anchor:** `memory.scope.files` resolves to the file or symbol node it names, emitting
  `anchor` edges. Same scope data doing double duty.

## Modes and Navigation

- **Three modes** (lens switch over the same canvas): code-only, memory-only, bridge (code with
  memory-stars woven in via `anchor` edges).
- **Drill-down navigation:** the top level is the cross-project memory galaxy (all projects plus
  `global`). Clicking a project drops into that repo's code or bridge view. A breadcrumb climbs
  back out. Mode is switchable at any level.
- **Semantic zoom:** scrolling swaps level of detail. The frontend requests a deeper `level`
  (via `focus`) as the user zooms into a cluster: constellations to nodes to symbols / memory text.

## Adaptive Detail (Fill Strategy)

Detail scales inversely with breadth so the canvas is full regardless of how many projects a
user has, and the flat spectacle is still available on demand:

- cross-project: `project` cluster nodes.
- one project, default: `dir` super-nodes; expanding a dir (focus) reveals its `file` nodes.
- one project, `--flat` / flat toggle: all `file` nodes at once (the 10k-file galaxy; WebGL
  handles it).
- one file (focus): its `symbol` nodes and `calls` edges.

Ambient polish: a faint decorative starfield fills genuinely empty margins (paint on top of the
real, substance-bearing fill above).

## CLI

```
cortex graph [--project <path>] [--mode code|memory|bridge] [--flat]
             [--semantic] [--export <file>] [--port <n>] [--no-open]
```

- Default: all projects, memory mode, browser opens.
- `--export <file>`: emit the `GraphPayload` as JSON and exit (no server). The building-block path
  for external tools.
- `--semantic`: include derived semantic memory edges.

## Aesthetic (locked during brainstorming)

- ANSI 16-color palette, one hue per cluster; amber `global` hub.
- Phosphor bloom via additive blending; faint grid and scanlines via CSS overlay; prompt line and
  blinking block cursor.
- Adaptive detail (B) as the engine, ambient starfield (A) as polish.

## File Structure

```
src/lib/graph/
  types.ts            # GraphNode, GraphEdge, GraphPayload, BuildOpts
  builder.ts          # buildGraph(): orchestrates level selection + providers
  aggregate.ts        # adaptive detail: project/dir rollup, flat bypass
  edges/
    code.ts           # imports, calls, contains
    memory.ts         # explicit links, derived scope
    semantic.ts       # derived semantic (cosine over memory vectors)
    bridge.ts         # anchor (memory -> file/symbol)
src/server/
  graph-server.ts     # ephemeral http server + endpoints
  discover.ts         # enumerate repoKey stores in ~/.cache
src/cli/
  graph.ts            # cortex graph command wiring
web/graph/            # frontend bundle source
  index.html
  main.ts             # Cosmograph setup, data fetch, mode/scope/zoom controls
  overlay.css         # grid, scanlines, prompt, control bar, node card
  terminal-theme.ts   # palette, glow params
```

## Testing

- **Builder unit tests** (fixture SQLite stores): one per mode, scope, and level; one per edge
  provider. Assert node/edge counts and ids for known fixtures.
- **Node ID namespacing:** two fixture stores sharing a raw memory id (and a repeated file path)
  produce two distinct, store-namespaced nodes with no collision, and edges attach to the correct
  per-store endpoints.
- **Semantic provider:** fixture with known vectors asserts top-K and threshold behavior, and that
  nothing is persisted.
- **Aggregation:** a 10k-file fixture asserts the default payload stays bounded (dir level) and
  that `--flat` returns the full file count.
- **Server:** endpoints return valid `GraphPayload`; a guard test asserts no writes occur outside
  `~/.cache`.
- **Frontend smoke:** the bundle mounts and fetches `/graph`. WebGL rendering output itself is not
  asserted (hard to assert meaningfully); logic is kept in testable non-render modules.

## Decomposition for Implementation

The implementation plan will sequence these as independently testable tasks:

1. `types.ts` and the builder skeleton with the `contains` + `imports` providers (code-only,
   project and file levels).
2. Aggregation (dir rollup, flat bypass) with the 10k-file fixture.
3. `calls` provider and symbol-level focus.
4. Memory providers: explicit links, derived scope; memory-only mode.
5. Semantic provider (cosine over the existing sidecar).
6. Bridge mode (anchor edges).
7. Graph server + discovery + endpoints.
8. CLI wiring, including `--export`.
9. Frontend: Cosmograph mount, data fetch, mode/scope switch, semantic zoom.
10. Aesthetic overlay: palette, bloom, grid, scanlines, starfield, prompt chrome.

## Open Questions Resolved During Brainstorming

- Surface: browser WebGL (not TUI). A symbol graph at repo scale is unviewable in a terminal.
- Renderer: Cosmograph, for GPU force layout and additive bloom.
- Memory edges: layered providers; semantic is a v1 toggle because memory bodies are already
  embedded.
- Scale: flat full-galaxy is a first-class feature (the showcase), so WebGL is required and
  aggregation is an option rather than a necessity.
- v1 is read-only.
```
