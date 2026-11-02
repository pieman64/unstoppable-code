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
  describe('restoreUsageLimit (CAN-4759)', () => {
    const OTHER = { projectId: 'p2', worktreeId: 'w2', chatId: 'c2' };
    const store = (): ReturnType<typeof useAiCreditsBannerStore.getState> =>
      useAiCreditsBannerStore.getState();

    it('shows a limit the user dismissed before choosing credits', () => {
      store().setUsageLimit(TARGET, { provider: 'claude', resetsAt: 1_000 });
      store().dismissUsageLimit(TARGET, 'claude:1000');
      expect(visibleBanner()).toBeNull();

      store().restoreUsageLimit(TARGET, {
        provider: 'claude',
        resetsAt: 1_000,
      });
      expect(visibleBanner()).toEqual({
        provider: 'claude',
        resetsAt: 1_000,
        dismissKey: 'claude:1000',
      });
    });

    it('restores after the banner state was cleared entirely', () => {
      store().setUsageLimit(TARGET, { provider: 'codex', resetsAt: 2_000 });
      store().clearUsageLimitForChat(TARGET);
      expect(visibleBanner()).toBeNull();

      store().restoreUsageLimit(TARGET, { provider: 'codex', resetsAt: 2_000 });
      expect(visibleBanner()?.provider).toBe('codex');
      expect(visibleBanner()?.resetsAt).toBe(2_000);
    });

    it('treats a later identical limit event as a no-op and can be dismissed again', () => {
      store().restoreUsageLimit(TARGET, {
        provider: 'claude',
        resetsAt: 1_000,
      });
      const before = store().usageLimitByChat;
      store().setUsageLimit(TARGET, { provider: 'claude', resetsAt: 1_000 });
      expect(store().usageLimitByChat).toBe(before);
      expect(visibleBanner()).not.toBeNull();

      store().dismissUsageLimit(TARGET, 'claude:1000');
      expect(visibleBanner()).toBeNull();
    });

    it('is replaced by a newer limit event', () => {
      store().restoreUsageLimit(TARGET, {
        provider: 'claude',
        resetsAt: 1_000,
      });
      store().setUsageLimit(TARGET, { provider: 'claude', resetsAt: 5_000 });
      expect(visibleBanner()?.resetsAt).toBe(5_000);
    });

    it('never rolls a newer limit back to the captured value', () => {
      store().setUsageLimit(TARGET, { provider: 'claude', resetsAt: 5_000 });
      store().dismissUsageLimit(TARGET, 'claude:5000');
      store().restoreUsageLimit(TARGET, {
        provider: 'claude',
        resetsAt: 1_000,
      });
      expect(visibleBanner()?.resetsAt).toBe(5_000);
    });

    it('replaces a limit recorded for another provider', () => {
      store().setUsageLimit(TARGET, { provider: 'codex', resetsAt: 5_000 });
      store().restoreUsageLimit(TARGET, {
        provider: 'claude',
        resetsAt: 1_000,
      });
      expect(visibleBanner()?.provider).toBe('claude');
      expect(visibleBanner()?.resetsAt).toBe(1_000);
    });

    it('leaves other targets and unrelated state untouched', () => {
      store().setRoutingActive(TARGET, true);
      store().setNoBillingSource(TARGET, { provider: 'claude', detectedAt: 1 });
      store().setUsageLimit(OTHER, { provider: 'codex', resetsAt: 9_000 });
      store().dismissUsageLimit(OTHER, 'codex:9000');

      store().restoreUsageLimit(TARGET, {
        provider: 'claude',
        resetsAt: 1_000,
      });

      expect(store().routingActiveByChat['p/w/c']?.active).toBe(true);
      expect(store().noBillingSourceByChat['p/w/c']).toEqual({
        provider: 'claude',
        detectedAt: 1,
      });
      expect(selectVisibleUsageLimitBanner(store(), OTHER)).toBeNull();
      expect(store().usageLimitByChat['p2/w2/c2']?.resetsAt).toBe(9_000);
    });
  });
});
