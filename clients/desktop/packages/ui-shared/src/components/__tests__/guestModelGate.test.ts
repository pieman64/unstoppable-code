import {
  GUEST_MODEL_GATE_DAILY_CREDITS_COPY,
  guestModelGateCopy,
} from '../guestModelGate';

describe('guestModelGateCopy', () => {
  it('names the free account and the guest model available right now', () => {
    expect(
      guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        fallbackLabel: 'Claude Haiku 5.5',
      }),
    ).toEqual({
      title: 'Sign in free to use Claude Opus 5',
      body: 'Claude Opus 5 needs a free Canopy account. As a guest you can use Claude Haiku 5.5 right now.',
      signInAction: 'Sign in to use Claude Opus 5',
      fallbackAction: 'Use Claude Haiku 5.5 (free)',
      dismissAction: 'Not now',
    });
  });

  it('keeps the reassurance and omits the action without a fallback', () => {
    const copy = guestModelGateCopy({
      modelLabel: 'Claude Opus 5',
      appName: 'Canopy',
    });
    expect(copy).toEqual({
      title: 'Sign in free to use Claude Opus 5',
      body: 'Claude Opus 5 needs a free Canopy account. Your guest work comes with you, nothing is lost.',
      signInAction: 'Sign in to use Claude Opus 5',
      dismissAction: 'Not now',
    });
    expect(copy).not.toHaveProperty('fallbackAction');
  });

  it('uses the app name it is given', () => {
    expect(
      guestModelGateCopy({ modelLabel: 'GPT 6 Sol', appName: 'Acme' }).body,
    ).toContain('needs a free Acme account.');
  });

  it('never explains hosting or offers free credits for a model usable now', () => {
    for (const fallbackLabel of [undefined, 'Claude Haiku 5.5']) {
      const { title, body } = guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        ...(fallbackLabel === undefined ? {} : { fallbackLabel }),
        fallbackAccess: 'now',
      });
      expect(`${title} ${body}`).not.toMatch(/hosted by|credit/i);
    }
  });

  it('names both requirements and leads with the purchase', () => {
    expect(
      guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        access: 'needs_sign_in_then_purchase',
      }),
    ).toEqual({
      title: 'Unlock advanced models',
      body: 'Using Claude Opus 5 requires a free Canopy account and a purchase of AI Credits.',
      signInAction: 'Get AI Credits',
      dismissAction: 'Not now',
    });
  });

  it('pairs the purchase copy with an eligible fallback', () => {
    expect(
      guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Unstoppable Code',
        access: 'needs_sign_in_then_purchase',
        fallbackLabel: 'Claude Haiku 5.5',
      }),
    ).toEqual({
      title: 'Unlock advanced models',
      body: 'Using Claude Opus 5 requires a free Unstoppable Code account and a purchase of AI Credits. As a guest you can use Claude Haiku 5.5 right now.',
      signInAction: 'Get AI Credits',
      fallbackAction: 'Use Claude Haiku 5.5 (free)',
      dismissAction: 'Not now',
    });
  });

  // CAN-5211 — a guest who declined free daily AI Credits can still reach the
  // fallback, but only by turning them on, so the copy says so.
  it.each([
    ['sign-in', 'needs_sign_in' as const],
    ['purchase', 'needs_sign_in_then_purchase' as const],
  ])(
    'names the daily-credits route to the fallback on the %s gate',
    (_, access) => {
      const copy = guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        access,
        fallbackLabel: 'Claude Haiku 5.5',
        fallbackAccess: 'daily-credits',
      });
      expect(copy.body).toMatch(
        / As a guest you can use Claude Haiku 5\.5 with free daily AI Credits\.$/,
      );
      expect(copy.body).not.toContain('right now');
      expect(copy.fallbackAction).toBe(
        'Use Claude Haiku 5.5 with free daily AI Credits',
      );
    },
  );

  it('defaults the fallback to one usable right now', () => {
    expect(
      guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        fallbackLabel: 'Claude Haiku 5.5',
      }),
    ).toEqual(
      guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        fallbackLabel: 'Claude Haiku 5.5',
        fallbackAccess: 'now',
      }),
    );
  });

  it('never states a fallback sentence without a fallback label', () => {
    for (const access of [
      'needs_sign_in',
      'needs_sign_in_then_purchase',
    ] as const) {
      const copy = guestModelGateCopy({
        modelLabel: 'Claude Opus 5',
        appName: 'Canopy',
        access,
        fallbackAccess: 'daily-credits',
      });
      expect(copy.body).not.toMatch(/As a guest/);
      expect(copy).not.toHaveProperty('fallbackAction');
    }
  });

  // CAN-5214 — every daily-credits status line names the grant the same way.
  it('names free daily AI Credits in every daily-credits status line', () => {
    expect(GUEST_MODEL_GATE_DAILY_CREDITS_COPY).toEqual({
      saveFailed: "Couldn't turn on free daily AI Credits. Try again.",
      saveUncertain:
        "Couldn't confirm whether free daily AI Credits are on. Check again.",
      savedRefreshFailed:
        "Free daily AI Credits are on, but we couldn't check your balance. Try again.",
      savedNoCoverage:
        'Free daily AI Credits are on, but no credits are available right now.',
      recheckAction: 'Check again',
    });
  });
});
