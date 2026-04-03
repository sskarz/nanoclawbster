import fs from 'fs';
import path from 'path';

/** Read key=value pairs from the .env file, ignoring comments and blank lines. */
function readEnvFile(filePath: string): Record<string, string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      const allowedKeys = [
        'DISCORD_BOT_TOKEN',
        'COMPOSIO_API_KEY',
        'COMPOSIO_WEBHOOK_SECRET',
        'ANTHROPIC_API_KEY',
        'RETELL_API_KEY',
        'RETELL_WEBHOOK_GROUP',
        'WEBHOOK_PORT',
        'ASSISTANT_NAME',
        'FITBIT_CLIENT_ID',
        'FITBIT_CLIENT_SECRET',
        'FITBIT_REDIRECT_URI',
        'FITBIT_TOKEN_PATH',
      ];
      if (allowedKeys.includes(key)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

const envConfig = readEnvFile(path.join('/workspace/project', '.env'));

export const ASSISTANT_NAME: string = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const IDLE_TIMEOUT = 5 * 60 * 1000;
export const MAX_SESSION_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const DATA_DIR = '/workspace/project/data';

export const DISCORD_BOT_TOKEN: string =
  process.env['DISCORD_BOT_TOKEN'] ?? envConfig['DISCORD_BOT_TOKEN'] ?? '';

export const COMPOSIO_API_KEY: string =
  process.env['COMPOSIO_API_KEY'] ?? envConfig['COMPOSIO_API_KEY'] ?? '';

export const COMPOSIO_WEBHOOK_SECRET: string =
  process.env['COMPOSIO_WEBHOOK_SECRET'] ?? envConfig['COMPOSIO_WEBHOOK_SECRET'] ?? '';

export const ANTHROPIC_API_KEY: string =
  process.env['ANTHROPIC_API_KEY'] ?? envConfig['ANTHROPIC_API_KEY'] ?? '';

export const RETELL_API_KEY: string =
  process.env['RETELL_API_KEY'] ?? envConfig['RETELL_API_KEY'] ?? '';

export const RETELL_WEBHOOK_GROUP: string =
  process.env['RETELL_WEBHOOK_GROUP'] ?? envConfig['RETELL_WEBHOOK_GROUP'] ?? '';

export const WEBHOOK_PORT: number = parseInt(
  process.env['WEBHOOK_PORT'] ?? envConfig['WEBHOOK_PORT'] ?? '3456',
  10,
);

export const TRIGGER_PATTERN = new RegExp(
  `@${ASSISTANT_NAME}`,
  'i',
);

export const FITBIT_CLIENT_ID: string =
  process.env['FITBIT_CLIENT_ID'] ?? envConfig['FITBIT_CLIENT_ID'] ?? '';

export const FITBIT_CLIENT_SECRET: string =
  process.env['FITBIT_CLIENT_SECRET'] ?? envConfig['FITBIT_CLIENT_SECRET'] ?? '';

export const FITBIT_REDIRECT_URI: string =
  process.env['FITBIT_REDIRECT_URI'] ?? envConfig['FITBIT_REDIRECT_URI'] ?? 'https://nanoclawbster.sanskar.dev/fitbit/callback';

export const FITBIT_TOKEN_PATH: string =
  process.env['FITBIT_TOKEN_PATH'] ?? envConfig['FITBIT_TOKEN_PATH'] ?? '/workspace/group/mcp-servers/node_modules/mcp-fitbit/.fitbit-token.json';
