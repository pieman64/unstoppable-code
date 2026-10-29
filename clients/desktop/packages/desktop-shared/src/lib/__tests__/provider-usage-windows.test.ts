import { parseCodexWhamUsage } from '../provider-usage-parsers';
import { buildProviderUsageWindows } from '../provider-usage-windows';

describe('buildProviderUsageWindows', () => {
  it.each([123, 0])(
    'shows a credits-only Codex WHAM balance of %d without quota metadata',
    (balance) => {
      const windows = buildProviderUsageWindows(
        'codex',
        parseCodexWhamUsage({ credits: { balance } }),
      );

      expect(windows).toHaveLength(1);
      const [window] = windows;
      expect(window).toMatchObject({
        title: 'Credits',
        credits: { remainingUsd: balance },
        creditsAreCount: true,
      });
      expect(window).not.toHaveProperty('usedPercent');
      expect(window).not.toHaveProperty('resetsAt');
      expect(window).not.toHaveProperty('windowDurationMs');
    },
  );

  it('does not add a standalone credits window when Codex quota windows exist', () => {
    const windows = buildProviderUsageWindows(
      'codex',
      parseCodexWhamUsage({
        rate_limit: {
          primary_window: { used_percent: 42, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 60, limit_window_seconds: 604800 },
        },
        credits: { balance: 123 },
      }),
    );

    expect(windows.map((window) => window.title)).toEqual([
      '5-hour window',
      '7-day window',
    ]);
  });

  it('does not fabricate a credits window when WHAM omits the balance', () => {
    const windows = buildProviderUsageWindows(
      'codex',
      parseCodexWhamUsage({ credits: {} }),
    );

    expect(windows).toEqual([]);
  });
});
