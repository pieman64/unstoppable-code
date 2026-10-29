import { create } from 'zustand';

interface HomeInterruptedSessionsBannerState {
  /**
   * Signature (see `summarizeInterruptedSessions`) of the interrupted set
   * the user dismissed. Session-only on purpose: a restart re-offers the
   * banner, and any change to the set (a new interruption or a resume made
   * elsewhere) also brings it back.
   */
  dismissedSignature: string | null;
  dismiss: (signature: string) => void;
}

export const useHomeInterruptedSessionsBannerStore =
  create<HomeInterruptedSessionsBannerState>((set) => ({
    dismissedSignature: null,
    dismiss: (signature): void => set({ dismissedSignature: signature }),
  }));
