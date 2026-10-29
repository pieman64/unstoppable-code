import { dynamicToolSetId } from '../dynamic-tool-fingerprint';
import type { DynamicToolSpec } from '../generated/v2/DynamicToolSpec';

describe('dynamicToolSetId', () => {
  const first: DynamicToolSpec = {
    type: 'function',
    name: 'alpha',
    description: 'Alpha tool',
    inputSchema: {
      type: 'object',
      properties: { second: { type: 'string' }, first: { type: 'number' } },
    },
  };
  const second: DynamicToolSpec = {
    type: 'function',
    name: 'beta',
    description: 'Beta tool',
    inputSchema: { type: 'object' },
  };

  it('ignores cosmetic tool, map, and schema-key ordering', () => {
    const reorderedFirst: DynamicToolSpec = {
      ...first,
      inputSchema: {
        properties: { first: { type: 'number' }, second: { type: 'string' } },
        type: 'object',
      },
    };

    expect(
      dynamicToolSetId([first, second], {
        beta: { route: 'two' },
        alpha: { route: 'one' },
      }),
    ).toBe(
      dynamicToolSetId([second, reorderedFirst], {
        alpha: { route: 'one' },
        beta: { route: 'two' },
      }),
    );
  });

  it('changes when routing policy or callable shape changes', () => {
    const baseline = dynamicToolSetId([first], { alpha: { enabled: true } });

    expect(dynamicToolSetId([first], { alpha: { enabled: false } })).not.toBe(
      baseline,
    );
    expect(
      dynamicToolSetId([{ ...first, description: 'Changed' }], {
        alpha: { enabled: true },
      }),
    ).not.toBe(baseline);
  });
});
