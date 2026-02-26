<p align="center">
  <img src="assets/nanoclawbster-logo.png" alt="NanoClawbster" width="400">
</p>

<h3 align="center">Your personal AI assistant, now with claws.</h3>

<p align="center">
  <a href="https://github.com/sskarz/nanoclawbster"><img src="https://img.shields.io/badge/GitHub-NanoClawbster-red?logo=github" alt="GitHub"></a>&nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord"></a>
</p>

---

## What is NanoClawbster?

NanoClawbster is a fork of [NanoClaw](https://github.com/qwibitai/NanoClaw) that adds Discord as a first-class channel, integrates [Composio](https://composio.dev) for 1000+ app connections, and is led by a lobster. Because every AI assistant deserves a crustacean mascot.

Like NanoClaw, it's a single Node.js process that routes messages to Claude agents running in isolated Linux containers. Small enough to read, secure enough to trust, weird enough to have a lobster logo.

## What's Different from NanoClaw?

| Feature | NanoClaw | NanoClawbster |
|---------|----------|---------------|
| Discord channel | Via skill | Built-in |
| Attachment vision | -- | Downloads images & files for agent access |
| Embedded image replies | -- | Agent image URLs sent as Discord attachments |
| Mention-only mode | -- | Bot only wakes on @mention in servers |
| Composio MCP | -- | 1000+ app integrations out of the box |
| Mascot | None | Lobster |

## Features

- **Discord + WhatsApp** - Talk to your assistant from Discord servers, DMs, or WhatsApp. Discord is built-in; WhatsApp works via Baileys.
- **Attachment & Vision Support** - Send images or files in Discord and the agent can see and read them. Images are presented for vision; files land in the agent's workspace.
- **Mention-Only Mode** - In Discord servers, the bot only responds to @mentions. Other messages are stored as context silently -- no typing indicator, no container spawned.
- **Composio MCP** - Connect 1000+ apps (Gmail, Slack, GitHub, Notion, etc.) through Composio's meta-toolkit. Agents discover and use tools dynamically at runtime. Just set `COMPOSIO_API_KEY` and go.
- **Container Isolation** - Agents run in Linux containers (Docker or Apple Container on macOS). Each group gets its own filesystem and `CLAUDE.md` memory.
- **Scheduled Tasks** - Set up recurring jobs that run Claude and message you back.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks.
- **Web Access** - Search and fetch content from the web.
- **AI-Native Customization** - No config files. Tell Claude Code what you want and it modifies the code directly.

## Quick Start

```bash
git clone https://github.com/sskarz/nanoclawbster.git
cd nanoclawbster
claude
```

Then run `/setup`. Claude Code handles dependencies, authentication, container builds, and service configuration. The lobster takes it from there.

## Architecture

```
Discord / WhatsApp ──> SQLite ──> Polling Loop ──> Container (Claude Agent SDK) ──> Response
                                                        │
                                                   Composio MCP
                                                   (1000+ apps)
```

Single Node.js process. Agents execute in isolated Linux containers with filesystem isolation. Per-group message queue with concurrency control. IPC via filesystem.

**Key files:**

| File | What it does |
|------|-------------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/discord.ts` | Discord connection, mentions, attachments, embeds |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `container/agent-runner/src/composio-mcp.ts` | Composio MCP server for agent containers |
| `groups/*/CLAUDE.md` | Per-group memory (isolated) |

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send me a summary of my GitHub PRs every morning at 9am
@Andy review the git history for the past week and update the README if there's drift
@Andy every Monday at 8am, compile AI news from Hacker News and message me a briefing
```

In Discord, just @mention the bot:
```
@NanoClawbster what's on my calendar today?
@NanoClawbster summarize the last 50 messages in this channel
```

From your main channel, manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the #general channel
```

## Customizing

No config files. Just talk to Claude Code:

- "Change the trigger word to @Claw"
- "Make responses shorter and snappier"
- "Add a custom greeting when someone says good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes. The codebase is small enough that Claude can safely modify it.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker](https://docker.com/products/docker-desktop) (macOS/Linux) or [Apple Container](https://github.com/apple/container) (macOS)
- Discord bot token (for Discord) and/or WhatsApp (via QR code pairing)
- `COMPOSIO_API_KEY` (optional, for Composio integrations)

## Credits

NanoClawbster is built on top of [NanoClaw](https://github.com/qwibitai/NanoClaw) by [qwibitai](https://github.com/qwibitai). All the core architecture -- container isolation, agent SDK integration, the message loop -- comes from there. This fork adds the Discord channel, Composio MCP, and a lobster.

## License

MIT
