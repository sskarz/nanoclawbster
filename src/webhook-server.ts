/**
 * HTTP webhook receiver for Composio trigger events.
 * Uses only Node.js built-in http and crypto modules — no new dependencies.
 *
 * Composio webhook verification (from docs.composio.dev/docs/webhook-verification):
 *   Headers: webhook-id, webhook-timestamp, webhook-signature
 *   Signing string: "${webhook-id}.${webhook-timestamp}.${body}"
 *   Secret: raw string (as-is from dashboard)
 *   Signature header: "v1,<base64>" — strip prefix, compare base64 HMAC-SHA256
 */
import crypto from 'crypto';
import http from 'http';
import { logger } from './logger.js';

export type WebhookEventHandler = (triggerName: string, data: unknown) => void;

const MAX_TIMESTAMP_AGE_S = 300; // 5 minutes

function verifySignature(
  body: string,
  secret: string,
  webhookId: string | undefined,
  timestamp: string | undefined,
  sigHeader: string | undefined,
): boolean {
  if (!webhookId || !timestamp || !sigHeader) return false;

  // Validate timestamp freshness
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_TIMESTAMP_AGE_S) return false;

  const signingString = `${webhookId}.${timestamp}.${body}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signingString)
    .digest('base64');

  // webhook-signature can have multiple space-delimited signatures
  const signatures = sigHeader.split(' ');
  for (const sig of signatures) {
    const received = sig.includes(',') ? sig.split(',')[1] : sig;
    if (!received) continue;
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function startWebhookServer(port: number, secret: string, onEvent: WebhookEventHandler): void {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook/composio') {
      res.writeHead(404); res.end('Not found'); return;
    }
    const MAX_BODY = 1_048_576;
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY && !aborted) { aborted = true; req.destroy(); res.writeHead(413); res.end('Payload too large'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks).toString('utf-8');
      const webhookId = req.headers['webhook-id'] as string | undefined;
      const timestamp = req.headers['webhook-timestamp'] as string | undefined;
      const sigHeader = req.headers['webhook-signature'] as string | undefined;
      if (!verifySignature(body, secret, webhookId, timestamp, sigHeader)) {
        logger.warn({ webhookId, timestamp, sigHeader: sigHeader?.slice(0, 30), bodyLen: body.length }, 'Webhook signature verification failed');
        res.writeHead(401); res.end('Unauthorized'); return;
      }
      let raw: unknown;
      try { raw = JSON.parse(body); }
      catch { res.writeHead(400); res.end('Bad request'); return; }
      // Support V3 (metadata.trigger_slug) and V1 (trigger_name) payload formats
      const payload = raw as Record<string, unknown>;
      const metadata = payload['metadata'] as Record<string, unknown> | undefined;
      const data = payload['data'] ?? payload['payload'];
      const triggerName = metadata
        ? String(metadata['trigger_slug'] ?? metadata['triggerName'] ?? '')
        : String(payload['trigger_name'] ?? '');
      if (!triggerName) {
        logger.warn('Webhook missing trigger name in payload');
        res.writeHead(400); res.end('Bad request'); return;
      }
      logger.info({ triggerName, webhookId }, 'Composio webhook received');
      res.writeHead(200); res.end('OK');
      try { onEvent(triggerName, data); }
      catch (err) { logger.error({ err }, 'Webhook event handler threw'); }
    });
    req.on('error', (err) => { if (!aborted) { logger.error({ err }, 'Webhook request error'); res.writeHead(500); res.end('Error'); } });
  });
  server.on('error', (err) => logger.error({ err, port }, 'Webhook server error'));
  server.listen(port, () => logger.info({ port }, 'Webhook server listening on /webhook/composio'));
}
