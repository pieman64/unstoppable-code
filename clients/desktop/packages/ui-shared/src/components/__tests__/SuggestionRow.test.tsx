/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SuggestionRow, SuggestionRowTrailing } from '../SuggestionRow';

describe('SuggestionRow', () => {
  it.each(['default', 'muted'] as const)(
    'preserves button activation and disabled behavior in %s tone',
    (tone) => {
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
      const container = document.createElement('div');
      const root = createRoot(container);
      const onClick = jest.fn();
      try {
        act(() =>
          root.render(
            <SuggestionRow icon={null} tone={tone} onClick={onClick}>
              Open chat
            </SuggestionRow>,
          ),
        );
        const button = container.querySelector('button');
        expect(button?.type).toBe('button');
        expect(button?.textContent).toBe('Open chat');
        act(() => button?.click());
        expect(onClick).toHaveBeenCalledTimes(1);
        act(() =>
          root.render(
            <SuggestionRow icon={null} tone={tone} onClick={onClick} disabled>
              Open chat
            </SuggestionRow>,
          ),
        );
        act(() => button?.click());
        expect(onClick).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('owns its hover chrome and reserves no trailing room by default', () => {
    const markup = renderToStaticMarkup(
      <SuggestionRow icon={null}>Import projects</SuggestionRow>,
    );
    expect(markup).toContain('hover:bg-subtle');
    expect(markup).not.toContain('group-hover:');
    expect(markup).not.toContain('pr-12');
  });

  it('shares its slot with a trailing control when asked', () => {
    // A dismiss button sits over the trailing edge: the label stops short of
    // it, and hovering it keeps the row highlighted through the group.
    const markup = renderToStaticMarkup(
      <SuggestionRow icon={null} trailingControl>
        Import projects
      </SuggestionRow>,
    );
    expect(markup).toContain('pr-12');
    expect(markup).toContain('group-hover:bg-subtle');
    expect(markup).not.toMatch(/(?<!group-)hover:bg-subtle/);
  });

  it('reserves room for a text action beside the dismiss control', () => {
    const markup = renderToStaticMarkup(
      <SuggestionRow icon={null} trailingControl="wide">
        Resume Fix checkout
      </SuggestionRow>,
    );
    expect(markup).toContain('pr-28');
    expect(markup).not.toContain('pr-12');
    expect(markup).toContain('group-hover:bg-subtle');
    expect(markup).not.toMatch(/(?<!group-)hover:bg-subtle/);
  });

  it('insets a trailing control equally from the pill end, top and bottom', () => {
    // A 28px control in the 48px pill clears its top and bottom by 10px, so
    // it ends 10px from the pill's trailing edge too (`right-2.5`).
    const markup = renderToStaticMarkup(
      <SuggestionRowTrailing>
        <button type="button">Dismiss</button>
      </SuggestionRowTrailing>,
    );
    expect(markup).toContain('right-2.5');
    expect(markup).toContain('top-1/2');
    expect(markup).not.toContain('right-4');
  });

  it('keeps the default label tone unless muted', () => {
    const defaultMarkup = renderToStaticMarkup(
      <SuggestionRow icon={null}>Import projects</SuggestionRow>,
    );
    expect(defaultMarkup).toMatch(/text-sm fg-secondary/);
    expect(defaultMarkup).not.toContain('text-sm fg-tertiary');

    // A row pointing at work under way reads one step down, with the same
    // hover and focus chrome.
    const mutedMarkup = renderToStaticMarkup(
      <SuggestionRow icon={null} tone="muted">
        Agent instructions · in progress
      </SuggestionRow>,
    );
    expect(mutedMarkup).toMatch(/text-sm fg-tertiary/);
    expect(mutedMarkup).not.toMatch(/text-sm fg-secondary/);
    expect(mutedMarkup).toContain('hover:bg-subtle hover:fg-primary');
    expect(mutedMarkup).toContain('focus-ring');
  });
});
