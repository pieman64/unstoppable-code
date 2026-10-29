// eslint-disable-next-line no-restricted-imports -- This mirror test inspects source without adding runtime Node usage.
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- This mirror test inspects source without adding runtime Node usage.
import { resolve } from 'node:path';
import { brandText } from '../brand';
import {
  GUEST_SIGN_IN_CTA_LABEL,
  GUEST_UPGRADE_NUDGE_BODY,
  guestModelGateBody,
  guestModelGateTitle,
} from '../guest-cta-copy';

// `brandText` is deliberately NOT stubbed with a plain object here. It is a
// getter-backed proxy, and this module must read it lazily; a literal stub
// would let a module-load capture pass unnoticed. The lazy-read regression
// test below swaps `appName` after import and asserts the change is observed.
jest.mock('../brand', () => {
  let appName = 'Mock App';
  return {
    brandText: {
      get appName(): string {
        return appName;
      },
      set appName(next: string) {
        appName = next;
      },
    },
  };
});

describe('GUEST_SIGN_IN_CTA_LABEL', () => {
  it('is the same general label on every brand', () => {
    expect(GUEST_SIGN_IN_CTA_LABEL).toBe('Sign in for more');
  });

  // `guest-sign-in-cta-fit.spec.mjs` mirrors the label as an ESM literal
  // because it cannot import TS. Reading the spec here keeps the mirror from
  // drifting: Jest runs in PR CI, the Electron suite does not.
  it('keeps the Electron fit spec mirroring the label', () => {
    const spec = readFileSync(
      resolve(
        __dirname,
        '../../../../../tests/electron/guest-sign-in-cta-fit.spec.mjs',
      ),
      'utf8',
    );

    expect(spec).toContain(`'${GUEST_SIGN_IN_CTA_LABEL}'`);
  });

  it('offers no perk the reader already has', () => {
    // Guests and signed-in free accounts can both turn on the same opt-in
    // daily AI credits, and the credits route to Codex for both, so neither is
    // something signing in provides.
    expect(GUEST_SIGN_IN_CTA_LABEL.toLowerCase()).not.toContain('codex');
    expect(GUEST_SIGN_IN_CTA_LABEL.toLowerCase()).not.toContain('credit');
  });
});

describe('GUEST_UPGRADE_NUDGE_BODY', () => {
  it('does not promise free AI Credits, which are opt-in', () => {
    // The body used to say "Your free AI Credits already work". The daily
    // drip is off until the user turns it on, so that claim is false for most
    // guests, and a perk they already hold argues against signing in.
    expect(GUEST_UPGRADE_NUDGE_BODY.toLowerCase()).not.toContain('credit');
    expect(GUEST_UPGRADE_NUDGE_BODY).toBe(
      'Sign in to sync your work across devices, and check on your agents from your phone or any browser. Your guest work comes with you.',
    );
  });
});

/**
 * Regression test for CAN-3026 review: `GUEST_MODEL_GATE_TITLE` used to capture
 * `brandText.appName` at module-evaluation time, which defeats the lazy-getter
 * contract `brand.ts` documents — "re-evaluated lazily through getters so test
 * setups that swap the brand runtime module see the new values without
 * import-order surprises". If either of these is ever converted back to a
 * module-level const, this fails.
 */
describe('brand text is read lazily, not captured at module load', () => {
  const originalAppName = brandText.appName;

  afterEach(() => {
    brandText.appName = originalAppName;
  });

  it('reflects a brand swapped AFTER this module was imported', () => {
    expect(guestModelGateTitle()).toBe(`Sign in to ${originalAppName} Cloud`);

    brandText.appName = 'Swapped Brand';

    expect(guestModelGateTitle()).toBe('Sign in to Swapped Brand Cloud');
    expect(guestModelGateBody('GPT 5.6 Luna')).toContain(
      'hosted by Swapped Brand',
    );
  });
});
