ALTER TABLE radio_api_keys DROP CONSTRAINT IF EXISTS radio_api_keys_talkgroup_ids_check;

CREATE TABLE IF NOT EXISTS receiver_requests (
  id bigserial PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  path text NOT NULL,
  status_code integer NOT NULL,
  system_id text,
  talkgroup_id text,
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS receiver_requests_recent_idx ON receiver_requests(id DESC);
