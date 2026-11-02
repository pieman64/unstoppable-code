import type { StoredDelegation } from '../broker';
import type { DelegationReadMetadataSource } from '../record-read-metadata';

interface FixtureEntry {
  readonly originAt: number;
  readonly lastActivityAt: number;
  readonly settling: boolean;
}

/**
 * Test-only metadata source: registered delegations read as stream-backed,
 * every other record as legacy. Production installs none before phase 11c.
 */
export class FixtureDelegationReadMetadata {
  private readonly streams = new Map<string, FixtureEntry>();

  public stream(
    delegationId: string,
    metadata: {
      readonly originAt: number;
      readonly lastActivityAt: number;
      readonly settling?: boolean;
    },
  ): void {
    this.streams.set(delegationId, {
      originAt: metadata.originAt,
      lastActivityAt: metadata.lastActivityAt,
      settling: metadata.settling === true,
    });
  }

  public readonly source: DelegationReadMetadataSource = (
    record: StoredDelegation,
  ) => {
    const entry = this.streams.get(record.state.delegationId);
    if (!entry) return undefined;
    return {
      originAt: entry.originAt,
      lastActivityAt: entry.lastActivityAt,
      current: {
        store: 'stream',
        target: {
          kind: 'delegation',
          chatId: record.parent.chatId,
          delegationId: record.state.delegationId,
          runGeneration: record.state.runGeneration,
        },
      },
      ...(entry.settling
        ? { settling: { runGeneration: record.state.runGeneration } }
        : {}),
    };
  };
}
