/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, type ButtonVariant } from '../Button';
import { ControlSelect } from '../ControlSelect';
import { HeaderActionButton } from '../HeaderActionButton';
import { PickerTrigger } from '../PickerMenu';

const VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'outline',
  'ghost',
  'ghost-overlay',
  'ghost-quiet',
  'ghost-accent',
  'ghost-destructive',
  'warning',
  'destructive',
];

/** The class tokens of the first element in the markup. */
function tokens(markup: string): readonly string[] {
  return (/class="([^"]*)"/.exec(markup)?.[1] ?? '').split(/\s+/);
}

/**
 * Tailwind 4's `scale-*` sets the CSS `scale` property, so the press only
 * eases when the transition names `scale` (`transition-transform` does).
 */
function easesItsPress(classTokens: readonly string[]): boolean {
  return classTokens.some(
    (token) =>
      token === 'transition-transform' ||
      (/^transition-\[[^\]]*\]$/.test(token) &&
        token.slice('transition-['.length, -1).split(',').includes('scale')),
  );
}

describe('the shared press', () => {
  it.each(VARIANTS)('eases on a %s Button', (variant) => {
    const classTokens = tokens(
      renderToStaticMarkup(<Button variant={variant}>Save</Button>),
    );
    expect(classTokens).toContain('active:scale-97');
    expect(easesItsPress(classTokens)).toBe(true);
  });

  it('eases on the header action, dropdown and picker triggers', () => {
    for (const markup of [
      renderToStaticMarkup(<HeaderActionButton>Open</HeaderActionButton>),
      renderToStaticMarkup(
        <ControlSelect aria-label="Model" value="a" onChange={() => {}}>
          <option value="a">A</option>
        </ControlSelect>,
      ),
      renderToStaticMarkup(<PickerTrigger variant="field">Pick</PickerTrigger>),
    ]) {
      const pressing = tokens(
        markup.slice(markup.search(/<(button|select)\b/)),
      );
      expect(pressing.some((token) => token.includes('scale-97'))).toBe(true);
      expect(easesItsPress(pressing)).toBe(true);
    }
  });
});
