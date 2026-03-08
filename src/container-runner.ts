/**
 * Container Runner for NanoClawbster
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAWBSTER_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAWBSTER_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isAdmin: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isAdmin: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isAdmin) {
    // Admin gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

  } else {
    // Non-admin gets only their own group folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Claude config directory (read-write so agents can update memory, etc.)
  const claudeConfigDir = path.join(process.env.HOME || '/root', '.claude');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  mounts.push({
    hostPath: claudeConfigDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'received'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'responses'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  // New files from the upstream src are synced in on every call so that
  // groups created before a new file was added still receive it.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
    fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
    // Always overwrite system-owned source files so updates (new MCP servers,
    // bug fixes) propagate to existing groups automatically. Agents may add
    // extra files alongside these; those are left untouched.
    for (const file of fs.readdirSync(agentRunnerSrc)) {
      fs.copyFileSync(path.join(agentRunnerSrc, file), path.join(groupAgentRunnerDir, file));
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Dev workspace: only the admin group has a dev workspace
  if (isAdmin) {
    const devWorkspaceDir = path.join(DATA_DIR, 'dev-workspace');
    if (fs.existsSync(devWorkspaceDir)) {
      mounts.push({
        hostPath: devWorkspaceDir,
        containerPath: '/workspace/dev',
        readonly: false,
      });
    }
  }

  // Additional mounts from group config
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(group.containerConfig.additionalMounts, isAdmin);
    for (const mount of validatedMounts) {
      mounts.push({
        hostPath: mount.resolvedHostPath,
        containerPath: mount.containerPath,
        readonly: mount.readonly,
      });
    }
  }

  return mounts;
}

export interface AgentRunOptions {
  group: RegisteredGroup;
  chatJid: string;
  onProcess: (proc: ChildProcess, containerName: string) => void;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const isAdmin = group.isAdmin === true;
  const mounts = buildVolumeMounts(group, isAdmin);

  const timeout = group.containerConfig?.timeout ?? CONTAINER_TIMEOUT;

  // Read ANTHROPIC_API_KEY and any extra secrets from the .env file
  const envVars = await readEnvFile();

  const containerName = `nanoclawbster-agent-${group.folder}-${Date.now()}`;

  // Build docker run args
  const args = [
    'run',
    '--rm',
    '--name', containerName,
    '--network', 'host',
    '--memory', '2g',
    '--cpus', '2',
  ];

  // Volume mounts
  for (const mount of mounts) {
    const flag = mount.readonly ? ':ro' : '';
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${flag}`);
  }

  // Environment variables
  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', `${key}=${value}`);
  }

  // Pass group context to MCP server
  args.push('-e', `NANOCLAWBSTER_CHAT_JID=${input.chatJid}`);
  args.push('-e', `NANOCLAWBSTER_GROUP_FOLDER=${input.groupFolder}`);
  args.push('-e', `NANOCLAWBSTER_IS_ADMIN=${isAdmin ? '1' : '0'}`);
  args.push('-e', `NANOCLAWBSTER_TIMEZONE=${TIMEZONE}`);

  args.push(CONTAINER_IMAGE);

  logger.debug({ containerName, mounts: mounts.length, timeout }, 'Spawning container');

  return new Promise((resolve) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, containerName);

    let outputBuffer = '';
    let errorBuffer = '';
    let outputSize = 0;
    let timedOut = false;
    let resolved = false;

    const resolveOnce = (result: ContainerOutput) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    // Set timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logger.warn({ containerName, timeout }, 'Container timed out, stopping');
      stopContainer(containerName);
      resolveOnce({
        status: 'error',
        result: null,
        error: `Container timed out after ${timeout}ms`,
      });
    }, timeout);

    // Write input to stdin
    const inputJson = JSON.stringify(input);
    proc.stdin.write(inputJson);
    proc.stdin.end();

    // Parse streaming output from stdout
    let parsingOutput = false;
    let outputJson = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      if (timedOut) return;

      outputSize += chunk.length;
      if (outputSize > CONTAINER_MAX_OUTPUT_SIZE) {
        logger.warn({ containerName, outputSize }, 'Container output too large, truncating');
        stopContainer(containerName);
        return;
      }

      outputBuffer += chunk.toString();

      // Process complete lines
      let newlineIdx;
      while ((newlineIdx = outputBuffer.indexOf('\n')) !== -1) {
        const line = outputBuffer.slice(0, newlineIdx);
        outputBuffer = outputBuffer.slice(newlineIdx + 1);

        if (line === OUTPUT_START_MARKER) {
          parsingOutput = true;
          outputJson = '';
        } else if (line === OUTPUT_END_MARKER) {
          parsingOutput = false;
          if (outputJson) {
            try {
              const parsed = JSON.parse(outputJson) as ContainerOutput;
              // Call onOutput callback for streaming results
              if (onOutput) {
                onOutput(parsed).catch((err) =>
                  logger.error({ err }, 'Error in onOutput callback'),
                );
              }
            } catch (err) {
              logger.error({ err, outputJson }, 'Failed to parse container output JSON');
            }
            outputJson = '';
          }
        } else if (parsingOutput) {
          outputJson += line;
        } else {
          // Log non-output lines as debug info
          logger.debug({ containerName, line }, 'Container log');
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errorBuffer += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      logger.error({ containerName, err }, 'Container process error');
      resolveOnce({
        status: 'error',
        result: null,
        error: err.message,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      if (timedOut) return;

      if (code !== 0) {
        logger.warn({ containerName, code, stderr: errorBuffer.slice(-500) }, 'Container exited with non-zero code');
      }

      resolveOnce({
        status: code === 0 ? 'success' : 'error',
        result: null,
        error: code !== 0 ? `Container exited with code ${code}` : undefined,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdmin: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filtered = isAdmin ? tasks : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(
    tasksFile,
    JSON.stringify(
      filtered.map((t) => ({
        id: t.id,
        createdBy: t.groupFolder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
      null,
      2,
    ),
  );
}

export function writeStatsSnapshot(
  groupFolder: string,
  stats: {
    messagesToday: number;
    totalMessages: number;
    registeredGroups: number;
    activeTasks: number;
    pausedTasks: number;
    uptime: string;
  },
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const statsFile = path.join(groupIpcDir, 'stats.json');
  fs.writeFileSync(statsFile, JSON.stringify({ ...stats, generatedAt: new Date().toISOString() }, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string | null;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isAdmin: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visible = isAdmin ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      visible.map((g) => ({
        jid: g.jid,
        name: g.name,
        lastActivity: g.lastActivity,
        isRegistered: registeredJids.has(g.jid),
      })),
      null,
      2,
    ),
  );
}
