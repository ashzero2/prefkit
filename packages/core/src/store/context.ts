import type { Database as DatabaseHandle } from "better-sqlite3";
import type { StoreConfig } from "../config/types.js";

export interface StoreContext {
  readonly db: DatabaseHandle;
  readonly config: StoreConfig;
  ensureSchema(): void;
}
