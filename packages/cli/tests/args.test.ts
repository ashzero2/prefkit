import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("collects positionals and repeated flags", () => {
    const args = parseArgs(["remember", "prefer", "pnpm", "--category", "tooling", "--tag", "a", "--tag", "b"]);

    expect(args.command).toBe("remember");
    expect(args.positionals).toEqual(["prefer", "pnpm"]);
    expect(args.flags.get("category")).toEqual(["tooling"]);
    expect(args.flags.get("tag")).toEqual(["a", "b"]);
  });

  it("supports --flag=value", () => {
    const args = parseArgs(["list", "--limit=5"]);

    expect(args.command).toBe("list");
    expect(args.flags.get("limit")).toEqual(["5"]);
  });

  it("accepts a value that starts with -- for a known value flag", () => {
    const args = parseArgs(["context", "--prompt", "--weird --text"]);

    expect(args.flags.get("prompt")).toEqual(["--weird --text"]);
  });

  it("does not consume the next token for boolean flags", () => {
    const args = parseArgs(["remember", "--reactivate", "prefer pnpm"]);

    expect(args.flags.get("reactivate")).toEqual(["true"]);
    expect(args.positionals).toEqual(["prefer pnpm"]);
  });

  it("treats everything after -- as positionals", () => {
    const args = parseArgs(["context", "--", "--not-a-flag"]);

    expect(args.command).toBe("context");
    expect(args.positionals).toEqual(["--not-a-flag"]);
  });

  it("captures an explicit config path", () => {
    const args = parseArgs(["--config", "custom.json", "list"]);

    expect(args.configPath).toBe("custom.json");
    expect(args.command).toBe("list");
  });
});
