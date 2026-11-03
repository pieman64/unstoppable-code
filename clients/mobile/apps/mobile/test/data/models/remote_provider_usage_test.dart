import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_provider_usage.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';

import '../../support/provider_usage_fixture.dart';

RemotePortalEvent _single(Map<String, dynamic> envelope) =>
    RemotePortalEventBatch.fromJson({
      'events': [envelope],
      'nextCursor': 9,
    }).events.single;

void main() {
  group('parseProviderUsageEntities', () {
    test('decodes the singleton among other overview entities', () {
      final update = parseProviderUsageEntities([
        {'entityType': 'workspace', 'localId': 'ws', 'payload': {}},
        providerUsageEntity(providerUsagePayload()),
      ]);
      final providers = update!.projection!.providers;
      expect(providers.map((p) => p.provider), [
        PortalProviderUsageProvider.claude,
        PortalProviderUsageProvider.codex,
      ]);
      expect(providers.first.windows[1].label, '7-day');
      expect(
        providers.first.windows.last.credits?.unit,
        PortalProviderUsageCreditUnit.usd,
      );
    });

    test('an absent singleton clears only an authoritative payload', () {
      final rows = [
        {'entityType': 'workspace', 'localId': 'ws', 'payload': {}},
      ];
      expect(parseProviderUsageEntities(rows), isNull);
      final cleared = parseProviderUsageEntities(rows, authoritative: true);
      expect(cleared, isNotNull);
      expect(cleared!.projection, isNull);
      expect(parseProviderUsageEntities(null, authoritative: true), isNull);
    });

    test('an undecodable singleton keeps the last value', () {
      expect(
        parseProviderUsageEntities([
          providerUsageEntity({'providers': 'nope'}),
        ], authoritative: true),
        isNull,
      );
    });

    test('removal rows name the singleton', () {
      expect(
        removesProviderUsage([
          {'entityType': 'provider_usage', 'localId': 'overview'},
        ]),
        isTrue,
      );
      expect(
        removesProviderUsage([
          {'entityType': 'workspace', 'localId': 'ws'},
        ]),
        isFalse,
      );
    });
  });

  group('portal events', () {
    test('a delta upsert carries the projection', () {
      final event =
          _single(providerUsageDeltaEnvelope(providerUsagePayload(), cursor: 7))
              as RemoteStateDeltaEvent;
      expect(event.providerUsage?.projection?.providers, hasLength(2));
      expect(event.cursor, 7);
    });

    test('a delta removal clears it and unrelated deltas leave it', () {
      final removal =
          _single({
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'overview',
                  'entities': <Object>[],
                  'removed': [
                    {'entityType': 'provider_usage', 'localId': 'overview'},
                  ],
                },
              })
              as RemoteStateDeltaEvent;
      expect(removal.providerUsage, isNotNull);
      expect(removal.providerUsage!.projection, isNull);

      final unrelated =
          _single({
                'type': 'portal.state.delta',
                'payload': {
                  'scope': 'overview',
                  'entities': [
                    {'entityType': 'workspace', 'localId': 'ws', 'payload': {}},
                  ],
                },
              })
              as RemoteStateDeltaEvent;
      expect(unrelated.providerUsage, isNull);
    });

    test('only overview snapshots own the singleton', () {
      RemoteStateSnapshotEvent snapshot(String scope) =>
          _single({
                'type': 'portal.state.snapshot',
                'payload': {
                  'scope': scope,
                  'entities': [
                    {'entityType': 'workspace', 'localId': 'ws', 'payload': {}},
                  ],
                },
              })
              as RemoteStateSnapshotEvent;
      expect(snapshot('worktree').providerUsage, isNull);
      final overview = snapshot('overview').providerUsage;
      expect(overview, isNotNull);
      expect(overview!.projection, isNull);
    });
  });
}
