import { readMetadataOfRecord } from '@canopy/desktop-shared/node/delegation/record-v3';
import { createDelegationRecordReader } from './record-reader';
import type {
  DelegationRecordReader,
  DelegationRecordReadInput,
} from './record-reader-contract';
import type { DelegationRecordReadPort } from './repository-transcript-port';

export { readMetadataOfRecord };

/** No service construction, repository load, or scope retention at module evaluation. */
const port: DelegationRecordReadPort = {
  generation: async (...args) => {
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    return getChatStateService().generation(...args);
  },
  resultByGeneration: async (...args) => {
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    return getChatStateService().resultByGeneration(...args);
  },
  generationsPage: async (...args) => {
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    return getChatStateService().generationsPage(...args);
  },
  getChildStreamState: async (...args) => {
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    return getChatStateService().getChildStreamState(...args);
  },
  readStoredParentMessage: async (...args) => {
    const { getChatStateService } =
      await import('../../services/chat-state-service');
    return getChatStateService().readStoredParentMessage(...args);
  },
};

function readerFor(input: DelegationRecordReadInput): DelegationRecordReader {
  const { projectId, worktreeId } = input.record.parent;
  return createDelegationRecordReader({
    scope: { projectId, worktreeId },
    port,
  });
}

/** Stateless routing: identity comes from the caller's already-filtered record. */
export const managedDelegationRecordReader: DelegationRecordReader = {
  resolveActivity: (input) => readerFor(input).resolveActivity(input),
  resolveGenerationOutcome: (input, runGeneration) =>
    readerFor(input).resolveGenerationOutcome(input, runGeneration),
  resolveGenerationHeader: (input, runGeneration) =>
    readerFor(input).resolveGenerationHeader(input, runGeneration),
  resolveGenerationList: (input) =>
    readerFor(input).resolveGenerationList(input),
};
