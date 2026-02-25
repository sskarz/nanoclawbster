/**
 * Composio MCP Server for NanoClaw
 * Stdio MCP server that exposes Composio's connected-app tools to the agent.
 *
 * On startup:
 * 1. Fetches connected accounts for userId "default" to discover toolkit slugs
 * 2. Loads all tools for those toolkits from Composio's API
 * 3. Exposes them as MCP tools; calls are proxied back to Composio for execution
 *
 * Requires: COMPOSIO_API_KEY env var
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Composio, type Tool } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  process.stderr.write('COMPOSIO_API_KEY is not set — composio MCP server cannot start\n');
  process.exit(1);
}

const USER_ID = 'default';

const composio = new Composio({ apiKey });

// Step 1: Discover connected toolkits via active connected accounts
let toolkitSlugs: string[] = [];
try {
  const accounts = await composio.connectedAccounts.list({
    userIds: [USER_ID],
    statuses: ['ACTIVE'],
  });
  toolkitSlugs = [...new Set(accounts.items.map((a) => a.toolkit.slug))];
  process.stderr.write(`[composio-mcp] Connected toolkits: ${toolkitSlugs.join(', ') || 'none'}\n`);
} catch (err) {
  process.stderr.write(`[composio-mcp] Failed to list connected accounts: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// Step 2: Load raw tools for all connected toolkits
let rawTools: Tool[] = [];
if (toolkitSlugs.length > 0) {
  try {
    rawTools = await composio.tools.getRawComposioTools({ toolkits: toolkitSlugs });
    process.stderr.write(`[composio-mcp] Loaded ${rawTools.length} tools\n`);
  } catch (err) {
    process.stderr.write(`[composio-mcp] Failed to load tools: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(`[composio-mcp] No active connected accounts — starting with no tools\n`);
}

// Map to MCP tool format
// Tool fields: slug (unique ID), name (display), description, inputParameters (JSON Schema)
interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const tools: McpTool[] = rawTools.map((t) => ({
  name: t.slug,
  description: t.description ?? t.name,
  inputSchema: (t.inputParameters as Record<string, unknown>) ?? {
    type: 'object',
    properties: {},
  },
}));

const server = new Server(
  { name: 'composio', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await composio.tools.execute(name, {
      userId: USER_ID,
      arguments: (args as Record<string, unknown>) ?? {},
      dangerouslySkipVersionCheck: true,
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Composio tool error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
