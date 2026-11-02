import {
  encodeTranscriptBlockManifest,
  encodeTranscriptBlockPage,
  estimateTranscriptWindowBytes,
  isTranscriptBlockManifest,
  isTranscriptBlockPage,
  isTranscriptBlocksReference,
  transcriptBodyReferences,
} from '../../transcript-storage';
import type {
  PersistedChatBlock,
  PersistedToolOutputReference,
  TranscriptBlocksReference,
} from '../../types';
import type {
  TranscriptBlockManifest,
  TranscriptBlockPage,
} from '../../transcript-storage';

const ref = (digit: string): PersistedToolOutputReference => ({
  version: 1,
  artifactId: `sha256-v1-${digit.repeat(64)}`,
  byteLength: 1,
  sha256: digit.repeat(64),
  encoding: 'utf-8',
  mediaType: 'text/plain',
});

describe('transcript body references', () => {
  it('enumerates every body reference kind in block order', () => {
    expect(
      transcriptBodyReferences({
        blocks: [
          { type: 'text', text: 'preview', textRef: ref('1') },
          { type: 'thinking', text: 'inline' },
          {
            type: 'tool_use',
            toolUseId: 'call',
            toolName: 'shell',
            input: 'preview',
            inputRef: ref('2'),
          },
          {
            type: 'tool_result',
            toolUseId: 'call',
            toolName: 'shell',
            output: 'preview',
            isError: false,
            outputTruncated: true,
            fullOutputRef: ref('3'),
          },
          { type: 'thinking', text: 'preview', textRef: ref('4') },
        ],
      }).map(({ blockOrdinal, field, reference }) => [
        blockOrdinal,
        field,
        reference.sha256[0],
      ]),
    ).toEqual([
      [0, 'text', '1'],
      [2, 'input', '2'],
      [3, 'output', '3'],
      [4, 'text', '4'],
    ]);
  });
});

describe('transcript block artifact codecs', () => {
  const acceptsTextBlock = (value: unknown): value is PersistedChatBlock =>
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'text';

  it('strictly validates root block references and their artifact references', () => {
    const reference: TranscriptBlocksReference = {
      version: 1,
      manifest: ref('1'),
      blockCount: 2,
    };

    expect(isTranscriptBlocksReference(reference)).toBe(true);
    expect(isTranscriptBlocksReference({ ...reference, extra: true })).toBe(
      false,
    );
    expect(isTranscriptBlocksReference({ ...reference, blockCount: 0 })).toBe(
      false,
    );
    expect(
      isTranscriptBlocksReference({
        ...reference,
        manifest: { ...reference.manifest, artifactId: 'not-a-digest' },
      }),
    ).toBe(false);
  });

  it('validates manifest coverage, contiguous ordinals, and safe bounds', () => {
    const firstEntry = {
      kind: 'page' as const,
      firstBlockOrdinal: 5,
      blockCount: 1,
      reference: ref('2'),
    };
    const secondEntry = {
      kind: 'manifest' as const,
      firstBlockOrdinal: 6,
      blockCount: 2,
      reference: ref('3'),
    };
    const manifest: TranscriptBlockManifest = {
      version: 1,
      kind: 'transcript-block-manifest',
      firstBlockOrdinal: 5,
      blockCount: 3,
      entries: [firstEntry, secondEntry],
    };

    expect(isTranscriptBlockManifest(manifest)).toBe(true);
    expect(isTranscriptBlockManifest({ ...manifest, extra: true })).toBe(false);
    expect(isTranscriptBlockManifest({ ...manifest, blockCount: 0 })).toBe(
      false,
    );
    expect(
      isTranscriptBlockManifest({
        ...manifest,
        entries: [firstEntry, { ...secondEntry, firstBlockOrdinal: 7 }],
      }),
    ).toBe(false);
    expect(
      isTranscriptBlockManifest({
        ...manifest,
        entries: [{ ...firstEntry, blockCount: 2 }, secondEntry],
      }),
    ).toBe(false);
    expect(
      isTranscriptBlockManifest({
        ...manifest,
        firstBlockOrdinal: Number.MAX_SAFE_INTEGER,
        blockCount: 1,
        entries: [
          {
            ...firstEntry,
            firstBlockOrdinal: Number.MAX_SAFE_INTEGER,
            blockCount: 1,
          },
        ],
      }),
    ).toBe(false);
  });

  it('validates strict page envelopes with an injected block validator', () => {
    const page: TranscriptBlockPage = {
      version: 1,
      kind: 'transcript-block-page',
      firstBlockOrdinal: 8,
      blocks: [{ type: 'text', text: 'body' }],
    };

    expect(isTranscriptBlockPage(page, acceptsTextBlock)).toBe(true);
    expect(
      isTranscriptBlockPage({ ...page, extra: true }, acceptsTextBlock),
    ).toBe(false);
    expect(
      isTranscriptBlockPage(
        { ...page, firstBlockOrdinal: Number.MAX_SAFE_INTEGER },
        acceptsTextBlock,
      ),
    ).toBe(false);
    expect(
      isTranscriptBlockPage(
        {
          ...page,
          blocks: [{ type: 'image', path: '/tmp/image.png', alt: '' }],
        },
        acceptsTextBlock,
      ),
    ).toBe(false);
  });

  it('encodes fixed envelope and reference key order while preserving block keys', () => {
    const digest = 'a'.repeat(64);
    const reverseOrderedReference: PersistedToolOutputReference = {
      mediaType: 'text/plain',
      encoding: 'utf-8',
      sha256: digest,
      byteLength: 3,
      artifactId: `sha256-v1-${digest}`,
      version: 1,
    };
    const manifest: TranscriptBlockManifest = {
      entries: [
        {
          reference: reverseOrderedReference,
          blockCount: 2,
          firstBlockOrdinal: 5,
          kind: 'page',
        },
      ],
      blockCount: 2,
      firstBlockOrdinal: 5,
      kind: 'transcript-block-manifest',
      version: 1,
    };
    const opaqueBlock = {
      vendorData: { z: 1, a: 2 },
      text: 'body',
      type: 'text',
    } as const;
    const page: TranscriptBlockPage = {
      blocks: [opaqueBlock],
      firstBlockOrdinal: 5,
      kind: 'transcript-block-page',
      version: 1,
    };

    expect(encodeTranscriptBlockManifest(manifest)).toBe(
      `{"version":1,"kind":"transcript-block-manifest","firstBlockOrdinal":5,"blockCount":2,"entries":[{"kind":"page","firstBlockOrdinal":5,"blockCount":2,"reference":{"version":1,"artifactId":"sha256-v1-${digest}","byteLength":3,"sha256":"${digest}","encoding":"utf-8","mediaType":"text/plain"}}]}`,
    );
    expect(encodeTranscriptBlockPage(page)).toBe(
      '{"version":1,"kind":"transcript-block-page","firstBlockOrdinal":5,"blocks":[{"vendorData":{"z":1,"a":2},"text":"body","type":"text"}]}',
    );
  });
});

describe('transcript storage metrics', () => {
  it('estimates a loaded window from durable descriptor metadata in constant time', () => {
    expect(
      estimateTranscriptWindowBytes(
        {
          committedByteLength: 20_000,
          committedMessageCount: 100,
        },
        25,
      ),
    ).toBe(5_000);
    expect(
      estimateTranscriptWindowBytes(
        {
          committedByteLength: 20_000,
          committedMessageCount: 100,
        },
        0,
      ),
    ).toBe(0);
  });
});
