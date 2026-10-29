import { create } from 'zustand';
import type { ShowFilesChatOrigin } from '@canopy/desktop-shared/types';

interface AgentFilePresentation {
  revision: number;
  line?: number;
  lineEnd?: number;
  origin?: ShowFilesChatOrigin;
}

interface AgentFilePresentationState {
  byTabId: Record<string, AgentFilePresentation>;
  transcriptOpenGenerationByScope: Record<string, number>;
  /** Supersede pending transcript links only within their originating chat. */
  beginTranscriptOpen: (
    target: { projectId: string; worktreeId: string },
    originChatTabId?: string,
  ) => () => boolean;
  present: (
    tabId: string,
    input: { line?: number; lineEnd?: number; origin?: ShowFilesChatOrigin },
  ) => void;
}

export const useAgentFilePresentationStore = create<AgentFilePresentationState>(
  (set, get) => ({
    byTabId: {},
    transcriptOpenGenerationByScope: {},
    beginTranscriptOpen: (target, originChatTabId): (() => boolean) => {
      const key = JSON.stringify([
        target.projectId,
        target.worktreeId,
        originChatTabId ?? null,
      ]);
      const generation = (get().transcriptOpenGenerationByScope[key] ?? 0) + 1;
      set((state) => ({
        transcriptOpenGenerationByScope: {
          ...state.transcriptOpenGenerationByScope,
          [key]: generation,
        },
      }));
      return (): boolean =>
        get().transcriptOpenGenerationByScope[key] === generation;
    },
    present: (tabId, input): void => {
      set((state) => {
        const previous = state.byTabId[tabId];
        const revision = (previous?.revision ?? 0) + 1;
        return {
          byTabId: {
            ...state.byTabId,
            [tabId]: {
              revision,
              ...(input.line !== undefined
                ? {
                    line: input.line,
                    ...(input.lineEnd !== undefined
                      ? { lineEnd: input.lineEnd }
                      : {}),
                  }
                : {}),
              ...(input.origin !== undefined
                ? { origin: input.origin }
                : previous?.origin !== undefined
                  ? { origin: previous.origin }
                  : {}),
            },
          },
        };
      });
    },
  }),
);
