CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  source_key TEXT UNIQUE,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  branch_prefix TEXT,
  slack_channel TEXT,
  slack_thread_ts TEXT,
  slack_message_ts TEXT,
  slack_user_id TEXT,
  github_owner TEXT,
  github_repo TEXT,
  github_issue_number INTEGER,
  github_comment_id BIGINT,
  github_trigger_comment_id BIGINT,
  github_installation_id BIGINT,
  github_issue_title TEXT,
  github_issue_body TEXT,
  branch_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS github_trigger_comment_id BIGINT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS runs_source_key_idx ON runs(source_key);

CREATE TABLE IF NOT EXISTS github_poll_state (
  tenant_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  last_comment_id BIGINT,
  last_comment_created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tenant_id, repo_full_name)
);

-- No FK from session_link_key.link_id to session_link.id (LLD §2). A key row
-- is the claim and may exist briefly before the session_link row.
CREATE TABLE IF NOT EXISTS session_link (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  opencode_session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, opencode_session_id),
  UNIQUE (id)
);

-- repo_key is derived from repo ('' when repo is NULL) so a Jira NULL repo
-- cannot bypass UNIQUE. Callers case-fold repo, repo_key, and value before
-- insert; the CHECK rejects an independently set repo_key (LLD §10).
CREATE TABLE IF NOT EXISTS session_link_key (
  link_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo TEXT,
  repo_key TEXT NOT NULL,
  value TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, repo_key, value),
  CONSTRAINT session_link_key_repo_key_matches_repo CHECK (repo_key = COALESCE(repo, ''))
);

CREATE INDEX IF NOT EXISTS idx_session_link_key_link ON session_link_key (link_id);

CREATE TABLE IF NOT EXISTS jira_poll_state (
  tenant_id TEXT PRIMARY KEY,
  last_cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
