import { CodexHostToolDispatcher } from '../host-tools';
import type { DynamicToolCallResponse } from '../generated/v2/DynamicToolCallResponse';

function bound(
  response: DynamicToolCallResponse,
): Promise<DynamicToolCallResponse> {
  const dispatcher = new CodexHostToolDispatcher(
    'thread',
    () => 'turn',
    {
      allowedTools: [{ namespace: null, tool: 'evidence' }],
      authorize: (): Promise<boolean> => Promise.resolve(true),
      execute: (): Promise<DynamicToolCallResponse> =>
        Promise.resolve(response),
    },
    new AbortController().signal,
  );
  return dispatcher.run({
    params: {
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'evidence',
      arguments: {},
    },
  });
}
it('accepts 256 items exactly', async () => {
  const response: DynamicToolCallResponse = {
    success: true,
    contentItems: Array.from({ length: 256 }, () => ({
      type: 'inputText',
      text: 'x',
    })),
  };
  expect(await bound(response)).toEqual({
    success: true,
    contentItems: Array.from({ length: 256 }, () => ({
      type: 'inputText',
      text: 'x',
    })),
  });
});
it('keeps cumulative overflow ahead of a later code-unit failure', async () => {
  expect(
    await bound({
      success: true,
      contentItems: [
        { type: 'inputText', text: 'a'.repeat(32_768) },
        { type: 'inputText', text: 'b'.repeat(32_769) },
        { type: 'inputText', text: 'x'.repeat(65_537) },
      ],
    }),
  ).toEqual({
    success: false,
    contentItems: [
      { type: 'inputText', text: 'Host tool result exceeds the output limit.' },
    ],
  });
});
it('keeps a later code-unit denial after an exact-limit cumulative total', async () => {
  expect(
    await bound({
      success: true,
      contentItems: [
        { type: 'inputText', text: 'a'.repeat(32_768) },
        { type: 'inputText', text: 'b'.repeat(32_768) },
        { type: 'inputText', text: 'x'.repeat(65_537) },
      ],
    }),
  ).toEqual({
    success: false,
    contentItems: [
      { type: 'inputText', text: 'Invalid or oversized host tool result.' },
    ],
  });
});
it('normalizes reversed property order and strips extras', async () => {
  const item = {
    extra: 'strip me',
    text: 'literal',
    type: 'inputText' as const,
  };
  const response = {
    extra: 'strip me too',
    contentItems: [item],
    success: true,
  };
  expect(JSON.stringify(await bound(response))).toBe(
    '{"success":true,"contentItems":[{"type":"inputText","text":"literal"}]}',
  );
});
