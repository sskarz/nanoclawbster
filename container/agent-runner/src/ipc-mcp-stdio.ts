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
import https from 'https';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const ATTACHMENTS_DIR = path.join(IPC_DIR, 'attachments');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

const ASK_USER_POLL_MS = 500;
const ASK_USER_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAWBSTER_CHAT_JID!;
const groupFolder = process.env.NANOCLAWBSTER_GROUP_FOLDER!;
const isAdmin = process.env.NANOCLAWBSTER_IS_ADMIN === '1';

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

server.registerTool(
  'send_message',
  {
    description: "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
    inputSchema: {
      text: z.string().describe('The message text to send'),
      sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
      files: z.array(z.string()).optional().describe('Filenames of files to attach (e.g. ["report.pdf"]). Files must be saved to /workspace/ipc/attachments/ first.'),
    },
  },
  async (args: { text: string; sender?: string; files?: string[] }) => {
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

server.registerTool(
  'ask_user',
  {
    description: "Ask the user a question and wait for their response. The question will be sent to them as a Discord message and execution will pause until they reply. Use this when you need clarification or a decision before continuing. Has a 5-minute timeout by default.",
    inputSchema: {
      question: z.string().describe('The question to ask the user'),
      timeout_ms: z.number().optional().describe('How long to wait for a response in milliseconds (default: 300000 = 5 minutes)'),
    },
  },
  async (args: { question: string; timeout_ms?: number }) => {
    const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = args.timeout_ms ?? ASK_USER_DEFAULT_TIMEOUT_MS;
    const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);

    // Write question to messages dir so host sends it to Discord
    writeIpcFile(MESSAGES_DIR, {
      type: 'question',
      chatJid,
      groupFolder,
      requestId,
      text: `\u2753 ${args.question}`,
      timestamp: new Date().toISOString(),
    });

    // Poll for response file
    const startTime = Date.now();
    while (true) {
      if (fs.existsSync(responseFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);
          return { content: [{ type: 'text' as const, text: data.answer }] };
        } catch {
          // If file is being written (partial read), retry on next poll
        }
      }

      if (Date.now() - startTime > timeout) {
        return {
          content: [{ type: 'text' as const, text: `[No response received after ${Math.round(timeout / 1000)}s — proceeding without user input]` }],
          isError: true,
        };
      }

      await new Promise(r => setTimeout(r, ASK_USER_POLL_MS));
    }
  },
);

server.registerTool(
  'schedule_task',
  {
    description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

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
    inputSchema: {
      prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
      schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
      schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: PST/PDT timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
      context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
      target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    },
  },
  async (args: { prompt: string; schedule_type: 'cron' | 'interval' | 'once'; schedule_value: string; context_mode?: 'group' | 'isolated'; target_group_jid?: string }) => {
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
    const targetJid = isAdmin && args.target_group_jid ? args.target_group_jid : chatJid;

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

server.registerTool(
  'list_tasks',
  {
    description: "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  },
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isAdmin
        ? allTasks
        : allTasks.filter((t: { createdBy: string }) => t.createdBy === groupFolder);

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

server.registerTool(
  'pause_task',
  {
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: { task_id: z.string().describe('The task ID to pause') },
  },
  async (args: { task_id: string }) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isAdmin,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.registerTool(
  'resume_task',
  {
    description: 'Resume a paused task.',
    inputSchema: { task_id: z.string().describe('The task ID to resume') },
  },
  async (args: { task_id: string }) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isAdmin,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.registerTool(
  'cancel_task',
  {
    description: 'Cancel and delete a scheduled task.',
    inputSchema: { task_id: z.string().describe('The task ID to cancel') },
  },
  async (args: { task_id: string }) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isAdmin,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

// Main-only tools: only registered when running as the main group so non-main
// agents never see them in the tool list (prevents hallucinated privilege).
if (isAdmin) {

server.registerTool(
  'delegate_task',
  {
    description: `Delegate a task to a dedicated coding agent with clean context (no conversation history). The coding agent runs in a separate container with only the task prompt and skill instructions. It reports progress via send_message. This tool returns immediately.`,
    inputSchema: {
      task: z.string().describe('Detailed description of what the coding agent should do. Include ALL necessary context \u2014 the agent has NO conversation history.'),
      skill: z.string().optional().describe('Skill name to load (e.g. "self-improve"). Instructions will be prepended to the prompt.'),
    },
  },
  async (args: { task: string; skill?: string }) => {
    writeIpcFile(TASKS_DIR, {
      type: 'delegate_task',
      task: args.task,
      skill: args.skill || undefined,
      chatJid,
      groupFolder,
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Task delegated to a clean-context coding agent. It will report progress via messages in this chat.${args.skill ? ` Skill "${args.skill}" will be loaded.` : ''}`,
      }],
    };
  },
);

server.registerTool(
  'register_group',
  {
    description: `Register a new WhatsApp group so the agent can respond to messages there.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
    inputSchema: {
      jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
      name: z.string().describe('Display name for the group'),
      folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
  },
  async (args: { jid: string; name: string; folder: string; trigger: string }) => {
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

server.registerTool(
  'get_stats',
  {
    description: 'Get a quick summary of system stats: messages today, total messages, registered groups, active scheduled tasks, and uptime.',
  },
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

server.registerTool(
  'restart_self',
  {
    description: 'Restart the NanoClawbster service. Use when asked to restart, or after making changes that require a restart to take effect. The host automatically sends deploy/restart notifications \u2014 do NOT send one yourself. After calling this tool, wrap your entire remaining output in <internal> tags since the user has already been notified.',
  },
  async () => {
    writeIpcFile(TASKS_DIR, {
      type: 'restart',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Restart command issued. The service will restart in a moment.' }] };
  },
);

server.registerTool(
  'pull_and_deploy',
  {
    description: `Pull merged changes from GitHub into the live codebase and deploy.

Use this AFTER a PR has been merged on GitHub. The host will:
1. Pull latest from the main branch (via git)
2. Run npm install if package.json changed
3. Build TypeScript
4. Rebuild Docker image if container/ files changed
5. Restart the service

If the build fails, it automatically rolls back to the previous version.

The host automatically sends deploy/restart notifications \u2014 do NOT send one yourself. After calling, wrap remaining output in <internal> tags.`,
    inputSchema: {
      branch: z.string().default('main').describe('Branch to pull (usually "main")'),
    },
  },
  async (args: { branch: string }) => {
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

server.registerTool(
  'test_container_build',
  {
    description: `Test-build the Docker container image from the dev workspace without deploying.

Use this to verify Dockerfile or agent-runner changes compile and build correctly
before creating a PR. The host builds from /workspace/dev/container/ and writes
the result to /workspace/dev/.build-result.json.

After calling this tool, poll the result file:
  cat /workspace/dev/.build-result.json
It may take 2-5 minutes. The file contains {success, error?, duration_ms, timestamp}.`,
  },
  async () => {
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

} // end main-only tools

// ---------------------------------------------------------------------------
// make_phone_call — available to all groups
// ---------------------------------------------------------------------------

/**
 * Make a raw HTTPS POST request and return the response body as a string.
 */
function httpsPost(options: https.RequestOptions, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.registerTool(
  'make_phone_call',
  {
    description: `Make an outbound phone call using Retell AI + Claude as the voice agent.

The call agent (Nano) will handle the conversation using the provided purpose as context.
Max call duration is 60 seconds. Requires RETELL_API_KEY and RETELL_AGENT_ID to be configured.

Use this when asked to make a phone call — provide the phone number and what the call is about.`,
    inputSchema: {
      phone_number: z.string().describe('The phone number to call in E.164 format (e.g. +16268337629). If the user gives a number without country code, assume +1 for US numbers.'),
      purpose: z.string().describe('What the call is about — this becomes the context/system prompt for the call agent so it knows why it\'s calling'),
      message: z.string().optional().describe('Optional specific opening message or talking points for the call agent'),
    },
  },
  async (args: { phone_number: string; purpose: string; message?: string }) => {
    // Read Retell credentials from environment
    const retellApiKey = process.env.RETELL_API_KEY ?? '';
    const retellAgentId = process.env.RETELL_AGENT_ID ?? '';
    const retellFromNumber = process.env.RETELL_FROM_NUMBER ?? '';
    const retellWebhookUrl = process.env.RETELL_WEBHOOK_URL ?? '';

    if (!retellApiKey) {
      return {
        content: [{
          type: 'text' as const,
          text: '\u274C RETELL_API_KEY is not configured. Please add it to your .env file and restart. Get a key from https://retellai.com',
        }],
        isError: true,
      };
    }

    if (!retellFromNumber) {
      return {
        content: [{
          type: 'text' as const,
          text: '\u274C RETELL_FROM_NUMBER is not configured. Add your Retell phone number (e.g. +14157774444) to .env.',
        }],
        isError: true,
      };
    }

    // Build call purpose context for the LLM server
    const purposeText = args.message
      ? `${args.purpose}. Opening message: ${args.message}`
      : args.purpose;

    // Encode purpose for URL query param (used by the WebSocket LLM server)
    const encodedPurpose = encodeURIComponent(purposeText);

    // Build the request body — use agent_id if configured, otherwise use llm_websocket_url override
    // Retell v2 create-phone-call API
    const toNumber = args.phone_number;

    type CallRequestBody = {
      from_number: string;
      to_number: string;
      override_agent_id?: string;
      agent_override?: {
        llm_websocket_url?: string;
        max_call_duration_ms: number;
        begin_message?: string;
      };
      metadata?: Record<string, string>;
    };

    const requestBody: CallRequestBody = {
      from_number: retellFromNumber,
      to_number: toNumber,
      metadata: {
        purpose: purposeText.slice(0, 200),
      },
    };

    if (retellAgentId) {
      // Use a pre-configured agent — attach purpose via metadata and webhook URL
      requestBody.override_agent_id = retellAgentId;
      requestBody.agent_override = {
        max_call_duration_ms: 60000, // 60 second hard limit
        ...(retellWebhookUrl ? { llm_websocket_url: `${retellWebhookUrl}/llm-websocket/${Date.now()}?purpose=${encodedPurpose}` } : {}),
        ...(args.message ? { begin_message: args.message } : {}),
      };
    } else if (retellWebhookUrl) {
      // No agent ID — require it
      return {
        content: [{
          type: 'text' as const,
          text: '\u274C RETELL_AGENT_ID is not configured. You need to create an agent in the Retell dashboard first.\n\nSetup steps:\n1. Go to https://retellai.com and create an account\n2. Create an agent with your WebSocket URL: ' + retellWebhookUrl + '/llm-websocket\n3. Copy the agent_id and add RETELL_AGENT_ID=<id> to your .env',
        }],
        isError: true,
      };
    } else {
      return {
        content: [{
          type: 'text' as const,
          text: '\u274C RETELL_AGENT_ID and RETELL_WEBHOOK_URL are not configured. See .env.example for setup instructions.',
        }],
        isError: true,
      };
    }

    const bodyString = JSON.stringify(requestBody);

    try {
      const response = await httpsPost(
        {
          hostname: 'api.retellai.com',
          path: '/v2/create-phone-call',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${retellApiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyString),
          },
        },
        bodyString,
      );

      if (response.status === 201 || response.status === 200) {
        let callId = 'unknown';
        try {
          const parsed = JSON.parse(response.body) as { call_id?: string; call_status?: string };
          callId = parsed.call_id ?? callId;
          return {
            content: [{
              type: 'text' as const,
              text: `\uD83D\uDCDE Call initiated!\n\nCall ID: ${callId}\nStatus: ${parsed.call_status ?? 'registered'}\nTo: ${toNumber}\nMax duration: 60 seconds\nPurpose: ${args.purpose}`,
            }],
          };
        } catch {
          return {
            content: [{
              type: 'text' as const,
              text: `\uD83D\uDCDE Call initiated (call_id unknown — raw response: ${response.body.slice(0, 200)})`,
            }],
          };
        }
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: `\u274C Retell API error (HTTP ${response.status}): ${response.body.slice(0, 500)}`,
          }],
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `\u274C Network error calling Retell API: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
