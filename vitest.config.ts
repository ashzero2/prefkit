import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@prefkit/core": fromRoot("./packages/core/src/index.ts"),
      "@prefkit/mcp": fromRoot("./packages/mcp/src/server.ts"),
    },
  },
});
