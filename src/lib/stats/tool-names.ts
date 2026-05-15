// src/lib/stats/tool-names.ts
//
// Canonical names of every tool the ai-cortex MCP server registers in
// src/mcp/server.ts. Used by the stats backfill to filter session-history
// evidence (which logs every tool the agent called, including Claude
// Code's built-ins like Read/Edit/Bash) down to just ai-cortex MCP calls.
//
// Keep this in lockstep with server.tool(...) / server.registerTool(...)
// call sites. Verify count: 33.

export const AI_CORTEX_TOOL_NAMES: ReadonlySet<string> = new Set([
	"rehydrate_project",
	"suggest_files",
	"suggest_files_deep",
	"suggest_files_semantic",
	"index_project",
	"blast_radius",
	"search_history",
	"recall_memory",
	"get_memory",
	"list_memories",
	"search_memories",
	"audit_memory",
	"record_memory",
	"update_memory",
	"update_scope",
	"deprecate_memory",
	"restore_memory",
	"merge_memories",
	"trash_memory",
	"untrash_memory",
	"purge_memory",
	"link_memories",
	"unlink_memories",
	"pin_memory",
	"unpin_memory",
	"confirm_memory",
	"add_evidence",
	"rebuild_index",
	"sweep_aging",
	"promote_to_global",
	"extract_session",
	"list_memories_pending_rewrite",
	"rewrite_memory",
]);

export function isCortexTool(name: string): boolean {
	return AI_CORTEX_TOOL_NAMES.has(name);
}
