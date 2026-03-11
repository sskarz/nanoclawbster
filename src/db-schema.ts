/**
 * Shared registered_groups table schema.
 * Used by both src/db.ts (full app) and setup/wizard.ts (setup before app is built).
 */

export const REGISTERED_GROUPS_SCHEMA = `CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1,
  is_admin INTEGER DEFAULT 0
)`;
