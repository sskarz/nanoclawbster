/**
 * Retell AI WebSocket LLM Server
 *
 * Retell AI connects to this WebSocket endpoint when a phone call starts.
 * We receive live transcripts and send back Claude-powered responses.
 *
 * Protocol reference: https://docs.retellai.com/api-references/llm-websocket
 *
 * Message flow:
 *   Retell → Server: { interaction_type: "response_required"|"reminder_required", response_id, transcript }
 *   Server → Retell: { response_type: "response", response_id, content, content_complete }
 *
 * End call: set end_call: true in the response event.
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types matching Retell's WebSocket protocol
// ---------------------------------------------------------------------------

interface RetellTranscriptUtterance {
  role: 'agent' | 'user';
  content: string;
}

interface RetellIncomingEvent {
  interaction_type: 'ping_pong' | 'call_details' | 'update_only' | 'response_required' | 'reminder_required';
  response_id?: number;
  transcript?: RetellTranscriptUtterance[];
  timestamp?: number;
  call?: unknown;
}

interface RetellOutgoingConfig {
  response_type: 'config';
  auto_reconnect: boolean;
  call_details: boolean;
}

interface RetellOutgoingResponse {
  response_type: 'response';
  response_id: number;
  content: string;
  content_complete: boolean;
  end_call?: boolean;
}

interface RetellOutgoingPingPong {
  response_type: 'ping_pong';
  timestamp: number;
}

type RetellOutgoing = RetellOutgoingConfig | RetellOutgoingResponse | RetellOutgoingPingPong;

// ---------------------------------------------------------------------------
// Agent SDK helper
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Nano, an AI assistant built by Sanskar. You are calling Sanskar by phone via Retell AI.

Keep responses SHORT and conversational — this is a phone call. Speak naturally, like you would on the phone.
Aim for 1-3 sentences per turn. Be warm, clear, and direct.

If you have completed the purpose of the call, or if Sanskar says goodbye or asks to end the call,
end the conversation gracefully. When you want to end the call, include the phrase "[END_CALL]" at
the very end of your response (this will be stripped before speaking).

Do not mention that you are an AI unless directly asked.`;

/**
 * Call Claude via the Agent SDK and return the full text response.
 * Uses maxTurns: 1 for a single voice exchange turn.
 */
async function callClaudeAgentSdk(
  prompt: string,
  systemPrompt: string,
): Promise<string> {
  let responseText = '';

  for await (const message of query({
    prompt,
    options: {
      maxTurns: 1,
      systemPrompt,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === 'assistant') {
      // Extract text content blocks from the assistant message
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseText += block.text;
        }
      }
    } else if (message.type === 'result') {
      // SDKResultSuccess has a `result` field with the final text
      if (!message.is_error && 'result' in message && typeof message.result === 'string') {
        // Use the result field if we didn't already capture text from assistant messages
        if (!responseText.trim()) {
          responseText = message.result;
        }
      }
    }
  }

  return responseText.trim();
}

/**
 * Build a single prompt string from the Retell transcript for the Agent SDK.
 * The transcript is formatted as a conversation history, with the call purpose
 * prepended if provided.
 */
function buildPromptFromTranscript(
  transcript: RetellTranscriptUtterance[],
  callPurpose?: string,
): string {
  const lines: string[] = [];

  if (callPurpose) {
    lines.push(`[Call context: ${callPurpose}]`);
    lines.push('');
  }

  if (transcript.length === 0) {
    lines.push('(The call just started. Please greet the person.)');
  } else {
    lines.push('Conversation so far:');
    for (const utterance of transcript) {
      const role = utterance.role === 'agent' ? 'You' : 'User';
      lines.push(`${role}: ${utterance.content}`);
    }
    lines.push('');
    lines.push('Please respond to the user\'s last message.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// WebSocket LLM Handler
// ---------------------------------------------------------------------------

function handleRetellWebSocket(ws: WebSocket, callId: string, callPurpose?: string): void {
  logger.info({ callId, callPurpose }, 'Retell WebSocket connected');

  // Send initial config
  const config: RetellOutgoingConfig = {
    response_type: 'config',
    auto_reconnect: false,
    call_details: false,
  };
  ws.send(JSON.stringify(config));

  // Track the latest response_id to ignore stale requests
  let latestResponseId = -1;
  let isGenerating = false;

  ws.on('message', async (data: Buffer) => {
    let event: RetellIncomingEvent;
    try {
      event = JSON.parse(data.toString('utf-8')) as RetellIncomingEvent;
    } catch {
      logger.warn({ callId }, 'Failed to parse Retell WebSocket message');
      return;
    }

    // Handle ping-pong keepalive
    if (event.interaction_type === 'ping_pong') {
      const pong: RetellOutgoingPingPong = {
        response_type: 'ping_pong',
        timestamp: event.timestamp ?? Date.now(),
      };
      ws.send(JSON.stringify(pong));
      return;
    }

    // We only act on response_required and reminder_required
    if (
      event.interaction_type !== 'response_required' &&
      event.interaction_type !== 'reminder_required'
    ) {
      return;
    }

    const responseId = event.response_id ?? 0;
    latestResponseId = responseId;

    if (isGenerating) {
      // A new request came in — cancel the previous in-flight generation
      // (we'll just skip sending if latestResponseId has moved on)
    }

    const transcript = event.transcript ?? [];
    const prompt = buildPromptFromTranscript(transcript, callPurpose);

    isGenerating = true;

    try {
      logger.info({ callId, responseId, turns: transcript.length }, 'Calling Claude Agent SDK for Retell response');
      const rawContent = await callClaudeAgentSdk(prompt, SYSTEM_PROMPT);

      // Check if we should end the call
      const shouldEndCall = rawContent.includes('[END_CALL]');
      const content = rawContent.replace('[END_CALL]', '').trim();

      // Only send if this response_id is still current
      if (responseId !== latestResponseId) {
        logger.debug({ callId, responseId, latestResponseId }, 'Stale response discarded');
        return;
      }

      const response: RetellOutgoingResponse = {
        response_type: 'response',
        response_id: responseId,
        content: content || 'I\'m here, please go ahead.',
        content_complete: true,
        ...(shouldEndCall ? { end_call: true } : {}),
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
        logger.info({ callId, responseId, endCall: shouldEndCall }, 'Sent Retell response');
      }
    } catch (err) {
      logger.error({ callId, responseId, err }, 'Error generating Retell response');

      // Send a fallback response so the call doesn't hang
      if (responseId === latestResponseId && ws.readyState === WebSocket.OPEN) {
        const fallback: RetellOutgoingResponse = {
          response_type: 'response',
          response_id: responseId,
          content: 'Sorry, I had a technical issue. Let me call you back.',
          content_complete: true,
          end_call: true,
        };
        ws.send(JSON.stringify(fallback));
      }
    } finally {
      isGenerating = false;
    }
  });

  ws.on('close', (code, reason) => {
    logger.info({ callId, code, reason: reason.toString() }, 'Retell WebSocket closed');
  });

  ws.on('error', (err) => {
    logger.error({ callId, err }, 'Retell WebSocket error');
  });
}

// ---------------------------------------------------------------------------
// Public API: attach Retell WebSocket server to an existing HTTP server
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket server to handle Retell LLM connections.
 *
 * Retell connects to: wss://<host>/llm-websocket/<call_id>
 * The call_id comes from the URL path (Retell appends it automatically).
 *
 * Optional query param: ?purpose=<encoded string> — passed as the call purpose
 * to Claude's system context.
 */
export function attachRetellWebSocketServer(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // Match /llm-websocket or /llm-websocket/<call_id>
    if (!pathname.startsWith('/llm-websocket')) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const parts = pathname.split('/').filter(Boolean);
      const callId = parts[1] ?? 'unknown';
      const callPurpose = url.searchParams.get('purpose') ?? undefined;

      wss.emit('connection', ws, request);
      handleRetellWebSocket(ws, callId, callPurpose);
    });
  });

  logger.info('Retell WebSocket LLM server attached at /llm-websocket');
}
