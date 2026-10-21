// AWS entry point for the tick: invoked by EventBridge Scheduler every minute.
import { ackUrlBuilder, runTick } from '@closed-loop/core';
import { DynamoStore } from '@closed-loop/store-dynamo';
import { SesMailer } from './mailers';

const store = new DynamoStore(process.env.TABLE_NAME!);
const mailer = new SesMailer(process.env.SES_SENDER!);
const ackUrl = ackUrlBuilder(process.env.WEB_URL!, process.env.ACK_LINK_SECRET!);

export async function lambdaHandler() {
  const report = await runTick(store, { mailer, ackUrl });
  console.log(JSON.stringify({ msg: 'tick', ...report }));
  if (report.errors.length) console.error(JSON.stringify({ msg: 'tick errors', errors: report.errors }));
  return report;
}
