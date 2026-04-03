/**
 * HTTP webhook receiver for Composio and RetellAI events.
 * Uses only Node.js built-in http and crypto modules — no new dependencies.
 *
 * Composio webhook verification (from docs.composio.dev/docs/webhook-verification):
 *   Headers: webhook-id, webhook-timestamp, webhook-signature
 *   Signing string: "${webhook-id}.${webhook-timestamp}.${body}"
 *   Secret: raw string (as-is from dashboard)
 *   Signature header: "v1,<base64>" — strip prefix, compare base64 HMAC-SHA256
 *
 * RetellAI webhook verification:
 *   Header: x-retell-signature = "v=<timestamp_ms>,d=<hex_hmac>"
 *   HMAC-SHA256(body + timestamp, apiKey) → compare hex digest (timing-safe)
 *   5-minute freshness check on timestamp.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { URL } from 'url';
import { logger } from './logger.js';

export type WebhookEventHandler = (triggerName: string, data: unknown) => void;
export type RetellEventHandler = (event: string, call: unknown) => void;

export interface FitbitOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenPath: string;
}

export interface WebhookServerConfig {
  port: number;
  composio?: { secret: string; onEvent: WebhookEventHandler };
  retell?: { apiKey?: string; onEvent: RetellEventHandler };
  fitbit?: FitbitOAuthConfig;
}

const MAX_TIMESTAMP_AGE_S = 300; // 5 minutes
const MAX_BODY = 1_048_576;

function verifyComposioSignature(
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

function verifyRetellSignature(
  body: string,
  apiKey: string,
  sigHeader: string | undefined,
): boolean {
  if (!sigHeader) return false;

  // Parse "v=<timestamp_ms>,d=<hex_digest>"
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      parts[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }

  const timestamp = parts['v'];
  const digest = parts['d'];
  if (!timestamp || !digest) return false;

  // Freshness check (timestamp is in milliseconds)
  const tsMs = parseInt(timestamp, 10);
  if (isNaN(tsMs)) return false;
  if (Math.abs(Date.now() - tsMs) > MAX_TIMESTAMP_AGE_S * 1000) return false;

  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(body + timestamp)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
  } catch {
    return false;
  }
}

/** Read the full request body with size limit. Returns null if aborted. */
function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY && !aborted) {
        aborted = true;
        req.destroy();
        res.writeHead(413);
        res.end('Payload too large');
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) { resolve(null); return; }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      if (!aborted) {
        logger.error({ err }, 'Webhook request error');
        res.writeHead(500);
        res.end('Error');
      }
      resolve(null);
    });
  });
}

/** Exchange a Fitbit OAuth authorization code for tokens and save to disk. */
function exchangeFitbitCode(
  code: string,
  fitbit: FitbitOAuthConfig,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${fitbit.clientId}:${fitbit.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: fitbit.redirectUri,
    }).toString();

    const options = {
      hostname: 'api.fitbit.com',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (chunk: Buffer) => chunks.push(chunk));
      resp.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let json: Record<string, unknown>;
        try { json = JSON.parse(raw); }
        catch { reject(new Error(`Fitbit token response not JSON: ${raw.slice(0, 200)}`)); return; }

        if (resp.statusCode !== 200) {
          reject(new Error(`Fitbit token exchange failed (${resp.statusCode}): ${raw.slice(0, 200)}`));
          return;
        }

        // Add expires_at for the mcp-fitbit token refresh logic
        const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 28800;
        json['expires_at'] = new Date(Date.now() + expiresIn * 1000).toISOString();

        // Ensure token directory exists
        const tokenDir = path.dirname(fitbit.tokenPath);
        try { fs.mkdirSync(tokenDir, { recursive: true }); } catch { /* ignore */ }

        fs.writeFileSync(fitbit.tokenPath, JSON.stringify(json, null, 2), 'utf-8');
        logger.info({ tokenPath: fitbit.tokenPath }, 'Fitbit token saved successfully');
        resolve();
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function startWebhookServer(config: WebhookServerConfig): void {
  const server = http.createServer(async (req, res) => {
    // Route: Fitbit OAuth callback (GET)
    if (req.method === 'GET' && req.url?.startsWith('/fitbit/callback') && config.fitbit) {
      const parsed = new URL(req.url, `http://localhost`);
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');

      if (error || !code) {
        const reason = error ?? 'missing code parameter';
        logger.warn({ reason }, 'Fitbit OAuth callback failed');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Fitbit Auth Failed</title></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>❌ Fitbit Authorization Failed</h2><p>Reason: ${reason}</p><p>Please try again.</p></body></html>`);
        return;
      }

      try {
        await exchangeFitbitCode(code, config.fitbit);
        logger.info('Fitbit OAuth flow completed successfully');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Fitbit Connected</title></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>✅ Fitbit Connected Successfully!</h2><p>Your Fitbit account is now linked. You can close this tab.</p></body></html>`);
      } catch (err) {
        logger.error({ err }, 'Fitbit token exchange error');
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Fitbit Auth Error</title></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>❌ Fitbit Authorization Error</h2><p>Something went wrong during token exchange. Please try again.</p></body></html>`);
      }
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404); res.end('Not found'); return;
    }

    // Route: Composio
    if (req.url === '/webhook/composio' && config.composio) {
      const body = await readBody(req, res);
      if (body === null) return;

      const webhookId = req.headers['webhook-id'] as string | undefined;
      const timestamp = req.headers['webhook-timestamp'] as string | undefined;
      const sigHeader = req.headers['webhook-signature'] as string | undefined;
      if (!verifyComposioSignature(body, config.composio.secret, webhookId, timestamp, sigHeader)) {
        logger.warn({ webhookId, timestamp, sigHeader: sigHeader?.slice(0, 30), bodyLen: body.length }, 'Webhook signature verification failed');
        res.writeHead(401); res.end('Unauthorized'); return;
      }

      let raw: unknown;
      try { raw = JSON.parse(body); }
      catch { res.writeHead(400); res.end('Bad request'); return; }

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
      try { config.composio.onEvent(triggerName, data); }
      catch (err) { logger.error({ err }, 'Webhook event handler threw'); }
      return;
    }

    // Route: RetellAI
    if (req.url === '/webhook/retell' && config.retell) {
      const body = await readBody(req, res);
      if (body === null) return;

      // Verify signature if API key is configured
      if (config.retell.apiKey) {
        const sigHeader = req.headers['x-retell-signature'] as string | undefined;
        if (!verifyRetellSignature(body, config.retell.apiKey, sigHeader)) {
          logger.warn({ sigHeader: sigHeader?.slice(0, 30), bodyLen: body.length }, 'Retell webhook signature verification failed');
          res.writeHead(401); res.end('Unauthorized'); return;
        }
      }

      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch { res.writeHead(400); res.end('Bad request'); return; }

      const payload = parsed as Record<string, unknown>;
      const event = String(payload['event'] ?? '');
      const call = payload['call'];

      // Only process call_analyzed — it contains everything from call_ended
      // plus sentiment/analysis data.  Processing both causes duplicate reports
      // and the second task's container can hang, blocking messages.
      if (event !== 'call_analyzed') {
        res.writeHead(200); res.end('OK'); return;
      }

      logger.info({ event, callId: (call as Record<string, unknown>)?.['call_id'] }, 'Retell webhook received');
      res.writeHead(200); res.end('OK');
      try { config.retell.onEvent(event, call); }
      catch (err) { logger.error({ err }, 'Retell event handler threw'); }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('error', (err) => logger.error({ err, port: config.port }, 'Webhook server error'));

  const routes: string[] = [];
  if (config.composio) routes.push('/webhook/composio');
  if (config.retell) routes.push('/webhook/retell');
  if (config.fitbit) routes.push('/fitbit/callback');
  server.listen(config.port, () => logger.info({ port: config.port, routes }, 'Webhook server listening'));
}
