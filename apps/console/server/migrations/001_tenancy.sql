-- ADR 0008 D6/D7: one Postgres, org_id on every tenant row, RLS as the first
-- wall, per-org keys (server/keys.js) as the second. Read server/db.js first.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaddiya_app') THEN
    CREATE ROLE kaddiya_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
-- The pool user drops to the app role inside every tenant transaction.
GRANT kaddiya_app TO CURRENT_USER;

-- ---- directory tables: ENABLE RLS (owner may resolve; app role is confined) ----

CREATE TABLE orgs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text UNIQUE,
  region              text NOT NULL DEFAULT 'us',
  edition             text NOT NULL DEFAULT 'saas',      -- saas | self-hosted
  status              text NOT NULL DEFAULT 'draft',     -- draft | active | suspended
  -- second wall: the org's data-encryption key, wrapped by the KeyProvider
  dek_wrapped         bytea NOT NULL,
  key_version         int NOT NULL DEFAULT 1,
  -- join policy (D3)
  join_policy         text NOT NULL DEFAULT 'approve',   -- approve | auto
  deny_external       boolean NOT NULL DEFAULT true,
  required_role       text,
  -- feature governance (D12): which catalog tiers this org may commit
  actions_tiers       text NOT NULL DEFAULT '1,2',
  session_ttl_ms      bigint,                              -- downward only; 8h ceiling in code
  -- BYOM (D9)
  model_provider      text NOT NULL DEFAULT 'trial',     -- trial | anthropic | gateway
  model_id            text,
  model_key_enc       bytea,
  model_base_url      text,
  model_effort        text,
  -- plan + billing
  plan                text NOT NULL DEFAULT 'free',      -- free | team | self-hosted
  plan_status         text,                              -- active | past_due | canceled
  stripe_customer_id  text UNIQUE,
  stripe_subscription_id text,
  -- bootstrap: a draft belongs to the browser that started it until the first
  -- verified claim (D2: claims complete only from the session that began them)
  draft_binding       text,
  expires_at          timestamptz,
  verified_at         timestamptz,
  anchor_instance_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orgs TO kaddiya_app
  USING (id = current_setting('app.org_id')::uuid)
  WITH CHECK (id = current_setting('app.org_id')::uuid);

CREATE TABLE instances (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label                 text NOT NULL DEFAULT 'prod',
  host                  text NOT NULL,
  instance_id           text UNIQUE,          -- the instance_id sys_property; one instance, one org
  client_id             text NOT NULL,
  client_secret_enc     bytea NOT NULL,
  status                text NOT NULL DEFAULT 'draft',  -- draft | verified | needs_reverification | disconnected
  verified_by_sys_id    text,
  verified_by_user_name text,
  verified_at           timestamptz,
  oauth_entity_sys_id   text,
  edge_encryption       boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instances_org ON instances (org_id);
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instances TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- A hostname enters this table only by completing OAuth against it (D2).
CREATE TABLE instance_aliases (
  host        text PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE instance_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instance_aliases TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- D8: the cookie is the key. sid_hash = SHA-256(sid); tokens_enc is AES-GCM
-- under HKDF(sid). A dump of this table yields zero usable tokens.
CREATE TABLE sessions (
  sid_hash          bytea PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id       uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  member_id         uuid,
  sn_user_sys_id    text,
  user_json         jsonb,
  tokens_enc        bytea NOT NULL,
  revoke_on_present boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);
CREATE INDEX sessions_org ON sessions (org_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

CREATE TABLE oauth_states (
  state        text PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id  uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  purpose      text NOT NULL,        -- signin | verify
  verifier     text NOT NULL,
  binding      text NOT NULL,        -- sha256 of the browser-bound cookie
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_states TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- ---- tenant tables: FORCE RLS (the owner is subject to the policy too) ----

CREATE TABLE members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id     uuid REFERENCES instances(id) ON DELETE SET NULL,
  sn_user_sys_id  text NOT NULL,
  user_name       text,
  name            text,
  role            text NOT NULL DEFAULT 'member',   -- owner | admin | member
  status          text NOT NULL DEFAULT 'pending',  -- pending | active | blocked
  pending_reason  text,
  approved_by     text,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  UNIQUE (org_id, sn_user_sys_id)
);
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON members TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- Index fields plaintext; the message bodies (instance data) encrypted under
-- the org key with `org_id:conversations.body` as AAD (D7).
CREATE TABLE conversations (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id     uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  sn_user_sys_id  text NOT NULL,
  title           text NOT NULL DEFAULT 'New chat',
  pinned          boolean NOT NULL DEFAULT false,
  turns           int NOT NULL DEFAULT 0,
  body_enc        bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner ON conversations (org_id, instance_id, sn_user_sys_id, updated_at DESC);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

CREATE TABLE notebook_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id     uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  text_enc        bytea NOT NULL,
  text_hash       bytea NOT NULL,       -- sha256(lower(text)) for de-duplication
  context         text,
  status          text NOT NULL DEFAULT 'pending',  -- pending | kept
  saved_by        text,
  kept_by         text,
  kept_at         timestamptz,
  conversation_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, text_hash)
);
ALTER TABLE notebook_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notebook_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notebook_entries TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- Append-only: UPDATE and DELETE are revoked from the app role below.
CREATE TABLE audit_events (
  id                bigserial PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id       uuid,
  ts                timestamptz NOT NULL DEFAULT now(),
  user_name         text,
  action            text NOT NULL,
  table_name        text,
  sys_id            text,
  conversation_id   uuid,
  approved_by_user  boolean,
  payload_enc       bytea
);
CREATE INDEX audit_events_org_ts ON audit_events (org_id, ts DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- One row per model turn: the meter behind the plan limits and the cost line.
CREATE TABLE usage_events (
  id                bigserial PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id       uuid,
  sn_user_sys_id    text,
  conversation_id   uuid,
  ts                timestamptz NOT NULL DEFAULT now(),
  model             text,
  provider          text NOT NULL,        -- trial | org | env
  input_tokens      bigint NOT NULL DEFAULT 0,
  output_tokens     bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_usd          numeric(12, 6)
);
CREATE INDEX usage_events_org_ts ON usage_events (org_id, ts DESC);
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- Webhook idempotency; no tenant data, owner-only.
CREATE TABLE stripe_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- ---- grants ----
GRANT USAGE ON SCHEMA public TO kaddiya_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  orgs, instances, instance_aliases, sessions, oauth_states,
  members, conversations, notebook_entries, audit_events, usage_events
  TO kaddiya_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kaddiya_app;
REVOKE UPDATE, DELETE ON audit_events FROM kaddiya_app;
REVOKE ALL ON stripe_events, schema_migrations FROM kaddiya_app;
