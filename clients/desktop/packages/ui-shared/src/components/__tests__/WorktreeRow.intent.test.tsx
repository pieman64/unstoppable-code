/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { WorktreeRow, type WorktreeRowProps } from '../WorktreeRow';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('WorktreeRow intent', () => {
  const presentations: Partial<WorktreeRowProps>[] = [
    { displayMode: 'list' },
    { displayMode: 'kanban' },
    { displayMode: 'list', textScale: 'sidebar', compact: true },
  ];
  it.each(presentations)(
    'reports pointer and focus intent in %j rows without selecting',
    (presentation) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const onIntent = jest.fn();
      const onClick = jest.fn();
      try {
        act(() =>
          root.render(
            <WorktreeRow
              branchLabel="Feature"
              uiStatus="idle"
              {...presentation}
              dataTestId="row"
              onIntent={onIntent}
              onClick={onClick}
            />,
          ),
        );
        const row = container.querySelector('[data-testid="row"]');
        if (!(row instanceof HTMLElement)) throw new Error('Missing row');
        act(() => {
          row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
          row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
          row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
          row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });
        expect(onIntent.mock.calls).toEqual([
          ['start', 'pointer'],
          ['end', 'pointer'],
          ['start', 'focus'],
          ['end', 'focus'],
        ]);
        expect(onClick).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('keeps rendered markup identical with and without the callback', () => {
    const props = { branchLabel: 'Feature', uiStatus: 'idle' } as const;
    expect(
      renderToString(<WorktreeRow {...props} onIntent={jest.fn()} />),
    ).toBe(renderToString(<WorktreeRow {...props} />));
  });
});
