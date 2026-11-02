import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import { canonicalDelegationJson } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import { DELEGATION_REGISTRY_MAX_ENTRY_BYTES } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { verifyRecordArtifacts } from '../lib/chat-delta-journal/replay';
import {
  decodeDeltaJournalV2Record,
  DELTA_JOURNAL_V2_GENESIS_DIGEST,
} from '../lib/chat-delta-journal/format';

function settlementRecord(
  ref: PersistedToolOutputReference,
  outcome: Record<string, unknown> = { status: 'completed', finishedAt: 2 },
): ReturnType<typeof decodeDeltaJournalV2Record> {
  const target = {
    kind: 'delegation',
    chatId: 'chat',
    delegationId: 'child',
    runGeneration: 0,
  };
  return decodeDeltaJournalV2Record({
    offset: 0,
    end: 0,
    digest: '',
    payload: Buffer.from(
      JSON.stringify({
        type: 'commit',
        v: 2,
        prev: DELTA_JOURNAL_V2_GENESIS_DIGEST,
        fromRevision: 0,
        toRevision: 1,
        mutationIds: ['settlement'],
        delta: {},
        transcripts: [
          {
            kind: 'child-settle',
            target,
            rows: [],
            settlementKey: 'settlement',
          },
        ],
        streamRegistrations: [],
        descriptorUpdates: [
          {
            version: 1,
            target,
            expectedStreamRevision: 0,
            nextStreamRevision: 1,
            status: 'settled',
            settleReceipt: {
              mutationId: 'settlement',
              scopeRevision: 1,
              streamRevision: 1,
              committedRowCount: 0,
              committedByteLength: 0,
              committedSha256: '0'.repeat(64),
            },
          },
        ],
        registryEffects: [
          {
            kind: 'delegation-result',
            target: {
              kind: 'delegation',
              chatId: 'chat',
              delegationId: 'child',
              runGeneration: 0,
            },
            entry: {
              version: 1,
              kind: 'result',
              resultIndex: 1,
              runGeneration: 0,
              settlementKey: 'settlement',
              settlementDigest: 'a'.repeat(64),
              outcome,
              answer: {
                kind: 'body',
                role: 'final',
                byteLength: ref.byteLength,
                sha256: ref.sha256,
                encoding: 'utf8',
                ref,
              },
              settlement: {
                streamRevision: 1,
                contentRevision: 1,
                finalItemCount: 0,
                finalItemsDigest: '0'.repeat(64),
              },
            },
          },
        ],
      }),
    ),
  });
}

it('verifies answer-only bodies while recovering a result journal effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-replay-ref-'));
  try {
    const artifacts = new ChatTranscriptArtifacts(root);
    const ref = await artifacts.put(
      'chat',
      'only the result journal effect references this body',
    );
    const record = settlementRecord(ref);
    if (record.type !== 'commit') throw new Error('commit expected');
    await expect(
      verifyRecordArtifacts(root, [record]),
    ).resolves.toBeUndefined();
    await unlink(join(root, 'tool-output', 'chat', `${ref.artifactId}.txt`));
    await expect(verifyRecordArtifacts(root, [record])).rejects.toThrow(
      'missing or damaged answer',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a result effect over the registry bound even when its entry fits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-registry-effect-bound-'));
  try {
    const ref = await new ChatTranscriptArtifacts(root).put('chat', 'answer');
    // Control characters escape to six bytes each in canonical JSON.
    const outcome = (length: number): Record<string, unknown> => ({
      status: 'failed',
      finishedAt: 2,
      error: {
        code: 'runtime_error',
        message: '\u001b'.repeat(length),
        retryable: false,
      },
    });
    const sizes = (length: number): { entry: number; effect: number } => {
      const record = settlementRecord(ref);
      if (record.type !== 'commit' || record.v !== 2)
        throw new Error('commit expected');
      const [effect] = record.registryEffects ?? [];
      if (effect?.kind !== 'delegation-result')
        throw new Error('result effect expected');
      const resized = {
        ...effect,
        entry: { ...effect.entry, outcome: outcome(length) },
      };
      return {
        entry: Buffer.byteLength(canonicalDelegationJson(resized.entry)),
        effect: Buffer.byteLength(canonicalDelegationJson(resized)),
      };
    };
    let length = 1;
    while (sizes(length + 1).entry <= DELEGATION_REGISTRY_MAX_ENTRY_BYTES)
      length += 1;
    expect(sizes(length).effect).toBeGreaterThan(
      DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
    );
    expect(() => settlementRecord(ref, outcome(length))).toThrow(
      'exceeds its metadata bound',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
