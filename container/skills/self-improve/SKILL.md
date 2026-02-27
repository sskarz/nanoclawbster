# Self-Improvement Workflow

Write features, fix bugs, and create PRs for the NanoClawbster codebase. You work in an isolated dev workspace, test locally, push via Composio, and deploy after user approval.

## Workspace Layout

```
/workspace/project  → Live code (READ-ONLY)
/workspace/dev      → Git clone (READ-WRITE) — edit and test here
/workspace/group    → Group files (READ-WRITE)
```

**Never edit /workspace/project directly.** All changes happen in /workspace/dev.

## Step-by-Step Workflow

### 1. Sync Dev Workspace

```bash
cd /workspace/dev
git checkout main
git pull origin main
npm install
```

### 2. Create a Branch

```bash
cd /workspace/dev
git checkout -b feature/your-change-name
```

This branch is local only — Composio handles the GitHub branch when you push.

### 3. Edit and Test

Make your changes in `/workspace/dev/src/` (host code) or `/workspace/dev/container/` (agent code).

**Always test before pushing:**

| What Changed | How to Test |
|-------------|-------------|
| `src/*.ts` (host code) | `cd /workspace/dev && npm run build` |
| `container/agent-runner/src/*.ts` | `cd /workspace/dev/container/agent-runner && npm run build` |
| `container/Dockerfile` or agent-runner | Call `test_container_build` tool, then poll `/workspace/dev/.build-result.json` |
| `container/skills/*` | No build needed — skills are copied on container start |

### 4. Determine Changed Files

```bash
cd /workspace/dev
git diff --name-only   # unstaged changes
git diff --staged --name-only   # staged changes
```

You'll need the file paths and contents for the Composio push step.

### 5. Push via Composio

Use Composio's GitHub tools to push your changes. First find the tools:

```
Use COMPOSIO_SEARCH_TOOLS to search for "github commit"
```

Then use `GITHUB_COMMIT_MULTIPLE_FILES` to push the changed files to a feature branch on GitHub:
- **owner**: "sskarz"
- **repo**: "nanoclawbster"
- **branch**: your feature branch name (Composio creates it on GitHub)
- **files**: array of `{path, content}` for each changed file
- **message**: descriptive commit message

### 6. Create PR

Use `GITHUB_CREATE_A_PULL_REQUEST`:
- **owner**: "sskarz"
- **repo**: "nanoclawbster"
- **head**: your feature branch
- **base**: "main"
- **title**: concise description
- **body**: what changed and why

### 7. Notify User

Send the PR link via `send_message` and ask the user to review and merge.

### 8. Deploy (After User Confirms Merge)

Once the user confirms the PR is merged:

1. Use `send_message` to warn: "Deploying changes — I'll be back shortly!"
2. Call `pull_and_deploy` tool (branch: "main")
3. Wrap remaining output in `<internal>` tags

The host will pull, build, and restart. If the build fails, it automatically rolls back to the previous version — tell the user and iterate.

## Safety Rules

- **Always test before pushing** — run the appropriate build command
- **Always create a PR** — never push directly to main
- **Always notify the user** before deploying (restart incoming)
- **One logical change per PR** — keep PRs focused and reviewable
- **Read before editing** — understand existing code patterns
- If deploy fails, rollback is automatic. Tell the user what went wrong and fix it in a new PR.
