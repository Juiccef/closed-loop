// Local run mode: `npm run dev`. No AWS needed: in-memory store, emails written to ./out/emails,
// the same simulated clock, and the rule-based planner. One port serves MCP, the console, and the simulator.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStore, ackUrlBuilder, now, runTick, seedDemoHousehold } from '@closed-loop/core';
import { createWebHandler, staticPathToFile } from '@closed-loop/api';
import { createOAuth, serveWebHandler } from '@closed-loop/mcp-server';
import { FileMailer, RecordingMailer } from '@closed-loop/tick';
import { rulesPlanner } from '@closed-loop/api';

const PORT = Number(process.env.PORT ?? 5173);
const ORIGIN = `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'local-dev';
const MCP_TOKEN = process.env.MCP_BEARER_TOKEN ?? 'local-dev-mcp';
const ACK_SECRET = process.env.ACK_LINK_SECRET ?? 'local-dev-ack-secret';
const APPS = join(import.meta.dirname, '..', 'apps');

const store = new MemoryStore();
const mailer = new RecordingMailer(new FileMailer(join(process.cwd(), 'out', 'emails')));
const seed = async () => {
  mailer.sent.length = 0; // a fresh demo day starts with an empty email panel
  await seedDemoHousehold(store, { now: await now(store), l1Email: 'dana@example.com', l2Email: 'sam@example.com', demoMode: true });
};
const tick = (origin: string) => runTick(store, { mailer, ackUrl: ackUrlBuilder(origin, ACK_SECRET) });

await seed();

// OAuth 2.1 (account linking). Local-only secrets; the AWS deployment reads real ones from .env.
const oauth = createOAuth(
  {
    signingSecret: process.env.OAUTH_SIGNING_SECRET ?? 'local-dev-oauth-signing-secret-change-me',
    clients: [
      {
        id: process.env.ALEXA_CLIENT_ID ?? 'alexa-plus',
        secret: process.env.ALEXA_CLIENT_SECRET ?? 'local-dev-alexa-secret',
        redirectUris: (process.env.ALEXA_REDIRECT_URIS ?? 'https://alexa.example/api/skill/link/LOCAL').split(',').filter(Boolean),
        allowClientCredentials: true,
      },
      { id: 'simulator', redirectUris: [], sameOriginRedirectPath: '/simulator/linked.html' },
    ],
  },
  store,
);

const handler = createWebHandler(
  store,
  { bearerTokens: { [MCP_TOKEN]: 'demo' }, allowedOrigins: [ORIGIN], allowSameOrigin: true, resourceUrl: `${ORIGIN}/mcp`, includeWwwAuthenticate: false, oauth },
  {
    store,
    adminToken: ADMIN_TOKEN,
    ackSecret: ACK_SECRET,
    runTick: tick,
    seed,
    recentEmails: () => mailer.sent,
    planner: async (body) => rulesPlanner(body),
    publicConfig: () => ({ mode: 'local', householdId: 'demo', localAccessCode: ADMIN_TOKEN }),
    demoConfig: (origin) => ({ mcpUrl: `${origin}/mcp`, mcpToken: MCP_TOKEN, householdId: 'demo', planner: 'rules', mode: 'local' }),
    staticFile: async (path) => {
      // Dev only: axe-core for the accessibility audit (docs/accessibility.md).
      if (path === '/__dev/axe.min.js') return { body: await readFile(join(APPS, '..', 'node_modules', 'axe-core', 'axe.min.js'), 'utf8'), type: 'text/javascript' };
      const f = staticPathToFile(path);
      if (!f) return undefined;
      try {
        return { body: await readFile(join(APPS, f.file), 'utf8'), type: f.type };
      } catch {
        return undefined;
      }
    },
  },
);

serveWebHandler(handler, PORT);
// Same cadence as the EventBridge schedule in AWS.
setInterval(() => void tick(ORIGIN).catch((e) => console.error('tick failed', e)), 60_000);

console.log(`
Closed Loop (local run mode)
  Simulator:  ${ORIGIN}/simulator/
  Console:    ${ORIGIN}/console/
  MCP:        ${ORIGIN}/mcp   (Authorization: Bearer ${MCP_TOKEN})
  Access code for the pages: ${ADMIN_TOKEN}
  Emails are written to ./out/emails
`);
