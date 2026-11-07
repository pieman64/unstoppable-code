import {
  buildHelperInjectedPrompts,
  type HelperTranscriptObserver,
  type HelperTranscriptSeed,
} from '@canopy/desktop-shared/lib/helper-transcript';
import { getExecutionObservabilityIngest } from '../observability/ingest';

function seedHelperTranscript(
  taskKey: string,
  seed: HelperTranscriptSeed,
): void {
  getExecutionObservabilityIngest().seedTranscript(taskKey, {
    provider: seed.provider,
    originalText: seed.originalText,
    submittedText: seed.submittedText,
    planMode: false,
    injectedPrompts: buildHelperInjectedPrompts(
      seed.provider,
      seed.systemPrompt,
    ),
  });
}

export function createHelperTranscriptObserver(
  taskKey: string,
): HelperTranscriptObserver {
  return {
    seed: (seed): void => {
      seedHelperTranscript(taskKey, seed);
    },
    appendEvent: (event): void => {
      getExecutionObservabilityIngest().appendTranscriptRecord(taskKey, event);
    },
    markChatMode: (chatMode): void => {
      getExecutionObservabilityIngest().updateObservedTask(taskKey, {
        chatMode,
      });
    },
    markAttempt: (attempt): void => {
      getExecutionObservabilityIngest().updateObservedTask(taskKey, {
        attempt,
      });
    },
    markSessionId: (sdkSessionId): void => {
      getExecutionObservabilityIngest().updateObservedTask(taskKey, {
        sdkSessionId,
      });
    },
  };
}
