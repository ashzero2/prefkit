import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureOpenCodeWorkerViaCli,
  injectOpenCodePreferenceContextViaCli,
  queueOpenCodeLearnerEventViaCli,
} from "../src/bridge.js";

describe("OpenCode Node context bridge", () => {
  it("runs a configured CLI and appends its bounded context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-bridge-"));
    const command = join(cwd, "prefkit-context.sh");
    writeFileSync(command, "#!/bin/sh\nprintf '%s' 'Relevant user preferences:\\n- Prefer pnpm.'\n", { mode: 0o700 });
    const output = { system: [] as string[] };

    await injectOpenCodePreferenceContextViaCli({
      output,
      cwd,
      options: { prefkitCommand: command },
      event: {
        agent: "build",
        messages: [{ role: "user", content: "How should I install dependencies?" }],
      },
    });

    expect(output.system.join("\n")).toContain("Prefer pnpm");
  });

  it("keeps injected context in the existing system message", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-bridge-"));
    const command = join(cwd, "prefkit-context.sh");
    writeFileSync(command, "#!/bin/sh\nprintf '%s' 'Relevant user preferences:\\n- Prefer concise updates.'\n", {
      mode: 0o700,
    });
    const output = { system: ["OpenCode base instructions"] };

    await injectOpenCodePreferenceContextViaCli({
      output,
      cwd,
      options: { prefkitCommand: command },
      event: {
        messages: [{ role: "user", content: "How should I communicate status?" }],
      },
    });

    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toBe(
      "OpenCode base instructions\n\nRelevant user preferences:\\n- Prefer concise updates.",
    );
  });

  it("reports an unavailable CLI without mutating output", async () => {
    const output = { system: [] as string[] };

    await expect(
      injectOpenCodePreferenceContextViaCli({
        output,
        cwd: process.cwd(),
        options: { prefkitCommand: "/missing/prefkit" },
        event: { messages: [{ role: "user", content: "I need to name an app" }] },
      }),
    ).rejects.toThrow("CLI context lookup failed");
    expect(output.system).toEqual([]);
  });

  it("starts a detached worker after the queue accepts an event", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prefkit-opencode-worker-"));
    const command = join(cwd, "prefkit-test.sh");
    const marker = join(cwd, "worker-started");
    writeFileSync(
      command,
      `#!/bin/sh
if [ "$1" = "queue" ]; then
  cat >/dev/null
  printf '%s' 'queued=true path=test'
else
  printf '%s' 'started' > '${marker}'
fi
`,
    );
    chmodSync(command, 0o700);

    const options = { prefkitCommand: command, queueDir: join(cwd, "queue") };
    const queued = await queueOpenCodeLearnerEventViaCli({
      cwd,
      options,
      event: { messages: [{ role: "user", content: "Remember that I prefer concise updates." }] },
    });

    expect(queued).toBe(true);
    ensureOpenCodeWorkerViaCli({ cwd, options });
    await waitForFile(marker);
    expect(readFileSync(marker, "utf8")).toBe("started");
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
