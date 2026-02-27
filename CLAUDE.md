# NanoClawbster

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClawbster changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
| `/self-improve` | Write features, fix bugs, create PRs for the NanoClawbster codebase |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclawbster.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclawbster.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclawbster  # restart

# Linux (systemd)
systemctl --user start nanoclawbster
systemctl --user stop nanoclawbster
systemctl --user restart nanoclawbster
```

## Trigger Gating (`requiresTrigger`)

Each registered group has a `requires_trigger` flag in the DB (`registered_groups.requires_trigger`):

- `1` (true) — agent only runs when a message matches `TRIGGER_PATTERN` (e.g. `@Nano`). No container spawned, no typing indicator for other messages.
- `0` (false) — agent runs on every message (e.g. a private self-chat).
- `null` — defaults to `true` for non-main groups, `false` for the main group.

**Important:** `requiresTrigger: true` is respected even for the main group folder. This matters when the main group is a public channel (e.g. Discord `#general`) where the bot should only respond to @mentions, not every message.

To update via Node:
```js
db.prepare("UPDATE registered_groups SET requires_trigger = 1 WHERE jid LIKE 'dc:%'").run();
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
