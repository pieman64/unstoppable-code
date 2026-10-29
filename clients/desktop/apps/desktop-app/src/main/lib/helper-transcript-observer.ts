import {
  buildHelperInjectedPrompts,
  type HelperTranscriptObserver,
  type HelperTranscriptSeed,
} from '@canopy/desktop-shared/lib/helper-transcript';
import { getObservabilityService } from '../observability';

function seedHelperTranscript(
  taskKey: string,
  seed: HelperTranscriptSeed,
): void {
  getObservabilityService().seedTranscript(taskKey, {
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
      getObservabilityService().appendTranscriptRecord(taskKey, event);
    },
    markChatMode: (chatMode): void => {
      getObservabilityService().updateObservedTask(taskKey, { chatMode });
    },
    markAttempt: (attempt): void => {
      getObservabilityService().updateObservedTask(taskKey, { attempt });
    },
    markSessionId: (sdkSessionId): void => {
      getObservabilityService().updateObservedTask(taskKey, { sdkSessionId });
    },
  };
}
