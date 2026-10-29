import { renderToString } from 'react-dom/server';
import type { JSX } from 'react';
import type * as UiSharedComponents from '@canopy/ui-shared/components';
import { ChatPartView } from '../ChatPartView';

// Collapsed rows never render their input, so expose what the row would show
// when expanded.
jest.mock('@canopy/ui-shared/components', () => {
  const actual = jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  );
  return {
    ...actual,
    ToolCallCard: ({ input }: { input?: string }): JSX.Element => (
      <pre data-testid="expanded-input">{input}</pre>
    ),
  };
});

describe('ChatPartView ShowVisual row', () => {
  it('expands to the title, never the HTML', () => {
    const out = renderToString(
      <ChatPartView
        part={{
          kind: 'tool_use',
          data: {
            toolName: 'mcp__canopy__ShowVisual',
            input: { title: 'Revenue chart', html: '<b>RAW_VISUAL_HTML</b>' },
          },
        }}
      />,
    );
    expect(out).toContain('Revenue chart');
    expect(out).not.toContain('RAW_VISUAL_HTML');
  });

  it('keeps other tools’ inputs', () => {
    const out = renderToString(
      <ChatPartView
        part={{ kind: 'tool_use', data: { toolName: 'Read', input: 'a.ts' } }}
      />,
    );
    expect(out).toContain('a.ts');
  });
});
