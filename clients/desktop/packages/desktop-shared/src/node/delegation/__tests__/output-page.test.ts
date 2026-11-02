import type {
  AgentDelegationResult,
  DelegateOutput,
  DelegateOutputAnswerPage,
  DelegateOutputContentErrorCode,
  GetDelegateOutputValue,
} from '@canopy/protocol/delegation';
import {
  pageLegacyDelegateText,
  projectLegacyDelegateOutput,
  projectRegistryDelegateOutput,
  type RegistryOutputContext,
  type RegistryOutputRead,
} from '../output-page';
import type {
  DelegationTranscriptAnswer,
  DelegationTranscriptContentRange,
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptResultEntry,
} from '../transcript-port';

const DIGEST =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONTINUATION_NOTICE =
  'The answer continues. Call Get Delegate Output again with this resultIndex and offset set to nextOffset.';
const ANSWER_ROLES: readonly ('final' | 'partial')[] = ['final', 'partial'];
const NOT_DESCENDANT = {
  code: 'parent_unavailable',
  message: 'That delegation is not one of your descendants.',
  retryable: false,
};
const CONTENT_ERROR_VECTORS: readonly {
  readonly portCode: DelegationTranscriptPortErrorCode;
  readonly code: DelegateOutputContentErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}[] = [
  {
    portCode: 'not_found',
    code: 'not_found',
    message: "The delegate's result was not found.",
    retryable: false,
  },
  {
    portCode: 'corruption',
    code: 'corruption',
    message: "The delegate's stored answer could not be read.",
    retryable: false,
  },
  {
    portCode: 'answer_unavailable',
    code: 'answer_unavailable',
    message: "The delegate's answer is not available.",
    retryable: false,
  },
  {
    portCode: 'storage_failure',
    code: 'storage_failure',
    message: "The delegate's answer could not be read right now. Try again.",
    retryable: true,
  },
  {
    portCode: 'stale_identity',
    code: 'storage_failure',
    message: "The delegate's answer could not be read right now. Try again.",
    retryable: true,
  },
  {
    portCode: 'conflict',
    code: 'corruption',
    message: "The delegate's stored answer could not be read.",
    retryable: false,
  },
  {
    portCode: 'unsupported_format',
    code: 'answer_unavailable',
    message: "The delegate's answer is not available.",
    retryable: false,
  },
];

const current: RegistryOutputContext['current'] = {
  delegationId: 'delegation-current',
  currentRunGeneration: 12,
  currentStatus: 'running',
  latestResultIndex: 9,
  currentPhase: 'running',
  queue: {
    id: 'default',
    name: 'Default',
    position: 2,
    waitingFor: 'app',
    running: 1,
    waiting: 2,
    limit: 3,
  },
};

function context(
  delivery: RegistryOutputContext['delivery'] = { kind: 'whole' },
  requestedResultIndex = 7,
): RegistryOutputContext {
  return { delivery, requestedResultIndex, current };
}

function entry(
  answer: DelegationTranscriptAnswer,
  resultIndex = 7,
): DelegationTranscriptResultEntry {
  return {
    version: 1,
    kind: 'result',
    resultIndex,
    runGeneration: 4,
    settlementKey: 'settlement-7',
    settlementDigest: DIGEST,
    outcome: {
      status: 'completed',
      error: {
        code: 'runtime_error',
        message: 'Execution failed safely.',
        retryable: true,
      },
      usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
      finishedAt: 123,
    },
    answer,
    settlement: {
      streamRevision: 6,
      contentRevision: 6,
      finalItemCount: 2,
      finalItemsDigest: DIGEST,
    },
  };
}

function bodyAnswer(
  role: 'final' | 'partial' = 'final',
  encoding: 'utf8' | 'utf16le' = 'utf8',
): DelegationTranscriptAnswer {
  const byteLength = 11;
  return {
    kind: 'body',
    role,
    byteLength,
    encoding,
    sha256: DIGEST,
    ref: {
      version: 1,
      artifactId: 'answer-artifact-7',
      byteLength,
      sha256: DIGEST,
      encoding: encoding === 'utf8' ? 'utf-8' : 'utf-16le',
      mediaType: 'text/plain',
    },
  };
}

function page(
  text: string,
  role: 'final' | 'partial',
  offset: number,
  limit: number,
): DelegateOutputAnswerPage {
  const result = pageLegacyDelegateText(text, role, offset, limit);
  if (!result.ok) {
    throw new Error(`Expected a page but received ${result.error.code}.`);
  }
  return result.value;
}

function expectRangeRejected(
  text: string,
  offset: number,
  limit: number,
): void {
  expect(pageLegacyDelegateText(text, 'final', offset, limit)).toEqual({
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'The requested answer range is not available.',
      retryable: false,
    },
  });
}

function failure(result: AgentDelegationResult<GetDelegateOutputValue>): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (result.ok) {
    throw new Error('Expected a projection failure.');
  }
  return result.error;
}

function expectInvalidRequest(
  result: AgentDelegationResult<GetDelegateOutputValue>,
  message = 'The requested answer range is not available.',
): void {
  expect(failure(result)).toEqual({
    code: 'invalid_request',
    message,
    retryable: false,
  });
}

function expectInvariantFailure(
  read: RegistryOutputRead,
  target: RegistryOutputContext,
): void {
  expect(projectRegistryDelegateOutput(read, target)).toEqual({
    ok: false,
    error: {
      code: 'runtime_error',
      message: "The delegate's result could not be read.",
      retryable: false,
    },
  });
}

function reassemble(
  text: string,
  role: 'final' | 'partial',
  limit: number,
): string {
  let offset: number | undefined = 0;
  let assembled = '';
  let pageCount = 0;
  while (offset !== undefined) {
    const nextPage = page(text, role, offset, limit);
    const bytes = Buffer.byteLength(nextPage.text, nextPage.encoding);
    expect(bytes).toBeLessThanOrEqual(limit);
    if (nextPage.nextOffset !== undefined) {
      const nextCharacter = Array.from(
        text.slice(assembled.length + nextPage.text.length),
      )[0];
      if (nextCharacter === undefined)
        throw new Error('Missing continuation character');
      expect(
        bytes + Buffer.byteLength(nextCharacter, nextPage.encoding),
      ).toBeGreaterThan(limit);
    }
    assembled += nextPage.text;
    offset = nextPage.nextOffset;
    pageCount += 1;
    if (pageCount > text.length + 1) {
      throw new Error('The page continuation did not make progress.');
    }
  }
  return assembled;
}

describe('projectRegistryDelegateOutput C8 mapping', () => {
  it('preserves the current outer result field order for entries and known lookups', () => {
    const target = context();
    const entryResult = projectRegistryDelegateOutput(
      {
        kind: 'entry',
        entry: entry({ kind: 'none' }),
        body: { kind: 'skipped' },
      },
      target,
    );
    if (!entryResult.ok) {
      throw new Error('Expected an entry projection.');
    }
    expect(Object.keys(entryResult.value)).toEqual([
      'delegationId',
      'currentRunGeneration',
      'currentStatus',
      'latestResultIndex',
      'result',
      'currentPhase',
      'queue',
    ]);

    const knownResult = projectRegistryDelegateOutput(
      {
        kind: 'lookup_failed',
        code: 'corruption',
        known: {
          resultIndex: 7,
          runGeneration: 2,
          status: 'interrupted',
        },
      },
      target,
    );
    if (!knownResult.ok) {
      throw new Error('Expected a known lookup projection.');
    }
    expect(Object.keys(knownResult.value)).toEqual([
      'delegationId',
      'currentRunGeneration',
      'currentStatus',
      'latestResultIndex',
      'result',
      'currentPhase',
      'queue',
    ]);
  });

  it('maps every answer kind for whole and ranged delivery', () => {
    const none = entry({ kind: 'none' });
    const noneWhole = context();
    expect(
      projectRegistryDelegateOutput(
        { kind: 'entry', entry: none, body: { kind: 'skipped' } },
        noneWhole,
      ),
    ).toEqual({
      ok: true,
      value: {
        ...noneWhole.current,
        result: {
          resultIndex: 7,
          runGeneration: 4,
          status: 'completed',
          outputTruncated: false,
          error: {
            code: 'runtime_error',
            message: 'Execution failed safely.',
            retryable: true,
          },
          usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
        },
      },
    });
    const noneRange = context({ kind: 'range', offset: 0, limit: 8 });
    expect(
      projectRegistryDelegateOutput(
        { kind: 'entry', entry: none, body: { kind: 'skipped' } },
        noneRange,
      ),
    ).toEqual({
      ok: true,
      value: {
        ...noneRange.current,
        result: {
          resultIndex: 7,
          runGeneration: 4,
          status: 'completed',
          outputTruncated: false,
          error: {
            code: 'runtime_error',
            message: 'Execution failed safely.',
            retryable: true,
          },
          usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
        },
      },
    });
    expectInvalidRequest(
      projectRegistryDelegateOutput(
        { kind: 'entry', entry: none, body: { kind: 'skipped' } },
        context({ kind: 'range', offset: 1, limit: 8 }),
      ),
    );

    for (const role of ANSWER_ROLES) {
      const empty = entry({ kind: 'empty', role });
      const whole = context();
      expect(
        projectRegistryDelegateOutput(
          { kind: 'entry', entry: empty, body: { kind: 'skipped' } },
          whole,
        ),
      ).toEqual({
        ok: true,
        value: {
          ...whole.current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            ...(role === 'final' ? { finalText: '' } : { partialText: '' }),
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
          },
        },
      });
      const range = context({ kind: 'range', offset: 0, limit: 8 });
      expect(
        projectRegistryDelegateOutput(
          { kind: 'entry', entry: empty, body: { kind: 'skipped' } },
          range,
        ),
      ).toEqual({
        ok: true,
        value: {
          ...range.current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
            answer: {
              role,
              text: '',
              encoding: 'utf8',
              byteLength: 0,
              offset: 0,
            },
          },
        },
      });
      expectInvalidRequest(
        projectRegistryDelegateOutput(
          { kind: 'entry', entry: empty, body: { kind: 'skipped' } },
          context({ kind: 'range', offset: 2, limit: 8 }),
        ),
      );
    }

    for (const role of ANSWER_ROLES) {
      const wholeEntry = entry(bodyAnswer(role));
      const wholeContext = context();
      expect(
        projectRegistryDelegateOutput(
          {
            kind: 'entry',
            entry: wholeEntry,
            body: {
              kind: 'whole',
              text: 'hello world',
              encoding: 'utf8',
              byteLength: 11,
            },
          },
          wholeContext,
        ),
      ).toEqual({
        ok: true,
        value: {
          ...wholeContext.current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            ...(role === 'final'
              ? { finalText: 'hello world' }
              : { partialText: 'hello world' }),
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
          },
        },
      });

      const rangeContext = context({ kind: 'range', offset: 0, limit: 5 });
      const range: DelegationTranscriptContentRange = {
        text: 'hello',
        nextOffset: 5,
        byteLength: 11,
        encoding: 'utf8',
      };
      expect(
        projectRegistryDelegateOutput(
          { kind: 'entry', entry: wholeEntry, body: { kind: 'range', range } },
          rangeContext,
        ),
      ).toEqual({
        ok: true,
        value: {
          ...rangeContext.current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
            answer: {
              role,
              text: 'hello',
              encoding: 'utf8',
              byteLength: 11,
              offset: 0,
              nextOffset: 5,
              notice: CONTINUATION_NOTICE,
            },
          },
        },
      });

      const continuationContext = context({
        kind: 'range',
        offset: 5,
        limit: 6,
      });
      expect(
        projectRegistryDelegateOutput(
          {
            kind: 'entry',
            entry: wholeEntry,
            body: {
              kind: 'range',
              range: {
                text: ' world',
                byteLength: 11,
                encoding: 'utf8',
              },
            },
          },
          continuationContext,
        ),
      ).toEqual({
        ok: true,
        value: {
          ...continuationContext.current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
            answer: {
              role,
              text: ' world',
              encoding: 'utf8',
              byteLength: 11,
              offset: 5,
            },
          },
        },
      });
    }

    const lost = entry({
      kind: 'lost',
      role: 'partial',
      sha256: DIGEST,
      length: 17,
    });
    const deliveries: readonly RegistryOutputContext['delivery'][] = [
      { kind: 'whole' },
      { kind: 'range', offset: 0, limit: 8 },
    ];
    for (const delivery of deliveries) {
      const target = context(delivery);
      expect(
        projectRegistryDelegateOutput(
          { kind: 'entry', entry: lost, body: { kind: 'skipped' } },
          target,
        ),
      ).toEqual({
        ok: true,
        value: {
          ...target.current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
            contentError: {
              code: 'answer_unavailable',
              message: "The delegate's answer is not available.",
              retryable: false,
            },
          },
        },
      });
    }
  });

  it('maps every content read code with fixed safe messages and privacy denials', () => {
    const bodyEntry = entry(bodyAnswer());
    const cases: readonly DelegationTranscriptPortErrorCode[] = [
      'unauthorized',
      'invalid_request',
      'not_found',
      'corruption',
      'answer_unavailable',
      'storage_failure',
      'stale_identity',
      'conflict',
      'unsupported_format',
    ];
    for (const portCode of cases) {
      const result = projectRegistryDelegateOutput(
        {
          kind: 'entry',
          entry: bodyEntry,
          body: { kind: 'failed', code: portCode },
        },
        context(),
      );
      if (portCode === 'unauthorized') {
        expect(result).toEqual({ ok: false, error: NOT_DESCENDANT });
        continue;
      }
      if (portCode === 'invalid_request') {
        expect(failure(result)).toEqual({
          code: 'invalid_request',
          message: "The delegate's result could not be read.",
          retryable: false,
        });
        continue;
      }
      const vector = CONTENT_ERROR_VECTORS.find(
        (candidate) => candidate.portCode === portCode,
      );
      if (vector === undefined) {
        throw new Error(`Missing body-error vector for ${portCode}.`);
      }
      expect(result).toEqual({
        ok: true,
        value: {
          ...current,
          result: {
            resultIndex: 7,
            runGeneration: 4,
            status: 'completed',
            outputTruncated: false,
            error: {
              code: 'runtime_error',
              message: 'Execution failed safely.',
              retryable: true,
            },
            usage: { inputTokens: 17, outputTokens: 5, costUsd: 0.25 },
            contentError: {
              code: vector.code,
              message: vector.message,
              retryable: vector.retryable,
            },
          },
        },
      });
    }
  });

  it('handles known and unknown lookup failures, established absence, and fixed outer errors', () => {
    const known: {
      readonly resultIndex: number;
      readonly runGeneration: number;
      readonly status: 'interrupted';
    } = {
      resultIndex: 7,
      runGeneration: 2,
      status: 'interrupted',
    };
    const codes: readonly DelegationTranscriptPortErrorCode[] = [
      'unauthorized',
      'invalid_request',
      'not_found',
      'corruption',
      'answer_unavailable',
      'storage_failure',
      'stale_identity',
      'conflict',
      'unsupported_format',
    ];
    for (const portCode of codes) {
      const target = context({ kind: 'range', offset: 0, limit: 8 });
      const knownResult = projectRegistryDelegateOutput(
        { kind: 'lookup_failed', code: portCode, known },
        target,
      );
      if (portCode === 'unauthorized') {
        expect(knownResult).toEqual({ ok: false, error: NOT_DESCENDANT });
      } else if (portCode === 'invalid_request') {
        expectInvalidRequest(knownResult, 'Result index is not available.');
      } else {
        const vector = CONTENT_ERROR_VECTORS.find(
          (candidate) => candidate.portCode === portCode,
        );
        if (vector === undefined) {
          throw new Error(`Missing known lookup vector for ${portCode}.`);
        }
        expect(knownResult).toEqual({
          ok: true,
          value: {
            ...target.current,
            result: {
              resultIndex: 7,
              runGeneration: 2,
              status: 'interrupted',
              outputTruncated: false,
              contentError: {
                code: vector.code,
                message: vector.message,
                retryable: vector.retryable,
              },
            },
          },
        });
      }

      const unknownResult = projectRegistryDelegateOutput(
        { kind: 'lookup_failed', code: portCode },
        target,
      );
      if (portCode === 'unauthorized') {
        expect(unknownResult).toEqual({ ok: false, error: NOT_DESCENDANT });
      } else if (portCode === 'invalid_request' || portCode === 'not_found') {
        expectInvalidRequest(unknownResult, 'Result index is not available.');
      } else {
        const vector = CONTENT_ERROR_VECTORS.find(
          (candidate) => candidate.portCode === portCode,
        );
        if (vector === undefined) {
          throw new Error(`Missing unknown lookup vector for ${portCode}.`);
        }
        expect(unknownResult).toEqual({
          ok: false,
          error: {
            code: 'runtime_error',
            message: "The delegate's result could not be read right now.",
            retryable: vector.retryable,
          },
        });
      }
    }

    // A deleted chat and a genuinely absent older result both establish absence.
    for (const absentIndex of [2, 3]) {
      expect(
        projectRegistryDelegateOutput(
          { kind: 'lookup_failed', code: 'not_found' },
          context({ kind: 'range', offset: 0, limit: 8 }, absentIndex),
        ),
      ).toEqual({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Result index is not available.',
          retryable: false,
        },
      });
    }
  });

  it('returns invariant failures for mismatched indexes, body tags, delivery tags, byte length, and encoding', () => {
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: entry({ kind: 'none' }, 8),
        body: { kind: 'skipped' },
      },
      context(),
    );

    const body = entry(bodyAnswer());
    const wholeContext = context();
    // A validated partial range must never be coerced into a whole reply.
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: body,
        body: {
          kind: 'range',
          range: {
            text: 'hello',
            byteLength: 11,
            encoding: 'utf8',
            nextOffset: 5,
          },
        },
      },
      wholeContext,
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: entry({ kind: 'none' }),
        body: { kind: 'whole', text: '', encoding: 'utf8', byteLength: 0 },
      },
      wholeContext,
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: body,
        body: {
          kind: 'whole',
          text: 'hello world',
          encoding: 'utf8',
          byteLength: 10,
        },
      },
      wholeContext,
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: body,
        body: {
          kind: 'whole',
          text: 'hello world',
          encoding: 'utf8',
          byteLength: 11,
        },
      },
      context({ kind: 'range', offset: 0, limit: 8 }),
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: body,
        body: {
          kind: 'range',
          range: { text: 'hello', byteLength: 11, encoding: 'utf16le' },
        },
      },
      context({ kind: 'range', offset: 0, limit: 8 }),
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: body,
        body: { kind: 'skipped' },
      },
      wholeContext,
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: entry({ kind: 'empty', role: 'final' }),
        body: {
          kind: 'whole',
          text: '',
          encoding: 'utf8',
          byteLength: 0,
        },
      },
      wholeContext,
    );
    expectInvariantFailure(
      {
        kind: 'entry',
        entry: entry({
          kind: 'lost',
          role: 'final',
          sha256: DIGEST,
          length: 1,
        }),
        body: { kind: 'failed', code: 'corruption' },
      },
      wholeContext,
    );
    expectInvariantFailure(
      {
        kind: 'lookup_failed',
        code: 'corruption',
        known: { resultIndex: 8, runGeneration: 2, status: 'interrupted' },
      },
      context(),
    );
  });
});

describe('legacy delegate output paging', () => {
  it('pages both UTF-8 and UTF-16LE bodies without splitting characters and reassembles them', () => {
    const utf8Text = 'aé😀z';
    expect(page(utf8Text, 'final', 0, 4)).toEqual({
      role: 'final',
      text: 'aé',
      encoding: 'utf8',
      byteLength: 8,
      offset: 0,
      nextOffset: 3,
      notice: CONTINUATION_NOTICE,
    });
    expect(page('😀a', 'partial', 0, 4)).toEqual({
      role: 'partial',
      text: '😀',
      encoding: 'utf8',
      byteLength: 5,
      offset: 0,
      nextOffset: 4,
      notice: CONTINUATION_NOTICE,
    });
    const utf16Text = 'a\ud800😀z';
    expect(page(utf16Text, 'partial', 0, 4)).toEqual({
      role: 'partial',
      text: 'a\ud800',
      encoding: 'utf16le',
      byteLength: 10,
      offset: 0,
      nextOffset: 4,
      notice: CONTINUATION_NOTICE,
    });

    for (const limit of [4, 5, 65_536]) {
      expect(reassemble(utf8Text, 'final', limit)).toBe(utf8Text);
      expect(reassemble(utf16Text, 'partial', limit)).toBe(utf16Text);
    }
  });

  it('uses whole-text encoding even when a lone trailing high surrogate is beyond the first page', () => {
    expect(page('ab\ud800', 'final', 0, 4)).toEqual({
      role: 'final',
      text: 'ab',
      encoding: 'utf16le',
      byteLength: 6,
      offset: 0,
      nextOffset: 4,
      notice: CONTINUATION_NOTICE,
    });
    expect(page('abc\ud800', 'partial', 0, 4)).toEqual({
      role: 'partial',
      text: 'ab',
      encoding: 'utf16le',
      byteLength: 8,
      offset: 0,
      nextOffset: 4,
      notice: CONTINUATION_NOTICE,
    });
  });

  it('accepts character boundaries, rejects offsets inside encodings, and handles end and past-end offsets', () => {
    const utf8Text = 'aé😀z';
    expect(page(utf8Text, 'final', 1, 4)).toEqual({
      role: 'final',
      text: 'é',
      encoding: 'utf8',
      byteLength: 8,
      offset: 1,
      nextOffset: 3,
      notice: CONTINUATION_NOTICE,
    });
    expectRangeRejected(utf8Text, 2, 4);
    expectRangeRejected(utf8Text, 4, 4);
    expect(page(utf8Text, 'final', 8, 4)).toEqual({
      role: 'final',
      text: '',
      encoding: 'utf8',
      byteLength: 8,
      offset: 8,
    });
    expectRangeRejected(utf8Text, 9, 4);

    const utf16Text = 'a\ud800😀z';
    expectRangeRejected(utf16Text, 1, 4);
    expectRangeRejected(utf16Text, 5, 4);
    expectRangeRejected(utf16Text, 6, 4);
    expect(page(utf16Text, 'partial', 10, 4)).toEqual({
      role: 'partial',
      text: '',
      encoding: 'utf16le',
      byteLength: 10,
      offset: 10,
    });
    expectRangeRejected(utf16Text, 12, 4);
  });

  it('distinguishes an empty body from no body and validates ranges and limits', () => {
    expect(page('', 'final', 0, 4)).toEqual({
      role: 'final',
      text: '',
      encoding: 'utf8',
      byteLength: 0,
      offset: 0,
    });
    expectRangeRejected('', 1, 4);
    expectRangeRejected('answer', -1, 4);
    expectRangeRejected('answer', 0.5, 4);
    expectRangeRejected('answer', 0, 3);
    expectRangeRejected('answer', 0, 65_537);
  });

  it('drops inline body fields and appends the selected final or partial page after preserved fields', () => {
    const output: DelegateOutput = {
      resultIndex: 7,
      runGeneration: 4,
      status: 'completed',
      finalText: 'aé😀z',
      partialText: 'ignored partial body',
      outputTruncated: true,
      error: {
        code: 'runtime_error',
        message: 'Execution failed safely.',
        retryable: true,
      },
      usage: { inputTokens: 17, outputTokens: 5 },
    };
    const projected = projectLegacyDelegateOutput(output, 0, 4);
    expect(projected).toEqual({
      ok: true,
      value: {
        resultIndex: 7,
        runGeneration: 4,
        status: 'completed',
        outputTruncated: true,
        error: {
          code: 'runtime_error',
          message: 'Execution failed safely.',
          retryable: true,
        },
        usage: { inputTokens: 17, outputTokens: 5 },
        answer: {
          role: 'final',
          text: 'aé',
          encoding: 'utf8',
          byteLength: 8,
          offset: 0,
          nextOffset: 3,
          notice: CONTINUATION_NOTICE,
        },
      },
    });
    if (!projected.ok) {
      throw new Error('Expected a legacy page projection.');
    }
    expect(Object.keys(projected.value)).toEqual([
      'resultIndex',
      'runGeneration',
      'status',
      'outputTruncated',
      'error',
      'usage',
      'answer',
    ]);

    expect(
      projectLegacyDelegateOutput(
        {
          resultIndex: 9,
          runGeneration: 4,
          status: 'completed',
          finalText: '',
          partialText: 'must not replace an empty final',
          outputTruncated: false,
        },
        0,
        8,
      ),
    ).toEqual({
      ok: true,
      value: {
        resultIndex: 9,
        runGeneration: 4,
        status: 'completed',
        outputTruncated: false,
        answer: {
          role: 'final',
          text: '',
          encoding: 'utf8',
          byteLength: 0,
          offset: 0,
        },
      },
    });

    const partial: DelegateOutput = {
      resultIndex: 8,
      runGeneration: 4,
      status: 'interrupted',
      partialText: 'partial answer',
      outputTruncated: false,
    };
    expect(projectLegacyDelegateOutput(partial, 0, 8)).toEqual({
      ok: true,
      value: {
        resultIndex: 8,
        runGeneration: 4,
        status: 'interrupted',
        outputTruncated: false,
        answer: {
          role: 'partial',
          text: 'partial ',
          encoding: 'utf8',
          byteLength: 14,
          offset: 0,
          nextOffset: 8,
          notice: CONTINUATION_NOTICE,
        },
      },
    });
  });

  it('keeps no-body ranges distinct and rejects invalid legacy offsets', () => {
    const noBody: DelegateOutput = {
      resultIndex: 7,
      runGeneration: 4,
      status: 'interrupted',
      outputTruncated: true,
      error: {
        code: 'runtime_error',
        message: 'Execution failed safely.',
        retryable: false,
      },
      usage: { inputTokens: 17 },
    };
    expect(projectLegacyDelegateOutput(noBody, 0, 8)).toEqual({
      ok: true,
      value: {
        resultIndex: 7,
        runGeneration: 4,
        status: 'interrupted',
        outputTruncated: true,
        error: {
          code: 'runtime_error',
          message: 'Execution failed safely.',
          retryable: false,
        },
        usage: { inputTokens: 17 },
      },
    });
    expect(projectLegacyDelegateOutput(noBody, 1, 8)).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'The requested answer range is not available.',
        retryable: false,
      },
    });
    expect(
      projectLegacyDelegateOutput({ ...noBody, finalText: '' }, 1, 8),
    ).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'The requested answer range is not available.',
        retryable: false,
      },
    });
  });
});
