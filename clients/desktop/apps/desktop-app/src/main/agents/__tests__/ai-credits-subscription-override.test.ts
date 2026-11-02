import {
  clearAiCreditsRoutingModeCache,
  resolveAiCreditsRoutingAttempt,
  setAiCreditsRoutingModeCache,
} from '../ai-credits-routing';
import {
  clearAllProviderQuotaReached,
  markProviderQuotaReached,
} from '../ai-credits-quota-state';

describe('explicit subscription billing attempt', () => {
  afterEach(() => {
    clearAiCreditsRoutingModeCache();
    clearAllProviderQuotaReached();
  });

  it.each(['on', 'on-quota', 'off'] as const)(
    'does not silently select credits in %s mode after a negative native auth check',
    async (mode) => {
      setAiCreditsRoutingModeCache(mode);
      markProviderQuotaReached('claude');
      const checkNativeAuth = jest.fn().mockResolvedValue(false);

      await expect(
        resolveAiCreditsRoutingAttempt(
          undefined,
          'claude',
          checkNativeAuth,
          true,
        ),
      ).resolves.toBeNull();
      expect(checkNativeAuth).not.toHaveBeenCalled();
    },
  );

  it('does not route a native-capable Codex model to paid credits after an explicit selection', async () => {
    setAiCreditsRoutingModeCache('on');
    await expect(
      resolveAiCreditsRoutingAttempt(
        undefined,
        'codex',
        () => Promise.resolve(false),
        true,
      ),
    ).resolves.toBeNull();
  });
});
