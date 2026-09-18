-- ADR 0014: read-only MCP access on per-user bearer tokens.
--
-- mcp_tokens is a directory table like sessions (ENABLE, not FORCE): the
-- owner role must resolve a bearer before the org is known, and the app role
-- is confined to its org by the same policy every tenant row carries.
-- D2: token_hash = SHA-256(bearer); tokens_enc is AES-GCM under HKDF(bearer).
-- A dump of this table yields zero usable tokens — test/mcp-tokens.test.js
-- dumps it and checks, as sessions.test.js does for sessions.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS mcp_enabled      boolean NOT NULL DEFAULT false;  -- D5, default off
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS mcp_token_ttl_ms bigint;                          -- downward only; 90-day ceiling in code

-- Recorded from the registry read at verification when the admin's token can
-- see it; null when unknown. Minting clamps to it (D2) and the reveal says so.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS refresh_token_lifespan_s integer;

-- Purpose-specific state a flow needs on the way back through /auth/callback:
-- for purpose = 'mcp', the label, TTL and member the mint was asked for.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE TABLE mcp_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         bytea NOT NULL UNIQUE,                      -- SHA-256(bearer), the lookup key
  token_prefix       text NOT NULL,                              -- first 12 chars, for display only
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id        uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  member_id          uuid NOT NULL,
  sn_user_sys_id     text NOT NULL,
  user_json          jsonb,
  label              text NOT NULL,
  minted_via         text NOT NULL DEFAULT 'console',            -- console | (a later AS, ADR 0014 open question 2)
  -- Which bound decided expires_at, recorded at the mint rather than derived
  -- later: the org ceiling and the instance's refresh lifespan can both change
  -- afterwards, and this token's expiry was settled by what they were then.
  clamped_by         text,                                       -- refresh_token_lifespan | org_ceiling | code_ceiling | null
  tokens_enc         bytea NOT NULL,                             -- the ServiceNow pair, under HKDF(bearer)
  reveal_enc         bytea,                                      -- the bearer, under HKDF(minting session cookie), one showing
  reveal_expires_at  timestamptz,
  revoke_on_present  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz NOT NULL
);
CREATE INDEX mcp_tokens_org    ON mcp_tokens (org_id);
CREATE INDEX mcp_tokens_member ON mcp_tokens (org_id, member_id);
CREATE INDEX mcp_tokens_expiry ON mcp_tokens (expires_at);
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_tokens TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_tokens TO kaddiya_app;
