# CodeBridge

CodeBridge turns GitHub issues, PR comments, and discussion comments into a control plane for a local coding agent.

Assign or mention your GitHub App bot, and CodeBridge runs Codex against the mapped local repo, then posts progress, summaries, and PR links back to the same thread.

## Why CodeBridge

- Run local agent workflows from GitHub web/mobile instead of a terminal.
- Keep session state visible in GitHub using labels and comments.
- Support both webhook and polling ingestion modes.
- Evaluate quality automatically with promptfoo against real GitHub tasks.

## System Design

```text
                                         GitHub
      +------------------------------------------------------------------------+
      | Issues / PR comments / Discussions / Assignments / Labels / PRs       |
      +-------------------------------------+----------------------------------+
                                            | events
                         webhook (/github/webhook) or polling (interval)
                                            v
+-------------------------------------------------------------------------------------------+
|                                         CodeBridge                                        |
|                                                                                           |
|  +--------------------+     +---------------------+     +-------------------------------+ |
|  | Ingestion          | --> | Router + Dedupe     | --> | Run Service                   | |
|  | - Probot webhook   |     | - parse command     |     | - create run record           | |
|  | - GitHub poller    |     | - resolve tenant    |     | - post initial status         | |
|  +--------------------+     +---------------------+     +---------------+---------------+ |
|                                                                          enqueue          |
|  +--------------------+     +---------------------+                     (BullMQ/memory)   |
|  | Storage            | <-- | Worker              | <------------------------------------+ |
|  | - SQLite/Postgres  |     | - Codex SDK thread  |                                       |
|  | - runs/events      |     | - repo branch/PR    |                                       |
|  | - poll high-water  |     | - status updates    |                                       |
|  +--------------------+     +----------+----------+                                       |
|                                         |                                                  |
|                             app-authored comments + labels + PR links                     |
+-----------------------------------------+--------------------------------------------------+
                                          |
                                          v
                                  GitHub thread updates
```

## Core Behavior

1. A user assigns an issue to an assignment bootstrap handle, or comments with `@codexengineer ...`.
2. CodeBridge resolves tenant/repo, creates a run, and marks lifecycle labels.
3. Worker executes Codex against the configured local repo path.
4. Progress and final summary are posted by the GitHub App identity.
5. If code changed, CodeBridge opens a PR and links it in the issue thread.

## GitHub Lifecycle Labels

- `agent:managed`
- `agent:in-progress`
- `agent:idle`
- `agent:completed`

## Quickstart

### 1. Prerequisites

- Node.js 18+
- `pnpm`
- `gh` CLI authenticated for repositories you test against
- GitHub App credentials (App ID + private key)
- Optional for Redis mode: Redis instance

### 2. Install

```bash
pnpm install
```

### 3. Configure tenants

Start from the example:

```bash
cp config/tenants.example.yaml config/tenants.yaml
```

Set:

- `secrets.githubAppId`
- `secrets.githubPrivateKey`
- tenant `github.installationId`
- tenant repo mapping in `repos`

You can also place real config in `~/.config/codebridge/config.yaml` and set `CONFIG_PATH`.

### 4. Set environment

Typical local dev defaults:

```bash
export PORT=8788
export ROLE=all
export DATABASE_URL=sqlite://./data/codex-bridge.db
export QUEUE_MODE=memory
export GITHUB_POLL_INTERVAL=15
export GITHUB_POLL_BACKFILL=false
# optional safety guard: fail stuck codex turns after 5 minutes
# export CODEX_TURN_TIMEOUT_MS=300000
# optional if config file is outside repo
# export CONFIG_PATH=$HOME/.config/codebridge/config.yaml
```

### 5. Run

```bash
pnpm dev
```

Health check:

```bash
curl http://127.0.0.1:8788/health
```

## GitHub App Requirements

Minimum app permissions:

- Issues: Read & Write
- Pull requests: Read & Write
- Contents: Read & Write
- Discussions: Read & Write (if discussion triggers are needed)

Events:

- `issues`
- `issue_comment`
- `pull_request_review_comment`
- `discussion_comment`

Detailed assignment constraints and fallback guidance:

- [GitHub Assignee Setup](docs/github-assignee-setup.md)

## Triggering Runs

### Assignment bootstrap

Assign the issue to a configured assignment handle.

### Mention bootstrap

Comment in issue/PR/discussion:

```text
@codexengineer run investigate flaky CI and propose a fix
```

### Follow-up

On managed issues, plain non-bot comments are treated as follow-up prompts.

## Promptfoo Evaluation (Live Bot Quality)

CodeBridge includes a custom promptfoo provider (`eval/provider.ts`) that:

1. creates test issues,
2. triggers the bot,
3. waits for bot responses,
4. fetches PR diffs,
5. scores results with an LLM rubric.

Run eval:

```bash
pnpm eval
```

Run serial (recommended for deterministic debugging):

```bash
pnpm exec promptfoo eval -j 1
```

Open report UI:

```bash
pnpm eval:view
```

Main config:

- `promptfooconfig.yaml`

## Development Commands

```bash
pnpm build
pnpm lint
pnpm test:github-polling
pnpm test:github-protocol
pnpm test:vibe-agents
```

## Troubleshooting

- If assignment bootstrap does not trigger, verify app/user assignability for that repo. Mention bootstrap remains the fallback.
- If polling misses first historical comments, keep `GITHUB_POLL_BACKFILL=false` and post a new comment after poller startup.
- If no PR is created, inspect run summary comments for repo cleanliness, auth, or network errors.

## Documentation

- [Requirements](docs/requirements.md)
- [Design](docs/design.md)
- [GitHub Surface Test Protocol](docs/test-protocol.md)
- [GitHub Assignee Setup](docs/github-assignee-setup.md)
- [Agent Harness PRD (Jira + GitHub)](docs/PRD-agent-harness.md)
- [Agent Harness LLD (Jira + GitHub)](docs/LLD-agent-harness.md)
