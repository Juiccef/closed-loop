import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CANCEL_STATUSES,
  CheckinInputError,
  DEFER_UNTIL,
  LEDGER_STATUSES,
  LOOP_KINDS,
  NEXT_STEPS,
  PAUSE_SCOPES,
  RESPONSES,
  SELF_REPEATS,
  SET_STATUSES,
  cancelMyCheckin,
  deferCheckin,
  getDueCheckins,
  getFamilySummary,
  getMyStatus,
  pauseCheckins,
  recordResponse,
  setMyCheckin,
  type CheckinResponse,
  type DeferUntil,
  type PauseScope,
  type SetMyCheckinInput,
  type Store,
} from '@closed-loop/core';
import { CARD_HTML, CARD_MIME, CARD_URI } from './card';

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

/** Words only: no digits (no doses or times in the phrase), nothing that reads as a web address. */
const phrase = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z'\u2019 ,.!?-]*$/);

export const ownCheckinSchema = z.object({
  checkinId: z.string().max(20),
  phrase: z.string().max(40),
  byLocal: z.string().max(5),
  tell: z.string().max(40),
  repeat: z.enum(SELF_REPEATS),
  occurrenceId: z.string().max(80),
  recorded: z.string().max(120),
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
    mine: z.array(ownCheckinSchema).max(6),
    say: spoken,
  }),
  pause_checkins: z.object({
    pausedUntilLocal: z.string().max(16),
    say: spoken,
  }),
  get_family_summary: z.object({
    date: z.string().max(10),
    recipientName: z.string().max(40),
    items: z.array(
      z.object({
        label: z.string().max(100),
        window: z.string().max(16),
        recorded: z.string().max(120),
        kind: z.enum(LOOP_KINDS),
      }),
    ),
    reported: z.number().int(),
    open: z.number().int(),
    needsHumanContact: z.number().int(),
    say: spoken,
  }),
  set_my_checkin: z.object({
    status: z.enum(SET_STATUSES),
    checkin: ownCheckinSchema.optional(),
    confirmToken: z.string().max(600).optional(),
    expiresInSeconds: z.number().int().optional(),
    nextStep: z.enum(NEXT_STEPS),
    calmingLine: z.string().max(200).optional(),
    say: spoken,
  }),
  cancel_my_checkin: z.object({
    status: z.enum(CANCEL_STATUSES),
    checkin: ownCheckinSchema.optional(),
    remaining: z.number().int(),
    say: spoken,
  }),
} as const;

export type ToolOutputs = { [K in keyof typeof outputs]: z.infer<(typeof outputs)[K]> };

export interface CallerContext {
  householdId: string;
  /** 'person': the person's own assistant. 'family': a family member's, which may read but never answer. 'any': the demo token. */
  role: 'person' | 'family' | 'any';
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
  getFamilySummary(ctx: CallerContext): Promise<ToolOutputs['get_family_summary']>;
  setMyCheckin(ctx: CallerContext, input: SetMyCheckinInput): Promise<ToolOutputs['set_my_checkin']>;
  cancelMyCheckin(ctx: CallerContext, input: { checkinId?: string; phrase?: string }): Promise<ToolOutputs['cancel_my_checkin']>;
}

/**
 * The real backend: core check-in logic over a Store (DynamoDB in AWS, memory locally).
 * `confirmSecret` signs set_my_checkin confirm tokens; every instance of a deployment must share it.
 */
export function coreBackend(store: Store, opts: { confirmSecret?: string } = {}): CheckinBackend {
  return {
    setMyCheckin: (ctx, input) => setMyCheckin(store, ctx.householdId, input, { secret: opts.confirmSecret }),
    cancelMyCheckin: (ctx, input) => cancelMyCheckin(store, ctx.householdId, input),
    getDueCheckins: (ctx) => getDueCheckins(store, ctx.householdId),
    recordResponse: (ctx, input) => recordResponse(store, ctx.householdId, input),
    deferCheckin: (ctx, input) => deferCheckin(store, ctx.householdId, input),
    getMyStatus: (ctx) => getMyStatus(store, ctx.householdId),
    pauseCheckins: (ctx, input) => pauseCheckins(store, ctx.householdId, input),
    getFamilySummary: (ctx) => getFamilySummary(store, ctx.householdId),
  };
}

/** Status lines Alexa+ shows while a tool runs and when it finishes (`_meta.ui` in the tool response). */
const UI_STATUS: Record<string, [invoking: string, invoked: string]> = {
  get_due_checkins: ['Checking today\u2019s check-ins', 'Check-ins ready'],
  record_response: ['Noting the answer', 'Answer noted'],
  defer_checkin: ['Moving the check-in', 'Check-in moved'],
  get_my_status: ['Reading today\u2019s summary', 'Summary ready'],
  pause_checkins: ['Pausing check-ins', 'Check-ins paused'],
  get_family_summary: ['Reading today\u2019s check-ins', 'Today\u2019s check-ins'],
  set_my_checkin: ['Setting up your check-in', 'Your check-in'],
  cancel_my_checkin: ['Cancelling your check-in', 'Check-in cancelled'],
};

/** Tool definitions reference the card per the MCP Apps extension (SEP-1865). */
const toolUiMeta = { ui: { resourceUri: CARD_URI } };

function result<T extends { say: string }>(tool: string, structured: T): CallToolResult {
  const [invoking, invoked] = UI_STATUS[tool] ?? ['Working', 'Done'];
  return {
    content: [{ type: 'text', text: structured.say }],
    structuredContent: structured as unknown as Record<string, unknown>,
    _meta: { ui: { resourceUri: CARD_URI, invoking, invoked } },
  };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Answers belong to the person. A family member's assistant can read the day but cannot answer, defer, or pause for them. */
const FAMILY_CANNOT_ANSWER =
  'Only the person can answer, pause, or set up their own check-ins, on their own device. Family can ask how the day went with get_family_summary.';
const PERSON_TOOLS = new Set(['get_due_checkins', 'record_response', 'defer_checkin', 'pause_checkins', 'set_my_checkin', 'cancel_my_checkin']);

async function guarded<T extends { say: string }>(tool: string, fn: () => Promise<T>, ctx?: CallerContext): Promise<CallToolResult> {
  if (ctx?.role === 'family' && PERSON_TOOLS.has(tool)) return failure(FAMILY_CANNOT_ANSWER);
  try {
    return result(tool, await fn());
  } catch (err) {
    if (err instanceof CheckinInputError) return failure(err.message);
    throw err;
  }
}

export function registerTools(server: McpServer, backend: CheckinBackend, ctx: CallerContext): void {
  server.registerResource(
    'checkin-card',
    CARD_URI,
    {
      title: 'Check-in card',
      description: 'Visual card for check-in results (MCP Apps). Clients without UI support use the text result.',
      mimeType: CARD_MIME,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({ contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: CARD_HTML, _meta: { ui: { prefersBorder: false } } }] }),
  );

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
      _meta: toolUiMeta,
    },
    async () => guarded('get_due_checkins', () => backend.getDueCheckins(ctx), ctx),
  );

  server.registerTool(
    'record_response',
    {
      title: 'Record a check-in answer',
      description:
        "Records the person's answer to one check-in. Pick the closest response: done, later, not_yet, no, unsure, or needs_help. " +
        'If the answer is hedged or unclear, use unsure. Pass the short utterance so the record reflects what was actually said. ' +
        'Read back the returned "say" text; if a calmingLine is returned, say it and do not ask further questions. ' +
        'When the person says the phrase of a check-in they set up themselves (for example "good night"), call this with that ' +
        "check-in's occurrenceId from get_my_status, response done, and their words.",
      inputSchema: {
        occurrenceId,
        response: z.enum(RESPONSES),
        utterance: z.string().max(200).optional().describe("The person's own words, at most 200 characters."),
      },
      outputSchema: outputs.record_response.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      _meta: toolUiMeta,
    },
    async (args) => guarded('record_response', () => backend.recordResponse(ctx, args), ctx),
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
      _meta: toolUiMeta,
    },
    async (args) => guarded('defer_checkin', () => backend.deferCheckin(ctx, args), ctx),
  );

  server.registerTool(
    'get_my_status',
    {
      title: "Today's check-in summary",
      description:
        "Tells the person, in plain words, how today's check-ins stand and which family contacts receive updates, so they know what is shared. " +
        'Also lists the check-ins the person set up themselves (mine), each with the occurrenceId that saying its phrase now would close.',
      inputSchema: {},
      outputSchema: outputs.get_my_status.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: toolUiMeta,
    },
    async () => guarded('get_my_status', () => backend.getMyStatus(ctx)),
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
      _meta: toolUiMeta,
    },
    async (args) => guarded('pause_checkins', () => backend.pauseCheckins(ctx, args), ctx),
  );

  server.registerTool(
    'get_family_summary',
    {
      title: "How today's check-ins went (for family)",
      description:
        "For a family member asking about the person, for example \"How is Mom doing today?\". Returns today's check-ins exactly as recorded " +
        '("reported by the person", "said later", "no response", "needs human contact"). Read the returned "say" text as is and never ' +
        'describe a check-in as more certain than it was recorded. Read-only; it cannot answer check-ins for the person.',
      inputSchema: {},
      outputSchema: outputs.get_family_summary.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: toolUiMeta,
    },
    async () => guarded('get_family_summary', () => backend.getFamilySummary(ctx)),
  );

  server.registerTool(
    'set_my_checkin',
    {
      title: 'Set up my own check-in',
      description:
        'For the person, on their own device: sets up a check-in of their own, in their words, for example "If I haven\u2019t said ' +
        'good night by ten, let Dana know." It is never asked; it closes when the person says the phrase before the time. ' +
        'Two calls. First call without confirmToken: returns a spoken preview and a confirmToken, and stores nothing. Read the ' +
        "preview, wait for the person's answer, then call again with only confirmToken and the person's own words as utterance. " +
        'Never make the second call without asking. The contact must already receive check-in emails. At most three at a time.',
      inputSchema: {
        phrase: phrase.optional().describe('What the person will say that closes the loop, in their words, for example "good night". First call only.'),
        by: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional()
          .describe('Local time it must be said by, 24-hour HH:MM, for example "22:00". First call only.'),
        tell: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[A-Za-z][A-Za-z'\u2019 -]*$/)
          .optional()
          .describe('First name or relation of the contact to email, for example "Dana" or "daughter". Defaults to the first contact. First call only.'),
        repeat: z.enum(SELF_REPEATS).optional().describe('tonight (once, the next time that hour comes) or daily. Defaults to tonight. First call only.'),
        confirmToken: z
          .string()
          .min(1)
          .max(600)
          .regex(/^[A-Za-z0-9_.-]+$/)
          .optional()
          .describe('From the preview. Second call only, together with utterance.'),
        utterance: z.string().max(200).optional().describe("The person's own words, at most 200 characters. On the second call, their answer to the preview."),
      },
      outputSchema: outputs.set_my_checkin.shape,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      _meta: toolUiMeta,
    },
    async (args) => guarded('set_my_checkin', () => backend.setMyCheckin(ctx, args), ctx),
  );

  server.registerTool(
    'cancel_my_checkin',
    {
      title: 'Cancel my own check-in',
      description:
        'For the person, on their own device: cancels one of the check-ins they set up themselves, for example "cancel my good ' +
        'night check". Pass the phrase, or the checkinId from get_my_status. Nobody is emailed about it afterwards. Always honor it.',
      inputSchema: {
        checkinId: z
          .string()
          .regex(/^me-[a-f0-9]{10}$/)
          .optional()
          .describe('From get_my_status (mine).'),
        phrase: phrase.optional().describe('The phrase of the check-in, for example "good night".'),
      },
      outputSchema: outputs.cancel_my_checkin.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      _meta: toolUiMeta,
    },
    async (args) => guarded('cancel_my_checkin', () => backend.cancelMyCheckin(ctx, args), ctx),
  );
}
