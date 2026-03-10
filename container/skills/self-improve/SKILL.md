---
name: self-improve
description: Write features, fix bugs, and create PRs for the NanoClawbster codebase. Works in an isolated dev workspace, pushes via Composio (CI validates on GitHub Actions), and deploys after user approval.
admin-only: true
---

# Self-Improvement Workflow

Write features, fix bugs, and create PRs for the NanoClawbster codebase. You work in an isolated dev workspace, push via Composio (GitHub Actions runs CI), and deploy after user approval.

## Workspace Layout

```
/workspace/project  → Live code (READ-ONLY)
/workspace/dev      → Git clone (READ-WRITE) — edit and test here
/workspace/group    → Group files (READ-WRITE)
```

**Never edit /workspace/project directly.** All changes happen in /workspace/dev.

## Step-by-Step Workflow

### 0. Announce and Track

**Before doing anything else:**

1. Use `send_message` to tell the user what you're working on:
   > "Working on: [brief description of the task]. I'll send you the PR link when done."

2. Use `TodoWrite` to set up your full task list with ALL steps below as pending todos. This keeps you on track and lets the user see progress. Include a todo for creating the PR — this is mandatory.

Example todos:
- Sync dev workspace and create branch
- Read and understand relevant files
- Make the code changes
- Run local build check (tsc --noEmit)
- Push via Composio and create PR ← **never skip this**
- Verify CI passes on the PR

Mark each todo `in_progress` before starting it, `completed` immediately when done.

### 1. Sync Dev Workspace

```bash
cd /workspace/dev
git checkout main
git pull origin main
npm install
```

If `git pull` fails because origin points to the local host path, fix it first:
```bash
git remote set-url origin https://github.com/sskarz/nanoclawbster.git
git pull origin main
```

### 2. Create a Branch

```bash
cd /workspace/dev
git checkout -b feature/your-change-name
```

This branch is local only — Composio handles the GitHub branch when you push.

### 3. Read Before Editing

Before making changes, read the files you'll edit. Understand the existing patterns. Do not modify code you haven't read.

### 4. Edit and Test

Make your changes in `/workspace/dev/src/` (host code) or `/workspace/dev/container/` (agent code).

**Run a quick local build check before pushing:**

```bash
cd /workspace/dev && node_modules/.bin/tsc --noEmit
```

This catches type errors early. Full CI (type check, unit tests via vitest, container build) runs automatically on every PR via GitHub Actions — you do NOT need to replicate all CI checks locally.

**For skill-only changes** (`container/skills/*`): No build needed — skills are copied on container start. Just review the content for correctness.

### 5. Determine Changed Files

```bash
cd /workspace/dev
git diff --name-only   # unstaged changes
git diff --staged --name-only   # staged changes
```

You'll need the file paths and contents for the Composio push step.

### 6. Push via Composio

Use `COMPOSIO_MULTI_EXECUTE_TOOL` (NOT `COMPOSIO_EXECUTE_TOOL` — it returns 404 for GitHub tools) with `GITHUB_COMMIT_MULTIPLE_FILES`:
- **owner**: "sskarz"
- **repo**: "nanoclawbster"
- **branch**: your feature branch name (Composio creates it on GitHub)
- **base_branch**: "main" (required when creating a new branch)
- **upserts**: array of `{path, content, encoding: "utf-8"}` for each changed file
- **message**: descriptive commit message

**Important:** For large files, the content string may be too large for inline tool arguments. In that case, use git push directly:
```bash
cd /workspace/dev
git config user.email "nano@nanoclawbster.ai"
git config user.name "Nano"
git add src/your-file.ts
git commit -m "your message"
git push origin feature/your-branch
```
Note: git push requires HTTPS credentials. If it fails with auth error, use Composio instead and split large files across multiple commits.

### 7. Create PR

**This step is MANDATORY. Never skip it, even if not explicitly asked.**

Use `GITHUB_CREATE_A_PULL_REQUEST` via `COMPOSIO_MULTI_EXECUTE_TOOL`:
- **owner**: "sskarz"
- **repo**: "nanoclawbster"
- **head**: your feature branch
- **base**: "main"
- **title**: concise description
- **body**: what changed and why

GitHub Actions will automatically run on the PR:
- **Type check** (`tsc --noEmit`) and **unit tests** (`vitest run`)
- **Container build** (Docker build of `./container`)
- **Skill PR check** (blocks PRs that mix new skills with source changes)

If CI fails, check the PR status, fix the issues, and push again.

### 8. Notify User

Send the PR link via `send_message`. Example:
> "PR ready for review: https://github.com/sskarz/nanoclawbster/pull/X — [brief summary of changes]"

Ask the user to review and merge.

**Important:** Your `send_message` here is the ONE final completion report to the user. Do NOT wrap up with additional text output after this — the host agent will stay silent and let your message stand on its own.

### 9. Deploy (After User Confirms Merge)

Once the user confirms the PR is merged:

1. Use `send_message` to warn: "Deploying changes — I'll be back shortly!"
2. Call `pull_and_deploy` tool (branch: "main")
3. Wrap remaining output in `<internal>` tags

The host will pull, build, and restart. If the build fails, it automatically rolls back to the previous version.

**If deploy fails:** Use `send_message` to tell the user exactly what happened — include the error message. Ask them how they'd like to proceed. Do NOT silently retry or move on.

### 10. Post-Deploy Verification

After `pull_and_deploy` completes and the service is back online:

1. **Check logs** — `tail /workspace/project/logs/nanoclaw.log` to confirm the service started cleanly with no errors
2. **Do a real end-to-end test** — exercise the feature you just deployed and verify it works correctly in the live environment
3. Report results to the user

## Safety Rules

- **Always announce first** — send_message at the start so the user knows what you're working on
- **Always use TodoWrite** — track every step; mark in_progress before starting, completed immediately when done
- **Run a local build check before pushing** — `tsc --noEmit` catches type errors early
- **Let CI do the heavy lifting** — GitHub Actions runs type check, vitest, container build, and skill PR checks on every PR. Don't replicate all CI locally.
- **Check CI status after pushing** — if CI fails, fix the issues and push again before notifying the user
- **Always create a PR** — never push directly to main; this is non-negotiable
- **Always notify the user** before deploying (restart incoming)
- **Always check logs after deploy** — confirm the service came up cleanly in `nanoclaw.log`
- **Always ask the user when stuck** — if any step fails (build, test, push, deploy), send the error to the user and ask for direction rather than silently retrying or giving up
- **One logical change per PR** — keep PRs focused and reviewable
- **Read before editing** — understand existing code patterns
