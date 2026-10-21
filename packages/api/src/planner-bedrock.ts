// Bedrock planner (Converse API with tool definitions), a stand-in for Alexa+'s own LLM.
// Off the MCP hot path: the browser asks the planner which tool to call, then calls the MCP server itself.
// Falls back to the rules planner on any error, missing model ID, or timeout, and says so in the response.
// Status: written against the Converse API types; live calls are blocked on this account (FRICTION_LOG #7).

import { BedrockRuntimeClient, ConverseCommand, type Tool } from '@aws-sdk/client-bedrock-runtime';
import { rulesPlanner, type PlannerRequest, type PlannerResponse } from './planner';

// One attempt: a throttled or failed call falls back to rules immediately instead of retrying.
const client = new BedrockRuntimeClient({ maxAttempts: 1 });
const TIMEOUT_MS = 4000;

const SYSTEM = `You decide the next tool call for a voice assistant running daily check-ins for an older adult who lives alone.
The person just spoke. Call exactly one tool.
Rules:
- If a check-in is in progress and the person answered it, call record_response with the closest response and pass their words as utterance.
- If they give a time ("after lunch", "this evening", "in an hour"), call defer_checkin with the matching value instead.
- Only use response "done" for a clear yes. Hedged or unclear answers ("I think so", "maybe") are "unsure". Never guess "done".
- Any sign of confusion, fear, pain, a fall, or asking for help: record_response with "needs_help".
- "Pause", "stop asking", "leave me alone": pause_checkins with no questions asked.
- "How am I doing", "who can see this": get_my_status.
- Otherwise, to see what is due: get_due_checkins.
Do not give medical advice. Do not ask follow-up questions.`;

function toBedrockTools(tools: PlannerRequest['tools']): Tool[] {
  return (tools ?? []).slice(0, 10).map((t) => {
    const { $schema: _ignored, ...schema } = (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;
    return { toolSpec: { name: t.name, description: (t.description ?? t.name).slice(0, 500), inputSchema: { json: schema as never } } };
  });
}

export async function bedrockPlanner(req: PlannerRequest, modelId: string): Promise<PlannerResponse> {
  const started = Date.now();
  const context = req.current
    ? `Check-in in progress: occurrenceId=${req.current.occurrenceId}, label="${req.current.label}", question="${req.current.prompt}".`
    : 'No check-in is in progress.';
  const res = await client.send(
    new ConverseCommand({
      modelId,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content: [{ text: `${context}\nThe person said: "${String(req.userText).slice(0, 200)}"` }] }],
      toolConfig: { tools: toBedrockTools(req.tools), toolChoice: { any: {} } },
      inferenceConfig: { maxTokens: 300, temperature: 0 },
    }),
    { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  const use = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  if (!use?.name) throw new Error('model returned no tool call');
  return {
    planner: 'bedrock',
    toolCall: { name: use.name, arguments: (use.input ?? {}) as Record<string, unknown> },
    rationale: 'model tool choice',
    model: modelId,
    latencyMs: Date.now() - started,
  };
}

export async function bedrockOrRulesPlanner(body: unknown): Promise<PlannerResponse> {
  const req = (body ?? {}) as PlannerRequest;
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) return rulesPlanner(req);
  if (!req.tools?.length) {
    const fallback = rulesPlanner(req);
    return { ...fallback, rationale: `${fallback.rationale} (no tool list sent, so Bedrock was not called)` };
  }
  try {
    return await bedrockPlanner(req, modelId);
  } catch (err) {
    const fallback = rulesPlanner(req);
    return { ...fallback, rationale: `${fallback.rationale} (Bedrock unavailable: ${(err as Error).name})` };
  }
}
