import { renderToStaticMarkup } from 'react-dom/server';
import { CancelActionButton } from '../CancelableActionButton';

function cancelButtonClasses(markup: string): string[] {
  const match = markup.match(
    /<button[^>]*data-testid="pr-status-bar-cancel-git-action"[^>]*class="([^"]*)"/,
  );
  return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('CancelActionButton', () => {
  it('wears the accent pill ink and its direct-hover wash by default', () => {
    const classes = cancelButtonClasses(
      renderToStaticMarkup(
        <CancelActionButton onCancel={jest.fn()} label="Cancel commit" />,
      ),
    );

    expect(classes).toEqual(
      expect.arrayContaining(['fg-accent', 'hover:bg-accent-subtle']),
    );
    expect(classes).not.toContain('fg-destructive');
  });

  it.each([
    ['warning', 'fg-warning', 'hover:bg-warning-subtle'],
    ['destructive', 'fg-destructive', 'hover:bg-destructive-subtle'],
    ['merged', 'fg-special-strong', 'hover:bg-special-subtle'],
  ] as const)(
    'takes the %s pill ink and wash',
    (tone, inkClass, hoverClass) => {
      const classes = cancelButtonClasses(
        renderToStaticMarkup(
          <CancelActionButton
            onCancel={jest.fn()}
            label="Cancel merge"
            tone={tone}
          />,
        ),
      );

      expect(classes).toEqual(expect.arrayContaining([inkClass, hoverClass]));
      expect(classes).not.toContain('fg-accent');
      expect(classes).not.toContain('hover:bg-accent-subtle');
    },
  );

  it('keeps the overlay geometry and the nested radius', () => {
    const classes = cancelButtonClasses(
      renderToStaticMarkup(
        <CancelActionButton onCancel={jest.fn()} label="Cancel merge" />,
      ),
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        'electron-no-drag',
        'h-6',
        'w-7',
        'rounded-[calc(var(--radius-md)-2px)]',
        'transition-colors',
      ]),
    );
  });
});
