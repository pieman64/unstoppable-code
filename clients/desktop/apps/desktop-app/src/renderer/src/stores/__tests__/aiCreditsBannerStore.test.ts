import {
  chatBannerKey,
  selectVisibleUsageLimitBanner,
  useAiCreditsBannerStore,
} from '../aiCreditsBannerStore';

const TARGET = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

function visibleBanner(): ReturnType<typeof selectVisibleUsageLimitBanner> {
  return selectVisibleUsageLimitBanner(
    useAiCreditsBannerStore.getState(),
    TARGET,
  );
}

describe('aiCreditsBannerStore', () => {
  beforeEach(() => {
    useAiCreditsBannerStore.setState({
      routingActiveByChat: {},
      usageLimitByChat: {},
      noBillingSourceByChat: {},
      dismissedUsageLimitKeyByChat: {},
    });
  });

  it('keys routing state by the full chat target', () => {
    expect(chatBannerKey(TARGET)).toBe('p/w/c');
  });

  it('sets and reads routing-active per target', () => {
    useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
    expect(
      useAiCreditsBannerStore.getState().routingActiveByChat['p/w/c']?.active,
    ).toBe(true);

    useAiCreditsBannerStore.getState().setRoutingActive(TARGET, false);
    expect(
      useAiCreditsBannerStore.getState().routingActiveByChat['p/w/c']?.active,
    ).toBe(false);
  });

  it('keeps targets independent', () => {
    useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
    useAiCreditsBannerStore
      .getState()
      .setRoutingActive(
        { projectId: 'p2', worktreeId: 'w2', chatId: 'c2' },
        false,
      );
    expect(
      useAiCreditsBannerStore.getState().routingActiveByChat['p/w/c']?.active,
    ).toBe(true);
  });

  it('drops state for a chat on clear', () => {
    useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
    useAiCreditsBannerStore.getState().clearForChat(TARGET);
    expect(
      'p/w/c' in useAiCreditsBannerStore.getState().routingActiveByChat,
    ).toBe(false);
  });

  it('refreshes updatedAt when setting an unchanged routing value', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(200);

    useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
    expect(
      useAiCreditsBannerStore.getState().routingActiveByChat['p/w/c'],
    ).toEqual({ active: true, updatedAt: 100 });

    useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
    expect(
      useAiCreditsBannerStore.getState().routingActiveByChat['p/w/c'],
    ).toEqual({ active: true, updatedAt: 200 });

    nowSpy.mockRestore();
  });

  describe('usage-limit banner', () => {
    it('exposes a visible banner with a provider/reset-derived dismiss key', () => {
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'codex', resetsAt: 123 });
      expect(visibleBanner()).toEqual({
        provider: 'codex',
        resetsAt: 123,
        dismissKey: 'codex:123',
      });
    });

    it('hides the banner once the matching dismiss key is acknowledged', () => {
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'claude' });
      useAiCreditsBannerStore.getState().dismissUsageLimit(TARGET, 'claude:');
      expect(visibleBanner()).toBeNull();
    });

    it('re-shows a new reached window after a previous dismissal', () => {
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'codex', resetsAt: 1 });
      useAiCreditsBannerStore.getState().dismissUsageLimit(TARGET, 'codex:1');
      // A later window (different resetsAt) has a fresh dismiss key.
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'codex', resetsAt: 2 });
      expect(visibleBanner()?.dismissKey).toBe('codex:2');
    });

    it('clears usage-limit + dismiss state on clearForChat', () => {
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'claude' });
      useAiCreditsBannerStore.getState().dismissUsageLimit(TARGET, 'claude:');
      useAiCreditsBannerStore.getState().clearForChat(TARGET);
      const key = chatBannerKey(TARGET);
      expect(key in useAiCreditsBannerStore.getState().usageLimitByChat).toBe(
        false,
      );
      expect(
        key in useAiCreditsBannerStore.getState().dismissedUsageLimitKeyByChat,
      ).toBe(false);
    });

    it('leaves the runtime no-billing-source signal alone when only the usage limit is cleared', () => {
      // The two are different failures with different remedies: a usage limit
      // resets on a clock, an empty credit balance does not. Clearing one must
      // not silently take the other's banner down with it.
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'codex' });
      useAiCreditsBannerStore
        .getState()
        .setNoBillingSource(TARGET, { provider: 'codex', detectedAt: 5 });

      useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);

      expect(
        useAiCreditsBannerStore.getState().noBillingSourceByChat['p/w/c'],
      ).toEqual({ provider: 'codex', detectedAt: 5 });
    });

    it('clears usage-limit state without dropping routing-active state', () => {
      useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'claude' });
      useAiCreditsBannerStore.getState().dismissUsageLimit(TARGET, 'claude:');
      useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);
      const key = chatBannerKey(TARGET);

      expect(
        useAiCreditsBannerStore.getState().routingActiveByChat[key],
      ).toEqual(expect.objectContaining({ active: true }));
      expect(key in useAiCreditsBannerStore.getState().usageLimitByChat).toBe(
        false,
      );
      expect(
        key in useAiCreditsBannerStore.getState().dismissedUsageLimitKeyByChat,
      ).toBe(false);
    });
  });

  describe('runtime no-billing-source signal', () => {
    it('records the failing provider per target', () => {
      useAiCreditsBannerStore
        .getState()
        .setNoBillingSource(TARGET, { provider: 'codex', detectedAt: 42 });

      expect(
        useAiCreditsBannerStore.getState().noBillingSourceByChat['p/w/c'],
      ).toEqual({ provider: 'codex', detectedAt: 42 });
      expect(
        useAiCreditsBannerStore.getState().noBillingSourceByChat['p2/w2/c2'],
      ).toBeUndefined();
    });

    it('keeps the first detection identity when the same provider fails again', () => {
      // Several failed model calls inside one turn must not churn the object
      // identity every composer subscribed to this target renders from.
      useAiCreditsBannerStore
        .getState()
        .setNoBillingSource(TARGET, { provider: 'claude', detectedAt: 1 });
      const first =
        useAiCreditsBannerStore.getState().noBillingSourceByChat['p/w/c'];

      useAiCreditsBannerStore
        .getState()
        .setNoBillingSource(TARGET, { provider: 'claude', detectedAt: 2 });

      expect(
        useAiCreditsBannerStore.getState().noBillingSourceByChat['p/w/c'],
      ).toBe(first);
    });

    it('clears on the dispatched-message boundary without touching routing state', () => {
      useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
      useAiCreditsBannerStore
        .getState()
        .setNoBillingSource(TARGET, { provider: 'claude', detectedAt: 1 });

      useAiCreditsBannerStore.getState().clearNoBillingSourceForChat(TARGET);

      expect(
        'p/w/c' in useAiCreditsBannerStore.getState().noBillingSourceByChat,
      ).toBe(false);
      expect(
        useAiCreditsBannerStore.getState().routingActiveByChat['p/w/c']?.active,
      ).toBe(true);
    });

    it('drops the signal on clearForChat', () => {
      useAiCreditsBannerStore
        .getState()
        .setNoBillingSource(TARGET, { provider: 'codex', detectedAt: 1 });
      useAiCreditsBannerStore.getState().clearForChat(TARGET);

      expect(
        'p/w/c' in useAiCreditsBannerStore.getState().noBillingSourceByChat,
      ).toBe(false);
    });
  });
});
