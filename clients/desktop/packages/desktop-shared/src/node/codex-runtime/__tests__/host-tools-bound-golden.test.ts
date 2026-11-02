import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DynamicToolCallResponse } from '../generated/v2/DynamicToolCallResponse';
import { CodexHostToolDispatcher } from '../host-tools';

const FIXTURE_DIRECTORY = path.join(
  __dirname,
  'fixtures/host-tools-bound-golden',
);
const CAPTURE_GOLDENS = process.env.CANOPY_CAPTURE_OUTPUT_GOLDENS === '1';
const CODEX_LIMIT_BYTES = 65_536;

interface BoundGolden {
  readonly response: DynamicToolCallResponse;
  readonly serializedResponse: string;
}

interface BoundCase {
  readonly name: string;
  readonly makeResponse: () => DynamicToolCallResponse;
}

function textResponse(text: string): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: 'inputText', text }],
  };
}

function exactNormalizedTextLength(): number {
  return (
    CODEX_LIMIT_BYTES -
    Buffer.byteLength(JSON.stringify(textResponse('')), 'utf8')
  );
}

function caseDefinitions(): readonly BoundCase[] {
  const tooManyItems: DynamicToolCallResponse['contentItems'] = Array.from(
    { length: 257 },
    (): DynamicToolCallResponse['contentItems'][number] => ({
      type: 'inputText',
      text: 'x',
    }),
  );

  return [
    {
      name: 'non-array-content-items',
      makeResponse: (): DynamicToolCallResponse => {
        const response = textResponse('x');
        Object.defineProperty(response, 'contentItems', {
          enumerable: true,
          value: 'not an array',
        });
        return response;
      },
    },
    {
      name: 'more-than-256-items',
      makeResponse: () => ({ success: true, contentItems: tooManyItems }),
    },
    {
      name: 'non-boolean-success',
      makeResponse: (): DynamicToolCallResponse => {
        const response = textResponse('x');
        Object.defineProperty(response, 'success', {
          enumerable: true,
          value: 'yes',
        });
        return response;
      },
    },
    {
      name: 'unsupported-item-type',
      makeResponse: (): DynamicToolCallResponse => {
        const item: DynamicToolCallResponse['contentItems'][number] = {
          type: 'inputText',
          text: 'x',
        };
        Object.defineProperty(item, 'type', {
          enumerable: true,
          value: 'inputResource',
        });
        return { success: true, contentItems: [item] };
      },
    },
    {
      name: 'supported-image-item',
      makeResponse: () => ({
        success: true,
        contentItems: [
          { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
        ],
      }),
    },
    {
      name: 'supported-audio-item',
      makeResponse: () => ({
        success: true,
        contentItems: [
          { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' },
        ],
      }),
    },
    {
      name: 'empty-content-items',
      makeResponse: () => ({ success: true, contentItems: [] }),
    },
    {
      name: 'non-string-item-value',
      makeResponse: (): DynamicToolCallResponse => {
        const item: DynamicToolCallResponse['contentItems'][number] = {
          type: 'inputText',
          text: 'x',
        };
        Object.defineProperty(item, 'text', {
          enumerable: true,
          value: 42,
        });
        return { success: true, contentItems: [item] };
      },
    },
    {
      name: 'value-over-65536-code-units',
      makeResponse: () => textResponse('x'.repeat(CODEX_LIMIT_BYTES + 1)),
    },
    {
      name: 'value-exactly-65536-code-units',
      makeResponse: () => textResponse('x'.repeat(CODEX_LIMIT_BYTES)),
    },
    {
      name: 'running-utf8-total-over-limit',
      makeResponse: () => textResponse('é'.repeat(32_769)),
    },
    {
      name: 'running-utf8-total-exactly-at-limit',
      makeResponse: () => textResponse('é'.repeat(32_768)),
    },
    {
      name: 'normalized-envelope-one-byte-over-limit',
      makeResponse: () =>
        textResponse('x'.repeat(exactNormalizedTextLength() + 1)),
    },
    {
      name: 'normalized-envelope-exactly-at-limit',
      makeResponse: () => textResponse('x'.repeat(exactNormalizedTextLength())),
    },
    {
      name: 'extra-properties-stripped-rebuilt-order',
      makeResponse: (): DynamicToolCallResponse => {
        const response = textResponse('okay');
        Object.defineProperty(response, 'privateAccount', {
          enumerable: true,
          value: 'not public',
        });
        const item = response.contentItems[0];
        if (!item) throw new Error('Expected an input item');
        Object.defineProperty(item, 'internalPath', {
          enumerable: true,
          value: '/private/path',
        });
        return response;
      },
    },
    {
      name: 'competing-failures-byte-overflow-first',
      makeResponse: () => ({
        success: true,
        contentItems: [
          { type: 'inputText', text: 'é'.repeat(32_769) },
          { type: 'inputText', text: 'x'.repeat(CODEX_LIMIT_BYTES + 1) },
        ],
      }),
    },
    {
      name: 'competing-failures-code-unit-overflow-first',
      makeResponse: () => ({
        success: true,
        contentItems: [
          { type: 'inputText', text: 'x'.repeat(CODEX_LIMIT_BYTES + 1) },
          { type: 'inputText', text: 'é'.repeat(32_769) },
        ],
      }),
    },
  ];
}

async function runCase(testCase: BoundCase): Promise<BoundGolden> {
  const response = testCase.makeResponse();
  const dispatcher = new CodexHostToolDispatcher(
    'golden-thread',
    () => 'golden-turn',
    {
      allowedTools: [{ namespace: null, tool: 'read' }],
      authorize: (): Promise<boolean> => Promise.resolve(true),
      execute: (): Promise<DynamicToolCallResponse> =>
        Promise.resolve(response),
    },
    new AbortController().signal,
  );
  const boundResponse = await dispatcher.run({
    params: {
      threadId: 'golden-thread',
      turnId: 'golden-turn',
      callId: `call-${testCase.name}`,
      namespace: null,
      tool: 'read',
      arguments: {},
    },
  });
  return {
    response: boundResponse,
    serializedResponse: JSON.stringify(boundResponse),
  };
}

function compareGolden(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

function assertOrCaptureGolden(name: string, actual: unknown): void {
  // Frozen in the 11c2 A0 commit; capture stays off so the oracle cannot be regenerated.
  if (CAPTURE_GOLDENS)
    throw new Error('Golden capture is disabled: these fixtures are frozen.');
  const file = path.join(FIXTURE_DIRECTORY, `${name}.json`);
  const expectedText = readFileSync(file, 'utf8');
  const expected: unknown = JSON.parse(expectedText);
  compareGolden(actual, expected);
}

function outputResultText(options: {
  readonly finalText?: string;
  readonly partialText?: string;
}): string {
  return JSON.stringify({
    ok: true,
    value: {
      delegationId: '00000000-0000-4000-8000-000000000001',
      currentRunGeneration: 1,
      currentStatus: 'completed',
      latestResultIndex: 1,
      result: {
        resultIndex: 1,
        runGeneration: 1,
        status: 'completed',
        ...(options.finalText !== undefined
          ? { finalText: options.finalText }
          : {}),
        ...(options.partialText !== undefined
          ? { partialText: options.partialText }
          : {}),
        outputTruncated: false,
      },
      currentPhase: 'idle',
      queue: {
        id: 'default',
        name: 'Default',
        running: 0,
        waiting: 0,
        limit: 2,
      },
    },
  });
}

interface OversizedCase {
  readonly name: string;
  readonly changesIn11c2: 'paged';
  readonly response: DynamicToolCallResponse;
}

function oversizedTodayCases(): readonly OversizedCase[] {
  return [
    {
      name: 'oversized-1mib-answer',
      changesIn11c2: 'paged',
      response: textResponse(
        outputResultText({ finalText: 'x'.repeat(1_048_576) }),
      ),
    },
    {
      name: 'oversized-utf8-under-unit-cap',
      changesIn11c2: 'paged',
      response: textResponse(
        outputResultText({ finalText: 'é'.repeat(32_768) }),
      ),
    },
    {
      name: 'oversized-empty-final-large-partial',
      changesIn11c2: 'paged',
      response: textResponse(
        outputResultText({
          finalText: '',
          partialText: 'p'.repeat(1_048_576),
        }),
      ),
    },
  ];
}

async function oversizedTodayGolden(): Promise<unknown> {
  const cases: Array<{
    name: string;
    changesIn11c2: 'paged';
    codexResponse: DynamicToolCallResponse;
    serializedCodexResponse: string;
  }> = [];
  for (const entry of oversizedTodayCases()) {
    const dispatcher = new CodexHostToolDispatcher(
      'golden-thread',
      () => 'golden-turn',
      {
        allowedTools: [{ namespace: null, tool: 'read' }],
        authorize: (): Promise<boolean> => Promise.resolve(true),
        execute: (): Promise<DynamicToolCallResponse> =>
          Promise.resolve(entry.response),
      },
      new AbortController().signal,
    );
    const actual = await dispatcher.run({
      params: {
        threadId: 'golden-thread',
        turnId: 'golden-turn',
        callId: `call-${entry.name}`,
        namespace: null,
        tool: 'read',
        arguments: {},
      },
    });
    expect(actual.success).toBe(false);
    cases.push({
      name: entry.name,
      changesIn11c2: 'paged',
      codexResponse: actual,
      serializedCodexResponse: JSON.stringify(actual),
    });
  }
  return { cases };
}

it('captures every current dispatcher bound branch as literal output goldens', async () => {
  for (const testCase of caseDefinitions())
    assertOrCaptureGolden(testCase.name, await runCase(testCase));
});

it('captures current Codex oversized-output denial bytes separately', async () => {
  assertOrCaptureGolden('oversized-today', await oversizedTodayGolden());
});

it('proves the golden comparison rejects a mutated captured bound result', async () => {
  const testCase = caseDefinitions().find(
    (candidate) => candidate.name === 'extra-properties-stripped-rebuilt-order',
  );
  if (!testCase) throw new Error('Missing normalization fixture case');
  const actual = await runCase(testCase);
  const mutated = {
    ...actual,
    serializedResponse: `${actual.serializedResponse} `,
  };
  expect(() => compareGolden(mutated, actual)).toThrow();
});
