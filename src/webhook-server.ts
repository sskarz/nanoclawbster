/**
 * HTTP webhook receiver for Composio trigger events.
 * Uses only Node.js built-in http and crypto modules — no new dependencies.
 */
import crypto from 'crypto';
import http from 'http';
import { logger } from './logger.js';

export type WebhookEventHandler = (triggerName: string, data: unknown) => void;

function verifySignature(body: Buffer, secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const parts = header.split(',');
  if (parts.length !== 2 || parts[0] !== 'v1') return false;
  const received = parts[1];
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
  try {
    const a = Buffer.from(received, 'base64');
    const b = Buffer.from(expected, 'base64');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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
      const body = Buffer.concat(chunks);
      const sigHeader = req.headers['x-composio-signature'] as string | undefined;
      if (!verifySignature(body, secret, sigHeader)) {
        logger.warn({ sigHeader }, 'Webhook signature verification failed');
        res.writeHead(401); res.end('Unauthorized'); return;
      }
      let raw: unknown;
      try { raw = JSON.parse(body.toString('utf-8')); }
      catch { res.writeHead(400); res.end('Bad request'); return; }
      const payload = raw as Record<string, unknown>;
      const metadata = payload['metadata'] as Record<string, unknown> | undefined;
      const data = payload['data'];
      const triggerName = metadata ? String(metadata['triggerName'] ?? '') : '';
      if (!triggerName) {
        logger.warn({ raw }, 'Webhook missing metadata.triggerName');
        res.writeHead(400); res.end('Bad request'); return;
      }
      logger.info({ triggerName }, 'Composio webhook received');
      res.writeHead(200); res.end('OK');
      try { onEvent(triggerName, data); }
      catch (err) { logger.error({ err }, 'Webhook event handler threw'); }
    });
    req.on('error', (err) => { if (!aborted) { logger.error({ err }, 'Webhook request error'); res.writeHead(500); res.end('Error'); } });
  });
  server.on('error', (err) => logger.error({ err, port }, 'Webhook server error'));
  server.listen(port, () => logger.info({ port }, 'Webhook server listening on /webhook/composio'));
}
