-- ADR 0012: multiple encrypted model connections and explicit task autonomy.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS model_connections jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS default_model_connection text;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS autonomous_mode boolean NOT NULL DEFAULT false;
