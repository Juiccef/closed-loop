// Async second opinion on what the person said. Runs after the response is stored (DynamoDB Streams),
// never on the MCP hot path. It can only move a record toward caution:
//  - distress or crisis heard by the model -> NEEDS_HUMAN, and the tick sends the family note
//  - stored "done" but the model hears something else -> reviewFlag, shown in the console
// Status: Bedrock calls are written against the Converse API; this account's quota is 0 (FRICTION_LOG #7),
// so today every call fails fast and is logged as "unavailable".

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mutateOccurrence, type CheckinResponse, type Store } from '@closed-loop/core';

export const CATEGORIES = ['done', 'later', 'not_yet', 'no', 'unsure', 'distress', 'crisis'] as const;
export type Category = (typeof CATEGORIES)[number];

const SYSTEM = `You review one reply that an older adult gave to a daily check-in question asked by a voice assistant.
Classify the reply into exactly one category:
- done: a clear statement that it is already done
- later / not_yet: will do it later, or has not done it yet
- no: declines
- unsure: hedged, vague, or unclear ("I think so", "maybe")
- distress: confused, frightened, lost, asking for people, wanting to go home
- crisis: a fall, pain, breathing trouble, an emergency, or any hint of self-harm
When in doubt between done and unsure, choose unsure. When in doubt between unsure and distress, choose distress.`;

let client: BedrockRuntimeClient | undefined;

export async function classifyWithBedrock(text: string, modelId: string): Promise<Category> {
  client ??= new BedrockRuntimeClient({ maxAttempts: 1 });
  const res = await client.send(
    new ConverseCommand({
      modelId,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content: [{ text: `Reply: "${text.slice(0, 200)}"` }] }],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'classify',
              description: 'Record the category of the reply.',
              inputSchema: { json: { type: 'object', properties: { category: { type: 'string', enum: [...CATEGORIES] } }, required: ['category'] } },
            },
          },
        ],
        toolChoice: { tool: { name: 'classify' } },
      },
      inferenceConfig: { maxTokens: 50, temperature: 0 },
    }),
  );
  const use = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  const category = (use?.input as { category?: string } | undefined)?.category;
  if (!category || !(CATEGORIES as readonly string[]).includes(category)) throw new Error('model gave no valid category');
  return category as Category;
}

export type ReviewOutcome = 'agrees' | 'escalated_needs_human' | 'flagged_done' | 'skipped';

/** Pure decision: only ever toward caution. */
export function reviewDecision(stored: CheckinResponse, model: Category): ReviewOutcome {
  if ((model === 'distress' || model === 'crisis') && stored !== 'needs_help') return 'escalated_needs_human';
  if (stored === 'done' && model !== 'done') return 'flagged_done';
  return 'agrees';
}

export interface UtteranceRecord {
  householdId: string;
  occurrenceId: string;
  at: string;
  text: string;
  stored: CheckinResponse;
}

export async function reviewUtterance(
  store: Store,
  u: UtteranceRecord,
  classify: (text: string) => Promise<Category>,
): Promise<{ outcome: ReviewOutcome; category?: Category; error?: string }> {
  let category: Category;
  try {
    category = await classify(u.text);
  } catch (err) {
    return { outcome: 'skipped', error: (err as Error).name || 'Error' };
  }
  const outcome = reviewDecision(u.stored, category);
  const nowIso = new Date().toISOString();
  if (outcome === 'escalated_needs_human') {
    await mutateOccurrence(store, u.householdId, u.occurrenceId, (cur) => ({
      ...cur,
      state: 'NEEDS_HUMAN',
      reviewFlag: 'needs_human',
      needsHumanNoteStatus: cur.needsHumanNoteStatus === 'sent' ? 'sent' : 'pending',
      needsHumanCrisis: cur.needsHumanCrisis || category === 'crisis',
      updatedAt: nowIso,
    }));
  } else if (outcome === 'flagged_done') {
    await mutateOccurrence(store, u.householdId, u.occurrenceId, (cur) => (cur.reviewFlag ? null : { ...cur, reviewFlag: 'needs_human', updatedAt: nowIso }));
  }
  if (outcome !== 'agrees') {
    await store.appendEvent({
      householdId: u.householdId,
      at: nowIso,
      type: 'review_flagged',
      occurrenceId: u.occurrenceId,
      detail:
        outcome === 'escalated_needs_human'
          ? 'Second check heard possible distress; marked as needing human contact and queued a family note.'
          : 'Second check was not sure this was done; flagged for a person to follow up.',
    });
  }
  await store.markUtteranceReviewed(u.householdId, u.occurrenceId, u.at);
  return { outcome, category };
}
