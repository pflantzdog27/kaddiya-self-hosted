-- The mailing list for people who want more than the free preview
-- (founder decision, 2026-09-06: there is nothing to buy yet, so every
-- "upgrade" surface became "tell us when it's ready"). Not tenant data: a
-- visitor on the marketing site has no org, so this table has no org_id and
-- no RLS, and it is written through the system role only.
CREATE TABLE IF NOT EXISTS waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  note        text,
  source      text,                       -- which page or surface the form was on
  from_org    uuid,                       -- set when a signed-in admin asks from the console (not a tenant row: no org_id, no RLS)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS waitlist_email ON waitlist (lower(email));
