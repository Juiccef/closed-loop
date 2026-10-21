// AWS entry point: DynamoDB Streams (new utterance items only, via an event filter) -> second opinion.
import { DynamoStore } from '@closed-loop/store-dynamo';
import type { CheckinResponse } from '@closed-loop/core';
import { classifyWithBedrock, reviewUtterance } from './index';

interface StreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, { S?: string }> };
}

const store = new DynamoStore(process.env.TABLE_NAME!);
const modelId = process.env.BEDROCK_MODEL_ID ?? '';

export async function lambdaHandler(event: { Records?: StreamRecord[] }) {
  for (const r of event.Records ?? []) {
    const img = r.dynamodb?.NewImage;
    if (r.eventName !== 'INSERT' || !img?.SK?.S?.startsWith('UTT#')) continue;
    const u = {
      householdId: img.householdId?.S ?? '',
      occurrenceId: img.occurrenceId?.S ?? '',
      at: img.at?.S ?? '',
      text: img.text?.S ?? '',
      stored: (img.stored?.S ?? 'unsure') as CheckinResponse,
    };
    if (!modelId) {
      console.log(JSON.stringify({ msg: 'review skipped: no model configured', occurrenceId: u.occurrenceId }));
      continue;
    }
    const result = await reviewUtterance(store, u, (text) => classifyWithBedrock(text, modelId));
    console.log(JSON.stringify({ msg: 'review', occurrenceId: u.occurrenceId, ...result }));
  }
}
