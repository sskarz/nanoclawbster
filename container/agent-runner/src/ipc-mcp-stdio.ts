/**
 * Stdio MCP Server for NanoClawbster
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const ATTACHMENTS_DIR = path.join(IPC_DIR, 'attachments');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAWBSTER_CHAT_JID!;
const groupFolder = process.env.NANOCLAWBSTER_GROUP_FOLDER!;
const isMain = process.env.NANOCLAWBSTER_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclawbster',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user \u2014 use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    files: z.array(z.string()).optional().describe('Filenames of files to attach (e.g. ["report.pdf"]). Files must be saved to /workspace/ipc/attachments/ first.'),
  },
  async (args) => {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

    const data: Record<string, string | string[] | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
      files: args.files?.length ? args.files : undefined,
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are PST/PDT \u2014 America/Los_Angeles):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am PST)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: PST/PDT time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: PST/PDT timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be PST/PDT time without timezone suffix. Got "${args.schedule_value}" \u2014 use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use PST/PDT format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'get_stats',
  'Get a quick summary of system stats: messages today, total messages, registered groups, active scheduled tasks, and uptime.',
  {},
  async () => {
    const statsFile = path.join(IPC_DIR, 'stats.json');
    try {
      if (!fs.existsSync(statsFile)) {
        return { content: [{ type: 'text' as const, text: 'Stats not available yet.' }] };
      }
      const stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
      const text = [
        `\uD83D\uDCCA *System Stats*`,
        `\u2022 Messages today: ${stats.messagesToday}`,
        `\u2022 Total messages: ${stats.totalMessages}`,
        `\u2022 Registered groups: ${stats.registeredGroups}`,
        `\u2022 Active scheduled tasks: ${stats.activeTasks}`,
        `\u2022 Paused tasks: ${stats.pausedTasks}`,
        `\u2022 Uptime: ${stats.uptime}`,
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error reading stats: ${err}` }] };
    }
  },
);

server.tool(
  'restart_self',
  'Restart the NanoClawbster service. Use when asked to restart, or after making changes that require a restart to take effect. IMPORTANT: Always use send_message BEFORE calling this tool to let the user know you are about to restart. The host automatically sends a "Back online!" notification on startup \u2014 do NOT send one yourself. After calling this tool, wrap your entire remaining output in <internal> tags since the user has already been notified.',
  {},
  async () => {
    // Write a flag file so the next startup knows a restart just happened
    // and can send a "back online" notification automatically.
    const restartFlagPath = '/workspace/group/restarting.flag';
    try {
      fs.writeFileSync(restartFlagPath, JSON.stringify({ timestamp: new Date().toISOString() }));
    } catch (err) {
      // Non-fatal: startup notification just won't fire
      console.error(`[nanoclawbster-mcp] Failed to write restart flag: ${err}`);
    }

    writeIpcFile(TASKS_DIR, {
      type: 'restart',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Restart command issued. The service will restart in a moment.' }] };
  },
);

server.tool(
  'rebuild_self',
  'Rebuild the NanoClawbster agent Docker image from source, then restart. Use this after merging PRs that change agent-runner code (container/agent-runner/src/). This takes ~2-5 minutes \u2014 always use send_message BEFORE calling this to warn the user. The host automatically sends a "Back online!" notification on startup \u2014 do NOT send one yourself. After calling this tool, wrap your entire remaining output in <internal> tags since the user has already been notified.',
  {},
  async () => {
    // Write a restart flag so the back-online notification fires after the rebuild+restart
    const restartFlagPath = '/workspace/group/restarting.flag';
    try {
      fs.writeFileSync(restartFlagPath, JSON.stringify({ timestamp: new Date().toISOString() }));
    } catch (err) {
      console.error(`[nanoclawbster-mcp] Failed to write restart flag: ${err}`);
    }

    writeIpcFile(TASKS_DIR, {
      type: 'rebuild',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Rebuild command issued. This will take ~2-5 minutes. The host will automatically notify the user when back online.' }] };
  },
);

server.tool(
  'pull_and_deploy',
  `Pull merged changes from GitHub into the live codebase and deploy.

Use this AFTER a PR has been merged on GitHub. The host will:
1. Pull latest from the main branch (via git)
2. Run npm install if package.json changed
3. Build TypeScript
4. Rebuild Docker image if container/ files changed
5. Restart the service

If the build fails, it automatically rolls back to the previous version.

IMPORTANT: Always use send_message BEFORE calling this to warn the user about the restart. After calling, wrap remaining output in <internal> tags.`,
  {
    branch: z.string().default('main').describe('Branch to pull (usually "main")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can pull and deploy.' }],
        isError: true,
      };
    }

    const restartFlagPath = '/workspace/group/restarting.flag';
    try {
      fs.writeFileSync(restartFlagPath, JSON.stringify({ timestamp: new Date().toISOString() }));
    } catch (err) {
      console.error(`[nanoclawbster-mcp] Failed to write restart flag: ${err}`);
    }

    writeIpcFile(TASKS_DIR, {
      type: 'pull_and_deploy',
      branch: args.branch,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: 'Pull and deploy command issued. The host will pull, build, and restart. Auto-rollback on build failure.',
      }],
    };
  },
);

server.tool(
  'test_container_build',
  `Test-build the Docker container image from the dev workspace without deploying.

Use this to verify Dockerfile or agent-runner changes compile and build correctly
before creating a PR. The host builds from /workspace/dev/container/ and writes
the result to /workspace/dev/.build-result.json.

After calling this tool, poll the result file:
  cat /workspace/dev/.build-result.json
It may take 2-5 minutes. The file contains {success, error?, duration_ms, timestamp}.`,
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can test container builds.' }],
        isError: true,
      };
    }

    // Clear any previous result
    try { fs.unlinkSync('/workspace/dev/.build-result.json'); } catch { /* ok */ }

    writeIpcFile(TASKS_DIR, {
      type: 'test_container_build',
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: 'Test build initiated. Poll /workspace/dev/.build-result.json for the result (2-5 min). The build uses the dev workspace, NOT the live code.',
      }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);