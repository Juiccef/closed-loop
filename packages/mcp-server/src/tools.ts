import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CheckinInputError,
  DEFER_UNTIL,
  LEDGER_STATUSES,
  NEXT_STEPS,
  PAUSE_SCOPES,
  RESPONSES,
  deferCheckin,
  getDueCheckins,
  getMyStatus,
  pauseCheckins,
  recordResponse,
  type CheckinResponse,
  type DeferUntil,
  type PauseScope,
  type Store,
} from '@closed-loop/core';

// Tool signatures are locked once an Alexa+ add-on is published, so everything here is
// deterministic: fixed names, fixed order, bounded strings, enums instead of free text.

export { RESPONSES, DEFER_UNTIL, PAUSE_SCOPES, LEDGER_STATUSES, NEXT_STEPS };
const occurrenceId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9#:_-]+$/)
  .describe('The occurrenceId returned by get_due_checkins.');

const spoken = z.string().max(400);

export const dueCheckinSchema = z.object({
  occurrenceId: z.string(),
  label: z.string().max(80),
  prompt: z.string().max(200),
  allowedResponses: z.array(z.enum(RESPONSES)),
  isFollowUp: z.boolean(),
});

export const outputs = {
  get_due_checkins: z.object({
    checkins: z.array(dueCheckinSchema),
    paused: z.boolean(),
    say: spoken,
  }),
  record_response: z.object({
    occurrenceId: z.string(),
    recordedAs: z.enum([...LEDGER_STATUSES, 'not_recorded']),
    recordedWording: z.string().max(120),
    nextStep: z.enum(NEXT_STEPS),
    calmingLine: z.string().max(200).optional(),
    say: spoken,
  }),
  defer_checkin: z.object({
    occurrenceId: z.string(),
    deferredUntilLocal: z.string().max(5),
    say: spoken,
  }),
  get_my_status: z.object({
    date: z.string().max(10),
    reported: z.number().int(),
    open: z.number().int(),
    sharedWith: z.array(z.string().max(60)),
    paused: z.boolean(),
    say: spoken,
  }),
  pause_checkins: z.object({
    pausedUntilLocal: z.string().max(16),
    say: spoken,
  }),
} as const;

export type ToolOutputs = { [K in keyof typeof outputs]: z.infer<(typeof outputs)[K]> };

export interface CallerContext {
  householdId: string;
}

/** What the tools need from the rest of the system. Implementations must touch storage only (no network on the hot path). */
export interface CheckinBackend {
  getDueCheckins(ctx: CallerContext): Promise<ToolOutputs['get_due_checkins']>;
  recordResponse(
    ctx: CallerContext,
    input: { occurrenceId: string; response: CheckinResponse; utterance?: string },
  ): Promise<ToolOutputs['record_response']>;
  deferCheckin(ctx: CallerContext, input: { occurrenceId: string; until: DeferUntil }): Promise<ToolOutputs['defer_checkin']>;
  getMyStatus(ctx: CallerContext): Promise<ToolOutputs['get_my_status']>;
  pauseCheckins(ctx: CallerContext, input: { scope: PauseScope }): Promise<ToolOutputs['pause_checkins']>;
}

/** The real backend: core check-in logic over a Store (DynamoDB in AWS, memory locally). */
export function coreBackend(store: Store): CheckinBackend {
  return {
    getDueCheckins: (ctx) => getDueCheckins(store, ctx.householdId),
    recordResponse: (ctx, input) => recordResponse(store, ctx.householdId, input),
    deferCheckin: (ctx, input) => deferCheckin(store, ctx.householdId, input),
    getMyStatus: (ctx) => getMyStatus(store, ctx.householdId),
    pauseCheckins: (ctx, input) => pauseCheckins(store, ctx.householdId, input),
  };
}

function result<T extends { say: string }>(structured: T): CallToolResult {
  return {
    content: [{ type: 'text', text: structured.say }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function guarded<T extends { say: string }>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return result(await fn());
  } catch (err) {
    if (err instanceof CheckinInputError) return failure(err.message);
    throw err;
  }
}

export function registerTools(server: McpServer, backend: CheckinBackend, ctx: CallerContext): void {
  server.registerTool(
    'get_due_checkins',
    {
      title: 'Get due check-ins',
      description:
        'Returns the daily check-ins that are open right now for this household, with the exact question wording the family wrote. ' +
        'Ask each returned prompt once, in order, then record the answer with record_response. Do not repeat a question in the same turn.',
      inputSchema: {},
      outputSchema: outputs.get_due_checkins.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => guarded(() => backend.getDueCheckins(ctx)),
  );

  server.registerTool(
    'record_response',
    {
      title: 'Record a check-in answer',
      description:
        "Records the person's answer to one check-in. Pick the closest response: done, later, not_yet, no, unsure, or needs_help. " +
        'If the answer is hedged or unclear, use unsure. Pass the short utterance so the record reflects what was actually said. ' +
        'Read back the returned "say" text; if a calmingLine is returned, say it and do not ask further questions.',
      inputSchema: {
        occurrenceId,
        response: z.enum(RESPONSES),
        utterance: z.string().max(200).optional().describe("The person's own words, at most 200 characters."),
      },
      outputSchema: outputs.record_response.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => guarded(() => backend.recordResponse(ctx, args)),
  );

  server.registerTool(
    'defer_checkin',
    {
      title: 'Ask again later',
      description:
        'Use when the person says they will do it later. Moves the check-in to a later time today and it will be asked again then.',
      inputSchema: { occurrenceId, until: z.enum(DEFER_UNTIL) },
      outputSchema: outputs.defer_checkin.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guarded(() => backend.deferCheckin(ctx, args)),
  );

  server.registerTool(
    'get_my_status',
    {
      title: "Today's check-in summary",
      description:
        "Tells the person, in plain words, how today's check-ins stand and which family contacts receive updates, so they know what is shared.",
      inputSchema: {},
      outputSchema: outputs.get_my_status.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => guarded(() => backend.getMyStatus(ctx)),
  );

  server.registerTool(
    'pause_checkins',
    {
      title: 'Pause check-ins',
      description:
        'Pauses all check-ins for today or for 24 hours. Always honor this request without asking why. The family sees the pause in their next summary.',
      inputSchema: { scope: z.enum(PAUSE_SCOPES) },
      outputSchema: outputs.pause_checkins.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guarded(() => backend.pauseCheckins(ctx, args)),
  );
}
