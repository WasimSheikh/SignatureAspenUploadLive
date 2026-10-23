-- Apply after db/schema.sql. Access identifiers are Entra oid claims, never email.
BEGIN;
CREATE TABLE IF NOT EXISTS employee_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  group_ids jsonb NOT NULL CHECK (jsonb_typeof(group_ids) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_sessions_expiry_idx ON employee_sessions (expires_at);
CREATE TABLE IF NOT EXISTS employee_login_states (
  state_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_login_states_expiry_idx ON employee_login_states (expires_at);
CREATE TABLE IF NOT EXISTS transfer_employee_access (
  transfer_id text NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  PRIMARY KEY (transfer_id, employee_id)
);
CREATE INDEX IF NOT EXISTS transfer_employee_access_employee_idx
  ON transfer_employee_access (employee_id, transfer_id);
COMMIT;
