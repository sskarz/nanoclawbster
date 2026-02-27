import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, files?: string[]) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Resolve file attachment paths (security: no path traversal)
                  const attachmentsDir = path.join(ipcBaseDir, sourceGroup, 'attachments');
                  const resolvedFiles = (Array.isArray(data.files) ? data.files : [])
                    .filter((f: unknown) => typeof f === 'string' && path.basename(f as string) === f)
                    .map((f: string) => path.join(attachmentsDir, f))
                    .filter((p: string) => fs.existsSync(p));

                  await deps.sendMessage(data.chatJid, data.text, resolvedFiles.length ? resolvedFiles : undefined);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, attachments: resolvedFiles.length },
                    'IPC message sent',
                  );

                  // Clean up attachment files after send
                  for (const p of resolvedFiles) {
                    try { fs.unlinkSync(p); } catch { /* best-effort */ }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Delete task file before processing — restart/rebuild handlers
              // call process.exit() and would never reach a post-process unlink.
              fs.unlinkSync(filePath);
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For pull_and_deploy
    branch?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'restart': {
      logger.info({ sourceGroup }, 'Restart requested via IPC — rebuilding and exiting for service manager restart');
      // Recompile TypeScript so the restarted process picks up any source changes
      // (e.g. from a merged PR), then exit for systemd Restart=always.
      const { execSync } = await import('child_process');
      try {
        execSync('npm run build', { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'pipe', timeout: 30_000 });
        logger.info('Build completed successfully before restart');
      } catch (buildErr) {
        logger.error({ err: buildErr }, 'Build failed before restart — restarting with existing compiled code');
      }
      // Exit immediately so buffered agent output doesn't get processed and sent
      process.exit(0);
      break;
    }

    case 'rebuild': {
      logger.info({ sourceGroup }, 'Rebuild requested via IPC — rebuilding Docker image and restarting');
      const { execSync: execSyncRebuild } = await import('child_process');
      const containerDir = path.resolve(import.meta.dirname, '..', 'container');
      try {
        // Rebuild the agent Docker image from source
        execSyncRebuild('docker build -t nanoclawbster-agent:latest .', {
          cwd: containerDir,
          stdio: 'pipe',
          timeout: 10 * 60 * 1000, // 10 minute timeout
        });
        logger.info('Docker image rebuild completed successfully');
        // Prune dangling images to free disk space
        try {
          execSyncRebuild('docker image prune -f', { stdio: 'pipe', timeout: 30_000 });
        } catch { /* non-fatal */ }
      } catch (buildErr) {
        logger.error({ err: buildErr }, 'Docker image rebuild failed — restarting with existing image');
      }
      // Recompile host TypeScript then exit (systemd will restart with new image)
      try {
        execSyncRebuild('npm run build', { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'pipe', timeout: 30_000 });
      } catch { /* non-fatal */ }
      // Exit immediately so buffered agent output doesn't get processed and sent
      process.exit(0);
      break;
    }

    case 'test_container_build': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized test_container_build attempt');
        break;
      }

      logger.info({ sourceGroup }, 'Test container build requested from dev workspace');
      const { execSync: execSyncTestBuild } = await import('child_process');
      const devContainerDir = path.join(DATA_DIR, 'dev-workspace', 'container');
      const resultPath = path.join(DATA_DIR, 'dev-workspace', '.build-result.json');
      const startTime = Date.now();

      try {
        execSyncTestBuild('docker build -t nanoclawbster-agent:test .', {
          cwd: devContainerDir,
          stdio: 'pipe',
          timeout: 10 * 60 * 1000,
        });

        // Clean up test image
        try { execSyncTestBuild('docker rmi nanoclawbster-agent:test', { stdio: 'pipe' }); } catch { /* ok */ }

        const result = { success: true, duration_ms: Date.now() - startTime, timestamp: new Date().toISOString() };
        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
        logger.info({ duration_ms: result.duration_ms }, 'Test container build succeeded');
      } catch (err) {
        const stderr = err instanceof Error && 'stderr' in err ? (err as any).stderr?.toString().slice(-2000) : String(err);
        const result = { success: false, error: stderr, duration_ms: Date.now() - startTime, timestamp: new Date().toISOString() };
        fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
        logger.error({ err }, 'Test container build failed');
      }
      // NOTE: No process.exit() — the host keeps running. This is a non-destructive test.
      break;
    }

    case 'pull_and_deploy': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized pull_and_deploy attempt');
        break;
      }

      const rawBranch = data.branch || 'main';
      // Sanitize branch name to prevent command injection (allow only safe git ref chars)
      const branch = rawBranch.replace(/[^a-zA-Z0-9._\-/]/g, '');
      if (!branch) {
        logger.error({ rawBranch }, 'Invalid branch name — aborting deploy');
        break;
      }
      logger.info({ sourceGroup, branch }, 'Pull and deploy requested via IPC');
      const { execSync: execSyncDeploy } = await import('child_process');
      const projectRoot = path.resolve(import.meta.dirname, '..');

      // 1. Save current HEAD for rollback
      let previousHead: string;
      try {
        previousHead = execSyncDeploy('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
        if (!/^[0-9a-f]{40}$/.test(previousHead)) {
          throw new Error(`Unexpected HEAD format: ${previousHead}`);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to get current HEAD — aborting deploy');
        break;
      }

      // 2. Fetch and reset to remote branch
      try {
        execSyncDeploy(`git fetch origin ${branch}`, { cwd: projectRoot, stdio: 'pipe', timeout: 60_000 });
        execSyncDeploy(`git reset --hard origin/${branch}`, { cwd: projectRoot, stdio: 'pipe', timeout: 30_000 });
        logger.info({ branch }, 'Git pull completed');
      } catch (err) {
        logger.error({ err }, 'Git fetch/reset failed — aborting deploy');
        break;
      }

      // 3. Check if package.json changed
      try {
        const diff = execSyncDeploy(`git diff ${previousHead} HEAD --name-only`, { cwd: projectRoot, encoding: 'utf-8' });
        if (diff.includes('package.json') || diff.includes('package-lock.json')) {
          logger.info('package.json changed — running npm install');
          execSyncDeploy('npm install', { cwd: projectRoot, stdio: 'pipe', timeout: 120_000 });
        }
      } catch (err) {
        logger.warn({ err }, 'npm install check/run failed — continuing with build');
      }

      // 4. Build TypeScript
      let buildFailed = false;
      try {
        execSyncDeploy('npm run build', { cwd: projectRoot, stdio: 'pipe', timeout: 60_000 });
        logger.info('TypeScript build succeeded');
      } catch (buildErr) {
        buildFailed = true;
        logger.error({ err: buildErr }, 'TypeScript build failed — rolling back');

        // Rollback: restore previous commit
        try {
          execSyncDeploy(`git reset --hard ${previousHead}`, { cwd: projectRoot, stdio: 'pipe', timeout: 30_000 });
          // Restore old dependencies if needed
          try {
            execSyncDeploy('npm install', { cwd: projectRoot, stdio: 'pipe', timeout: 120_000 });
          } catch { /* best-effort */ }
          // Rebuild with old code
          execSyncDeploy('npm run build', { cwd: projectRoot, stdio: 'pipe', timeout: 60_000 });
          logger.info({ previousHead }, 'Rollback completed successfully');
        } catch (rollbackErr) {
          logger.error({ err: rollbackErr }, 'Rollback build also failed — restarting with whatever is compiled');
        }
      }

      // 5. Rebuild Docker image if container/ files changed (only if build succeeded)
      if (!buildFailed) {
        try {
          const diff = execSyncDeploy(`git diff ${previousHead} HEAD --name-only`, { cwd: projectRoot, encoding: 'utf-8' });
          if (diff.split('\n').some(f => f.startsWith('container/'))) {
            logger.info('container/ files changed — rebuilding Docker image');
            const deployContainerDir = path.join(projectRoot, 'container');
            execSyncDeploy('docker build -t nanoclawbster-agent:latest .', {
              cwd: deployContainerDir,
              stdio: 'pipe',
              timeout: 10 * 60 * 1000,
            });
            logger.info('Docker image rebuild completed');
            try {
              execSyncDeploy('docker image prune -f', { stdio: 'pipe', timeout: 30_000 });
            } catch { /* non-fatal */ }
          }
        } catch (err) {
          logger.warn({ err }, 'Docker rebuild check/run failed — continuing with restart');
        }
      }

      // 6. Sync dev workspace to match the deployed branch
      const devWorkspaceDir = path.join(DATA_DIR, 'dev-workspace');
      if (fs.existsSync(devWorkspaceDir)) {
        try {
          execSyncDeploy(`git fetch origin ${branch}`, { cwd: devWorkspaceDir, stdio: 'pipe', timeout: 60_000 });
          execSyncDeploy(`git reset --hard origin/${branch}`, { cwd: devWorkspaceDir, stdio: 'pipe', timeout: 30_000 });
          logger.info('Dev workspace synced to deployed branch');
        } catch (err) {
          logger.warn({ err }, 'Dev workspace sync failed — non-fatal');
        }
      }

      // 7. Exit for systemd restart
      logger.info({ buildFailed }, 'Pull and deploy complete — restarting');
      process.exit(0);
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
