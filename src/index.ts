import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  COMPOSIO_WEBHOOK_SECRET,
  DATA_DIR,
  DISCORD_BOT_TOKEN,
  IDLE_TIMEOUT,
  MAX_SESSION_FILE_SIZE,
  POLL_INTERVAL,
  RETELL_API_KEY,
  RETELL_WEBHOOK_GROUP,
  TRIGGER_PATTERN,
  WEBHOOK_PORT,
} from './config.js';
import { startWebhookServer } from './webhook-server.js';
import { DiscordChannel } from './channels/discord.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeStatsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  clearAdminGroupFlag,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getStats,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher, tryAnswerPendingQuestion } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  if (group.isAdmin) {
    clearAdminGroupFlag();
  }
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isAdminGroup = group.isAdmin === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // System-only batches (e.g. webhook events) — suppress agent text output.
  // Agent must use send_message IPC tool for deliberate notifications.
  const isSystemOnlyBatch = missedMessages.every(m => m.sender.startsWith('system:'));

  // Check trigger requirement:
  // - Non-admin groups require a trigger by default (unless requiresTrigger is explicitly false)
  // - Admin group also checks trigger if requiresTrigger is explicitly set to true
  const needsTrigger = group.requiresTrigger === true ||
    (!isAdminGroup && group.requiresTrigger !== false);
  if (needsTrigger) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Timeout setTyping to prevent hanging the entire processing pipeline
  // if the Discord REST API stalls.
  await Promise.race([
    channel.setTyping?.(chatJid, true),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]).catch(() => {});
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        if (isSystemOnlyBatch) {
          logger.debug({ group: group.name }, `Suppressed agent text for system-only batch: ${text.slice(0, 120)}`);
        } else {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      if (isSystemOnlyBatch) {
        // Close container promptly — no user to wait for
        setTimeout(() => queue.closeStdin(chatJid), 10_000);
      } else {
        queue.notifyIdle(chatJid);
      }
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await Promise.race([
    channel.setTyping?.(chatJid, false),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]).catch(() => {});
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isAdmin = group.isAdmin === true;
  let sessionId: string | undefined = sessions[group.folder];

  // Trim oversized session files to last compact boundary
  if (sessionId) {
    try {
      const sessionFile = path.join(
        DATA_DIR, 'sessions', group.folder,
        '.claude', 'projects', '-workspace-group',
        `${sessionId}.jsonl`,
      );
      const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
      if (stat && stat.size > MAX_SESSION_FILE_SIZE) {
        const content = fs.readFileSync(sessionFile, 'utf-8');
        const lines = content.split('\n');
        let lastBoundaryIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes('"subtype":"compact_boundary"')) {
            lastBoundaryIdx = i;
            break;
          }
        }
        if (lastBoundaryIdx > 0) {
          const trimmed = lines.slice(lastBoundaryIdx).join('\n');
          if (trimmed.length <= MAX_SESSION_FILE_SIZE) {
            fs.writeFileSync(sessionFile, trimmed);
            logger.warn(
              { group: group.name, before: stat.size, after: trimmed.length },
              'Trimmed oversized session file to last compact boundary',
            );
          } else {
            // Still too large after trim — start fresh
            sessionId = undefined;
            logger.warn(
              { group: group.name, size: stat.size },
              'Session file too large even after trim, starting fresh session',
            );
          }
        } else {
          // No compact boundary found — start fresh
          sessionId = undefined;
          logger.warn(
            { group: group.name, size: stat.size },
            'Oversized session file has no compact boundary, starting fresh session',
          );
        }
      }
    } catch (err) {
      logger.error({ err, group: group.name }, 'Failed to trim session file, continuing with existing session');
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isAdmin,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Write stats snapshot for the container to read
  writeStatsSnapshot(group.folder, getStats());

  // Update available groups snapshot (admin group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isAdmin,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isAdmin,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClawbster running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          // Check if there's a pending ask_user question for this chat.
          // If so, the latest user message is the answer — route it to the
          // waiting container and skip the normal agent flow.
          const latestUserMessage = groupMessages
            .filter(m => !m.is_from_me && !m.is_bot_message)
            .at(-1);
          if (latestUserMessage && tryAnswerPendingQuestion(chatJid, latestUserMessage.content)) {
            logger.info({ chatJid }, 'User reply routed to pending ask_user question');
            // Advance the agent cursor so these messages aren't re-processed
            // when the container (still running) finishes answering the question.
            lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
            saveState();
            continue;
          }

          const isAdminGroup = group.isAdmin === true;
          const needsTrigger = group.requiresTrigger === true ||
            (!isAdminGroup && group.requiresTrigger !== false);

          // Only act on trigger messages when required.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel.setTyping?.(chatJid, true)?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }

      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }

}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Runs once at startup:
 * 1. Sends "✅ Online — N groups registered" to the admin group.
 * 2. For any group with a recent restarting.flag, sends "✅ Back online!" instead.
 */
async function sendRestartNotifications(): Promise<void> {
  const FIVE_MINUTES = 5 * 60 * 1000;

  // Send a general startup notification to the admin group
  const adminEntry = Object.entries(registeredGroups).find(([, g]) => g.isAdmin === true);
  if (adminEntry) {
    const [adminJid] = adminEntry;
    const adminChannel = findChannel(channels, adminJid);
    if (adminChannel) {
      const groupCount = Object.keys(registeredGroups).length;
      try {
        await adminChannel.sendMessage(adminJid, `✅ Online — ${groupCount} group${groupCount !== 1 ? 's' : ''} registered`);
      } catch (err) {
        logger.warn({ err }, 'Failed to send startup notification');
      }
    }
  }

  // Check for restarting.flag files and send group-specific back-online messages
  for (const [jid, group] of Object.entries(registeredGroups)) {
    const flagPath = path.join(resolveGroupFolderPath(group.folder), 'restarting.flag');
    try {
      if (!fs.existsSync(flagPath)) continue;

      const flagData = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      const flagAge = Date.now() - new Date(flagData.timestamp).getTime();

      if (flagAge < FIVE_MINUTES) {
        const channel = findChannel(channels, jid);
        if (channel) {
          logger.info({ group: group.name }, 'Restart flag detected — sending back-online notification');
          await channel.sendMessage(jid, '✅ Back online!');
        } else {
          logger.warn({ jid }, 'Restart flag found but no channel for JID');
        }
      } else {
        logger.info({ group: group.name, ageSeconds: Math.round(flagAge / 1000) }, 'Restart flag is stale, removing');
      }

      fs.unlinkSync(flagPath);
    } catch (err) {
      logger.warn({ group: group.name, err }, 'Restart flag check failed');
      // Clean up flag even on error
      try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
    }
  }
}


async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (DISCORD_BOT_TOKEN) {
    const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
    channels.push(discord);
    await discord.connect();
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, files) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, files);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    getAvailableGroups,
    writeGroupsSnapshot,
  });

  // Start webhook server for proactive event notifications (Composio and/or RetellAI)
  const hasComposio = !!COMPOSIO_WEBHOOK_SECRET;
  const hasRetell = true; // Always enable Retell route — signature verification is optional
  if (WEBHOOK_PORT && (hasComposio || hasRetell)) {
    startWebhookServer({
      port: WEBHOOK_PORT,
      composio: hasComposio ? {
        secret: COMPOSIO_WEBHOOK_SECRET,
        onEvent: (triggerName, payload) => {
          const adminEntry = Object.entries(registeredGroups).find(([, g]) => g.isAdmin === true);
          if (!adminEntry) {
            logger.warn('Webhook received but no admin group registered — cannot deliver notification');
            return;
          }
          const payloadStr = JSON.stringify(payload, null, 2);
          const truncatedPayload = payloadStr.length > 800 ? payloadStr.slice(0, 800) + '\n...(truncated)' : payloadStr;
          storeMessage({
            id: `webhook-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: adminEntry[0],
            sender: 'system:composio',
            sender_name: 'Webhook Event',
            content: `[Webhook] ${triggerName}\n${truncatedPayload}\n\n[Note: Your text output is suppressed for webhook events — the user will NOT see anything you say unless you use the send_message tool. If this is noteworthy, use send_message to notify the user. If it's noise (e.g. synchronize event, bot commit, welcome email), do nothing.]`,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          });
          logger.info({ triggerName, chatJid: adminEntry[0] }, 'Composio webhook event stored in conversation history');
        },
      } : undefined,
      retell: {
        apiKey: RETELL_API_KEY || undefined,
        onEvent: (_event, rawCall) => {
          // Find admin group
          const adminEntry = Object.entries(registeredGroups).find(([, g]) => g.isAdmin === true);
          if (!adminEntry) {
            logger.warn('Retell webhook received but no admin group registered');
            return;
          }
          // Resolve target group from RETELL_WEBHOOK_GROUP, fall back to admin
          let targetJid = adminEntry[0];
          if (RETELL_WEBHOOK_GROUP) {
            const targetEntry = Object.entries(registeredGroups).find(([, g]) => g.folder === RETELL_WEBHOOK_GROUP);
            if (targetEntry) {
              targetJid = targetEntry[0];
            } else {
              logger.warn({ folder: RETELL_WEBHOOK_GROUP }, 'RETELL_WEBHOOK_GROUP folder not found, falling back to admin');
            }
          }

          const call = rawCall as Record<string, unknown>;
          // Format call details
          const direction = String(call['direction'] ?? 'unknown');
          const fromNumber = String(call['from_number'] ?? 'unknown');
          const toNumber = String(call['to_number'] ?? 'unknown');
          const durationMs = Number(call['duration_ms'] ?? 0);
          const durationStr = durationMs > 0
            ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
            : 'unknown';
          const disconnectReason = call['disconnection_reason'] ? String(call['disconnection_reason']) : undefined;
          const callAnalysis = call['call_analysis'] as Record<string, unknown> | undefined;

          // Format transcript
          let transcriptText = '';
          const transcriptObj = call['transcript_object'] as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(transcriptObj) && transcriptObj.length > 0) {
            transcriptText = transcriptObj
              .map((t) => `${String(t['role'] ?? 'unknown')}: ${String(t['content'] ?? '')}`)
              .join('\n');
          } else if (call['transcript']) {
            transcriptText = String(call['transcript']);
          }

          // Build stored message
          const callSummaryParts = [
            `[Phone Call] ${direction} call from ${fromNumber} to ${toNumber} (${durationStr})`,
          ];
          if (disconnectReason) callSummaryParts.push(`Disconnect: ${disconnectReason}`);
          if (callAnalysis) {
            const analysisStr = JSON.stringify(callAnalysis);
            callSummaryParts.push(`Analysis: ${analysisStr.length > 300 ? analysisStr.slice(0, 300) + '...' : analysisStr}`);
          }
          if (transcriptText) {
            const excerpt = transcriptText.length > 500 ? transcriptText.slice(0, 500) + '...' : transcriptText;
            callSummaryParts.push(`Transcript excerpt:\n${excerpt}`);
          } else {
            callSummaryParts.push('(No transcript available)');
          }
          callSummaryParts.push('', '[Note: Your text output is suppressed for webhook events — the user will NOT see anything you say unless you use the send_message tool. If the caller made requests, take action. Always send a brief summary of the call via send_message.]');

          storeMessage({
            id: `retell-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: targetJid,
            sender: 'system:retell',
            sender_name: 'Phone Call',
            content: callSummaryParts.join('\n'),
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          });
          logger.info({ direction, fromNumber, chatJid: targetJid }, 'Retell call event stored in conversation history');
        },
      },
    });
  } else {
    logger.info('Webhook server not started (WEBHOOK_PORT not configured)');
  }

  queue.setProcessMessagesFn(processGroupMessages);
  await sendRestartNotifications();
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClawbster');
    process.exit(1);
  });
}
