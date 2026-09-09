-- Public marketing inquiries are operator data, never customer-org data.
CREATE TABLE site_conversations (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  messages_enc bytea NOT NULL,
  dek_wrapped bytea NOT NULL,
  turns integer NOT NULL DEFAULT 0
);
REVOKE ALL ON site_conversations FROM kaddiya_app;
CREATE INDEX site_conversations_updated ON site_conversations(updated_at DESC);
