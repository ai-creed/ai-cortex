# Configuration Reference

Use this page when you need to configure ai-cortex behavior without changing project files.

Most users do not need custom configuration. The defaults are designed for local, per-developer use.

## Configuration Surfaces

ai-cortex uses three configuration surfaces:

| Surface | Purpose |
|---|---|
| Environment variables | Runtime toggles and cache overrides |
| Memory config JSON | Memory aging, ranking, extraction, and injection policy |
| Agent config files | MCP registration and optional hooks |

Target repositories are not used for ai-cortex state.

## Environment Variables

| Variable | Purpose |
|---|---|
| `AI_CORTEX_CACHE_HOME` | Override the cache root. Default is `~/.cache/ai-cortex/`. Mostly useful for tests or isolated runs. |
| `AI_CORTEX_NO_UPDATE_CHECK` | Disable update and hook migration notices. |
| `AI_CORTEX_HISTORY` | Set `0` to disable session capture. Set `1` to force-enable it even if the disable flag exists. |
| `AI_CORTEX_HISTORY_RAW_DAYS` | Retention window for raw history chunks. Default `30`, clamped to `0..90`. |
| `AI_CORTEX_SESSION_ID` | Explicit current session id for harnesses or wrappers. Preferred over heuristic detection. |
| `AI_CORTEX_SURFACE` | Set `0` to disable edit-time memory surfacing. Capture hooks are unaffected. |

Test-only or developer-only variables:

| Variable | Purpose |
|---|---|
| `AI_CORTEX_SEMANTIC_INTEGRATION` | Enables semantic integration tests that download the embedding model. |

## Memory Config Files

Memory configuration is loaded in this order:

```text
defaults
  -> ~/.config/ai-cortex/config.json
  -> ~/.cache/ai-cortex/v1/<repo-key>/memory/config.json
```

Later layers override earlier layers.

The JSON shape is:

```json
{
  "memory": {
    "aging": {},
    "promotion": {},
    "extractor": {},
    "ranking": {},
    "injection": {}
  }
}
```

## Default Memory Config

Current defaults:

```json
{
  "memory": {
    "aging": {
      "candidateToTrashedDays": 90,
      "deprecatedToTrashedDays": 180,
      "mergedIntoToTrashedDays": 90,
      "trashedToPurgedDays": 90,
      "lowConfidenceThreshold": 0.4
    },
    "promotion": {
      "decision": { "reExtractionPromoteCount": 5 },
      "gotcha": { "reExtractionPromoteCount": 3 },
      "pattern": { "reExtractionPromoteCount": 2 },
      "how-to": { "reExtractionPromoteCount": 3 }
    },
    "extractor": {
      "dedupCosine": 0.85,
      "reExtractionMatchCosine": 0.92
    },
    "ranking": {
      "weights": {
        "semantic": 0.5,
        "scope": 0.3,
        "status": 0.1,
        "confidence": 0.05,
        "recency": 0.05,
        "source": 0.1,
        "link": 0.05,
        "typeMismatchPenalty": 0.2
      },
      "recencyHalfLifeDays": 60,
      "candidatePoolSize": 200,
      "topK": 10
    },
    "injection": {
      "pinnedHardCap": 20,
      "pinnedSoftWarn": 10,
      "autoInjectTopK": 5
    }
  }
}
```

## Common Overrides

Disable history capture for one command:

```bash
AI_CORTEX_HISTORY=0 ai-cortex rehydrate /path/to/repo
```

Disable edit-time surfacing:

```bash
AI_CORTEX_SURFACE=0
```

Use an isolated cache:

```bash
AI_CORTEX_CACHE_HOME=/tmp/ai-cortex-cache ai-cortex index /path/to/repo
```

Provide an explicit session id:

```bash
AI_CORTEX_SESSION_ID=session-123 ai-cortex history capture --session session-123
```

Override memory ranking globally:

```json
{
  "memory": {
    "ranking": {
      "topK": 5,
      "candidatePoolSize": 100
    }
  }
}
```

Put that in:

```text
~/.config/ai-cortex/config.json
```

## Agent Config Files

The MCP registration and hook installer affect user-level agent config files.

Common files:

| Agent | Config file |
|---|---|
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.toml` |

Register MCP manually through the agent command where possible:

```bash
claude mcp add -s user ai-cortex -- ai-cortex mcp
codex mcp add ai-cortex -- ai-cortex mcp
```

Install hooks:

```bash
ai-cortex history install-hooks
```

The hook installer creates timestamped backups before editing agent config files.

## Per-Command Flags

Common CLI flags:

| Flag | Purpose |
|---|---|
| `--json` | Machine-readable output where supported |
| `--cwd <path>` | Override working directory for some history and memory commands |
| `--repo-key <key>` | Override derived repo identity for some legacy CLI paths |
| `--stale` | Use existing cache without freshness checks on structural commands |

MCP tools generally prefer `path` or `worktreePath` over raw repo keys.

## Related Docs

- [Storage reference](./storage.md): where config-adjacent state lives.
- [Agent integration](../guides/integrate-with-agents.md): MCP registration and hooks.
- [CLI reference](./cli.md): command flags and command groups.
- [MCP tools](./mcp-tools.md): agent-facing parameters and usage.
