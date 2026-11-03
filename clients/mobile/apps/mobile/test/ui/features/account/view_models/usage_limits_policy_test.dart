import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';

import '../../../../support/provider_usage_fixture.dart';

PortalProviderUsageProjection _projection({
  Map<String, dynamic>? claude,
  Map<String, dynamic>? codex,
}) => PortalProviderUsageProjection.fromJson(
  providerUsagePayload(claude: claude, codex: codex),
);

PortalProviderUsageWindow _window({num? used, String? resetsAt}) =>
    PortalProviderUsageWindow(
      id: 'w',
      label: 'w',
      usedPercent: used,
      resetsAt: resetsAt,
    );

void main() {
  test(
    'includes a reported Copilot account with its premium request quota',
    () {
      final lines = usageSummaryLines(
        desktopAvailable: true,
        projection: PortalProviderUsageProjection.fromJson(
          providerUsagePayload(copilot: copilotUsageEntry(premium: 0)),
        ),
      )!;
      expect(lines.map((line) => line.provider.wire), [
        'claude',
        'codex',
        'copilot',
      ]);
      expect(lines.last.valueLabel, '0% · Premium requests');
    },
  );

  test(
    'an all-unlimited Copilot quota stays distinct from unavailable usage',
    () {
      final lines = usageSummaryLines(
        desktopAvailable: true,
        projection: PortalProviderUsageProjection.fromJson(
          providerUsagePayload(
            claude: signedOutUsageEntry('claude'),
            codex: signedOutUsageEntry('codex'),
            copilot: copilotUsageEntry(allUnlimited: true),
          ),
        ),
      );
      expect(lines, isNotNull);
      expect(lines!.single.valueLabel, 'Unlimited');
      expect(lines.single.usedPercent, isNull);
    },
  );

  test('tones follow the desktop thresholds on the unrounded value', () {
    expect(usageToneFor(0), UsageTone.normal);
    expect(usageToneFor(79.9), UsageTone.normal);
    expect(usageToneFor(80), UsageTone.warning);
    expect(usageToneFor(97.9), UsageTone.warning);
    expect(usageToneFor(98), UsageTone.critical);
    expect(usageToneFor(140), UsageTone.critical);
  });

  test('the most-used window is the highest percentage, first on ties', () {
    final entry = PortalProviderUsageEntry(
      provider: PortalProviderUsageProvider.claude,
      authState: PortalProviderUsageAuthState.authenticated,
      windows: [
        const PortalProviderUsageWindow(id: 'a', label: 'A', usedPercent: 40),
        const PortalProviderUsageWindow(id: 'b', label: 'B'),
        const PortalProviderUsageWindow(id: 'c', label: 'C', usedPercent: 72),
        const PortalProviderUsageWindow(id: 'd', label: 'D', usedPercent: 72),
        const PortalProviderUsageWindow(
          id: 'e',
          label: 'E',
          usedPercent: double.nan,
        ),
      ],
    );
    expect(mostUsedWindow(entry)?.id, 'c');
    expect(
      mostUsedWindow(
        const PortalProviderUsageEntry(
          provider: PortalProviderUsageProvider.codex,
          authState: PortalProviderUsageAuthState.authenticated,
          windows: [PortalProviderUsageWindow(id: 'x', label: 'X')],
        ),
      ),
      isNull,
    );
  });

  group('summary lines', () {
    test('Claude then Codex, each with its most-used window', () {
      final lines = usageSummaryLines(
        desktopAvailable: true,
        projection: _projection(),
      )!;
      expect(lines.map((l) => l.valueLabel), [
        '72% · 7-day',
        '55% · 7-day window',
      ]);
      expect(lines.map((l) => l.provider), kUsageProviderOrder);
    });

    test('only signed-in providers get a line', () {
      final claudeOnly = usageSummaryLines(
        desktopAvailable: true,
        projection: _projection(codex: signedOutUsageEntry('codex')),
      )!;
      expect(claudeOnly.single.provider, PortalProviderUsageProvider.claude);
      final codexOnly = usageSummaryLines(
        desktopAvailable: true,
        projection: _projection(claude: signedOutUsageEntry('claude')),
      )!;
      expect(codexOnly.single.provider, PortalProviderUsageProvider.codex);
    });

    test('a signed-in provider whose fetch failed keeps an unavailable '
        'line', () {
      final failedClaude = usageSummaryLines(
        desktopAvailable: true,
        projection: _projection(
          claude: failedUsageEntry('claude'),
          codex: signedOutUsageEntry('codex'),
        ),
      )!;
      expect(failedClaude, [
        const UsageSummaryLine(provider: PortalProviderUsageProvider.claude),
      ]);
      expect(failedClaude.single.valueLabel, 'Usage unavailable');

      final bothFailed = usageSummaryLines(
        desktopAvailable: true,
        projection: _projection(
          claude: failedUsageEntry('claude'),
          codex: failedUsageEntry('codex'),
        ),
      )!;
      expect(bothFailed.map((l) => l.provider), kUsageProviderOrder);
      expect(bothFailed.map((l) => l.valueLabel), [
        'Usage unavailable',
        'Usage unavailable',
      ]);

      final withCodex = usageSummaryLines(
        desktopAvailable: true,
        projection: _projection(claude: failedUsageEntry('claude')),
      )!;
      expect(withCodex.map((l) => l.valueLabel), [
        'Usage unavailable',
        '55% · 7-day window',
      ]);
    });

    test('hidden when unavailable or nobody is signed in', () {
      expect(
        usageSummaryLines(desktopAvailable: false, projection: _projection()),
        isNull,
      );
      expect(
        usageSummaryLines(desktopAvailable: true, projection: null),
        isNull,
      );
      expect(
        usageSummaryLines(
          desktopAvailable: true,
          projection: _projection(
            claude: signedOutUsageEntry('claude'),
            codex: signedOutUsageEntry('codex'),
          ),
        ),
        isNull,
      );
      // The desktop has no usage summary for either provider yet.
      expect(
        usageSummaryLines(
          desktopAvailable: true,
          projection: _projection(
            claude: const {
              'provider': 'claude',
              'authState': 'unknown',
              'windows': <Object>[],
            },
            codex: const {
              'provider': 'codex',
              'authState': 'unknown',
              'windows': <Object>[],
            },
          ),
        ),
        isNull,
      );
      expect(
        usageSummaryLines(
          desktopAvailable: false,
          projection: _projection(claude: failedUsageEntry('claude')),
        ),
        isNull,
      );
    });

    test('a signed-in provider without percentages says so', () {
      const line = UsageSummaryLine(
        provider: PortalProviderUsageProvider.codex,
      );
      expect(line.valueLabel, 'Usage unavailable');
      expect(
        const UsageSummaryLine(
          provider: PortalProviderUsageProvider.claude,
          usedPercent: 72.4,
          windowLabel: '7-day',
        ),
        const UsageSummaryLine(
          provider: PortalProviderUsageProvider.claude,
          usedPercent: 72.4,
          windowLabel: '7-day',
        ),
      );
    });
  });

  test('reset passed at or before now, never for a missing or bad time', () {
    final now = DateTime.utc(2026, 10, 5, 12);
    expect(
      isUsageResetPassed(_window(resetsAt: '2026-10-05T11:59:00Z'), now),
      isTrue,
    );
    expect(
      isUsageResetPassed(_window(resetsAt: '2026-10-05T12:00:00Z'), now),
      isTrue,
    );
    expect(
      isUsageResetPassed(_window(resetsAt: '2026-10-05T12:00:01Z'), now),
      isFalse,
    );
    expect(isUsageResetPassed(_window(resetsAt: 'soon'), now), isFalse);
    expect(isUsageResetPassed(_window(), now), isFalse);
  });

  test('the next reset is the earliest future one', () {
    final projection = _projection();
    final next = nextUsageResetAfter(projection, usageFixtureNow);
    expect(next, usageFixtureNow.add(const Duration(hours: 1)));
    expect(nextUsageResetAfter(null, usageFixtureNow), isNull);
  });

  test('percent, bar and credit formatting', () {
    expect(formatUsedPercent(72), '72.0%');
    expect(formatUsedPercent(79.94), '79.9%');
    expect(usageBarFraction(-5), 0);
    expect(usageBarFraction(150), 1);
    expect(usageBarFraction(40), 0.4);
    expect(
      usageCreditLines(
        const PortalProviderUsageCredits(
          spent: 15.5,
          total: 50,
          unit: PortalProviderUsageCreditUnit.usd,
        ),
      ),
      ['Spent \$15.50 of \$50.00'],
    );
    expect(
      usageCreditLines(
        const PortalProviderUsageCredits(
          remaining: 1250,
          unit: PortalProviderUsageCreditUnit.credits,
        ),
      ),
      ['1,250 credits remaining'],
    );
    expect(usageCreditLines(null), isEmpty);
  });
}
