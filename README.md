<p align="center">
  <img src="assets/nanoclawbster-logo.png" alt="NanoClawbster" width="400">
</p>

<h3 align="center">Your personal AI assistant, now with claws.</h3>

<p align="center">
  <a href="https://github.com/sskarz/nanoclawbster"><img src="https://img.shields.io/badge/GitHub-NanoClawbster-red?logo=github" alt="GitHub"></a>&nbsp;
</p>

---

# NanoClawbster

A self-hosted Discord AI assistant powered by Anthropic's Claude Agent SDK. Each conversation runs inside an isolated Docker container, giving you a fully capable Claude agent with web browsing, file operations, scheduled tasks, 500+ app integrations via Composio, and the ability to write and deploy its own code.

## Key Features

- **Discord-native** — Responds to @mentions in any registered channel or server
- **Containerized agents** — Each group's agent runs in an isolated Docker container (safe Bash, filesystem isolation, non-root user)
- **Claude Agent SDK** — Built directly on Anthropic's `@anthropic-ai/claude-agent-sdk`, not a wrapper
- **Composio integration** — 500+ app integrations out of the box (Google Calendar, Gmail, GitHub, Slack, Notion, and more)
- **Skills system** — Extensible prompt-based skills: `self-improve`, `agent-browser`, `mcp-builder`, `daily-memory`, and more
- **Scheduled tasks** — Cron, interval, and one-time scheduled agents (e.g. morning briefings, weekly reports)
- **Persistent memory** — Per-group CLAUDE.md files + SQLite for message history and sessions
- **ask_user tool** — Agents can pause mid-task, ask you a question, and resume after your reply
- **Self-improvement** — The bot can write its own features, open GitHub PRs, and deploy updates to itself
- **Web browsing** — Full browser automation via the `agent-browser` skill (Chromium-based)
- **Multi-group** — Multiple Discord channels/servers, each with isolated context and memory
- **Admin controls** — Privileged admin groups with extra tools: deploy, restart, register channels, view stats

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    HOST (Node.js)                         │
│                                                          │
│  Discord.js ──▶ Message Loop ──▶ Container Runner        │
│                      │                    │              │
│                 Scheduler Loop       IPC Watcher         │
│                      │                    │              │
│                 SQLite (messages.db)       │              │
│                                           ▼              │
├───────────────────── CONTAINER (Docker) ─────────────────┤
│                                                          │
│  Agent Runner (Claude Agent SDK)                         │
│    • Working dir: /workspace/group  (group's CLAUDE.md)  │
│    • Tools: Bash, Read/Write/Edit, WebSearch, WebFetch   │
│    • MCP: nanoclawbster (scheduler + messaging tools)    │
│    • MCP: Composio (500+ app integrations)               │
│    • Skills: agent-browser, self-improve, mcp-builder    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**IPC**: The host and containers communicate via JSON files written to `data/ipc/` (messages, tasks, input, responses directories). This file-based IPC allows containers to trigger host actions (send a message, schedule a task, etc.) without network sockets.

**Memory**: Each group has a `groups/{name}/CLAUDE.md` file that Claude reads automatically on every invocation. A global `groups/CLAUDE.md` is shared across all groups. Agents can write to their memory files to persist facts, preferences, and notes across conversations.

**Sessions**: Session IDs are stored in SQLite and passed to the Agent SDK's `resume` option, so each group maintains a continuous conversation context across restarts.

## Prerequisites

- **Node.js 20+**
- **Docker** (or Apple Container on macOS)
- **[Claude Code](https://claude.ai/code)** installed (`npm install -g @anthropic-ai/claude-code`)
- **Discord bot token** — create one at https://discord.com/developers/applications
  - Enable: Message Content Intent, Server Members Intent, Presence Intent
  - Bot permissions: Send Messages, Read Message History, Use Slash Commands
- **Anthropic API key** (`ANTHROPIC_API_KEY`) **or** Claude Code OAuth (via `CLAUDE_CODE_OAUTH_TOKEN`)

## Quick Start

```bash
git clone https://github.com/sskarz/nanoclawbster.git
cd nanoclawbster
cp .env.example .env
# Edit .env — set DISCORD_BOT_TOKEN and ANTHROPIC_API_KEY
claude
```

Then in Claude Code, run:
```
/setup
```

The `/setup` skill will:
1. Check your environment (Node, Docker, credentials)
2. Build the agent container image
3. Configure and start the background service (launchd on macOS, systemd on Linux)
4. Register your first Discord channel as the admin group

Once running, invite your bot to a Discord server and @mention it:
```
@Andy what's on my calendar today?
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Authentication (one required)
ANTHROPIC_API_KEY=          # Anthropic API key (pay-per-use)
CLAUDE_CODE_OAUTH_TOKEN=    # Claude Code OAuth token (subscription)

# Discord (required)
DISCORD_BOT_TOKEN=          # From https://discord.com/developers/applications
ASSISTANT_NAME=Andy         # The @mention trigger word

# Webhooks (optional — for Composio triggers like Gmail, GitHub events)
WEBHOOK_PORT=3456
COMPOSIO_WEBHOOK_SECRET=

# Container tuning (optional)
CONTAINER_IMAGE=nanoclawbster-agent:latest
CONTAINER_TIMEOUT=1800000     # 30 min
IDLE_TIMEOUT=1800000          # 30 min
MAX_CONCURRENT_CONTAINERS=5
```

## Registering Groups

To register additional Discord channels, message the bot from your admin channel:
```
@Andy register this channel as "my-group"
```

Or use the `register_group` admin tool directly.

Each registered group gets:
- Its own isolated Docker container
- Isolated memory (`groups/{name}/CLAUDE.md`)
- Isolated session continuity
- Optional: additional directory mounts, custom container config

## Skills

Skills are prompt files that give agents specialized capabilities. They live in `container/skills/`.

| Skill | Description |
|-------|-------------|
| `agent-browser` | Full browser automation — research, scraping, form filling, screenshots |
| `self-improve` | Write features, fix bugs, and create PRs for NanoClawbster itself |
| `mcp-builder` | Build and register custom MCP servers for new integrations |
| `daily-memory` | Write daily memory journal entries summarizing conversations |

Skills are loaded automatically based on system instructions. The `agent-browser` skill provides a `agent-browser` CLI tool (Chromium-based) available inside every container.

## Agent Tools

### Available to All Agents

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to the group |
| `schedule_task` | Schedule recurring or one-time tasks (cron, interval, once) |
| `list_tasks` | View scheduled tasks for this group |
| `pause_task` | Pause a scheduled task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a scheduled task |
| `ask_user` | Pause mid-task and wait for user input before continuing |

### Admin-Only Tools

| Tool | Description |
|------|-------------|
| `register_group` | Register new Discord channels/groups |
| `get_stats` | View usage and system statistics |
| `restart_self` | Restart the host service |
| `pull_and_deploy` | Pull from GitHub, build, rebuild Docker if needed, restart |
| `test_container_build` | Test-build the Docker image without deploying |
| `delegate_task` | Delegate a task to a clean-context coding agent |

## Scheduled Tasks

Agents can schedule tasks that run as full agents in their group's context:

```
@Andy send me a morning briefing every weekday at 8am with today's calendar and top HN stories
@Andy in 2 hours, check my email and summarize anything important
@Andy every Monday at 9am, compile a report on open GitHub PRs and message me
```

Schedule types: `cron` (cron expression), `interval` (milliseconds), `once` (ISO timestamp).

## Example Usage

```
@Andy what's on my Google Calendar today?
@Andy summarize my unread emails from the last 24 hours
@Andy search HackerNews for AI agent news and give me the top 5 stories
@Andy take a screenshot of https://example.com
@Andy remember that I prefer bullet points over paragraphs
@Andy schedule a daily standup reminder every weekday at 9am
```

## Project Structure

```
nanoclawbster/
├── src/                         # Host process (Node.js/TypeScript)
│   ├── index.ts                 # Orchestrator: state, message loop, agent invocation
│   ├── channels/discord.ts      # Discord connection, mentions, attachments
│   ├── ipc.ts                   # IPC watcher and task processing
│   ├── router.ts                # Message formatting and outbound routing
│   ├── container-runner.ts      # Spawns agent containers with mounts
│   ├── task-scheduler.ts        # Runs scheduled tasks when due
│   └── db.ts                   # SQLite operations
├── container/
│   ├── Dockerfile               # Agent container image (node user, Claude Code CLI)
│   ├── build.sh                 # Container build script
│   ├── agent-runner/src/        # Code running inside the container
│   │   ├── index.ts             # Entry point (query loop, IPC polling, session resume)
│   │   └── ipc-mcp-stdio.ts     # Stdio MCP server for host communication
│   └── skills/                  # Skill prompt files (agent-browser, self-improve, etc.)
├── groups/
│   ├── CLAUDE.md                # Global memory (all groups)
│   └── {group-name}/
│       ├── CLAUDE.md            # Group-specific memory
│       └── logs/                # Container execution logs
├── docs/                        # Architecture docs (SPEC.md, SECURITY.md, etc.)
├── .env.example                 # Configuration reference
└── README.md                    # This file
```

## Development

```bash
# TypeScript check (host)
cd /path/to/nanoclawbster
node_modules/.bin/tsc --noEmit

# TypeScript check (container agent)
cd container/agent-runner
node_modules/.bin/tsc --noEmit

# Run tests
npm test

# Run locally (no background service)
npm run dev

# Rebuild agent container
./container/build.sh
```

**Service management (macOS):**
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclawbster.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclawbster.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclawbster  # restart
```

**Service management (Linux):**
```bash
systemctl --user start nanoclawbster
systemctl --user stop nanoclawbster
systemctl --user restart nanoclawbster
```

## Security

- **Container isolation**: All agents run inside Docker containers — Bash is safe because it runs in the container, not on your host
- **Non-root user**: Containers run as unprivileged `node` user (uid 1000)
- **Filesystem isolation**: Agents can only access mounted directories (`/workspace/group`, `/workspace/global`, `/workspace/extra/*`)
- **Admin gating**: Admin-only tools are only registered when `NANOCLAWBSTER_IS_ADMIN=1` is set; the host also enforces this at the IPC level
- **No is_admin from container**: No agent can modify the `is_admin` flag — it's only changeable via direct SQLite access on the host

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

## Credits

NanoClawbster is inspired by [NanoClaw](https://github.com/qwibitai/NanoClaw) by [qwibitai](https://github.com/qwibitai). The core architecture — container isolation, agent SDK integration, the message loop — draws from that project. NanoClawbster adds the Discord channel, Composio MCP, and a lobster.

## License

MIT
