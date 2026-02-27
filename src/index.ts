import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { runContainerAgent, writeGroupsSnapshot, writeStatsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { Discord } from './channels/discord.js';
import { WhatsApp } from './channels/whatsapp.js';
import { Telegram } from './channels/telegram.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { startTaskScheduler } from './task-scheduler.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { readDb } from './db.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

import path from 'path';
import fs from 'fs';

/** @internal - exported for testing */
export function resolveRegisteredGroupsPath() {
  return path.join(DATA_DIR, 'registered_groups.json');
}

export function loadRegisteredGroups(): RegisteredGroup[] {
  const path = resolveRegisteredGroupsPath();
  if (!fs.existsSync(path)) return [];
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

export function saveRegisteredGroups(groups: RegisteredGroup[]) {
  const path = resolveRegisteredGroupsPath();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path, JSON.stringify(groups, null, 2));
}

/**
 * Register a new group, adding it to the persistent storage.
 * Safe to call from multiple paths - checks for duplicates.
 */
export function registerGroup(group: RegisteredGroup): { success: boolean; alreadyExisted: boolean } {
  const groups = loadRegisteredGroups();
  const existing = groups.find((g) => g.folder === group.folder);
  if (existing) return { success: true, alreadyExisted: true };
  groups.push(group);
  saveRegisteredGroups(groups);
  return { success: true, alreadyExisted: false };
}

/**
 * Get all available WhatsApp groups for display to the main group.
 */
export function getAvailableGroups() {
  if (!whatsapp) return [];
  const allGroups = whatsapp.getAllGroups();
  const registered = loadRegisteredGroups();
  const registeredJids = new Set(registered.map((g) => g.folder));

  return allGroups.map((group) => ({
    jid: group.jid,
    name: group.name || 'Unknown',
    lastActivity: group.lastActivity,
    isRegistered: registeredJids.has(group.jid),
  }));
}

let whatsapp: WhatsApp | undefined;
// Exposed for testing
/** @internal */
export function getWhatsApp() { return whatsapp; }

async function main() {
  const channels: Channel[] = [];

  // Discord -- try to connect if configured
  let discord: Discord | undefined;
  let telegram: Telegram | undefined;
  try {
    discord = new Discord();
    await discord.connect();
    channels.push(discord);
    logger.info('Discord connected');
  } catch (err) {
    logger.warn({ err }, 'Discord not configured or failed to connect');
  }
  try {
    telegram = new Telegram();
    await telegram.connect();
    channels.push(telegram);
    logger.info('Telegram connected');
  } catch (err) {
    logger.warn({ err }, 'Telegram not configured or failed to connect');
  }

  // WhatsApp -- try to connect if configured
  try {
    whatsapp = new WhatsApp();
    await whatsapp.connect();
    channels.push(whatsapp);
    logger.info('WhatsApp connected');
  } catch err {
    logger.warn({ err }, 'WhatsApp not configured or failed to connect');
  }

  if (channels.length === 0) {
    logger.error('No channels connected');
    process.exit(1);
  }

  const queue = new GroupQueue();

  // Registered groups in memory (loaded from disk)
  let registeredGroups: RegisteredGroup[] = loadRegisteredGroups();
  logger.info(
    { count: registeredGroups.length },
    'Loaded registered groups',
  );

  // Keep registeredGroups in sync with disk
  const reloadRegisteredGroups = () => {
    registeredGroups = loadRegisteredGroups();
  };

  // Discord routing -- use Discord JIDs directly for catch-all routing
  const discordRouting = async (
    chatJid: string,
    message: NewMessage,
  ) => {
    // Find a matching registered group for this Discord channel/DM
    const matchedGroup = registeredGroups.find((g) => {
      const gjid = g.folder;
      // Check for direct JID match
      if (gjid === chatJid) return true;
      // Check for Discord prefixed JID
      if (gjid.startsWith('dc:') && gjid === chatJid) return true;
      return false;
    });

    if (matchedGroup) {
      // Use the matched group's configuration
      const raw = message.content;
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (!text) return;

      await channel.setTyping?.(chatJid, true);
      const isMain = matchedGroup.folder === channels.find((c) => c.ownsJid(chatJid))?.constructor.name;
      await queue.enqueue(chatJid, {
        group: matchedGroup,
        prompt: formatMessages([message]),
        chatJid,
        isMain: false,
      });
      return;
    }
  };

  // Typing indicator tracking
  let channel: Channel | undefined;
  for (const c of channels) {
    if (c instanceof Discord) {
      channel = c;
      break;
    }
  }

  const onInboundMessage = async (chatJid: string, message: NewMessage) => {
    // Ignore messages from ourselves
    if (message.is_from_me || message.is_bot_message) return;

    // Reload registered groups from disk on each message to pick up new registrations
    reloadRegisteredGroups();

    // Discord catch-all routing
    if (chatJid.startsWith('dc:')) {
      const discordChannel = findChannel(channels, chatJid);
      if (!discordChannel) {
        logger.warn({ chatJid }, 'No channel found for Discord JID');
        return;
      }
      const raw = message.content;
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (!text) return;

      // Find matching registered group for this Discord channel
      const matchedGroup = registeredGroups.find((g) => {
        const gjid = g.folder;
        if (gjid === chatJid) return true;
        if (gjid.startsWith('dc:') && gjid === chatJid) return true;
        return false;
      });

      if (matchedGroup) {
        // Route to matched registered group
        await discordChannel.setTyping?.(chatJid, true);
        queue.enqueue(chatJid, {
          group: matchedGroup,
          prompt: formatMessages([message]),
          chatJid: chatJid,
          isMain: false,
        });
      } else {
        logger.debug({ chatJid }, 'No matching group for Discord channel, ignoring');
      }
      return;
    }

    // WhatsApp and Telegram routing
    const group = registeredGroups.find((g) => g.folder === chatJid);
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered chat, ignoring');
      return;
    }

    // Check if this group requires a trigger word
    const requiresTrigger = group.requiresTrigger !== false; // Default true
    if (requiresTrigger) {
      const triggerWord = group.trigger || ASSISTANT_NAME;
      const mentioned = message.content.includes(triggerWord);
      if (!mentioned) {
        logger.debug({ chatJid, triggerWord }, 'Message did not mention trigger word, ignoring');
        return;
      }
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel found for JID, ignoring');
      return;
    }

    // Determine if this is the main group
    const mainGroup = registeredGroups.find((g) => g.isMain);
    const isMain = mainGroup?.folder === group.folder;

    // If an active container is running for this chat, pipe the message in
    if (queue.sendMessage(chatJid, formatMessages([message]))) {
      logger.info({ chatJid }, 'Message piped to active container');
      // Show typing indicator while the container processes the piped message
      channel.setTyping?.(chatJid, true).catch((err) =>
        logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
      );
      return;
    }

    // Start a new container
    channel.setTyping?.(chatJid, true).catch((err) =>
      logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
    );

    const chatHistory = await readDb(group.folder, 50);
    const chatHistoryLast4 = chatHistory.slice(-4);

    logger.info(
      { chatJid, group: group.name, isMain },
      'Enqueuing message for processing',
    );
    queue.enqueue(chatJid, {
      group,
      prompt: formatMessages(chatHistoryLast4),
      chatJid,
      isMain,
    });
  };

  // Attach onInboundMessage handler to all channels
  for (const channel of channels) {
    channel.onMessage = onInboundMessage;
  }

  const onChatMetadata = async (
    chatJid: string,
    timestamp: string,
    name?: string,
  ) => {
    // Nothing to do for now
  };

  // Start GroupQueue
  await queue.start({
    runContainerAgent,
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
      const filtered = formatOutbound(text);
      if (!filtered) return Promise.resolve();
      return channel.sendMessage(jid, filtered, files);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });

  // Start task scheduler
  await startTaskScheduler({
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel for task message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    runContainerAgent,
    writeTasksSnapshot,
    writeStatsSnapshot,
    channels,
  });

  // Send startup notification to registered groups
  for (const group of registeredGroups) {
    const channel = findChannel(channels, group.folder);
    if (channel) {
      await channel.sendMessage(group.folder, '✅ Back online!');
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled error in main');
  process.exit(1);
});
