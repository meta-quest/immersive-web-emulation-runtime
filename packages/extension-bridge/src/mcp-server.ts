/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Builds the stdio MCP server: registers one tool per catalog entry (Zod input
 * shapes), forwards each tool call to the browser via the hub, and formats the
 * response — including the screenshot image remap + size ceiling and tab-change
 * warnings.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, type ToolDef } from './contract.js';
import { BrowserHub, type DispatchResponse } from './hub.js';
import { createTabTracker, type TabTracker } from './tab-tracker.js';
import {
  enforceImageCeiling,
  mergeCaptureParams,
  toImageContent,
  type CaptureParams,
  type CaptureResult,
} from './screenshot.js';

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;
interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** A tool error already shaped for the agent. */
class ToolError extends Error {}

function errorText(error: DispatchResponse['error']): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object')
    return error.message ?? JSON.stringify(error);
  return 'Unknown error';
}

function tabMeta(env: DispatchResponse): {
  _tabId?: string;
  _tabGeneration?: number;
} {
  return { _tabId: env._tabId, _tabGeneration: env._tabGeneration };
}

async function handleScreenshot(
  hub: BrowserHub,
  tabTracker: TabTracker,
  tool: ToolDef,
  args: CaptureParams,
): Promise<ToolResult> {
  const params = mergeCaptureParams(args);
  let lastEnvelope: DispatchResponse | undefined;

  const capture = async (
    p: Required<CaptureParams>,
  ): Promise<CaptureResult> => {
    const env = await hub.dispatch(tool.wsMethod, p);
    lastEnvelope = env;
    if (env.error) throw new ToolError(errorText(env.error));
    const result = env.result as CaptureResult | undefined;
    if (
      !result ||
      typeof result.imageData !== 'string' ||
      result.imageData.length === 0
    ) {
      throw new ToolError(
        'screenshot returned no image data. Make sure the paired tab is the ' +
          'active/visible tab in its window — the browser can only capture the ' +
          'focused tab.',
      );
    }
    return result;
  };

  const { result, attempts, stillOver, finalParams } =
    await enforceImageCeiling(capture, params);
  const content: ToolContent[] = [];
  const warning = lastEnvelope
    ? tabTracker.noteResponse(tabMeta(lastEnvelope))
    : null;
  if (warning) content.push({ type: 'text', text: warning });
  content.push(toImageContent(result));
  if (stillOver) {
    content.push({
      type: 'text',
      text:
        `Note: the screenshot still exceeds the size ceiling after ${attempts} attempt(s) ` +
        `(downscaled to ${finalParams.maxWidth}px @ q${finalParams.quality}); your client may truncate it.`,
    });
  }
  return { content };
}

async function handleStandard(
  hub: BrowserHub,
  tabTracker: TabTracker,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const env = await hub.dispatch(tool.wsMethod, args);
  if (env.error) {
    return {
      content: [{ type: 'text', text: errorText(env.error) }],
      isError: true,
    };
  }
  const content: TextContent[] = [];
  const warning = tabTracker.noteResponse(tabMeta(env));
  if (warning) content.push({ type: 'text', text: warning });
  content.push({
    type: 'text',
    text: JSON.stringify(env.result ?? null, null, 2),
  });
  return { content };
}

async function handleCall(
  hub: BrowserHub,
  tabTracker: TabTracker,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    // Browser-host tools (e.g. screenshot) are serviced by the extension, not
    // IWER device.remote, and need image post-processing. Routed by the flag,
    // not a hardcoded name, so new host tools are catalog-only additions.
    if (tool.browserTool) {
      return await handleScreenshot(
        hub,
        tabTracker,
        tool,
        args as CaptureParams,
      );
    }
    return await handleStandard(hub, tabTracker, tool, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

export interface BuildMcpServerOptions {
  hub: BrowserHub;
  name?: string;
  version?: string;
}

export function buildMcpServer(opts: BuildMcpServerOptions): McpServer {
  const server = new McpServer({
    name: opts.name ?? 'iwer',
    version: opts.version ?? '0.0.0',
  });
  const tabTracker = createTabTracker();

  for (const tool of TOOLS) {
    server.registerTool(
      tool.mcpName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { readOnlyHint: tool.readOnlyHint },
      },
      // The SDK infers args from inputSchema; in this generic loop it is a
      // plain record. Cast the result to satisfy the SDK's CallToolResult.
      (async (args: Record<string, unknown>) =>
        handleCall(opts.hub, tabTracker, tool, args ?? {})) as never,
    );
  }

  return server;
}

// Re-export for tests/consumers.
export { handleCall };
