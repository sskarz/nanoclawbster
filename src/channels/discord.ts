import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Client, Events, GatewayIntentBits, Message, Partials, TextChannel } from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Handle reply context — include who the user is replying to.
      // This must run BEFORE mention detection so that the trigger
      // prepended below still lands at the start of the final string.
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger so TRIGGER_PATTERN matches at the start.
          // At this point content may be "[Reply to X] message" so we
          // always prepend rather than checking TRIGGER_PATTERN first.
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Download attachments for the agent to read
      if (message.attachments.size > 0) {
        const receivedDir = path.join(resolveGroupIpcPath(group.folder), 'received');
        fs.mkdirSync(receivedDir, { recursive: true });
        const MAX_SIZE = 25 * 1024 * 1024;
        const lines: string[] = [];
        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          if (contentType.startsWith('video/')) {
            lines.push(`[Video: ${att.name || 'video'} (not downloaded)]`);
            continue;
          }
          if (att.size > MAX_SIZE) {
            lines.push(`[File too large: ${att.name} (${(att.size / 1024 / 1024).toFixed(1)} MB)]`);
            continue;
          }
          const safeName = `${msgId}-${(att.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          const hostPath = path.join(receivedDir, safeName);
          const containerPath = `/workspace/ipc/received/${safeName}`;
          try {
            const resp = await fetch(att.url);
            fs.writeFileSync(hostPath, Buffer.from(await resp.arrayBuffer()));
            if (process.getuid?.() === 0) {
              try { execSync(`chown 1000:1000 ${JSON.stringify(hostPath)}`, { stdio: 'ignore' }); } catch {}
            }
            lines.push(contentType.startsWith('image/')
              ? `[Image: ${att.name} → ${containerPath}]`
              : `[File: ${att.name} → ${containerPath}]`);
          } catch (err) {
            logger.warn({ name: att.name, err }, 'Failed to download Discord attachment');
            lines.push(`[Attachment download failed: ${att.name}]`);
          }
        }
        if (lines.length > 0) {
          content = content ? `${content}\n${lines.join('\n')}` : lines.join('\n');
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string, files?: string[]): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Extract image URLs and strip them from the text
      const IMAGE_URL_RE = /(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?)/gi;
      const imageUrls = [...text.matchAll(IMAGE_URL_RE)].map((m) => m[0]);
      const cleanText = text.replace(IMAGE_URL_RE, '').replace(/\n{3,}/g, '\n\n').trim();

      const MAX_LENGTH = 2000;

      // Merge file-path attachments with extracted image URLs
      // discord.js accepts both absolute file paths and URLs in the files array
      const allFiles = [...(files ?? []), ...imageUrls];

      if (allFiles.length > 0) {
        // Send first chunk with all attachments
        const firstChunk = cleanText.slice(0, MAX_LENGTH) || undefined;
        await textChannel.send({ content: firstChunk, files: allFiles });
        // Send any remaining text as plain follow-up messages
        for (let i = MAX_LENGTH; i < cleanText.length; i += MAX_LENGTH) {
          await textChannel.send(cleanText.slice(i, i + MAX_LENGTH));
        }
      } else {
        // Text-only path
        if (cleanText.length <= MAX_LENGTH) {
          await textChannel.send(cleanText);
        } else {
          for (let i = 0; i < cleanText.length; i += MAX_LENGTH) {
            await textChannel.send(cleanText.slice(i, i + MAX_LENGTH));
          }
        }
      }
      logger.info({ jid, length: text.length, images: imageUrls.length, attachments: files?.length ?? 0 }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}