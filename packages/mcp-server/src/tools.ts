import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Tool signatures are locked once an Alexa+ add-on is published, so everything here is
// deterministic: fixed names, fixed order, bounded strings, enums instead of free text.

export const RESPONSES = ['done', 'later', 'not_yet', 'no', 'unsure', 'needs_help'] as const;
export const DEFER_UNTIL = ['in_30_min', 'in_1_hour', 'after_lunch', 'this_afternoon', 'this_evening'] as const;
export const PAUSE_SCOPES = ['today', '24_hours'] as const;
export const LEDGER_STATUSES = [
  'scheduled',
  'asked',
  'reported_by_person',
  'said_later',
  'said_not_yet',
  'declined',
  'not_sure',
  'no_response',
  'needs_human_contact',
  'acknowledged',
] as const;

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
    recordedAs: z.enum(LEDGER_STATUSES),
    recordedWording: z.string().max(120),
    nextStep: z.enum(['none', 'will_ask_again_later', 'family_will_be_told', 'call_emergency_services']),
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
export type Response = (typeof RESPONSES)[number];
export type DeferUntil = (typeof DEFER_UNTIL)[number];
export type PauseScope = (typeof PAUSE_SCOPES)[number];

export interface CallerContext {
  householdId: string;
}

/** What the tools need from the rest of the system. Implementations must touch storage only (no network on the hot path). */
export interface CheckinBackend {
  getDueCheckins(ctx: CallerContext): Promise<ToolOutputs['get_due_checkins']>;
  recordResponse(
    ctx: CallerContext,
    input: { occurrenceId: string; response: Response; utterance?: string },
  ): Promise<ToolOutputs['record_response']>;
  deferCheckin(ctx: CallerContext, input: { occurrenceId: string; until: DeferUntil }): Promise<ToolOutputs['defer_checkin']>;
  getMyStatus(ctx: CallerContext): Promise<ToolOutputs['get_my_status']>;
  pauseCheckins(ctx: CallerContext, input: { scope: PauseScope }): Promise<ToolOutputs['pause_checkins']>;
}

export class ToolInputError extends Error {}

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
    if (err instanceof ToolInputError) return failure(err.message);
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
