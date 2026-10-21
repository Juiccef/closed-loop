// Phase 0 spike 3: the real MCP HTTP handler on a Lambda Function URL, with one DynamoDB read per tool call.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createMcpHttpHandler } from '../../packages/mcp-server/src/http';
import { urlEventHandler } from '../../packages/mcp-server/src/lambda-adapter';
import { stubBackend } from '../../packages/mcp-server/src/stub-backend';
import type { CheckinBackend } from '../../packages/mcp-server/src/tools';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = process.env.TABLE_NAME!;

// Open the DynamoDB connection and resolve credentials during init (ESM top-level await), not on the first request.
if (process.env.WARM_AT_INIT === '1') {
  try {
    await ddb.send(new GetCommand({ TableName: table, Key: { PK: 'WARMUP', SK: 'WARMUP' } }));
  } catch {
    // Warm-up is best effort.
  }
}

const backend: CheckinBackend = {
  ...stubBackend,
  async getDueCheckins(ctx) {
    await ddb.send(new GetCommand({ TableName: table, Key: { PK: ctx.householdId, SK: 'META' } }));
    return stubBackend.getDueCheckins(ctx);
  },
};

export const handler = urlEventHandler(
  createMcpHttpHandler(
    {
      bearerTokens: { [process.env.MCP_BEARER_TOKEN!]: 'H#demo' },
      allowedOrigins: [],
      resourceUrl: process.env.RESOURCE_URL ?? '',
      includeWwwAuthenticate: false,
    },
    backend,
  ),
);
