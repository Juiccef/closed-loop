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
      occurrenceId: input.occurrenceId,
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
};
