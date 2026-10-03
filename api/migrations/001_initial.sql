CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK (role IN ('Admin','Reviewer','Viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS talkgroups (
  id text PRIMARY KEY, label text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS radio_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  key_hash text UNIQUE NOT NULL, system_id text NOT NULL,
  talkgroup_ids text[] NOT NULL CHECK (cardinality(talkgroup_ids) > 0),
  enabled boolean NOT NULL DEFAULT true, created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, location text NOT NULL,
  path text NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text,
  talkgroup_id text NOT NULL REFERENCES talkgroups(id), event_type text NOT NULL DEFAULT 'dispatch',
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','draft','approved','rejected','publish_queued','published','publish_failed','publish_unknown','merged')),
  received_at timestamptz NOT NULL DEFAULT now(), original_path text, playable_path text,
  audio_token_hash text UNIQUE, transcript text,
  internal_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  public_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_id uuid REFERENCES images(id), source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  facebook_post_id text, publish_error text, created_by uuid REFERENCES users(id),
  merged_into uuid REFERENCES incidents(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_queue_idx ON incidents(status, received_at DESC);
CREATE INDEX IF NOT EXISTS incidents_talkgroup_idx ON incidents(talkgroup_id, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_external_id_idx ON incidents(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_dispatch_external_id_idx ON incidents((source_metadata->>'dispatchExternalId')) WHERE source_metadata ? 'dispatchExternalId';
CREATE UNIQUE INDEX IF NOT EXISTS incidents_facebook_post_idx ON incidents(facebook_post_id) WHERE facebook_post_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid NOT NULL REFERENCES incidents(id),
  user_id uuid NOT NULL REFERENCES users(id), public_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_incident_idx ON approvals(incident_id, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL,
  incident_id uuid REFERENCES incidents(id), details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_facebook_published_once_idx ON audit_log(incident_id) WHERE action='facebook.published';
CREATE TABLE IF NOT EXISTS publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), incident_id uuid NOT NULL UNIQUE REFERENCES incidents(id),
  status text NOT NULL DEFAULT 'queued', facebook_post_id text, error text, attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS radio_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), radio_key_id uuid NOT NULL REFERENCES radio_api_keys(id),
  external_id text UNIQUE NOT NULL, talkgroup_id text NOT NULL REFERENCES talkgroups(id),
  system_id text NOT NULL, received_at timestamptz NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','complete','failed')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS radio_upload_sessions_pending_idx ON radio_upload_sessions(status,expires_at);
CREATE TABLE IF NOT EXISTS background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_key text UNIQUE NOT NULL,
  job_type text NOT NULL CHECK (job_type IN ('process','publish')),
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','complete','failed')),
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 4,
  run_after timestamptz NOT NULL DEFAULT now(), last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS background_jobs_ready_idx ON background_jobs(status,run_after,created_at);
CREATE OR REPLACE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'History records are append-only';
END;
$$;
DROP TRIGGER IF EXISTS approvals_append_only ON approvals;
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();