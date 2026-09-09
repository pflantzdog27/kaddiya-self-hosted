-- ADR 0011: runs, and approval per plan on non-production instances.
--
-- Two flags, both default-off, both conditions that plan-approved commits
-- check in code (ADR 0011 D3): the org must have turned plan mode on, and
-- the instance must be marked non-production. Personal developer instances
-- are recognised by host and marked at registration; anything else is
-- production until an org admin says otherwise.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS runs_plan_mode boolean NOT NULL DEFAULT false;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS non_production boolean NOT NULL DEFAULT false;

UPDATE instances SET non_production = true WHERE host ~ '^dev[0-9]+\.service-now\.com$';
