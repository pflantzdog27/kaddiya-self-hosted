-- The artifact workspace: durable outputs with immutable revisions.
--
-- An *output* is the thing being made — a document, a table, a snippet — with
-- a stable id the model and the browser both name. A *revision* is one
-- complete saved version of it. Revisions are append-only to the application
-- (UPDATE and DELETE are revoked below, as for audit_events); the head
-- pointer on `outputs` moves, and deleting a conversation cascades both away.
--
-- Two walls, the same two as everywhere else (ADR 0008 D6/D7):
--   RLS pins the org, forced so the owner role is subject to it too;
--   the payload is one AES-GCM blob under the org DEK, with an AAD that names
--   this output and this revision — so a ciphertext lifted from another
--   output, another version or another org fails to open rather than decoding
--   into someone else's document. Title and filename are inside that blob:
--   "Payroll incident 4471 — after-hours escalation" is itself instance data.
--
-- Tenancy is structural, not just filtered. conversations gains UNIQUE
-- (id, org_id) so outputs can carry a composite foreign key, and revisions
-- carry one back to (output_id, org_id). A row cannot be parented to another
-- tenant's conversation even if an id is guessed, because the pair must match.

ALTER TABLE conversations ADD CONSTRAINT conversations_id_org UNIQUE (id, org_id);

CREATE TABLE outputs (
  id                uuid PRIMARY KEY,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id       uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  sn_user_sys_id    text NOT NULL,
  conversation_id   uuid NOT NULL,
  current_revision  int  NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- The composite parent key: this output's conversation must belong to this
  -- output's org. Deleting the conversation takes the output with it.
  CONSTRAINT outputs_conversation_fk FOREIGN KEY (conversation_id, org_id)
    REFERENCES conversations (id, org_id) ON DELETE CASCADE,
  -- So revisions can point back at (output, org) as one unit.
  CONSTRAINT outputs_id_org UNIQUE (id, org_id)
);
CREATE INDEX outputs_conversation ON outputs (org_id, conversation_id, created_at, id);
CREATE INDEX outputs_owner ON outputs (org_id, instance_id, sn_user_sys_id, updated_at DESC);
ALTER TABLE outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE outputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outputs TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

CREATE TABLE output_revisions (
  org_id        uuid NOT NULL,
  output_id     uuid NOT NULL,
  revision      int  NOT NULL,
  payload_enc   bytea NOT NULL,   -- {schemaVersion,title,filename,format,language,content,sha256,changeSummary,provenance}
  byte_length   int  NOT NULL,    -- Buffer.byteLength of the UTF-8 content, for quotas and the card
  created_at    timestamptz NOT NULL DEFAULT now(),
  actor_kind    text NOT NULL,    -- assistant | user
  operation_id  text NOT NULL,    -- server-derived from turn/tool identity, or a client UUID on a human save
  PRIMARY KEY (output_id, revision),
  CONSTRAINT output_revisions_output_fk FOREIGN KEY (output_id, org_id)
    REFERENCES outputs (id, org_id) ON DELETE CASCADE
);
-- Idempotency, scoped to the tenant: replaying a committed save returns the
-- revision it already made instead of writing a second one.
CREATE UNIQUE INDEX output_revisions_operation ON output_revisions (org_id, operation_id);
ALTER TABLE output_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE output_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON output_revisions TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

-- The turn lease (spec §5): one turn at a time per conversation, across
-- processes. A browser flag and a process-local Map both stop being true the
-- moment a second app process or a second tab exists, and the lost update
-- that follows is silent. The row is the arbiter; `lease_id` is what a writer
-- proves it still holds before it commits, so a turn whose lease expired
-- under it cannot land a write after someone else took over.
CREATE TABLE conversation_turns (
  conversation_id uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  lease_id        uuid NOT NULL,
  holder          text NOT NULL,        -- 'chat' | 'run', for the message a second turn sees
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  renewed_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT conversation_turns_conversation_fk FOREIGN KEY (conversation_id, org_id)
    REFERENCES conversations (id, org_id) ON DELETE CASCADE
);
CREATE INDEX conversation_turns_expiry ON conversation_turns (expires_at);
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_turns TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON outputs, conversation_turns TO kaddiya_app;
GRANT SELECT, INSERT ON output_revisions TO kaddiya_app;
-- Append-only, like audit_events: a saved version is evidence of what was
-- handed over. Cascading deletion still works — referential actions run as the
-- referencing table's owner and are exempt from both the grant and the policy.
REVOKE UPDATE, DELETE ON output_revisions FROM kaddiya_app;
