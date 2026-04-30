import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "../../../src/mcp/server.js";
import { openLifecycle, createMemory, pinMemory } from "../../../src/lib/memory/lifecycle.js";

let tmp: string;
let repoKey: string;

async function makeClient(): Promise<any> {
    const server = createServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientTransport);
    return client;
}

beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-mcp-mem-"));
    process.env.AI_CORTEX_CACHE_HOME = tmp;
    repoKey = "test-mcp-memory";
});
afterEach(async () => {
    delete process.env.AI_CORTEX_CACHE_HOME;
    await fs.rm(tmp, { recursive: true, force: true });
});

describe("MCP memory read tools — registration", () => {
    it("registers recall_memory, get_memory, list_memories, search_memories, audit_memory", async () => {
        const client = await makeClient();
        const { tools } = await client.listTools();
        const names = tools.map((t: { name: string }) => t.name);
        expect(names).toContain("recall_memory");
        expect(names).toContain("get_memory");
        expect(names).toContain("list_memories");
        expect(names).toContain("search_memories");
        expect(names).toContain("audit_memory");
    });
});

describe("MCP list_memories", () => {
    it("returns empty array for fresh repo", async () => {
        const client = await makeClient();
        const result = await client.callTool({
            name: "list_memories",
            arguments: { repoKey },
        });
        const text = (result.content[0] as any).text;
        const parsed = JSON.parse(text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(0);
    });

    it("returns memories after creating one", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        try {
            await createMemory(lc, { type: "decision", title: "MCP test", body: "## Body\ntest", scope: { files: [], tags: [] }, source: "explicit" });
        } finally { lc.close(); }

        const client = await makeClient();
        const result = await client.callTool({
            name: "list_memories",
            arguments: { repoKey },
        });
        const items = JSON.parse((result.content[0] as any).text);
        expect(items.length).toBe(1);
        expect(items[0].title).toBe("MCP test");
    });
});

describe("MCP search_memories", () => {
    it("returns empty array when no memories match", async () => {
        const client = await makeClient();
        const result = await client.callTool({
            name: "search_memories",
            arguments: { repoKey, query: "nonexistent" },
        });
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(Array.isArray(parsed)).toBe(true);
    });
});

describe("MCP get_memory", () => {
    it("returns memory record for existing id", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        let id: string;
        try {
            id = await createMemory(lc, { type: "pattern", title: "Get test", body: "## Body\npattern", scope: { files: [], tags: [] }, source: "explicit" });
        } finally { lc.close(); }

        const client = await makeClient();
        const result = await client.callTool({
            name: "get_memory",
            arguments: { repoKey, id: id! },
        });
        const parsed = JSON.parse((result.content[0] as any).text);
        expect(parsed.frontmatter.id).toBe(id!);
    });

    it("returns isError for nonexistent id", async () => {
        const client = await makeClient();
        const result = await client.callTool({
            name: "get_memory",
            arguments: { repoKey, id: "nonexistent-id" },
        });
        expect(result.isError).toBe(true);
    });
});

describe("MCP audit_memory", () => {
    it("returns audit rows after creating a memory", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        let id: string;
        try {
            id = await createMemory(lc, { type: "decision", title: "Audit test", body: "## Body\naudit", scope: { files: [], tags: [] }, source: "explicit" });
        } finally { lc.close(); }

        const client = await makeClient();
        const result = await client.callTool({
            name: "audit_memory",
            arguments: { repoKey, id: id! },
        });
        const rows = JSON.parse((result.content[0] as any).text);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].changeType).toBe("create");
    });
});

describe("MCP memory write tools — registration", () => {
    it("registers all write tool names", async () => {
        const client = await makeClient();
        const { tools } = await client.listTools();
        const names = tools.map((t: { name: string }) => t.name);
        for (const name of [
            "record_memory", "update_memory", "update_scope", "deprecate_memory",
            "restore_memory", "merge_memories", "trash_memory", "untrash_memory",
            "purge_memory", "link_memories", "unlink_memories", "pin_memory",
            "unpin_memory", "confirm_memory", "add_evidence", "rebuild_index",
        ]) {
            expect(names).toContain(name);
        }
    });
});

describe("MCP record_memory", () => {
    it("creates a memory and returns its id", async () => {
        const client = await makeClient();
        const result = await client.callTool({
            name: "record_memory",
            arguments: {
                repoKey,
                type: "decision",
                title: "MCP write test",
                body: "## Decision\nuse MCP",
                scopeFiles: [],
                scopeTags: [],
                source: "explicit",
            },
        });
        expect(result.isError).toBeFalsy();
        const id = (result.content[0] as any).text.trim();
        expect(id).toMatch(/^mem-\d{4}-\d{2}-\d{2}-mcp-write-test-[0-9a-f]{6}$/);
    });
});

describe("MCP update_memory", () => {
    it("updates title and returns ok", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        let id: string;
        try {
            id = await createMemory(lc, { type: "decision", title: "Before", body: "## Body\nbefore", scope: { files: [], tags: [] }, source: "explicit" });
        } finally { lc.close(); }

        const client = await makeClient();
        const result = await client.callTool({
            name: "update_memory",
            arguments: { repoKey, id: id!, title: "After", reason: "test" },
        });
        expect(result.isError).toBeFalsy();
    });
});

describe("MCP trash_memory + untrash_memory", () => {
    it("trash then untrash cycle succeeds", async () => {
        const lc = await openLifecycle(repoKey, { agentId: "test" });
        let id: string;
        try {
            id = await createMemory(lc, { type: "decision", title: "Trash me", body: "## Body\ntrash", scope: { files: [], tags: [] }, source: "explicit" });
        } finally { lc.close(); }

        const client = await makeClient();
        const tr = await client.callTool({ name: "trash_memory", arguments: { repoKey, id: id!, reason: "test" } });
        expect(tr.isError).toBeFalsy();

        const ut = await client.callTool({ name: "untrash_memory", arguments: { repoKey, id: id! } });
        expect(ut.isError).toBeFalsy();
    });
});
