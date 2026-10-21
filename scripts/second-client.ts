// A second, independent MCP client (the official TypeScript SDK client) against any deployment.
// Usage: tsx scripts/second-client.ts <mcp_url> <bearer_token>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, token] = process.argv.slice(2);
if (!url || !token) {
  console.error('Usage: tsx scripts/second-client.ts <mcp_url> <bearer_token>');
  process.exit(2);
}

const client = new Client({ name: 'closed-loop-second-client', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
const t0 = performance.now();
await client.connect(transport);
console.log(`connected: ${client.getServerVersion()?.name} ${client.getServerVersion()?.version} (${Math.round(performance.now() - t0)} ms)`);
console.log(`session id: ${transport.sessionId ?? 'none (stateless)'}`);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

const status = await client.callTool({ name: 'get_my_status', arguments: {} });
console.log('get_my_status ->', JSON.stringify(status.structuredContent));

const bad = await client.callTool({ name: 'pause_checkins', arguments: { scope: 'forever' } });
console.log(`pause_checkins(scope=forever) rejected: ${bad.isError === true}`);

await client.close();
