import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';

void main() {
  test(
    'decodes optional OpenCode accounts alongside existing quota entries',
    () {
      final projection = PortalProviderUsageProjection.fromJson({
        'updatedAt': '2026-10-21T23:00:00Z',
        'providers': [
          {'provider': 'codex', 'authState': 'unknown', 'windows': []},
        ],
        'openCodeAccounts': {
          'status': 'ready',
          'updatedAt': '2026-10-21T23:00:00Z',
          'providers': [
            {
              'id': 'fixture',
              'name': 'Fixture',
              'accounts': [
                {
                  'label': 'Work account',
                  'method': 'oauth',
                  'selected': true,
                  'needsSignIn': false,
                },
              ],
            },
          ],
        },
      });
      expect(projection.providers.single.provider.wire, 'codex');
      final account =
          projection.openCodeAccounts!.providers.single.accounts.single;
      expect(account.label, 'Work account');
      expect(account.method.wire, 'oauth');
      expect(account.selected, isTrue);
      expect(account.needsSignIn, isFalse);
      expect(
        PortalProviderUsageRefreshPayload.fromJson({
          'provider': 'opencode',
        }).provider.wire,
        'opencode',
      );
    },
  );
  test(
    'distinguishes absent account details from an empty proxy inventory',
    () {
      for (final accounts in [null, <Map<String, dynamic>>[]]) {
        final projection = PortalProviderUsageProjection.fromJson({
          'updatedAt': '2026-10-20T12:00:00.000Z',
          'providers': [
            {
              'provider': 'codex',
              'authState': 'authenticated',
              'windows': <Map<String, dynamic>>[],
              'accounts': ?accounts,
            },
          ],
        });
        expect(projection.providers, hasLength(1));
        expect(
          projection.providers.single.accounts,
          accounts == null ? isNull : isEmpty,
        );
      }
    },
  );
  test('decodes a Copilot quota entry without dropping the provider row', () {
    final projection = PortalProviderUsageProjection.fromJson({
      'updatedAt': '2026-10-12T19:00:00.000Z',
      'providers': [
        {
          'provider': 'copilot',
          'authState': 'authenticated',
          'accountLabel': 'octocat',
          'windows': [
            {'id': 'chat-primary', 'label': 'Chat', 'unlimited': true},
            {
              'id': 'premium-primary',
              'label': 'Premium requests',
              'usedPercent': 0,
            },
          ],
        },
      ],
    });
    expect(projection.providers, hasLength(1));
    final entry = projection.providers.single;
    expect(entry.provider.wire, 'copilot');
    expect(entry.accountLabel, 'octocat');
    expect(entry.accountEmail, isNull);
    expect(entry.windows, hasLength(2));
    expect(entry.windows.first.unlimited, isTrue);
    expect(entry.windows.first.usedPercent, isNull);
    expect(entry.windows.last.unlimited, isNull);
    expect(entry.windows.last.usedPercent, 0);
  });
  group('PortalProviderUsageProjection.fromJson (CAN-3635)', () {
    test('decodes windows, credits and classified errors', () {
      final projection = PortalProviderUsageProjection.fromJson({
        'updatedAt': '2026-10-04T17:05:00.000Z',
        'providers': [
          {
            'provider': 'claude',
            'authState': 'authenticated',
            'accountEmail': 'claude-user@example.com',
            'planLabel': 'Claude Max 20x',
            'lastUpdatedAt': '2026-10-04T17:00:00.000Z',
            'windows': [
              {
                'id': 'session-primary',
                'label': '5-hour window',
                'usedPercent': 42,
                'resetsAt': '2026-10-04T20:00:00.000Z',
                'windowDurationMs': 18000000,
              },
              {
                'id': 'extra_usage-primary',
                'label': 'Extra usage',
                'usedPercent': 25.5,
                'credits': {
                  'unit': 'usd',
                  'spent': 12.5,
                  'remaining': 37.5,
                  'total': 50,
                },
              },
            ],
          },
          {
            'provider': 'codex',
            'authState': 'error',
            'error': {
              'kind': 'network',
              'message':
                  'Check your connection, then try reaching Codex again.',
            },
            'windows': [],
          },
        ],
      });

      expect(projection.updatedAt, '2026-10-04T17:05:00.000Z');
      final claude = projection.providers[0];
      expect(claude.provider, PortalProviderUsageProvider.claude);
      expect(claude.authState, PortalProviderUsageAuthState.authenticated);
      expect(claude.accountEmail, 'claude-user@example.com');
      expect(claude.planLabel, 'Claude Max 20x');
      expect(claude.lastUpdatedAt, '2026-10-04T17:00:00.000Z');
      expect(claude.error, isNull);
      expect(claude.windows.map((window) => window.id), [
        'session-primary',
        'extra_usage-primary',
      ]);
      final session = claude.windows[0];
      expect(session.label, '5-hour window');
      expect(session.usedPercent, 42);
      expect(session.resetsAt, '2026-10-04T20:00:00.000Z');
      expect(session.windowDurationMs, 18000000);
      expect(session.credits, isNull);
      final credits = claude.windows[1].credits!;
      expect(credits.unit, PortalProviderUsageCreditUnit.usd);
      expect(credits.spent, 12.5);
      expect(credits.remaining, 37.5);
      expect(credits.total, 50);

      final codex = projection.providers[1];
      expect(codex.provider, PortalProviderUsageProvider.codex);
      expect(codex.authState, PortalProviderUsageAuthState.error);
      expect(codex.error!.kind, PortalProviderUsageErrorKind.network);
      expect(
        codex.error!.message,
        'Check your connection, then try reaching Codex again.',
      );
      expect(codex.windows, isEmpty);
    });

    test('keeps a Codex credit count and skips an undecodable window', () {
      final entry = PortalProviderUsageEntry.fromJson({
        'provider': 'codex',
        'authState': 'authenticated',
        'windows': [
          {
            'id': 'codex-primary',
            'label': '5-hour window',
            'usedPercent': 0,
            'credits': {'unit': 'credits', 'remaining': 120},
          },
          {'label': 'missing id'},
        ],
      });

      expect(entry.windows, hasLength(1));
      expect(entry.windows.single.usedPercent, 0);
      expect(
        entry.windows.single.credits!.unit,
        PortalProviderUsageCreditUnit.credits,
      );
      expect(entry.windows.single.credits!.remaining, 120);
      expect(entry.windows.single.credits!.spent, isNull);
    });

    test('decodes the refresh payload', () {
      expect(
        PortalProviderUsageRefreshPayload.fromJson({
          'provider': 'codex',
        }).provider.wire,
        'codex',
      );
      expect(
        () =>
            PortalProviderUsageRefreshPayload.fromJson({'provider': 'cursor'}),
        throwsFormatException,
      );
    });
  });
}
