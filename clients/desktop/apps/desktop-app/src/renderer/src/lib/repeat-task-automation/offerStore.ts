import { create } from 'zustand';
import type { AutomationDraftSeed } from '@/lib/workflows/edit-target';

/** The repeated-task offer on screen, waiting for an answer. */
export interface RepeatTaskOffer {
  /** The history entry the answer resolves. */
  entryId: string;
  /** Account epoch the offer was made under; it does nothing after a switch. */
  accountEpoch: number;
  seed: AutomationDraftSeed;
}

interface RepeatTaskOfferState {
  /** Session-only: a reload drops it unanswered, so the next repeat offers again. */
  offer: RepeatTaskOffer | null;
}

export const useRepeatTaskOfferStore = create<RepeatTaskOfferState>(() => ({
  offer: null,
}));
