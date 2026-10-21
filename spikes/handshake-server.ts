import { createMcpHttpHandler, serveWebHandler } from '@closed-loop/mcp-server';
import { stubBackend } from '../packages/mcp-server/src/stub-backend';

const port = Number(process.env.PORT ?? 8787);
const handler = createMcpHttpHandler(
  {
    bearerTokens: { 'spike-token': 'H#demo' },
    allowedOrigins: ['http://localhost:5173'],
    resourceUrl: `http://localhost:${port}/mcp`,
    includeWwwAuthenticate: process.env.WWW_AUTH === '1',
  },
  stubBackend,
);
serveWebHandler(handler, port);
console.log(`spike MCP server on http://localhost:${port}/mcp`);
