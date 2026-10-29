import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerIconButton } from '../ComposerIconButton';

function classesOf(markup: string): string[] {
  const match = markup.match(/class="([^"]*)"/);
  return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('ComposerIconButton', () => {
  it('rests in the secondary ink with a subtle hover by default', () => {
    const classes = classesOf(
      renderToStaticMarkup(<ComposerIconButton>+</ComposerIconButton>),
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        'fg-secondary',
        'hover:bg-subtle',
        'hover:fg-primary',
        'disabled:hover:bg-transparent',
        'disabled:hover:fg-secondary',
        'h-7',
        'w-7',
        'rounded-lg',
      ]),
    );
  });

  it('gives a pending control the secondary ink without hover feedback', () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <ComposerIconButton tone="pending">…</ComposerIconButton>,
      ),
    );

    expect(classes).toContain('fg-secondary');
    expect(classes.some((token) => token.startsWith('hover:'))).toBe(false);
  });

  it('rests a destructive control at 70% and brings it to full strength under the pointer', () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <ComposerIconButton tone="destructive">!</ComposerIconButton>,
      ),
    );

    expect(classes).toEqual(
      expect.arrayContaining([
        'fg-destructive/70',
        'hover:bg-destructive-subtle',
        'hover:fg-destructive',
        'disabled:hover:bg-transparent',
        'disabled:hover:fg-destructive/70',
      ]),
    );
    expect(classes).not.toContain('fg-secondary');
    expect(classes).not.toContain('bg-destructive-subtle');
  });

  it('keeps the wash on and the ink at full strength while an intent is active', () => {
    const destructive = classesOf(
      renderToStaticMarkup(
        <ComposerIconButton tone="destructive" active>
          !
        </ComposerIconButton>,
      ),
    );
    expect(destructive).toEqual(
      expect.arrayContaining([
        'bg-destructive-subtle',
        'fg-destructive',
        'hover:bg-destructive-subtle/80',
        'disabled:hover:bg-destructive-subtle',
      ]),
    );
    expect(destructive).not.toContain('fg-destructive/70');

    const warning = classesOf(
      renderToStaticMarkup(
        <ComposerIconButton tone="warning" active>
          +
        </ComposerIconButton>,
      ),
    );
    expect(warning).toEqual(
      expect.arrayContaining([
        'bg-warning-subtle',
        'fg-warning',
        'hover:bg-warning-subtle',
      ]),
    );
    expect(warning).not.toContain('fg-secondary');
    expect(warning).not.toContain('hover:fg-primary');
  });

  it('spaces a primary icon from its trailing disclosure in a wide control', () => {
    const plain = classesOf(
      renderToStaticMarkup(<ComposerIconButton wide>+</ComposerIconButton>),
    );
    expect(plain).toEqual(expect.arrayContaining(['w-9', 'gap-0.5']));

    const capsule = classesOf(
      renderToStaticMarkup(
        <ComposerIconButton capsule wide>
          +
        </ComposerIconButton>,
      ),
    );
    expect(capsule).toEqual(expect.arrayContaining(['w-10', 'gap-0.5']));
    expect(capsule).not.toContain('text-xs');
  });

  it('sets a labeled capsule in the 12px label type with 4px between its parts', () => {
    const classes = classesOf(
      renderToStaticMarkup(
        <ComposerIconButton capsule autoWidth>
          Label
        </ComposerIconButton>,
      ),
    );

    expect(classes).toEqual(
      expect.arrayContaining(['min-w-10', 'px-2', 'gap-1', 'text-xs']),
    );
    expect(classes).not.toContain('gap-0.5');
  });
});
