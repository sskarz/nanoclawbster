---
name: mcp-builder
description: Build, register, and use custom MCP servers within this environment. Use this when asked to create a new tool, capability, or integration as an MCP server.
allowed-tools: Bash, Read, Write, Edit
---

# Building Custom MCP Servers

MCP (Model Context Protocol) servers extend what I can do by exposing new tools. I can write, register, and use them across sessions.

## File locations

- Server code: `/workspace/group/mcp-servers/<server-name>/index.js`
- Shared dependencies: `/workspace/group/mcp-servers/package.json`
- Registration: `/workspace/group/.mcp.json`

All paths under `/workspace/group/` persist across container restarts.

---

## Step-by-step: Create and register an MCP server

### 1. Set up shared dependencies (first time only)

All MCP servers share a single `node_modules` at the `mcp-servers/` root. Only do this once:

```bash
mkdir -p /workspace/group/mcp-servers
cd /workspace/group/mcp-servers
if [ ! -f package.json ]; then
  npm init -y
  # Add "type": "module" for ES module support
  node -e "const p=require('./package.json'); p.type='module'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)+'\n')"
  npm install @modelcontextprotocol/sdk zod
fi
```

### 2. Write the server

Create `/workspace/group/mcp-servers/<name>/index.js`:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "<name>", version: "1.0.0" });

server.tool(
  "tool-name",
  "Description of what this tool does",
  { param: z.string().describe("A parameter") },
  async ({ param }) => ({
    content: [{ type: "text", text: `Result: ${param}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Node resolves imports from the shared `node_modules` up the directory tree — no per-server install needed.

### 3. Test it

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test"},"protocolVersion":"2024-11-05"}}' | node /workspace/group/mcp-servers/<name>/index.js
```

Should return a JSON response without errors.

### 4. Register in `.mcp.json`

Add the server to `/workspace/group/.mcp.json`. If the file doesn't exist, create it:

```json
{
  "mcpServers": {
    "<name>": {
      "command": "node",
      "args": ["/workspace/group/mcp-servers/<name>/index.js"]
    }
  }
}
```

If `.mcp.json` already exists, merge the new entry into the existing `mcpServers` object — don't overwrite other servers.

### 5. Tell the user

After creating and registering the server, tell the user:

> I've created the `<name>` MCP server. It will be available as a tool next time you message me.

The current session cannot pick up newly registered MCP servers. They take effect on the next container invocation.

---

## Common patterns

### Tool with no params

```js
server.tool("get-time", "Get current time", {}, async () => ({
  content: [{ type: "text", text: new Date().toISOString() }],
}));
```

### Tool that calls an external API

```js
server.tool(
  "fetch-weather",
  "Get weather for a city",
  { city: z.string() },
  async ({ city }) => {
    const res = await fetch(`https://wttr.in/${city}?format=3`);
    return { content: [{ type: "text", text: await res.text() }] };
  }
);
```

### Tool that reads/writes files

```js
import { readFileSync, writeFileSync } from "fs";

server.tool("read-notes", "Read saved notes", {}, async () => ({
  content: [{ type: "text", text: readFileSync("/workspace/group/notes.md", "utf8") }],
}));

server.tool(
  "save-note",
  "Save a note",
  { text: z.string() },
  async ({ text }) => {
    writeFileSync("/workspace/group/notes.md", text);
    return { content: [{ type: "text", text: "Saved." }] };
  }
);
```

### Tool that runs a shell command

```js
import { execSync } from "child_process";

server.tool(
  "run-command",
  "Run a shell command",
  { command: z.string() },
  async ({ command }) => {
    try {
      const output = execSync(command, { timeout: 30000 }).toString();
      return { content: [{ type: "text", text: output || "(no output)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
  }
);
```

### Multiple tools in one server

Group related tools into a single server rather than creating one server per tool:

```js
const server = new McpServer({ name: "project-tools", version: "1.0.0" });

server.tool("lint", "Run linter", {}, async () => { /* ... */ });
server.tool("test", "Run tests", {}, async () => { /* ... */ });
server.tool("deploy", "Deploy to staging", {}, async () => { /* ... */ });
```

---

## Debugging

- **Server crashes silently**: Wrap all tool handlers in try/catch. Unhandled errors kill the process and Claude Code just sees "MCP server disconnected."
- **Tools don't appear**: Check that `/workspace/group/.mcp.json` is valid JSON. A trailing comma or syntax error silently breaks registration.
- **Import errors**: Make sure the shared `package.json` has `"type": "module"` and that `node_modules` exists at `/workspace/group/mcp-servers/`.
- **Logging**: Use `console.error()` for debug output. Stdout is reserved for the JSON-RPC protocol — anything else on stdout breaks communication.

---

## Python alternative

```python
# /workspace/group/mcp-servers/<name>/server.py
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("<name>")

@mcp.tool()
def my_tool(param: str) -> str:
    """Description of the tool"""
    return f"Result: {param}"

if __name__ == "__main__":
    mcp.run()
```

Install: `pip install mcp`

Register in `/workspace/group/.mcp.json`:
```json
{
  "mcpServers": {
    "<name>": {
      "command": "python3",
      "args": ["/workspace/group/mcp-servers/<name>/server.py"]
    }
  }
}
```
