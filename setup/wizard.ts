/**
 * Interactive setup wizard for NanoClawbster.
 * Runs after `setup.sh` bootstraps Node.js and npm.
 *
 * Usage: npx tsx setup/wizard.ts
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { REGISTERED_GROUPS_SCHEMA } from '../src/db-schema.js';
import { commandExists, getPlatform, isWSL } from './platform.js';

const PROJECT_ROOT = process.cwd();

// ─── Terminal helpers ──────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function heading(text: string): void {
  console.log(`\n${BOLD}${CYAN}=== ${text} ===${RESET}\n`);
}

function success(text: string): void {
  console.log(`${GREEN}✓${RESET} ${text}`);
}

function warn(text: string): void {
  console.log(`${YELLOW}!${RESET} ${text}`);
}

function fail(text: string): void {
  console.log(`${RED}✗${RESET} ${text}`);
}

function info(text: string): void {
  console.log(`${DIM}  ${text}${RESET}`);
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${BOLD}${question}${RESET} `, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a secret value. Masks input with asterisks.
 * Falls back to normal readline if masking fails.
 */
function askSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    const output = rl.output as NodeJS.WritableStream;
    const input = rl.input as NodeJS.ReadableStream;

    output.write(`${BOLD}${question}${RESET} `);

    let secret = '';
    const stdin = input as typeof process.stdin;
    const wasRaw = stdin.isRaw;

    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }

    const onData = (key: Buffer): void => {
      const char = key.toString();

      if (char === '\n' || char === '\r') {
        // Enter pressed
        if (typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.removeListener('data', onData);
        output.write('\n');
        resolve(secret);
      } else if (char === '\x03') {
        // Ctrl+C
        if (typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(wasRaw ?? false);
        }
        process.exit(130);
      } else if (char === '\x7f' || char === '\b') {
        // Backspace
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
          output.write('\b \b');
        }
      } else if (char.length === 1 && char.charCodeAt(0) >= 32) {
        secret += char;
        output.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await ask(rl, `${question} ${hint}`);
  if (answer === '') return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

// ─── Step 1: Docker check ──────────────────────────────────────────────────

async function stepDocker(rl: readline.Interface): Promise<void> {
  heading('Step 1: Docker');

  // Check if Docker is running
  if (commandExists('docker')) {
    try {
      execSync('docker info', { stdio: 'ignore' });
      success('Docker is installed and running');
      return;
    } catch {
      warn('Docker is installed but not running');
      const platform = getPlatform();
      if (platform === 'macos') {
        console.log('  Starting Docker Desktop...');
        try {
          execSync('open -a Docker', { stdio: 'ignore' });
        } catch {
          fail('Could not start Docker Desktop. Please start it manually.');
          process.exit(1);
        }
      } else if (platform === 'linux') {
        console.log('  Starting Docker daemon...');
        try {
          execSync('sudo systemctl start docker', { stdio: 'inherit' });
        } catch {
          fail('Could not start Docker. Please start it manually.');
          process.exit(1);
        }
      }

      // Poll for Docker to be ready
      console.log('  Waiting for Docker to start...');
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          execSync('docker info', { stdio: 'ignore' });
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!ready) {
        fail('Docker did not start in time. Please start it and re-run setup.');
        process.exit(1);
      }
      success('Docker is now running');
      return;
    }
  }

  // Docker not found — offer to install
  warn('Docker is not installed');
  const shouldInstall = await confirm(rl, 'Install Docker now?');
  if (!shouldInstall) {
    fail('Docker is required. Please install it and re-run setup.');
    process.exit(1);
  }

  const platform = getPlatform();
  if (platform === 'linux') {
    console.log('  Installing Docker via get.docker.com...');
    try {
      execSync('curl -fsSL https://get.docker.com | sudo sh', {
        stdio: 'inherit',
        timeout: 300000,
      });
      execSync('sudo usermod -aG docker $USER', { stdio: 'inherit' });
      success('Docker installed');
      info('You may need to log out and back in for group changes to take effect.');
    } catch {
      fail('Docker installation failed. Please install manually: https://docs.docker.com/engine/install/');
      process.exit(1);
    }
  } else if (platform === 'macos') {
    if (commandExists('brew')) {
      console.log('  Installing Docker Desktop via Homebrew...');
      try {
        execSync('brew install --cask docker', { stdio: 'inherit' });
        execSync('open -a Docker', { stdio: 'ignore' });
        success('Docker Desktop installed and starting');
      } catch {
        fail('Homebrew Docker install failed.');
        console.log('  Please install Docker Desktop from: https://docker.com/products/docker-desktop');
        process.exit(1);
      }
    } else {
      console.log('  Please install Docker Desktop from: https://docker.com/products/docker-desktop');
      fail('Homebrew not found — cannot auto-install Docker.');
      process.exit(1);
    }
  } else {
    fail('Unsupported platform for Docker auto-install.');
    process.exit(1);
  }

  // Wait for Docker to be ready after install
  console.log('  Waiting for Docker to be ready...');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      execSync('docker info', { stdio: 'ignore' });
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!ready) {
    warn('Docker may not be ready yet. You can continue and it should work when Docker finishes starting.');
  } else {
    success('Docker is ready');
  }
}

// ─── Step 2: Credentials ───────────────────────────────────────────────────

function readEnv(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      let val = match[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[match[1]] = val;
    }
  }
  return result;
}

function writeEnv(values: Record<string, string>): void {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const examplePath = path.join(PROJECT_ROOT, '.env.example');

  let content: string;
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  } else if (fs.existsSync(examplePath)) {
    content = fs.readFileSync(examplePath, 'utf-8');
  } else {
    content = '';
  }

  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      content = content.trimEnd() + '\n' + line + '\n';
    }
  }

  fs.writeFileSync(envPath, content);
}

async function stepCredentials(rl: readline.Interface): Promise<{ assistantName: string }> {
  heading('Step 2: Credentials');

  const existingEnv = readEnv();
  let discordToken = existingEnv.DISCORD_BOT_TOKEN || '';
  let anthropicKey = existingEnv.ANTHROPIC_API_KEY || '';
  let oauthToken = existingEnv.CLAUDE_CODE_OAUTH_TOKEN || '';
  let assistantName = existingEnv.ASSISTANT_NAME || 'Andy';

  // Discord bot token
  if (discordToken) {
    success(`Discord bot token already configured`);
    const reconfig = await confirm(rl, 'Reconfigure Discord token?', false);
    if (reconfig) discordToken = '';
  }

  if (!discordToken) {
    console.log(`\n  To create a Discord bot:`);
    console.log(`  1. Go to ${CYAN}https://discord.com/developers/applications${RESET}`);
    console.log(`  2. Click "New Application" → name it → go to "Bot" tab`);
    console.log(`  3. Click "Reset Token" and copy it`);
    console.log(`  4. Under "Privileged Gateway Intents", enable:`);
    console.log(`     - Message Content Intent`);
    console.log(`     - Server Members Intent`);
    console.log(`     - Presence Intent`);
    console.log(`  5. Go to OAuth2 → URL Generator, select "bot" scope with permissions:`);
    console.log(`     Send Messages, Read Message History, Use Slash Commands`);
    console.log(`  6. Use the generated URL to invite the bot to your server\n`);

    discordToken = await askSecret(rl, 'Discord bot token:');
    if (!discordToken) {
      fail('Discord bot token is required.');
      process.exit(1);
    }
  }

  // Validate Discord token
  console.log('  Validating Discord token...');
  let tokenValid = false;
  try {
    const { Client, GatewayIntentBits } = await import('discord.js');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        client.once('ready', () => {
          success(`Discord bot: ${client.user?.username}#${client.user?.discriminator}`);
          client.destroy();
          resolve();
        });
        client.once('error', reject);
        client.login(discordToken).catch(reject);
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Discord login timed out')), 15000),
      ),
    ]);
    tokenValid = true;
  } catch (err) {
    fail(`Discord token validation failed: ${err instanceof Error ? err.message : String(err)}`);
    const retry = await confirm(rl, 'Continue anyway? (token might still work)');
    if (!retry) process.exit(1);
    tokenValid = true; // User chose to continue
  }

  // Claude auth
  const hasExistingAuth = !!(anthropicKey || oauthToken);
  if (hasExistingAuth) {
    const authType = anthropicKey ? 'API key' : 'OAuth token';
    success(`Claude authentication already configured (${authType})`);
    const reconfig = await confirm(rl, 'Reconfigure Claude auth?', false);
    if (reconfig) {
      anthropicKey = '';
      oauthToken = '';
    }
  }

  if (!anthropicKey && !oauthToken) {
    console.log('');
    const authChoice = await ask(rl, 'Claude auth method — (1) API key or (2) Claude subscription (OAuth)? [1/2]');

    if (authChoice === '2') {
      console.log(`\n  In another terminal, run: ${CYAN}claude setup-token${RESET}`);
      console.log(`  Copy the token it outputs.\n`);
      oauthToken = await askSecret(rl, 'Claude OAuth token:');
      if (!oauthToken) {
        fail('Claude auth token is required.');
        process.exit(1);
      }
    } else {
      console.log(`\n  Get your API key from: ${CYAN}https://console.anthropic.com/settings/keys${RESET}\n`);
      anthropicKey = await askSecret(rl, 'Anthropic API key:');
      if (!anthropicKey) {
        fail('Anthropic API key is required.');
        process.exit(1);
      }
    }
  }

  // Assistant name
  const nameAnswer = await ask(rl, `Assistant name (trigger word) [${assistantName}]:`);
  if (nameAnswer) assistantName = nameAnswer;

  // Write .env
  const envValues: Record<string, string> = {
    DISCORD_BOT_TOKEN: discordToken,
    ASSISTANT_NAME: assistantName,
  };
  if (anthropicKey) envValues.ANTHROPIC_API_KEY = anthropicKey;
  if (oauthToken) envValues.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

  writeEnv(envValues);
  success('.env written');

  return { assistantName };
}

// ─── Step 3: Build container ────────────────────────────────────────────────

async function stepContainer(rl: readline.Interface): Promise<void> {
  heading('Step 3: Container image');

  // Check if image already exists
  let imageExists = false;
  try {
    const output = execSync('docker images nanoclawbster-agent:latest --format "{{.ID}}"', {
      encoding: 'utf-8',
    }).trim();
    imageExists = !!output;
  } catch {
    // docker images failed
  }

  if (imageExists) {
    success('Container image already exists');
    const rebuild = await confirm(rl, 'Rebuild container image?', false);
    if (!rebuild) return;
  }

  console.log('  Building container image (this may take a few minutes)...');

  const buildScript = path.join(PROJECT_ROOT, 'container', 'build.sh');
  const buildProc = spawn('bash', [buildScript], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });

  const exitCode = await new Promise<number>((resolve) => {
    buildProc.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    warn('Build failed. Pruning builder cache and retrying...');
    try {
      execSync('docker builder prune -f', { stdio: 'ignore' });
    } catch {
      // prune failed, continue anyway
    }

    const retryProc = spawn('bash', [buildScript], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    const retryCode = await new Promise<number>((resolve) => {
      retryProc.on('close', (code) => resolve(code ?? 1));
    });

    if (retryCode !== 0) {
      fail('Container build failed after retry. Check the output above.');
      process.exit(1);
    }
  }

  success('Container image built');
}

// ─── Step 4: Auto-register admin DM ─────────────────────────────────────────

async function stepRegisterAdmin(rl: readline.Interface, assistantName: string): Promise<void> {
  heading('Step 4: Register admin channel');

  // Check for existing admin registration
  const dbPath = path.join(STORE_DIR, 'messages.db');
  let existingAdmin = false;

  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare(
          'SELECT jid, name FROM registered_groups WHERE is_admin = 1',
        ).get() as { jid: string; name: string } | undefined;
        if (row) {
          existingAdmin = true;
          success(`Admin channel already registered: ${row.name} (${row.jid})`);
        }
      } catch {
        // Table might not exist
      }
      db.close();
    } catch {
      // DB might not exist or be corrupt
    }
  }

  if (existingAdmin) {
    const reconfig = await confirm(rl, 'Reconfigure admin channel?', false);
    if (!reconfig) return;
  }

  console.log('  Connecting to Discord to find bot owner...');

  const env = readEnv();
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) {
    fail('Discord bot token not found in .env');
    process.exit(1);
  }

  const { Client, GatewayIntentBits } = await import('discord.js');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
    ],
  });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        client.once('ready', () => resolve());
        client.once('error', reject);
        client.login(token).catch(reject);
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Discord login timed out')), 15000),
      ),
    ]);

    // Fetch application to find owner
    const application = await client.application!.fetch();
    const owner = application.owner;

    if (!owner) {
      fail('Could not determine bot owner from Discord application');
      client.destroy();
      process.exit(1);
    }

    // Handle team vs individual owner
    let ownerId: string;
    let ownerName: string;

    if ('members' in owner) {
      // Team application — use the team owner
      const teamOwner = owner.members.find((m) => m.id === owner.ownerId) || owner.members.first();
      if (!teamOwner) {
        fail('Could not find team member to DM');
        client.destroy();
        process.exit(1);
      }
      ownerId = teamOwner.user.id;
      ownerName = teamOwner.user.username;
    } else {
      ownerId = owner.id;
      ownerName = owner.username;
    }

    success(`Bot owner: ${ownerName}`);

    // Create DM channel
    const ownerUser = await client.users.fetch(ownerId);
    const dmChannel = await ownerUser.createDM();
    const jid = `dc:${dmChannel.id}`;
    const triggerPattern = `@${assistantName}`;

    info(`DM channel ID: ${dmChannel.id}`);

    // Register in database
    fs.mkdirSync(path.join(PROJECT_ROOT, 'store'), { recursive: true });
    fs.mkdirSync(path.join(PROJECT_ROOT, 'data'), { recursive: true });

    const db = new Database(dbPath);
    db.exec(REGISTERED_GROUPS_SCHEMA);

    // Migration: add is_admin column if missing
    try {
      db.exec('ALTER TABLE registered_groups ADD COLUMN is_admin INTEGER DEFAULT 0');
    } catch {
      /* column already exists */
    }

    // Clear existing admin
    db.prepare('UPDATE registered_groups SET is_admin = 0 WHERE is_admin = 1').run();

    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_admin)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(jid, `DM with ${ownerName}`, 'main', triggerPattern, timestamp, 0, 1);

    db.close();

    // Create group folders
    fs.mkdirSync(path.join(PROJECT_ROOT, 'groups', 'main', 'logs'), { recursive: true });

    // Create empty mount allowlist if not exists
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.config', 'nanoclawbster');
    const configFile = path.join(configDir, 'mount-allowlist.json');
    if (!fs.existsSync(configFile)) {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: true,
      }, null, 2) + '\n');
      info('Created empty mount allowlist');
    }

    // Update assistant name in CLAUDE.md files if needed
    if (assistantName !== 'Andy') {
      const mdFiles = [
        path.join(PROJECT_ROOT, 'groups', 'global', 'CLAUDE.md'),
        path.join(PROJECT_ROOT, 'groups', 'main', 'CLAUDE.md'),
      ];
      for (const mdFile of mdFiles) {
        if (fs.existsSync(mdFile)) {
          let content = fs.readFileSync(mdFile, 'utf-8');
          content = content.replace(/^# Andy$/m, `# ${assistantName}`);
          content = content.replace(/You are Andy/g, `You are ${assistantName}`);
          fs.writeFileSync(mdFile, content);
        }
      }
    }

    // Send welcome message
    try {
      await dmChannel.send(
        `Hey! I'm **${assistantName}**, your NanoClawbster assistant. ` +
        `Setup is almost complete — once the service starts, you can message me here. ` +
        `Try: \`@${assistantName} what can you do?\``,
      );
      success('Welcome message sent to your DM');
    } catch (err) {
      warn(`Could not send welcome DM (bot may lack permission): ${err instanceof Error ? err.message : String(err)}`);
    }

    client.destroy();
    success(`Admin DM registered: ${jid} → main/`);
  } catch (err) {
    client.destroy();
    fail(`Auto-registration failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log('\n  You can register manually later using the /setup skill in Claude Code.');
    const cont = await confirm(rl, 'Continue setup without admin registration?');
    if (!cont) process.exit(1);
  }
}

// ─── Step 5: Build and start service ────────────────────────────────────────

async function stepService(): Promise<void> {
  heading('Step 5: Install and start service');

  // Import and run the existing service setup (which handles the TypeScript build)
  const { run } = await import('./service.js');
  await run([]);
}

// ─── Step 6: Verify and summary ─────────────────────────────────────────────

async function stepVerify(): Promise<void> {
  heading('Step 6: Verify');

  // Wait a moment for the service to start
  await new Promise((r) => setTimeout(r, 3000));

  const env = readEnv();
  const assistantName = env.ASSISTANT_NAME || 'Andy';

  // Check service
  let serviceRunning = false;
  const platform = getPlatform();

  if (platform === 'macos') {
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      serviceRunning = output.includes('com.nanoclawbster');
    } catch {
      // not available
    }
  } else if (platform === 'linux') {
    // Try system-level first (root), then user-level
    try {
      execSync('systemctl is-active nanoclawbster 2>/dev/null || systemctl is-active nanoclaw 2>/dev/null', {
        stdio: 'ignore',
      });
      serviceRunning = true;
    } catch {
      try {
        execSync('systemctl --user is-active nanoclawbster', { stdio: 'ignore' });
        serviceRunning = true;
      } catch {
        // Check nohup pid file
        const pidFile = path.join(PROJECT_ROOT, 'nanoclawbster.pid');
        if (fs.existsSync(pidFile)) {
          try {
            const pid = fs.readFileSync(pidFile, 'utf-8').trim();
            execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
            serviceRunning = true;
          } catch {
            // not running
          }
        }
      }
    }
  }

  // Check credentials
  const hasCredentials = !!(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);

  // Check registered groups
  let groupCount = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) as count FROM registered_groups').get() as { count: number };
      groupCount = row.count;
      db.close();
    } catch {
      // table might not exist
    }
  }

  // Summary
  heading('Setup Complete');

  console.log(`  ${serviceRunning ? GREEN + '✓' : RED + '✗'} ${RESET}Service: ${serviceRunning ? 'running' : 'not running'}`);
  console.log(`  ${hasCredentials ? GREEN + '✓' : RED + '✗'} ${RESET}Credentials: ${hasCredentials ? 'configured' : 'missing'}`);
  console.log(`  ${groupCount > 0 ? GREEN + '✓' : RED + '✗'} ${RESET}Registered groups: ${groupCount}`);
  console.log(`  ${BOLD}Assistant name:${RESET} ${assistantName}`);
  console.log(`  ${BOLD}Trigger:${RESET} @${assistantName}`);

  if (serviceRunning && hasCredentials && groupCount > 0) {
    console.log(`\n${GREEN}${BOLD}  All good! DM your bot on Discord to test.${RESET}`);
    console.log(`${DIM}  Try: @${assistantName} what can you do?${RESET}\n`);
  } else {
    console.log('');
    if (!serviceRunning) warn('Service is not running. Check logs: tail -f logs/nanoclawbster.log');
    if (!hasCredentials) warn('Missing credentials in .env');
    if (groupCount === 0) warn('No groups registered. DM your bot or use /setup in Claude Code.');
    console.log('');
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}NanoClawbster Setup Wizard${RESET}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await stepDocker(rl);
    const { assistantName } = await stepCredentials(rl);
    await stepContainer(rl);
    await stepRegisterAdmin(rl, assistantName);
    await stepService();
    await stepVerify();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n${RED}Setup failed:${RESET}`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
