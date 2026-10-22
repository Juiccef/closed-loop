import { createHmac } from 'node:crypto';
import { coreBackend, createMcpHttpHandler, type McpHttpConfig } from '@closed-loop/mcp-server';
import type { Store } from '@closed-loop/core';
import { createApiHandler, type ApiConfig } from './router';

export type WebHandler = (req: Request) => Promise<Response>;

/**
 * One URL, path-routed: /mcp and OAuth discovery go to the MCP server; everything else to the console API,
 * acknowledge links, and static pages. (Two Function URLs that reference each other form a CloudFormation cycle.)
 */
export function createWebHandler(store: Store, mcp: McpHttpConfig, api: ApiConfig): WebHandler {
  // set_my_checkin confirm tokens are signed with a key derived from the ack-link secret, so every instance agrees.
  const confirmSecret = createHmac('sha256', api.ackSecret).update('closed-loop/set-my-checkin/v1').digest('base64url');
  const mcpHandler = createMcpHttpHandler(mcp, coreBackend(store, { confirmSecret }));
  const apiHandler = createApiHandler(api);
  return (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/mcp' || p.startsWith('/.well-known/oauth-') || p.startsWith('/oauth/')) return mcpHandler(req);
    return apiHandler(req);
  };
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json',
};

/** Maps a URL path to a file under apps/: "/" -> index.html, "/console/" -> console/index.html. */
export function staticPathToFile(path: string): { file: string; type: string } | undefined {
  let p = path;
  if (p === '/' || p === '') p = '/index.html';
  else if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z]+$/.test(p)) p += '/index.html';
  if (!/^\/[a-z0-9/_-]+\.(html|js|css|svg|json)$/.test(p) || p.includes('..')) return undefined;
  const ext = p.split('.').pop()!;
  return { file: p.slice(1), type: TYPES[ext]! };
}
