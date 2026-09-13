-- Optional organization identity; existing workspaces retain the default look.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}'::jsonb;
