import type { ButtonProps } from '../Button';

// Compile-time contract for the `link` variant: inline text with no capsule,
// so the capsule-only props (`size`, `iconOnly`, `shortcut`, `fillRow`) do
// not apply to it. `tsc` enforces each annotation below; the single runtime
// assertion only keeps the values used. Nothing is suppressed: if the props
// ever allowed one of these on a link, its annotation would read `true` and
// the `false` would stop compiling.

type Accepts<Props> = Props extends ButtonProps ? true : false;
type Link = { variant: 'link'; children: string };

const link: Accepts<Link> = true;
const linkWithSize: Accepts<Link & { size: 'sm' }> = false;
const linkIconOnly: Accepts<Link & { iconOnly: true; 'aria-label': string }> =
  false;
const linkWithShortcut: Accepts<Link & { shortcut: string }> = false;
const linkFillRow: Accepts<Link & { fillRow: true }> = false;
// The capsule variants keep every one of them.
const capsuleWithSize: Accepts<{ variant: 'secondary'; size: 'compact' }> =
  true;
const capsuleIconOnly: Accepts<{
  variant: 'ghost';
  iconOnly: true;
  'aria-label': string;
}> = true;
const capsuleWithShortcut: Accepts<{ variant: 'primary'; shortcut: string }> =
  true;
const capsuleFillRow: Accepts<{ variant: 'primary'; fillRow: true }> = true;
const defaultVariantWithSize: Accepts<{ size: 'lg' }> = true;

describe('Button link props (compile-time)', () => {
  it('forbids the capsule-only props on the link variant only', () => {
    expect([
      link,
      linkWithSize,
      linkIconOnly,
      linkWithShortcut,
      linkFillRow,
    ]).toEqual([true, false, false, false, false]);
    expect([
      capsuleWithSize,
      capsuleIconOnly,
      capsuleWithShortcut,
      capsuleFillRow,
      defaultVariantWithSize,
    ]).toEqual([true, true, true, true, true]);
  });
});
