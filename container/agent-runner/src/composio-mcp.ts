/**
 * Composio MCP Server for NanoClaw
 * Stdio MCP server that exposes Composio's meta tools to the agent.
 *
 * On startup:
 * 1. Loads the 5 COMPOSIO meta tools (search, execute, manage connections, etc.)
 * 2. Exposes them as MCP tools; calls are proxied back to Composio for execution
 *
 * The agent uses COMPOSIO_SEARCH_TOOLS to discover any of 1000+ app tools at
 * runtime, then COMPOSIO_MULTI_EXECUTE_TOOL to run them — no pre-registration needed.
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

// Load the COMPOSIO meta-toolkit tools (search, execute, manage connections, etc.)
let rawTools: Tool[] = [];
try {
  rawTools = await composio.tools.getRawComposioTools({ toolkits: ['COMPOSIO'] });
  const names = rawTools.map((t) => t.slug).join(', ');
  process.stderr.write(`[composio-mcp] Loaded ${rawTools.length} meta tools: ${names}\n`);
} catch (err) {
  process.stderr.write(`[composio-mcp] Failed to load meta tools: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
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
