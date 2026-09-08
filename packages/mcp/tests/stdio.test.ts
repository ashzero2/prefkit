import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createPreferenceStore, defaultConfig } from "@prefkit/core";

const root = resolve(__dirname, "..", "..", "..");
const serverEntry = join(root, "packages", "mcp", "src", "main.ts");

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function seedStore(path: string): void {
  const store = createPreferenceStore({ ...defaultConfig.store, path });
  store.init();
  try {
    store.remember({
      statement: "Prefer pnpm for JavaScript package management.",
      scopeType: "global",
      category: "tooling",
      evidence: { sourceType: "USER_EXPLICIT" },
    });
  } finally {
    store.close();
  }
}

function startServer(storePath: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: root,
    env: { ...process.env, PREFKIT_STORE: storePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("MCP stdio server", () => {
  it(
    "serves initialize, tools/list, and tool calls over newline-delimited JSON-RPC",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "prefkit-mcp-stdio-"));
      const storePath = join(dir, "prefs.db");
      seedStore(storePath);
      const child = startServer(storePath);

      const lines: string[] = [];
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim().length > 0) {
            lines.push(part);
          }
        }
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const send = (message: unknown) => {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      };
      const waitFor = async (id: number | string): Promise<JsonRpcResponse> => {
        const deadline = Date.now() + 15000;
        for (;;) {
          const index = lines.findIndex((line) => {
            try {
              return (JSON.parse(line) as JsonRpcResponse).id === id;
            } catch {
              return false;
            }
          });
          if (index !== -1) {
            return JSON.parse(lines.splice(index, 1)[0] as string) as JsonRpcResponse;
          }
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for response ${String(id)}; stderr: ${stderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };

      try {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "prefkit-smoke", version: "0.0.0" },
          },
        });
        const initialized = await waitFor(1);
        expect(initialized.error).toBeUndefined();
        expect(
          ((initialized.result?.serverInfo ?? {}) as { name?: string }).name,
        ).toBe("prefkit");

        send({ jsonrpc: "2.0", method: "notifications/initialized" });

        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const listed = await waitFor(2);
        const tools = (listed.result?.tools ?? []) as { name: string }[];
        expect(tools.map((tool) => tool.name).sort()).toEqual(
          [
            "prefkit_forget",
            "prefkit_list",
            "prefkit_pin",
            "prefkit_recall",
            "prefkit_remember",
            "prefkit_search",
            "prefkit_why",
          ].sort(),
        );

        send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "prefkit_recall",
            arguments: { task: "set up a JavaScript project" },
          },
        });
        const recalled = await waitFor(3);
        const content = (recalled.result?.content ?? []) as { type: string; text: string }[];
        expect(content[0]?.text).toMatch(/pnpm/);
        expect(recalled.result).toHaveProperty("structuredContent");

        send({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "prefkit_forget", arguments: { id: "pref_missing" } },
        });
        const forgotten = await waitFor(4);
        expect(forgotten.result).toHaveProperty("isError", true);
        const errorText = ((forgotten.result?.content ?? []) as { text: string }[])[0]?.text ?? "";
        expect(errorText).toMatch(/prefkit_(list|search)/);

        // Every stdout line must be valid JSON-RPC (no log pollution).
        for (const line of lines) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    60000,
  );
});
