-- Apply explicitly with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
BEGIN;
CREATE TABLE IF NOT EXISTS transfers (
  id text PRIMARY KEY,
  upload_token_hash text NOT NULL,
  sender_email text NOT NULL,
  recipient_emails jsonb NOT NULL,
  company text NOT NULL DEFAULT '',
  title text NOT NULL,
  message text NOT NULL DEFAULT '',
  passcode_hash text,
  retention_days integer NOT NULL CHECK (retention_days IN (7, 14, 30)),
  part_size bigint NOT NULL,
  status text NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'completing', 'complete', 'deleting', 'deleted', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  email_status text NOT NULL DEFAULT 'pending'
    CHECK (email_status IN ('pending', 'sent', 'failed')),
  email_attempted_at timestamptz,
  email_results jsonb NOT NULL DEFAULT '{}',
  reminder_sent_at timestamptz,
  unlock_failures integer NOT NULL DEFAULT 0,
  unlock_window_at timestamptz,
  cleaned_at timestamptz
);
CREATE INDEX IF NOT EXISTS transfers_expiry_idx ON transfers (expires_at) WHERE cleaned_at IS NULL;
CREATE TABLE IF NOT EXISTS transfer_files (
  id text PRIMARY KEY,
  transfer_id text NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  name text NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  content_type text NOT NULL,
  object_key text NOT NULL UNIQUE,
  upload_id text,
  part_size bigint NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_parts jsonb NOT NULL DEFAULT '[]',
  UNIQUE (transfer_id, ordinal)
);
ALTER TABLE transfer_files ADD COLUMN IF NOT EXISTS azure_snapshot text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'upload' CHECK (purpose IN ('upload', 'proof'));
CREATE TABLE IF NOT EXISTS transfer_access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id text NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  event text NOT NULL,
  file_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transfer_events_idx ON transfer_access_events (transfer_id, occurred_at);
COMMIT;
