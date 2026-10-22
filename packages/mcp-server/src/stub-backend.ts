import type { CheckinBackend } from './tools';

/** Fixed responses for the Phase 0 handshake spike. Replaced by the core ledger in Phase 2. */
export const stubBackend: CheckinBackend = {
  async getDueCheckins() {
    return {
      checkins: [
        {
          occurrenceId: 'OCC#2026-10-19#morning#0',
          label: 'your morning routine',
          prompt: 'Good morning. Have you done your morning routine yet?',
          allowedResponses: ['done', 'later', 'not_yet', 'no', 'unsure', 'needs_help'],
          isFollowUp: false,
        },
      ],
      paused: false,
      say: 'Good morning. Have you done your morning routine yet?',
    };
  },
  async recordResponse(_ctx, input) {
    return {
      occurrenceId: input.occurrenceId ?? 'OCC#2026-10-19#OUTSIDE#0',
      recordedAs: 'not_sure',
      recordedWording: 'said they would, not sure',
      nextStep: 'will_ask_again_later',
      say: "Okay, I've noted that. I'll check again later.",
    };
  },
  async deferCheckin(_ctx, input) {
    return { occurrenceId: input.occurrenceId, deferredUntilLocal: '13:00', say: "Okay, I'll ask again after lunch." };
  },
  async getMyStatus() {
    return {
      date: '2026-10-19',
      reported: 0,
      open: 1,
      sharedWith: ['Dana (daughter)'],
      paused: false,
      mine: [],
      say: 'Today: none reported yet, 1 still open. Dana gets a note if a check-in stays open.',
    };
  },
  async pauseCheckins() {
    return { pausedUntilLocal: '2026-10-19 23:59', say: 'Okay, check-ins are paused for today.' };
  },
  async getFamilySummary() {
    return {
      date: '2026-10-19',
      recipientName: 'Margaret',
      items: [{ label: "Margaret's morning routine", window: '08:00–11:00', recorded: 'asked, no answer yet', kind: 'open' as const }],
      reported: 0,
      open: 1,
      needsHumanContact: 0,
      say: "Here is what Margaret's check-ins recorded today. Margaret's morning routine: asked, no answer yet. These are Margaret's own answers, recorded as said.",
    };
  },
  async setMyCheckin(_ctx, input) {
    const checkin = { checkinId: '', phrase: input.phrase ?? 'good night', byLocal: input.by ?? '22:00', tell: 'Dana', repeat: input.repeat ?? ('tonight' as const), occurrenceId: '', recorded: '' };
    return input.confirmToken
      ? { status: 'set' as const, checkin: { ...checkin, checkinId: 'me-0123456789', occurrenceId: 'OCC#2026-10-19#me-0123456789#0', recorded: 'not said yet' }, nextStep: 'none' as const, say: "Okay, it's set. Say good night any time before 10 pm tonight. If I don't hear it, I'll email Dana." }
      : { status: 'confirm_needed' as const, checkin, confirmToken: 'stub.token', expiresInSeconds: 300, nextStep: 'none' as const, say: "If you haven't said good night by 10 pm tonight, I'll email Dana. Should I set that up?" };
  },
  async cancelMyCheckin() {
    return { status: 'not_cancelled' as const, remaining: 0, say: "You haven't set up any check-ins of your own." };
  },
};
