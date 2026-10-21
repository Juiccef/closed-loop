// AWS entry point for the web function: MCP (/mcp), console API, acknowledge links, static pages.
import { ackUrlBuilder, now, runTick, seedDemoHousehold } from '@closed-loop/core';
import { urlEventHandler, type FunctionUrlEvent } from '@closed-loop/mcp-server/src/lambda-adapter';
import { DynamoStore } from '@closed-loop/store-dynamo';
import { SesMailer } from '@closed-loop/tick';
import { bedrockOrRulesPlanner } from './planner-bedrock';
import { STATIC_FILES } from './static.generated';
import { createWebHandler, staticPathToFile } from './web';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const store = new DynamoStore(env('TABLE_NAME'));
const mailer = new SesMailer(env('SES_SENDER'));
const ACK_SECRET = env('ACK_LINK_SECRET');
const MCP_TOKEN = env('MCP_BEARER_TOKEN');

// Resolve credentials and open the DynamoDB connection during init (cold-start latency, see FRICTION_LOG #8).
await store.getClockOffsetSeconds().catch(() => 0);

const handler = urlEventHandler(
  createWebHandler(
    store,
    { bearerTokens: { [MCP_TOKEN]: 'demo' }, allowedOrigins: [], allowSameOrigin: true, resourceUrl: '', includeWwwAuthenticate: false },
    {
      store,
      adminToken: env('ADMIN_TOKEN'),
      ackSecret: ACK_SECRET,
      runTick: (origin) => runTick(store, { mailer, ackUrl: ackUrlBuilder(origin, ACK_SECRET) }),
      seed: async () =>
        seedDemoHousehold(store, { now: await now(store), l1Email: env('SEED_L1_EMAIL'), l2Email: env('SEED_L2_EMAIL'), demoMode: true }),
      planner: (body) => bedrockOrRulesPlanner(body),
      publicConfig: () => ({ mode: 'aws', householdId: 'demo' }),
      demoConfig: (origin) => ({
        mcpUrl: `${origin}/mcp`,
        mcpToken: MCP_TOKEN,
        householdId: 'demo',
        planner: process.env.BEDROCK_MODEL_ID ? 'bedrock' : 'rules',
        mode: 'aws',
      }),
      staticFile: async (path) => {
        const f = staticPathToFile(path);
        const body = f && STATIC_FILES[f.file];
        return body === undefined || !f ? undefined : { body, type: f.type };
      },
    },
  ),
);

export async function lambdaHandler(event: FunctionUrlEvent | { source?: string }) {
  // EventBridge Scheduler keep-warm ping: return immediately (one warm instance covers one household).
  if ((event as { source?: string }).source === 'closed-loop.keep-warm') return { warm: true };
  return handler(event as FunctionUrlEvent);
}
