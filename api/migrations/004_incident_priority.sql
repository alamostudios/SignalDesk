ALTER TABLE incidents ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'low'
  CHECK (priority IN ('high','medium','low'));

CREATE INDEX IF NOT EXISTS incidents_priority_idx ON incidents(priority,status,received_at DESC);
