import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/services/push_message_coordinator.dart';

import '../support/foreground_push_fixture.dart';

/// [FakePushMessaging] whose cold-start reads stay pending until the test
/// completes them, and which counts listeners on the foreground stream.
final class _ControlledMessaging implements PushMessaging {
  final FakePushMessaging _fake = FakePushMessaging();
  final List<Completer<PushMessage?>> initialReads = [];
  int foregroundListens = 0;

  void emitForegroundMessage(PushMessage message) =>
      _fake.emitForegroundMessage(message);

  void emitNotificationOpened(PushMessage message) =>
      _fake.emitNotificationOpened(message);

  @override
  Future<PushPermissionStatus> requestPermission() => _fake.requestPermission();

  @override
  Future<String?> getToken() => _fake.getToken();

  @override
  Stream<String> get onTokenRefresh => _fake.onTokenRefresh;

  @override
  Future<void> deleteToken() => _fake.deleteToken();

  @override
  Stream<PushMessage> get onForegroundMessage {
    foregroundListens++;
    return _fake.onForegroundMessage;
  }

  @override
  Stream<PushMessage> get onNotificationOpened => _fake.onNotificationOpened;

  @override
  Future<PushMessage?> getInitialMessage() {
    final read = Completer<PushMessage?>();
    initialReads.add(read);
    return read.future;
  }
}

Future<void> _flush() => Future<void>.delayed(Duration.zero);

void main() {
  late FakePushMessaging fake;
  late PushMessageCoordinator coordinator;

  setUp(() {
    fake = FakePushMessaging();
    coordinator = PushMessageCoordinator(messaging: fake);
  });

  tearDown(() async {
    await coordinator.dispose();
  });

  test('foreground messages never queue navigation (CAN-3642)', () async {
    await coordinator.start();
    for (final push in can3642Pushes) {
      fake.emitForegroundMessage(push);
    }
    await _flush();
    expect(coordinator.pendingTap.value, isNull);
  });

  test('foreground messages never replace a pending tap', () async {
    fake.initialMessage = const PushMessage(data: {'clientChatId': 'boot'});
    await coordinator.start();
    for (final push in can3642Pushes) {
      fake.emitForegroundMessage(push);
    }
    await _flush();
    expect(coordinator.pendingTap.value?.data['clientChatId'], 'boot');

    fake.emitNotificationOpened(
      const PushMessage(data: {'clientChatId': 'tapped'}),
    );
    await _flush();
    for (final push in can3642Pushes) {
      fake.emitForegroundMessage(push);
    }
    await _flush();
    expect(coordinator.pendingTap.value?.data['clientChatId'], 'tapped');
  });

  test('the coordinator does not subscribe to foreground messages', () async {
    final messaging = _ControlledMessaging();
    final subject = PushMessageCoordinator(messaging: messaging);
    unawaited(subject.start());
    await _flush();
    await subject.stop();
    unawaited(subject.start());
    await _flush();
    expect(messaging.foregroundListens, 0);
    await subject.dispose();
  });

  test('notification taps and requestOpen set pendingTap', () async {
    await coordinator.start();
    fake.emitNotificationOpened(
      const PushMessage(data: {'clientChatId': 'c1'}),
    );
    await _flush();
    expect(coordinator.pendingTap.value?.data['clientChatId'], 'c1');
    coordinator.clearPendingTap();
    coordinator.requestOpen(const PushMessage(data: {'clientChatId': 'c2'}));
    expect(coordinator.pendingTap.value?.data['clientChatId'], 'c2');
  });

  test(
    'a pipeline tap is queued unchanged for the deep-link resolver',
    () async {
      await coordinator.start();
      fake.emitNotificationOpened(can3642Pushes.first);
      await _flush();
      expect(
        coordinator.pendingTap.value?.data['clientChatId'],
        'pipeline:synthetic-execution',
      );
    },
  );

  test('cold-start initial message seeds pendingTap', () async {
    fake.initialMessage = const PushMessage(data: {'clientChatId': 'boot'});
    await coordinator.start();
    expect(coordinator.pendingTap.value?.data['clientChatId'], 'boot');
  });

  test('an empty cold-start read leaves nothing pending', () async {
    await coordinator.start();
    expect(coordinator.pendingTap.value, isNull);
  });

  test('a failed cold-start read never throws and taps still work', () async {
    final messaging = _ControlledMessaging();
    final subject = PushMessageCoordinator(messaging: messaging);
    final started = subject.start();
    await _flush();
    messaging.initialReads.single.completeError(StateError('unavailable'));
    await started;
    expect(subject.pendingTap.value, isNull);
    messaging.emitNotificationOpened(
      const PushMessage(data: {'clientChatId': 'after-error'}),
    );
    await _flush();
    expect(subject.pendingTap.value?.data['clientChatId'], 'after-error');
    await subject.dispose();
  });

  test('a tap that arrives during the cold-start read wins', () async {
    final messaging = _ControlledMessaging();
    final subject = PushMessageCoordinator(messaging: messaging);
    final started = subject.start();
    await _flush();
    messaging.emitNotificationOpened(
      const PushMessage(data: {'clientChatId': 'tapped'}),
    );
    await _flush();
    messaging.initialReads.single.complete(
      const PushMessage(data: {'clientChatId': 'late-boot'}),
    );
    await started;
    expect(subject.pendingTap.value?.data['clientChatId'], 'tapped');
    await subject.dispose();
  });

  test(
    'a cold-start read finishing after stop or restart is ignored',
    () async {
      final messaging = _ControlledMessaging();
      final subject = PushMessageCoordinator(messaging: messaging);
      final first = subject.start();
      await _flush();
      await subject.stop();
      messaging.initialReads.first.complete(
        const PushMessage(data: {'clientChatId': 'previous-user'}),
      );
      await first;
      expect(subject.pendingTap.value, isNull);

      final second = subject.start();
      await _flush();
      expect(messaging.initialReads, hasLength(2));
      messaging.initialReads.last.complete(null);
      await second;
      expect(subject.pendingTap.value, isNull);
      await subject.dispose();
    },
  );

  test('start is idempotent', () async {
    final messaging = _ControlledMessaging();
    final subject = PushMessageCoordinator(messaging: messaging);
    unawaited(subject.start());
    unawaited(subject.start());
    await _flush();
    expect(messaging.initialReads, hasLength(1));
    messaging.emitNotificationOpened(
      const PushMessage(data: {'clientChatId': 'once'}),
    );
    await _flush();
    expect(subject.pendingTap.value?.data['clientChatId'], 'once');
    await subject.dispose();
  });

  test(
    'stop clears user state and start creates fresh subscriptions',
    () async {
      await coordinator.start();
      coordinator.requestOpen(
        const PushMessage(data: {'clientChatId': 'previous-user'}),
      );

      await coordinator.stop();
      expect(coordinator.pendingTap.value, isNull);

      fake.emitForegroundMessage(
        const PushMessage(data: {'clientChatId': 'stale-foreground'}),
      );
      fake.emitNotificationOpened(
        const PushMessage(data: {'clientChatId': 'stale-tap'}),
      );
      coordinator.requestOpen(
        const PushMessage(data: {'clientChatId': 'stale-request'}),
      );
      await _flush();
      expect(coordinator.pendingTap.value, isNull);

      await coordinator.start();
      fake.emitForegroundMessage(
        const PushMessage(data: {'clientChatId': 'next-foreground'}),
      );
      await _flush();
      expect(coordinator.pendingTap.value, isNull);
      fake.emitNotificationOpened(
        const PushMessage(data: {'clientChatId': 'next-tap'}),
      );
      await _flush();
      expect(coordinator.pendingTap.value?.data['clientChatId'], 'next-tap');
    },
  );

  // Seeded sequences over every input the coordinator sees. A reference
  // model states the invariants: only taps, cold-start reads of the current
  // generation (when nothing else is pending) and requestOpen while started
  // set pendingTap; foreground messages never change it; stop clears it.
  for (final seed in const [1, 7, 42, 3642, 90210]) {
    test(
      'seeded lifecycle sequence keeps pendingTap consistent ($seed)',
      () async {
        final random = Random(seed);
        final messaging = _ControlledMessaging();
        final subject = PushMessageCoordinator(messaging: messaging);
        var started = false;
        String? expected;
        // Cold-start reads still pending, with whether they belong to the
        // current generation.
        final pendingReads =
            <({Completer<PushMessage?> read, int generation})>[];
        var generation = 0;
        final trace = <String>[];

        for (var step = 0; step < 120; step++) {
          final id = 'm$step';
          final message = PushMessage(data: {'clientChatId': id});
          switch (random.nextInt(7)) {
            case 0:
              trace.add('foreground');
              messaging.emitForegroundMessage(
                can3642Pushes[random.nextInt(can3642Pushes.length)],
              );
            case 1:
              trace.add('opened $id');
              messaging.emitNotificationOpened(message);
              if (started) expected = id;
            case 2:
              trace.add('requestOpen $id');
              subject.requestOpen(message);
              if (started) expected = id;
            case 3:
              trace.add('clear');
              subject.clearPendingTap();
              expected = null;
            case 4:
              trace.add('stop');
              await subject.stop();
              started = false;
              expected = null;
            case 5:
              trace.add('start');
              if (!started) {
                started = true;
                generation++;
                unawaited(subject.start());
                await _flush();
                pendingReads.add((
                  read: messaging.initialReads.last,
                  generation: generation,
                ));
              }
            case 6:
              if (pendingReads.isEmpty) break;
              final entry = pendingReads.removeAt(
                random.nextInt(pendingReads.length),
              );
              final value = random.nextBool() ? message : null;
              trace.add('initial ${value == null ? 'none' : id}');
              entry.read.complete(value);
              if (started &&
                  entry.generation == generation &&
                  value != null &&
                  expected == null) {
                expected = id;
              }
          }
          await _flush();
          expect(
            subject.pendingTap.value?.data['clientChatId'],
            expected,
            reason: 'seed $seed, steps: ${trace.join(', ')}',
          );
        }
        expect(messaging.foregroundListens, 0);
        for (final entry in pendingReads) {
          entry.read.complete(null);
        }
        await subject.dispose();
      },
    );
  }
}
