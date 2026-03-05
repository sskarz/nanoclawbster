/**
 * Composio MCP Server for NanoClawbster
 * Stdio MCP server that exposes Composio's meta tools to the agent.
 *
 * On startup:
 * 1. Loads the 5 COMPOSIO meta tools (search, execute, manage connections, etc.)
 * 2. Registers 7 trigger management tools for subscribing to webhook events
 * 3. Exposes them as MCP tools; calls are proxied back to Composio for execution
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
const WEBHOOK_URL = process.env.COMPOSIO_WEBHOOK_URL || '';

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

// -- Trigger management tools --

const triggerTools: McpTool[] = [
  {
    name: 'composio_trigger_list_types',
    description: 'List available trigger types. Optionally filter by toolkit slugs (e.g. ["github", "slack"]).',
    inputSchema: {
      type: 'object',
      properties: {
        toolkit_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by toolkit slugs (e.g. ["github", "slack"])',
        },
        limit: {
          type: 'number',
          description: 'Max items per page (default 100, max 1000)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for next page',
        },
      },
    },
  },
  {
    name: 'composio_trigger_get_type',
    description: 'Get detailed info about a specific trigger type including config schema and payload schema.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Trigger type slug (e.g. "GITHUB_PULL_REQUEST_EVENT")',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'composio_trigger_subscribe',
    description: 'Subscribe to a trigger (create a trigger instance). Events will be delivered to the configured webhook URL.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Trigger type slug to subscribe to',
        },
        connected_account_id: {
          type: 'string',
          description: 'Connected account nano ID (if omitted, uses first matching account)',
        },
        trigger_config: {
          type: 'object',
          description: 'Trigger-specific configuration (see trigger type config schema)',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'composio_trigger_list_active',
    description: 'List active trigger instances. Optionally filter by trigger names, IDs, or connected accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by trigger type names',
        },
        trigger_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by trigger instance IDs',
        },
        connected_account_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by connected account IDs',
        },
        show_disabled: {
          type: 'boolean',
          description: 'Include disabled triggers (default false)',
        },
        limit: {
          type: 'number',
          description: 'Max items per page',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor',
        },
      },
    },
  },
  {
    name: 'composio_trigger_enable',
    description: 'Re-enable a previously disabled trigger instance.',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: {
          type: 'string',
          description: 'The trigger instance ID to enable',
        },
      },
      required: ['trigger_id'],
    },
  },
  {
    name: 'composio_trigger_disable',
    description: 'Temporarily disable a trigger instance (can be re-enabled later).',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: {
          type: 'string',
          description: 'The trigger instance ID to disable',
        },
      },
      required: ['trigger_id'],
    },
  },
  {
    name: 'composio_trigger_delete',
    description: 'Permanently delete a trigger instance.',
    inputSchema: {
      type: 'object',
      properties: {
        trigger_id: {
          type: 'string',
          description: 'The trigger instance ID to delete',
        },
      },
      required: ['trigger_id'],
    },
  },
];

tools.push(...triggerTools);

// -- Trigger tool handler --

async function handleTriggerTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    let result: unknown;

    switch (name) {
      case 'composio_trigger_list_types':
        result = await composio.triggers.listTypes({
          toolkits: args.toolkit_slugs as string[] | undefined,
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
        });
        break;

      case 'composio_trigger_get_type':
        result = await composio.triggers.getType(args.slug as string);
        break;

      case 'composio_trigger_subscribe': {
        const subscribeResult = await composio.triggers.create(USER_ID, args.slug as string, {
          connectedAccountId: args.connected_account_id as string | undefined,
          triggerConfig: args.trigger_config as Record<string, unknown> | undefined,
        });
        result = {
          ...subscribeResult,
          webhook_url: WEBHOOK_URL || '(not configured — set COMPOSIO_WEBHOOK_URL in .env)',
        };
        break;
      }

      case 'composio_trigger_list_active':
        result = await composio.triggers.listActive({
          triggerNames: args.trigger_names as string[] | undefined,
          triggerIds: args.trigger_ids as string[] | undefined,
          connectedAccountIds: args.connected_account_ids as string[] | undefined,
          showDisabled: args.show_disabled as boolean | undefined,
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
        });
        break;

      case 'composio_trigger_enable':
        result = await composio.triggers.enable(args.trigger_id as string);
        break;

      case 'composio_trigger_disable':
        result = await composio.triggers.disable(args.trigger_id as string);
        break;

      case 'composio_trigger_delete':
        result = await composio.triggers.delete(args.trigger_id as string);
        break;

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown trigger tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Composio trigger error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

const server = new Server(
  { name: 'composio', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Route trigger tools to dedicated handler
  if (name.startsWith('composio_trigger_')) {
    return handleTriggerTool(name, (args as Record<string, unknown>) ?? {});
  }

  // Fall through to Composio meta-tool execution
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
