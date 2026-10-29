import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '../../types';
import {
  artifactRefsOf,
  clampVisualHeight,
  findVisualTokens,
  isValidVisualHeights,
  isVisualId,
  messageHasVisual,
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
} from '../visual-ref';

const VISUAL_ID = 'vis_00000000-0000-0000-0000-000000000001';
const SECOND_VISUAL_ID = 'vis_00000000-0000-0000-0000-000000000002';

const visualReference: PersistedVisualReference = {
  version: 1,
  visualId: VISUAL_ID,
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  byteLength: 128,
  sha256: 'a'.repeat(64),
  mediaType: 'text/html',
  title: 'Preview',
  maxHeight: 400,
};

const toolOutputReference: PersistedToolOutputReference = {
  version: 1,
  artifactId: `sha256-v1-${'b'.repeat(64)}`,
  byteLength: 256,
  sha256: 'b'.repeat(64),
  encoding: 'utf-8',
  mediaType: 'text/plain',
};

function toolResult(
  options: {
    fullOutputRef?: PersistedToolOutputReference;
    visualRef?: PersistedVisualReference;
  } = {},
): Extract<PersistedChatBlock, { type: 'tool_result' }> {
  return {
    type: 'tool_result',
    toolUseId: 'tool-1',
    toolName: 'ShowVisual',
    output: 'published',
    isError: false,
    ...options,
  };
}

function message(blocks: PersistedChatBlock[]): PersistedChatMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    timestamp: 1,
    blocks,
  };
}

describe('visual id helpers', () => {
  describe('isVisualId', () => {
    it('accepts only a complete lowercase canonical visual id', () => {
      expect(isVisualId(VISUAL_ID)).toBe(true);
      expect(isVisualId(` ${VISUAL_ID}`)).toBe(false);
      expect(isVisualId(`${VISUAL_ID}x`)).toBe(false);
      expect(isVisualId('VIS_00000000-0000-0000-0000-000000000001')).toBe(
        false,
      );
      expect(isVisualId('vis_00000000-0000-0000-0000-00000000000A')).toBe(
        false,
      );
      expect(isVisualId(VISUAL_ID.slice(0, -1))).toBe(false);
    });
  });

  describe('findVisualTokens', () => {
    it('finds an id in raw tool output without requiring a leading boundary', () => {
      expect(findVisualTokens(`published ${VISUAL_ID}`)).toEqual([VISUAL_ID]);
    });

    it('finds an id in newline-joined text', () => {
      expect(findVisualTokens(['tool output', VISUAL_ID].join('\n'))).toEqual([
        VISUAL_ID,
      ]);
    });

    it('finds an id inside a JSON-stringified string', () => {
      const output = JSON.stringify(`published\n${VISUAL_ID}`);
      expect(findVisualTokens(output)).toEqual([VISUAL_ID]);
    });

    it('finds ids inside a JSON-stringified array', () => {
      const output = JSON.stringify([
        `published\t${VISUAL_ID}`,
        `another\r${SECOND_VISUAL_ID}`,
      ]);
      expect(findVisualTokens(output)).toEqual([VISUAL_ID, SECOND_VISUAL_ID]);
    });

    it.each([
      ['newline', '\n'],
      ['tab', '\t'],
      ['carriage return', '\r'],
    ])('finds an id after an escaped %s', (_label, separator) => {
      const output = JSON.stringify(`prefix${separator}${VISUAL_ID}`);
      expect(findVisualTokens(output)).toEqual([VISUAL_ID]);
    });

    it('returns multiple ids in first-seen order', () => {
      expect(
        findVisualTokens(
          `${SECOND_VISUAL_ID} ${VISUAL_ID} ${SECOND_VISUAL_ID}`,
        ),
      ).toEqual([SECOND_VISUAL_ID, VISUAL_ID]);
    });

    it('de-duplicates repeated ids', () => {
      expect(findVisualTokens(`${VISUAL_ID} ${VISUAL_ID}`)).toEqual([
        VISUAL_ID,
      ]);
    });

    it('rejects ids followed by another lowercase hexadecimal character', () => {
      expect(findVisualTokens(`${VISUAL_ID}a ${SECOND_VISUAL_ID}`)).toEqual([
        SECOND_VISUAL_ID,
      ]);
    });

    it('rejects uppercase prefixes and uppercase hexadecimal digits', () => {
      expect(
        findVisualTokens(
          'VIS_00000000-0000-0000-0000-000000000001 vis_00000000-0000-0000-0000-00000000000A',
        ),
      ).toEqual([]);
    });

    it('rejects truncated ids', () => {
      expect(findVisualTokens(VISUAL_ID.slice(0, -1))).toEqual([]);
    });

    it('finds an id at the end of a large input', () => {
      const output = `${'x'.repeat(200_000 - VISUAL_ID.length)}${VISUAL_ID}`;
      expect(findVisualTokens(output)).toEqual([VISUAL_ID]);
    });
  });
});

describe('clampVisualHeight', () => {
  it('clamps values below the minimum', () => {
    expect(clampVisualHeight(20)).toBe(VISUAL_MIN_HEIGHT);
  });

  it('keeps values inside the supported range', () => {
    expect(clampVisualHeight(400)).toBe(400);
  });

  it('clamps values above the maximum', () => {
    expect(clampVisualHeight(2_500)).toBe(VISUAL_MAX_HEIGHT);
  });

  it('rounds fractional values to the nearest integer before clamping', () => {
    expect(clampVisualHeight(100.4)).toBe(100);
    expect(clampVisualHeight(100.6)).toBe(101);
  });

  it('maps non-finite values to the maximum', () => {
    expect(clampVisualHeight(Number.NaN)).toBe(VISUAL_MAX_HEIGHT);
    expect(clampVisualHeight(Number.POSITIVE_INFINITY)).toBe(VISUAL_MAX_HEIGHT);
    expect(clampVisualHeight(Number.NEGATIVE_INFINITY)).toBe(VISUAL_MAX_HEIGHT);
  });
});

describe('artifactRefsOf', () => {
  it('returns no references for non-tool-result blocks', () => {
    expect(artifactRefsOf({ type: 'text', text: 'hello' })).toEqual([]);
  });

  it('returns no references when neither artifact is attached', () => {
    expect(artifactRefsOf(toolResult())).toEqual([]);
  });

  it('returns a tool-output reference when present', () => {
    expect(
      artifactRefsOf(toolResult({ fullOutputRef: toolOutputReference })),
    ).toEqual([{ family: 'tool-output', reference: toolOutputReference }]);
  });

  it('returns a visual reference when present', () => {
    expect(artifactRefsOf(toolResult({ visualRef: visualReference }))).toEqual([
      { family: 'visual', reference: visualReference },
    ]);
  });

  it('returns the tool-output reference before the visual reference', () => {
    expect(
      artifactRefsOf(
        toolResult({
          fullOutputRef: toolOutputReference,
          visualRef: visualReference,
        }),
      ),
    ).toEqual([
      { family: 'tool-output', reference: toolOutputReference },
      { family: 'visual', reference: visualReference },
    ]);
  });
});

describe('messageHasVisual', () => {
  it('returns true when a tool result has a visual reference', () => {
    expect(
      messageHasVisual(message([toolResult({ visualRef: visualReference })])),
    ).toBe(true);
  });

  it('returns false when no tool result has a visual reference', () => {
    expect(messageHasVisual(message([toolResult()]))).toBe(false);
    expect(messageHasVisual(message([{ type: 'text', text: 'hello' }]))).toBe(
      false,
    );
  });
});

describe('isValidVisualHeights', () => {
  it('accepts up to 32 finite positive pairs', () => {
    expect(isValidVisualHeights([])).toBe(true);
    expect(
      isValidVisualHeights([
        [360, 812],
        [960, 400.5],
      ]),
    ).toBe(true);
    expect(isValidVisualHeights(Array.from({ length: 32 }, () => [1, 1]))).toBe(
      true,
    );
  });

  it.each([
    ['a non-array', { 360: 800 }],
    ['too many pairs', Array.from({ length: 33 }, () => [1, 1])],
    ['a short pair', [[360]]],
    ['a long pair', [[360, 800, 1]]],
    ['a zero height', [[360, 0]]],
    ['a negative width', [[-1, 80]]],
    ['an infinite height', [[360, Infinity]]],
    ['NaN', [[360, Number.NaN]]],
    ['a string', [['360', 800]]],
  ])('rejects %s', (_label, value) => {
    expect(isValidVisualHeights(value)).toBe(false);
  });
});
