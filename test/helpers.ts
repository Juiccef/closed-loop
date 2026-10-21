import {
  MemoryStore,
  runTick,
  seedDemoHousehold,
  setRealTimeSource,
  signAck,
  zonedInstant,
  type Mailer,
  type OutgoingEmail,
  type TickReport,
} from '../packages/core/src';

export const TZ = 'America/New_York';
export const H = 'demo';

export class FakeMailer implements Mailer {
  readonly label = 'test mailer';
  sent: OutgoingEmail[] = [];
  failNext = 0;
  async send(email: OutgoingEmail) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated SES failure');
    }
    this.sent.push(email);
    return { messageId: `m${this.sent.length}` };
  }
}

/** Sets the real-time source to a local New York wall time, e.g. "2026-10-19 08:00". */
export function setLocal(local: string): Date {
  const [date, time] = local.split(' ') as [string, string];
  const t = zonedInstant(date, time, TZ);
  setRealTimeSource(() => t.getTime());
  return t;
}

export async function demo(start = '2026-10-19 07:00', opts: { demoMode?: boolean } = {}) {
  const store = new MemoryStore();
  const mailer = new FakeMailer();
  const now = setLocal(start);
  await seedDemoHousehold(store, { now, l1Email: 'dana@example.com', l2Email: 'sam@example.com', demoMode: opts.demoMode ?? true });
  const tick = (): Promise<TickReport> =>
    runTick(store, {
      mailer,
      ackUrl: (h, o, c) => `https://example.test/ack?t=${signAck('test-secret', { householdId: h, occurrenceId: o, contactId: c, exp: 9e9 })}`,
    });
  return { store, mailer, tick };
}
