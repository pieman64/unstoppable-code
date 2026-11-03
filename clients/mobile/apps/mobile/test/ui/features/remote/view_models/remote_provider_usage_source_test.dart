import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_provider_usage_source.dart';

import '../../../../support/provider_usage_fixture.dart';
import '../../../../support/remote_session_fake_server.dart';
import '../../../../support/usage_limits_shell.dart';

const _claude = PortalProviderUsageProvider.claude;

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

void main() {
  test('availability needs a pairing, a live desktop and the capability', () {
    expect(
      isProviderUsageAvailable(
        isConnected: true,
        desktopStatus: RemotePortalConnectionStatus.active,
        supportsProviderUsage: true,
      ),
      isTrue,
    );
    for (final (connected, status, capable) in [
      (false, RemotePortalConnectionStatus.active, true),
      (true, RemotePortalConnectionStatus.active, false),
      (true, null, true),
      (true, RemotePortalConnectionStatus.reconnecting, true),
      (true, RemotePortalConnectionStatus.inactive, true),
      (true, RemotePortalConnectionStatus.ended, true),
      (true, RemotePortalConnectionStatus.pending, true),
    ]) {
      expect(
        isProviderUsageAvailable(
          isConnected: connected,
          desktopStatus: status,
          supportsProviderUsage: capable,
        ),
        isFalse,
        reason: '$connected $status $capable',
      );
    }
  });

  testWidgets('mirrors the paired desktop through the borrowed view model', (
    tester,
  ) async {
    final server = FakePortalSessionServer()
      ..addSession(
        id: 'sess-a',
        clientName: 'Desktop A',
        eventCursor: 40,
        capabilities: const {'provider_usage': true},
        providerUsage: providerUsagePayload(),
      );
    final remote = RemoteControlViewModel(
      repository: server.repository(),
      stateRefreshDebounce: Duration.zero,
    );
    final source = RemoteProviderUsageSource(remote);
    var notifications = 0;
    void listener() => notifications++;
    source.addListener(listener);
    try {
      expect(source.isAvailable, isFalse);
      expect(source.projection, isNull);
      unawaited(remote.restoreIfIdle());
      for (var i = 0; i < 20 && source.projection == null; i++) {
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(source.isAvailable, isTrue);
      expect(source.projection!.providers.first.provider, _claude);
      expect(notifications, greaterThan(0));

      // Refresh goes out on the existing command path.
      await source.refresh(_claude);
      await _settle(tester);
      expect(server.commandBodies, [
        {
          'type': 'portal.provider_usage.refresh',
          'payload': {'provider': 'claude'},
        },
      ]);
      expect(source.isRefreshing(_claude), isTrue);
      expect(source.refreshFailure(_claude), isNull);

      // Removing the listener detaches it from the view model.
      source.removeListener(listener);
      final before = notifications;
      server.push('sess-a', [
        providerUsageDeltaEnvelope(
          providerUsagePayload(claude: claudeUsageEntry(sevenDay: 84)),
          cursor: 41,
        ),
      ]);
      await _settle(tester);
      expect(source.isRefreshing(_claude), isFalse);
      expect(
        source.projection!.providers.first.windows.map(
          (window) => window.usedPercent,
        ),
        contains(84),
      );
      expect(notifications, before);

      server.sleep('sess-a');
      await _settle(tester);
      expect(remote.isConnected, isTrue, reason: 'still paired');
      expect(source.isAvailable, isFalse);
    } finally {
      server.close();
      await tester.pump(const Duration(milliseconds: 100));
      remote.dispose();
      await tester.pump(const Duration(seconds: 1));
    }
  });

  for (final failureFirst in [false, true]) {
    testWidgets('a rejected refresh stays on Usage limits '
        '(failure ${failureFirst ? 'before' : 'after'} the ACK)', (
      tester,
    ) async {
      final server = FakePortalSessionServer()
        ..addSession(
          id: 'sess-a',
          clientName: 'Desktop A',
          eventCursor: 40,
          capabilities: const {'provider_usage': true},
          providerUsage: providerUsagePayload(),
        );
      final remote = RemoteControlViewModel(
        repository: server.repository(),
        stateRefreshDebounce: Duration.zero,
      );
      final source = RemoteProviderUsageSource(remote);
      try {
        unawaited(remote.restoreIfIdle());
        for (var i = 0; i < 20 && source.projection == null; i++) {
          await tester.pump(const Duration(milliseconds: 10));
        }
        expect(source.isAvailable, isTrue);

        final gate = server.commandGate = failureFirst
            ? Completer<void>()
            : null;
        unawaited(source.refresh(_claude));
        await _settle(tester);
        server.push('sess-a', [
          {
            'eventId': 'evt-usage-failed',
            'cursor': 41,
            'type': 'portal.command.failed',
            'payload': {'commandId': 'cmd-1', 'error': 'Claude is busy.'},
          },
        ]);
        await _settle(tester);
        gate?.complete();
        await _settle(tester);

        expect(source.isRefreshing(_claude), isFalse);
        expect(source.refreshFailure(_claude), 'Claude is busy.');
        // Remote Control's banner, composer gate and turn reporting read
        // this; a usage failure must not reach them.
        expect(remote.commandFailureMessage, isNull);
        expect(remote.hasCommandFailed('cmd-1'), isFalse);
      } finally {
        server.close();
        await tester.pump(const Duration(milliseconds: 100));
        remote.dispose();
        await tester.pump(const Duration(seconds: 1));
      }
    });
  }

  testWidgets('reports this phone losing the server apart from the desktop', (
    tester,
  ) async {
    final server = FakePortalSessionServer()
      ..addSession(
        id: 'sess-a',
        clientName: 'Desktop A',
        eventCursor: 40,
        capabilities: const {'provider_usage': true},
        providerUsage: providerUsagePayload(),
      );
    final remote = RemoteControlViewModel(
      repository: server.repository(),
      stateRefreshDebounce: Duration.zero,
    );
    final source = RemoteProviderUsageSource(remote);
    final deliveries = <ProviderUsageDelivery>[];
    void listener() {
      if (deliveries.lastOrNull != source.delivery) {
        deliveries.add(source.delivery);
      }
    }

    source.addListener(listener);
    try {
      unawaited(remote.restoreIfIdle());
      for (var i = 0; i < 20 && source.projection == null; i++) {
        await tester.pump(const Duration(milliseconds: 10));
      }
      expect(source.isAvailable, isTrue);
      await proveUsageLimitsDelivery(tester, server);
      // Control: a quiet but delivering link stays live past the grace.
      await tester.pump(kRemoteUnreachableAfter);
      expect(source.delivery, ProviderUsageDelivery.live);
      final cached = source.projection;

      server.dropDelivery();
      await _settle(tester);
      expect(source.delivery, ProviderUsageDelivery.live, reason: 'grace');
      await tester.pump(kRemoteReconnectingGrace);
      expect(source.delivery, ProviderUsageDelivery.reconnecting);
      await tester.pump(kRemoteUnreachableAfter);
      expect(source.delivery, ProviderUsageDelivery.unreachable);
      // The desktop was never reported gone, and the values are kept.
      expect(source.isAvailable, isTrue);
      expect(source.projection, same(cached));

      // The retried poll is held until the next batch proves delivery.
      server.restoreDelivery();
      await _settle(tester);
      expect(source.delivery, ProviderUsageDelivery.unreachable);
      server.heartbeat('sess-a');
      await _settle(tester);
      expect(source.delivery, ProviderUsageDelivery.live);
      expect(deliveries, [
        ProviderUsageDelivery.live,
        ProviderUsageDelivery.reconnecting,
        ProviderUsageDelivery.unreachable,
        ProviderUsageDelivery.live,
      ]);
    } finally {
      source.removeListener(listener);
      server.close();
      await tester.pump(const Duration(milliseconds: 100));
      remote.dispose();
      await tester.pump(const Duration(seconds: 1));
    }
  });
}
