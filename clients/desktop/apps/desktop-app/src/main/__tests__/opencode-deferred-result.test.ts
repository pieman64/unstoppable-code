import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { openCodeDeferredResultReceipts } from '../opencode/deferred-result';

const result = {
  status: 'success',
  requestId: 'receipt',
  willEnable: [{ ref: 'one' }],
};
function event(output: unknown, server = 'app', isError = false): unknown {
  return {
    type: 'canopy_assistant_patch',
    patches: [
      {
        block: {
          type: 'tool_use',
          toolUseId: 'native',
          display: {
            toolName: `mcp__${server}__${CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.displayName}`,
          },
        },
      },
      {
        block: {
          type: 'tool_result',
          toolUseId: 'native',
          output: JSON.stringify(output),
          isError,
        },
      },
    ],
  };
}

test.each([
  result,
  { output: JSON.stringify(result), metadata: {} },
  { content: [{ type: 'text', text: JSON.stringify(result) }] },
  [
    {
      type: 'content',
      content: { type: 'text', text: JSON.stringify(result) },
    },
  ],
])('reads the receipt from bounded native output shapes', (output) => {
  expect(openCodeDeferredResultReceipts(event(output), 'app')).toEqual([
    'receipt',
  ]);
});

test('ignores unrelated tools, errors, text, malformed and oversized results', () => {
  for (const candidate of [
    event(result, 'plugin'),
    event(result, 'app', true),
    event({ ...result, status: 'error' }),
    event({ ...result, willEnable: [] }),
    event({ ...result, isError: true }),
    event({ content: [{ type: 'text', text: '{bad' }] }),
    event({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ...result, payload: 'x'.repeat(256 * 1024) }),
        },
      ],
    }),
    {
      type: 'canopy_assistant_patch',
      patches: [{ block: { type: 'text', text: JSON.stringify(result) } }],
    },
    {
      type: 'canopy_assistant_patch',
      patches: [
        {
          block: {
            type: 'tool_result',
            toolUseId: 'native',
            output: JSON.stringify(result),
          },
        },
      ],
    },
  ])
    expect(openCodeDeferredResultReceipts(candidate, 'app')).toEqual([]);
});

test('retains native tool identity when the completion title changes', () => {
  const ids = new Set<string>();
  const started = {
    type: 'canopy_assistant_patch',
    patches: [
      {
        block: {
          type: 'tool_use',
          toolUseId: 'native',
          display: {
            toolName: `mcp__app__${CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.displayName}`,
          },
        },
      },
    ],
  };
  const completed = {
    type: 'canopy_assistant_patch',
    patches: [
      {
        block: {
          type: 'tool_result',
          toolUseId: 'native',
          toolName: 'Resource enabled',
          output: JSON.stringify({ output: JSON.stringify(result) }),
        },
      },
    ],
  };
  expect(openCodeDeferredResultReceipts(started, 'app', ids)).toEqual([]);
  expect(openCodeDeferredResultReceipts(completed, 'app', ids)).toEqual([
    'receipt',
  ]);
  expect(openCodeDeferredResultReceipts(completed, 'app', ids)).toEqual([]);
  expect(ids.size).toBe(0);
});
