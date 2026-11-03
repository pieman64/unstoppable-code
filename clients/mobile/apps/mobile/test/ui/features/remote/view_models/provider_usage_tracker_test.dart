import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_provider_usage.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/provider_usage_tracker.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/provider_usage_fixture.dart';

const _claude = PortalProviderUsageProvider.claude;
const _codex = PortalProviderUsageProvider.codex;

RemoteProviderUsageUpdate _update({
  Map<String, dynamic>? claude,
  Map<String, dynamic>? codex,
}) => RemoteProviderUsageUpdate(
  PortalProviderUsageProjection.fromJson(
    providerUsagePayload(claude: claude, codex: codex),
  ),
);

void main() {
  late FakeRemoteControlRepository repository;
  late OwnedCommandRegistry commands;
  late bool connected;
  late int notifications;

  ProviderUsageTracker build() => ProviderUsageTracker(
    usageCommands: repository.providerUsage,
    commands: commands,
    isConnected: () => connected,
    notify: () => notifications++,
  );

  setUp(() {
    repository = FakeRemoteControlRepository()..supportsProviderUsage = true;
    commands = OwnedCommandRegistry(notify: () {});
    connected = true;
    notifications = 0;
  });

  test('applies projections and ignores an older read', () {
    final tracker = build();
    tracker.apply(_update(claude: claudeUsageEntry(sevenDay: 50)), cursor: 10);
    tracker.apply(_update(claude: claudeUsageEntry(sevenDay: 60)), cursor: 12);
    // A state read that started before the delta at 12 lands late.
    tracker.apply(_update(claude: claudeUsageEntry(sevenDay: 50)), cursor: 11);
    expect(tracker.projection!.providers.first.windows[1].usedPercent, 60);
    tracker.apply(const RemoteProviderUsageUpdate(null), cursor: 13);
    expect(tracker.projection, isNull);
  });

  test('repeated refresh taps send one command until new data arrives', () {
    fakeAsync((async) {
      final tracker = build()..apply(_update(), cursor: 1);
      final gate = repository.providerUsageRefreshGate = Completer<void>();
      unawaited(tracker.refresh(_claude));
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      expect(tracker.isRefreshing(_claude), isTrue);
      gate.complete();
      async.flushMicrotasks();
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      expect(repository.providerUsageRefreshes, [_claude]);
      // The ACK alone does not settle it.
      expect(tracker.isRefreshing(_claude), isTrue);

      // An unrelated Codex change does not settle Claude's refresh.
      tracker.apply(_update(codex: codexUsageEntry(secondary: 70)), cursor: 2);
      expect(tracker.isRefreshing(_claude), isTrue);

      tracker.apply(
        _update(
          claude: claudeUsageEntry(updatedAgo: Duration.zero),
          codex: codexUsageEntry(secondary: 70),
        ),
        cursor: 3,
      );
      expect(tracker.isRefreshing(_claude), isFalse);
      expect(tracker.refreshFailure(_claude), isNull);
      tracker.dispose();
    });
  });

  test('an identical re-read keeps the refresh pending', () {
    final tracker = build()..apply(_update(), cursor: 1);
    unawaited(tracker.refresh(_codex));
    tracker.apply(_update(), cursor: 2);
    expect(tracker.isRefreshing(_codex), isTrue);
    tracker.dispose();
  });

  test('a desktop rejection ends the refresh and allows a retry', () {
    fakeAsync((async) {
      final tracker = build()..apply(_update(), cursor: 1);
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      commands.handleFailed(
        'usage-refresh-1',
        'Claude is busy.',
        projectionSequence: 0,
      );
      expect(tracker.isRefreshing(_claude), isFalse);
      expect(tracker.refreshFailure(_claude), 'Claude is busy.');
      expect(tracker.projection, isNotNull, reason: 'last values kept');
      // The failure is the Usage limits screen's, not Remote Control's
      // command-failure banner.
      expect(commands.failureMessage, isNull);
      expect(commands.hasFailed('usage-refresh-1'), isFalse);
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      expect(repository.providerUsageRefreshes, [_claude, _claude]);
      expect(tracker.refreshFailure(_claude), isNull);
      tracker.dispose();
    });
  });

  test('a failure that races ahead of the ACK still settles', () {
    fakeAsync((async) {
      final tracker = build()..apply(_update(), cursor: 1);
      final gate = repository.providerUsageRefreshGate = Completer<void>();
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      commands.handleFailed(
        'usage-refresh-1',
        'Rejected.',
        projectionSequence: 0,
      );
      gate.complete();
      async.flushMicrotasks();
      expect(tracker.isRefreshing(_claude), isFalse);
      expect(tracker.refreshFailure(_claude), 'Rejected.');
      expect(commands.failureMessage, isNull);
      expect(commands.hasFailed('usage-refresh-1'), isFalse);
      tracker.dispose();
    });
  });

  test('a usage failure leaves another command\'s banner failure intact', () {
    fakeAsync((async) {
      final tracker = build()..apply(_update(), cursor: 1);
      commands.register('send-1');
      commands.handleFailed(
        'send-1',
        'The send was rejected.',
        projectionSequence: 0,
      );
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      commands.handleFailed(
        'usage-refresh-1',
        'Claude is busy.',
        projectionSequence: 0,
      );
      expect(tracker.refreshFailure(_claude), 'Claude is busy.');
      expect(commands.failureMessage, 'The send was rejected.');
      expect(commands.clearFailureMessage(), isTrue);
      expect(commands.failureMessage, isNull);
      tracker.dispose();
    });
  });

  test('a submit error and the watchdog both end the refresh', () {
    fakeAsync((async) {
      final tracker = build()..apply(_update(), cursor: 1);
      repository.providerUsageRefreshError = const RemoteControlException(
        'Update the desktop app to refresh usage.',
      );
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      expect(tracker.isRefreshing(_claude), isFalse);
      expect(
        tracker.refreshFailure(_claude),
        'Update the desktop app to refresh usage.',
      );

      repository.providerUsageRefreshError = null;
      unawaited(tracker.refresh(_codex));
      async.flushMicrotasks();
      async.elapse(kRemoteProviderUsageRefreshTimeout);
      expect(tracker.isRefreshing(_codex), isFalse);
      expect(
        tracker.refreshFailure(_codex),
        kRemoteProviderUsageRefreshUnconfirmed,
      );
      tracker.dispose();
    });
  });

  test('reset forgets the session and a disconnected refresh is a no-op', () {
    fakeAsync((async) {
      final tracker = build()..apply(_update(), cursor: 5);
      unawaited(tracker.refresh(_claude));
      async.flushMicrotasks();
      tracker.reset();
      expect(tracker.projection, isNull);
      expect(tracker.isRefreshing(_claude), isFalse);
      // A new session's lower cursor is not treated as stale.
      tracker.apply(_update(), cursor: 1);
      expect(tracker.projection, isNotNull);
      connected = false;
      unawaited(tracker.refresh(_codex));
      async.flushMicrotasks();
      expect(repository.providerUsageRefreshes, [_claude]);
      async.elapse(kRemoteProviderUsageRefreshTimeout);
      expect(tracker.refreshFailure(_claude), isNull);
      tracker.dispose();
    });
  });
}
