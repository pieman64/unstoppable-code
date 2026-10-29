// ---------------------------------------------------------------------------
// Shared Stripe Elements appearance derived from the app's live design tokens.
//
// Used by every embedded Stripe `<PaymentElement>` (account billing section and
// the org Billing tab) so the card form matches the active theme + color mode
// instead of Stripe's default light tiles reading as stark white blocks inside
// our dark modals. Client-only: reads resolved CSS custom properties off
// `<html>` via `getComputedStyle`.
// ---------------------------------------------------------------------------

import type { Appearance } from '@stripe/stripe-js';

/** Read a resolved CSS custom property (hex color) off the document root. */
function readThemeToken(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

/**
 * Build a Stripe Elements `Appearance` from the app's live design tokens so the
 * embedded PaymentElement matches the active theme + color mode.
 * `getComputedStyle` resolves whichever theme/color-mode is currently applied
 * to `<html>`, so this stays correct across all themes. Falls back to Stripe's
 * `night` theme during SSR where there is no `document`.
 */
export function buildStripeAppearance(): Appearance {
  if (typeof window === 'undefined') {
    return { theme: 'night' };
  }
  const styles = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains('dark');
  const border = readThemeToken(styles, '--line-base');
  const ring = readThemeToken(styles, '--line-focus');
  return {
    theme: isDark ? 'night' : 'stripe',
    variables: {
      colorPrimary: readThemeToken(styles, '--fg-accent'),
      colorBackground: readThemeToken(styles, '--bg-base'),
      colorText: readThemeToken(styles, '--fg-primary'),
      colorTextSecondary: readThemeToken(styles, '--fg-secondary'),
      colorDanger: readThemeToken(styles, '--fg-destructive'),
      borderRadius: '8px',
      fontSizeBase: '14px',
      spacingUnit: '4px',
    },
    rules: {
      '.Tab, .Input, .Block, .PickerItem': {
        border: `0.5px solid ${border}`,
        boxShadow: 'none',
      },
      '.Tab:hover': {
        border: `0.5px solid ${ring}`,
      },
      '.Tab--selected, .Tab--selected:focus, .Input:focus': {
        border: `0.5px solid ${ring}`,
      },
    },
  };
}
