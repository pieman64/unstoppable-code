import type { DelegationChildRow } from '@canopy/agent-transcript';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import type { DelegationTranscriptTarget } from '../transcript-port';
import {
  describeDelegationTranscriptPortConformance,
  type DelegationTranscriptPortConformanceFactory,
  type DelegationTranscriptPortConformanceFixture,
} from '../testing/transcript-port-conformance';

class FeatureMemoryPort extends InMemoryDelegationTranscriptPort {
  public advanceFixtureCardRevision(target: DelegationTranscriptTarget): void {
    const stream = this.findStream(target);
    stream.state = {
      ...stream.state,
      streamRevision: stream.state.streamRevision + 1,
    };
  }

  public seedMetadataLessRows(
    target: DelegationTranscriptTarget,
    rows: readonly DelegationChildRow[],
  ): void {
    const stream = this.findStream(target);
    for (const row of rows) {
      stream.rows.set(row.id, row);
      if (!row.final) stream.openRows.set(row.id, row);
      stream.admissions.delete(row.id);
      if (row.final) stream.finalRows.push(row);
    }
    stream.state = {
      ...stream.state,
      streamRevision: stream.state.streamRevision + 1,
    };
  }

  private findStream(
    target: DelegationTranscriptTarget,
  ): NonNullable<ReturnType<FeatureMemoryPort['streams']['get']>> {
    const stream = this.streams.get(
      JSON.stringify([
        target.kind,
        target.chatId,
        target.delegationId,
        target.runGeneration,
      ]),
    );
    if (stream === undefined) throw new Error('Missing fixture stream');
    return stream;
  }
}

function createFixture(): DelegationTranscriptPortConformanceFixture {
  const port = new FeatureMemoryPort({
    owns: (target): boolean => target.chatId !== 'foreign-chat',
    ownsChat: (chatId): boolean => chatId !== 'foreign-chat',
  });
  return {
    port,
    ownedTarget: (chatId, delegationId, runGeneration) => ({
      kind: 'delegation',
      chatId,
      delegationId,
      runGeneration,
    }),
    foreignTarget: {
      kind: 'delegation',
      chatId: 'foreign-chat',
      delegationId: 'foreign-child',
      runGeneration: 1,
    },
    removeChat: (chatId) => port.removeChat(chatId),
    portWithoutChatOwnership: () =>
      new InMemoryDelegationTranscriptPort({ owns: () => true }),
    updateCardState: (target) => port.advanceFixtureCardRevision(target),
    seedMetadataLessRows: (target, rows) =>
      port.seedMetadataLessRows(target, rows),
  };
}

const factory: DelegationTranscriptPortConformanceFactory = Object.assign(
  createFixture,
  {
    capabilities: {
      reopen: false,
      storageFailure: false,
      checkpoint: false,
      freshInstance: false,
      noJournal: false,
      faults: false,
      chatRemoval: true,
      registryFaults: false,
    },
  },
);

describeDelegationTranscriptPortConformance('in-memory features', factory, {
  registry: true,
  durability: 'memory',
  features: { receipts: true, repair: true },
});
