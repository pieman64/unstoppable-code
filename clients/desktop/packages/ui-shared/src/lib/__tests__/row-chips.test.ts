import { OPERATIONAL_STATUS_COLORS } from '../operational-status-colors';
import {
  ACTION_CHIP_BASE_CLASS,
  SECONDARY_SURFACE_CLASS,
  SECONDARY_SURFACE_HOVER_CLASS,
  SECONDARY_SURFACE_SHELL_CLASS,
  STATUS_BADGE_BASE_CLASS,
  actionChipClassName,
  secondaryToneClassName,
  statusBadgeClassName,
  type ActionChipTone,
  type StatusBadgeTone,
} from '../row-chips';

const FORBIDDEN = /(^|\s)border(-|\s|$)|\b(sky|violet|amber|rose)-/;

describe('row chip class builders', () => {
  const badgeTones: StatusBadgeTone[] = [
    'unread',
    'active',
    'failed',
    'success',
    'merged',
    'paused',
    'warning',
    'neutral',
  ];
  const chipTones: ActionChipTone[] = ['neutral', 'warning', 'destructive'];

  it('gives every status badge tone the same geometry and a ring, never a border', () => {
    for (const tone of badgeTones) {
      for (const muted of [false, true]) {
        const className = statusBadgeClassName(tone, { muted });
        expect(className.startsWith(STATUS_BADGE_BASE_CLASS)).toBe(true);
        for (const token of [
          'h-5',
          'rounded-full',
          'text-3xs',
          'ring-[length:var(--border-hairline)]',
        ]) {
          expect(className.split(' ')).toContain(token);
        }
        expect(className).not.toMatch(FORBIDDEN);
        expect(className).toMatch(/\bring-[a-z-]+(\/\d+)?/);
      }
    }
  });

  it('maps operational tones onto the shared status colours', () => {
    expect(statusBadgeClassName('active')).toContain(
      `${OPERATIONAL_STATUS_COLORS.active.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.active.foreground} ${OPERATIONAL_STATUS_COLORS.active.ring}`,
    );
    expect(statusBadgeClassName('success', { muted: true })).toContain(
      `${OPERATIONAL_STATUS_COLORS.success.backgroundQuiet} ${OPERATIONAL_STATUS_COLORS.success.foregroundQuiet} ${OPERATIONAL_STATUS_COLORS.success.ringQuiet}`,
    );
    expect(statusBadgeClassName('warning')).toContain(
      'bg-warning-subtle fg-warning ring-line-attention/30',
    );
    expect(statusBadgeClassName('neutral')).toContain(
      'bg-subtle fg-secondary ring-line-secondary',
    );
  });

  it('gives every action chip tone the same geometry and a ring, never a border', () => {
    for (const tone of chipTones) {
      const className = actionChipClassName(tone);
      expect(className.startsWith(ACTION_CHIP_BASE_CLASS)).toBe(true);
      for (const token of [
        'h-6',
        'rounded-md',
        'text-2xs',
        'ring-[length:var(--border-hairline)]',
        'focus-ring',
      ]) {
        expect(className.split(' ')).toContain(token);
      }
      expect(className).not.toMatch(FORBIDDEN);
    }
  });

  it('defines the house secondary control surface once', () => {
    const tokens = SECONDARY_SURFACE_CLASS.split(' ');
    expect(tokens).toEqual([
      'bg-quaternary',
      'shadow-sm',
      'ring-[length:var(--border-hairline)]',
      'ring-line-secondary',
      'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    ]);
    // Split controls compose the same two halves, never a third literal.
    expect(SECONDARY_SURFACE_CLASS).toBe(
      `${SECONDARY_SURFACE_SHELL_CLASS} ${SECONDARY_SURFACE_HOVER_CLASS}`,
    );
    // The surface carries no ink: tones add exactly one `fg-*` role.
    expect(SECONDARY_SURFACE_CLASS).not.toMatch(/\bfg-/);
    expect(secondaryToneClassName('neutral')).toBe('fg-primary');
    expect(secondaryToneClassName('warning')).toBe('fg-warning');
    expect(secondaryToneClassName('destructive')).toBe('fg-destructive');
    expect(secondaryToneClassName('accent')).toBe('fg-accent');
  });

  it('puts every action chip tone on the shared secondary surface, differing only by ink', () => {
    const surfaceTokens = SECONDARY_SURFACE_CLASS.split(' ');
    for (const tone of chipTones) {
      const className = actionChipClassName(tone);
      const tokens = className.split(' ');
      for (const token of surfaceTokens) {
        expect(tokens).toContain(token);
      }
      // The ring width comes from the surface alone, never twice.
      expect(
        tokens.filter(
          (token) => token === 'ring-[length:var(--border-hairline)]',
        ),
      ).toHaveLength(1);
      // No tone swaps the surface for a tinted `*-subtle` fill or a tinted
      // ring; the shell is the same quaternary chip as the header `Open in`
      // pill.
      expect(className).not.toMatch(/\bbg-[a-z]+-subtle\b/);
      expect(className).not.toMatch(/\bring-line-(attention|destructive)\b/);
      expect(className).not.toMatch(/\bhover:bg-(warning|destructive)\/\d+/);
      expect(tokens).toContain(secondaryToneClassName(tone));
      // Exactly one ink role per chip.
      expect(tokens.filter((token) => /^fg-/.test(token))).toHaveLength(1);
    }
    const stripInk = (className: string): string =>
      className
        .split(' ')
        .filter((token) => !/^fg-/.test(token))
        .join(' ');
    expect(stripInk(actionChipClassName('warning'))).toBe(
      stripInk(actionChipClassName('neutral')),
    );
    expect(stripInk(actionChipClassName('destructive'))).toBe(
      stripInk(actionChipClassName('neutral')),
    );
  });
});
