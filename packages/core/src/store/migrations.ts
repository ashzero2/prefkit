export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial-preferences-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS preferences (
        id TEXT PRIMARY KEY,
        statement TEXT NOT NULL,
        normalized_statement TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'repository', 'path', 'task', 'agent')),
        scope_value TEXT,
        category TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'pinned', 'suppressed', 'superseded', 'rejected')),
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT,
        supersedes_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (supersedes_id) REFERENCES preferences(id)
      );

      CREATE INDEX IF NOT EXISTS idx_preferences_status_updated ON preferences(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_preferences_scope ON preferences(scope_type, scope_value);
      CREATE INDEX IF NOT EXISTS idx_preferences_category ON preferences(category);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        session_id TEXT,
        agent TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('USER_EXPLICIT', 'MODEL_EXTRACTED', 'AGENT_EVENT', 'IMPORT')),
        polarity TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'neutral')),
        weight REAL NOT NULL CHECK (weight >= 0),
        summary TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (preference_id) REFERENCES preferences(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_preference_created ON evidence(preference_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_hash ON evidence(evidence_hash);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        agent TEXT NOT NULL,
        event_type TEXT NOT NULL,
        cwd TEXT,
        prompt_hash TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_created ON events(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS preferences_fts USING fts5(
        statement,
        category,
        tags,
        content='preferences',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS preferences_ai AFTER INSERT ON preferences BEGIN
        INSERT INTO preferences_fts(rowid, statement, category, tags)
        VALUES (new.rowid, new.statement, new.category, new.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS preferences_ad AFTER DELETE ON preferences BEGIN
        INSERT INTO preferences_fts(preferences_fts, rowid, statement, category, tags)
        VALUES ('delete', old.rowid, old.statement, old.category, old.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS preferences_au AFTER UPDATE ON preferences BEGIN
        INSERT INTO preferences_fts(preferences_fts, rowid, statement, category, tags)
        VALUES ('delete', old.rowid, old.statement, old.category, old.tags_json);
        INSERT INTO preferences_fts(rowid, statement, category, tags)
        VALUES (new.rowid, new.statement, new.category, new.tags_json);
      END;
    `,
  },
];
