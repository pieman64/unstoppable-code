import { create } from 'zustand';
import type {
  ChatSessionExportRequest,
  ChatSessionExportResponse,
} from '@canopy/desktop-shared/types';

export type ShareSessionStatus =
  | { phase: 'sharing' }
  | { phase: 'success'; response: ChatSessionExportResponse }
  | { phase: 'error'; message: string };

interface ShareSessionStatusState {
  target: ChatSessionExportRequest | null;
  ownerDocument: Document | null;
  status: ShareSessionStatus | null;
  operationId: number;
  begin: (target: ChatSessionExportRequest, ownerDocument: Document) => number;
  succeed: (operationId: number, response: ChatSessionExportResponse) => void;
  fail: (operationId: number, message: string) => void;
  close: () => void;
}

let nextOperationId = 0;

/** Foreground status for a user-initiated private session upload. */
export const useShareSessionStatusStore = create<ShareSessionStatusState>(
  (set) => ({
    target: null,
    ownerDocument: null,
    status: null,
    operationId: 0,
    begin: (target, ownerDocument): number => {
      const operationId = ++nextOperationId;
      set({
        target,
        ownerDocument,
        status: { phase: 'sharing' },
        operationId,
      });
      return operationId;
    },
    succeed: (operationId, response): void => {
      set((state) =>
        state.operationId === operationId
          ? { status: { phase: 'success', response } }
          : state,
      );
    },
    fail: (operationId, message): void => {
      set((state) =>
        state.operationId === operationId
          ? { status: { phase: 'error', message } }
          : state,
      );
    },
    close: (): void => set({ target: null, ownerDocument: null, status: null }),
  }),
);
