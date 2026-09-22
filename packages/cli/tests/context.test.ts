import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..", "..", "..");
const mainEntry = join(root, "packages", "cli", "src", "main.ts");

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", mainEntry, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

describe("prefkit context", () => {
  it(
    "does not create the store when none exists",
    async () => {
      const storePath = join(mkdtempSync(join(tmpdir(), "prefkit-context-")), "prefs.db");

      const result = await runCli(["context", "--prompt", "name an app"], { PREFKIT_STORE: storePath });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(storePath)).toBe(false);
    },
    30000,
  );
});
