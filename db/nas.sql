BEGIN;
CREATE TABLE IF NOT EXISTS nas_mirrors (
  transfer_id text PRIMARY KEY REFERENCES transfers(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('syncing', 'available', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error text
);
CREATE INDEX IF NOT EXISTS nas_mirrors_status_idx ON nas_mirrors (status, updated_at);
COMMIT;
