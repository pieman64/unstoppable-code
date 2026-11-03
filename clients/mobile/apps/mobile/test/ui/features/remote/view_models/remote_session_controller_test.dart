// Pairing restore, foreground/background, and session-end handling through
// the assembled engine.
import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_dispatcher.dart';
import 'package:mobile/ui/features/remote/view_models/project_clone_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show RemoteLinkState, kRemoteFreshResumeAfter, kRemoteSessionCacheBudget;

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/memory_remote_transcript_storage.dart';
import '../../../../support/remote_engine_harness.dart';

void main() {
  group('RemoteSessionController restore', () {
    test(
      'restoreIfIdle connects when the server has an active session',
      () async {
        final engine = buildRemoteEngine(
          repository: MockRemoteControlRepository(
            latency: Duration.zero,
            restorableConnection: RemoteConnection(
              deviceLabel: 'Restored Desktop',
              pairedAt: DateTime(2026),
            ),
          ),
        );

        await engine.session.restoreIfIdle();

        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(engine.session.connection?.deviceLabel, 'Restored Desktop');
        expect(engine.store.workspaces, isNotEmpty);
      },
    );

    group('CAN-3373 persisted chat tails', () {
      RemoteClientEngine engineWithGatedTails(
        MemoryRemoteTranscriptStorage storage,
      ) => buildRemoteEngine(
        repository: MockRemoteControlRepository(
          latency: Duration.zero,
          restorableConnection: RemoteConnection(
            deviceLabel: 'Restored Desktop',
            pairedAt: DateTime(2026),
            sessionId: 'session-1',
          ),
        ),
        transcriptCache: RemoteTranscriptCache(
          storage: storage,
          accountScope: 'test:7',
        ),
      );

      test('restore loads them before the first snapshot opens chats', () {
        fakeAsync((async) {
          final storage = MemoryRemoteTranscriptStorage()
            ..loadGate = Completer();
          final engine = engineWithGatedTails(storage);
          unawaited(engine.session.restoreIfIdle());
          async.elapse(const Duration(milliseconds: 100));
          expect(storage.log, ['load session-1']);
          expect(engine.store.snapshot, isNull);

          storage.loadGate!.complete();
          async.flushMicrotasks();
          expect(engine.store.snapshot, isNotNull);
          expect(engine.session.status, RemoteConnectionStatus.connected);
          engine.dispose();
        });
      });

      test('a slow load never holds the session past its budget', () {
        fakeAsync((async) {
          final storage = MemoryRemoteTranscriptStorage()
            ..loadGate = Completer();
          final engine = engineWithGatedTails(storage);
          unawaited(engine.session.restoreIfIdle());
          async.elapse(
            kRemoteSessionCacheBudget - const Duration(milliseconds: 1),
          );
          expect(engine.store.snapshot, isNull);
          async.elapse(const Duration(milliseconds: 1));
          expect(engine.store.snapshot, isNotNull);
          engine.dispose();
        });
      });
    });

    test(
      'hasProbedSession flips once the first restore probe answers',
      () async {
        final engine = buildRemoteEngine(
          repository: MockRemoteControlRepository(latency: Duration.zero),
        );
        expect(engine.session.hasProbedSession, isFalse);

        final restoring = engine.session.restoreIfIdle();
        expect(engine.session.hasProbedSession, isFalse);
        await restoring;

        expect(engine.session.status, RemoteConnectionStatus.disconnected);
        expect(engine.session.hasProbedSession, isTrue);
        engine.dispose();
      },
    );

    test(
      'restoreIfIdle stays disconnected when nothing is restorable',
      () async {
        final engine = buildRemoteEngine(
          repository: MockRemoteControlRepository(latency: Duration.zero),
        );

        await engine.session.restoreIfIdle();

        expect(engine.session.status, RemoteConnectionStatus.disconnected);
        expect(engine.session.isRestoring, isFalse);
      },
    );

    test('restoreIfIdle probes once per foreground, throttled', () async {
      // CAN-2651: the gate used to be a permanent one-shot latch, so a single
      // unlucky cold start (during a Mac sleep or a Wi-Fi drop) stranded the
      // user on the pairing form for the whole process lifetime. It is now a
      // throttle: back-to-back calls still collapse, but a later probe runs.
      final repository = _CountingRestoreRepository();
      var now = DateTime(2026, 8, 1, 12);
      final engine = buildRemoteEngine(
        repository: repository,
        clock: () => now,
      );

      await engine.session.restoreIfIdle();
      await engine.session.restoreIfIdle();

      expect(repository.restoreCalls, 1);

      now = now.add(const Duration(seconds: 6));
      await engine.session.restoreIfIdle();

      expect(repository.restoreCalls, 2);
    });

    test('foregrounding while disconnected re-probes the session', () async {
      final repository = _CountingRestoreRepository();
      var now = DateTime(2026, 8, 1, 12);
      final engine = buildRemoteEngine(
        repository: repository,
        clock: () => now,
      );

      await engine.session.restoreIfIdle();
      expect(repository.restoreCalls, 1);

      // The old `if (!isConnected) return;` meant a foreground could never
      // recover a session the first probe missed.
      now = now.add(const Duration(seconds: 30));
      await engine.session.onAppForegrounded();

      expect(repository.restoreCalls, 2);
      expect(engine.session.status, RemoteConnectionStatus.disconnected);
    });

    test('a cold start that cannot reach the server keeps restoring', () {
      // CAN-3557: reopening the app after swiping it away runs one probe. When
      // that probe cannot reach the server, the user was left on the pairing
      // form until the next background/foreground cycle, although the
      // desktop session was still live.
      fakeAsync((async) {
        final start = DateTime(2026, 10, 2, 12);
        final repository = _UnreachableThenRestorableRepository(
          unreachableProbes: 2,
        );
        final engine = buildRemoteEngine(
          repository: repository,
          clock: () => start.add(async.elapsed),
        );

        unawaited(engine.session.restoreIfIdle());
        async.flushMicrotasks();
        expect(engine.session.status, RemoteConnectionStatus.disconnected);
        expect(engine.session.hasProbedSession, isFalse);
        expect(engine.session.isRestoreRetrying, isTrue);

        async.elapse(const Duration(minutes: 1));

        expect(repository.probeCalls, 3);
        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(engine.session.isRestoreRetrying, isFalse);
        engine.dispose();
      });
    });

    test('an unreachable restore does not retry while backgrounded', () {
      fakeAsync((async) {
        final start = DateTime(2026, 10, 2, 12);
        final repository = _UnreachableThenRestorableRepository(
          unreachableProbes: 1000,
        );
        final engine = buildRemoteEngine(
          repository: repository,
          clock: () => start.add(async.elapsed),
        );

        unawaited(engine.session.restoreIfIdle());
        async.flushMicrotasks();
        engine.session.onAppBackgrounded();
        final probesWhenBackgrounded = repository.probeCalls;

        async.elapse(const Duration(minutes: 10));

        expect(repository.probeCalls, probesWhenBackgrounded);
        engine.dispose();
      });
    });

    test('a throttled foreground still retries an unreachable restore', () {
      fakeAsync((async) {
        final start = DateTime(2026, 10, 2, 12);
        final repository = _UnreachableThenRestorableRepository(
          unreachableProbes: 1,
        );
        final engine = buildRemoteEngine(
          repository: repository,
          clock: () => start.add(async.elapsed),
        );

        unawaited(engine.session.restoreIfIdle());
        async.flushMicrotasks();
        engine.session.onAppBackgrounded();
        async.elapse(const Duration(seconds: 1));
        // Inside the probe throttle, so this foreground cannot probe itself.
        unawaited(engine.session.onAppForegrounded());
        async.flushMicrotasks();
        expect(repository.probeCalls, 1);

        async.elapse(const Duration(minutes: 1));

        expect(engine.session.status, RemoteConnectionStatus.connected);
        engine.dispose();
      });
    });

    test('a definitive "no session" answer is not retried', () {
      fakeAsync((async) {
        final start = DateTime(2026, 10, 2, 12);
        final repository = _CountingRestoreRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          clock: () => start.add(async.elapsed),
        );

        unawaited(engine.session.restoreIfIdle());
        async.elapse(const Duration(minutes: 10));

        expect(repository.restoreCalls, 1);
        expect(engine.session.hasProbedSession, isTrue);
        engine.dispose();
      });
    });

    test('does not auto-probe over a rejected pairing code', () async {
      // CAN-2588's surface: an auto-probe here would stomp the inline error
      // the user is reading on the code field.
      final repository = _CountingFailingConnectRepository();
      final engine = buildRemoteEngine(repository: repository);

      await engine.session.connect('123456');
      expect(engine.session.status, RemoteConnectionStatus.error);

      await engine.session.onAppForegrounded();

      expect(repository.restoreCalls, 0);
    });

    test(
      'restores onto a stale session and seeds the degraded banner',
      () async {
        final repository = _StaleRestoreRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();

        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(
          engine.session.portalConnectionStatus,
          RemotePortalConnectionStatus.inactive,
        );
      },
    );

    test(
      'foreground refresh abandons an inactive orphan the server no longer has',
      () async {
        final repository = _StaleRestoreRepository()
          ..probeOutcome = RemoteSessionProbeOutcome.gone
          ..requestOverviewStateHandler = () async {
            throw const RemoteControlException(
              'Active remote control session not found',
            );
          };
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();
        expect(engine.session.status, RemoteConnectionStatus.connected);

        await engine.session.onAppForegrounded();

        expect(repository.requestOverviewStateCalls, 1);
        expect(engine.session.status, RemoteConnectionStatus.error);
        expect(engine.session.connection, isNull);
        expect(engine.store.snapshot, isNull);
        expect(repository.pauseEventsCalls, greaterThan(0));
        // CAN-3624: only the user's Disconnect ends a session on the server.
        // The teardown is local.
        expect(repository.disconnectCalls, 0);
        expect(repository.clearLocalSessionCalls, 1);
      },
    );

    test(
      'a rejected command over a still-renderable session keeps the pairing',
      () async {
        // The command route rejects every persisted session whose status is
        // not ACTIVE, including an `inactive` row a desktop heartbeat would
        // revive. The rejection starts the check; the session read decides.
        final repository = _StaleRestoreRepository()
          ..requestOverviewStateHandler = () async {
            throw const RemoteControlException(
              'Active remote control session not found',
            );
          };
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();
        expect(engine.session.status, RemoteConnectionStatus.connected);

        await engine.session.onAppForegrounded();

        expect(repository.requestOverviewStateCalls, 1);
        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(engine.session.connection, isNotNull);
        expect(repository.disconnectCalls, 0);
      },
    );

    test('an unanswerable session probe keeps the cached pairing', () async {
      // The 5xx/timeout path. `restoreSession()` collapses this into the same
      // `null` it returns for a genuinely absent session, so the probe is what
      // keeps a transient failure from irreversibly ending a live pairing.
      final repository = _StaleRestoreRepository()
        ..probeOutcome = RemoteSessionProbeOutcome.unknown
        ..requestOverviewStateHandler = () async {
          throw const RemoteControlException(
            'Active remote control session not found',
          );
        };
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );

      await engine.session.restoreIfIdle();
      await engine.session.onAppForegrounded();

      expect(engine.session.status, RemoteConnectionStatus.connected);
      expect(engine.session.connection, isNotNull);
      expect(repository.disconnectCalls, 0);
    });

    test('rapid degraded flapping issues one heartbeat read', () async {
      final repository = _StaleRestoreRepository()
        ..restoreSessionHandler = ((call) => RemoteConnection(
          deviceLabel: 'Desk',
          pairedAt: DateTime(2026, 8, 1),
          connectionStatus: RemotePortalConnectionStatus.active,
        ));
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );

      await engine.session.restoreIfIdle();
      expect(repository.restoreSessionCalls, 1);

      // Hold the next read open so the second transition lands while the
      // first is still in flight — the window the single-flight guard exists
      // to close.
      final gate = Completer<void>();
      repository.restoreSessionGate = gate;
      for (final status in const [
        RemotePortalConnectionStatus.reconnecting,
        RemotePortalConnectionStatus.inactive,
      ]) {
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: const [],
            nextCursor: 1,
            connectionStatus: status,
          ),
        );
        await pumpEventQueue();
      }
      gate.complete();
      await pumpEventQueue();

      expect(repository.restoreSessionCalls, 2, reason: 'restore + one read');
      expect(
        engine.session.portalConnectionStatus,
        RemotePortalConnectionStatus.inactive,
      );
    });

    test('the pairing form appears without a server teardown', () async {
      final repository = _StaleRestoreRepository()
        ..probeOutcome = RemoteSessionProbeOutcome.gone
        ..requestOverviewStateHandler = () async {
          throw const RemoteControlException(
            'Active remote control session not found',
          );
        };
      var listening = false;
      var repaintedAsEnded = false;
      late final RemoteClientEngine engine;
      engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        onChanged: () {
          if (listening &&
              engine.session.status == RemoteConnectionStatus.error) {
            repaintedAsEnded = true;
          }
        },
      );

      await engine.session.restoreIfIdle();
      listening = true;

      await engine.session.onAppForegrounded();

      expect(repository.disconnectCalls, 0);
      expect(repository.clearLocalSessionCalls, 1);
      expect(engine.session.status, RemoteConnectionStatus.error);
      expect(engine.session.connection, isNull);
      expect(repaintedAsEnded, isTrue);
    });

    test('a session-ended event forgets the session locally', () async {
      final repository = _StaleRestoreRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );

      await engine.session.restoreIfIdle();
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [RemoteSessionEndedEvent()],
          nextCursor: 1,
          connectionStatus: RemotePortalConnectionStatus.ended,
        ),
      );
      await pumpEventQueue();

      expect(engine.session.status, RemoteConnectionStatus.error);
      expect(engine.session.connection, isNull);
      expect(repository.clearLocalSessionCalls, 1);
      expect(repository.disconnectCalls, 0);
    });

    test(
      'a teardown racing the probe does not clobber a fresh session',
      () async {
        final repository = _StaleRestoreRepository()
          ..probeOutcome = RemoteSessionProbeOutcome.gone
          ..requestOverviewStateHandler = () async {
            throw const RemoteControlException(
              'Active remote control session not found',
            );
          };
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();
        final refreshing = engine.refresh();
        // A user-driven disconnect lands while the overview request is in
        // flight. `refresh()` captures its generation before that await, so the
        // stale probe result must not tear down the newer state.
        await engine.session.disconnect();
        await refreshing;

        expect(engine.session.status, RemoteConnectionStatus.disconnected);
        expect(engine.session.error, isNull);
      },
    );

    test(
      'a live session that degrades refreshes its last-seen heartbeat',
      () async {
        final connectedAt = DateTime.utc(2026, 9, 1, 10);
        final degradedAt = DateTime.utc(2026, 9, 4, 9);
        final repository = _StaleRestoreRepository()
          ..restoreSessionHandler = ((call) => RemoteConnection(
            deviceLabel: 'Desk',
            pairedAt: DateTime(2026, 8, 1),
            connectionStatus: call == 0
                ? RemotePortalConnectionStatus.active
                : RemotePortalConnectionStatus.inactive,
            lastSeenAt: call == 0 ? connectedAt : degradedAt,
          ));
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();
        expect(engine.session.connection?.lastSeenAt, connectedAt);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [],
            nextCursor: 1,
            connectionStatus: RemotePortalConnectionStatus.inactive,
          ),
        );
        await pumpEventQueue();

        expect(
          engine.session.portalConnectionStatus,
          RemotePortalConnectionStatus.inactive,
        );
        // Event batches carry the status but no heartbeat, so a session that
        // stayed live for hours would otherwise report its connect time.
        expect(engine.session.connection?.lastSeenAt, degradedAt);
      },
    );

    test(
      'an inactive session that revives still heals without re-pairing',
      () async {
        final repository = _StaleRestoreRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [],
            nextCursor: 1,
            connectionStatus: RemotePortalConnectionStatus.active,
          ),
        );
        await Future<void>.delayed(Duration.zero);
        await Future<void>.delayed(Duration.zero);

        await engine.session.onAppForegrounded();

        expect(repository.requestOverviewStateCalls, 0);
        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(
          engine.session.portalConnectionStatus,
          RemotePortalConnectionStatus.active,
        );
      },
    );

    test(
      'restoreIfIdle fetches the snapshot before starting event delivery',
      () async {
        final repository = _OrderRecordingRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();

        expect(repository.ops, ['snapshot', 'resume']);
      },
    );

    test(
      'failed cold snapshot waits to start events until a retry hydrates state',
      () async {
        final repository = _RestoreSnapshotRetryRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );

        await engine.session.restoreIfIdle();

        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(engine.store.snapshot, isNull);
        expect(repository.resumeEventsCalls, 0);

        await engine.refresh();

        expect(engine.store.workspaces.single.name, 'Recovered workspace');
        expect(repository.resumeEventsCalls, 1);
      },
    );

    test('foreground cannot bypass a still-failing cold snapshot', () async {
      final repository = _RestoreSnapshotFailingRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );

      await engine.session.restoreIfIdle();
      await engine.session.onAppForegrounded();

      expect(engine.session.status, RemoteConnectionStatus.connected);
      expect(engine.store.snapshot, isNull);
      expect(repository.resumeEventsCalls, 0);
    });
  });

  group('RemoteSessionController link state', () {
    // CAN-3557: after the app returns, the phone's own connection to the
    // server may take a while to come back. The chats on screen are a cache
    // until it does, and the user must be told instead of watching them sit
    // still.

    /// A restored, connected engine whose event delivery reports live only
    /// when the test says so.
    RemoteClientEngine connectedEngine(
      FakeAsync async,
      _RestorableRepository repository,
    ) {
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      unawaited(engine.session.restoreIfIdle());
      async.flushMicrotasks();
      repository.eventsLiveController.add(true);
      async.flushMicrotasks();
      expect(engine.session.linkState, RemoteLinkState.live);
      return engine;
    }

    test(
      'a resume that stays offline reports reconnecting, then a verdict',
      () {
        fakeAsync((async) {
          final repository = _RestorableRepository();
          final engine = connectedEngine(async, repository);

          engine.session.onAppBackgrounded();
          unawaited(engine.session.onAppForegrounded());
          async.elapse(const Duration(seconds: 1));
          // A resume that reconnects promptly must not flash a warning.
          expect(engine.session.linkState, RemoteLinkState.live);

          async.elapse(const Duration(seconds: 2));
          expect(engine.session.linkState, RemoteLinkState.reconnecting);

          async.elapse(const Duration(seconds: 30));
          expect(engine.session.linkState, RemoteLinkState.unreachable);

          repository.eventsLiveController.add(true);
          async.flushMicrotasks();
          expect(engine.session.linkState, RemoteLinkState.live);
          engine.dispose();
        });
      },
    );

    test('a resume that reconnects within the grace never warns', () {
      fakeAsync((async) {
        final repository = _RestorableRepository();
        final engine = connectedEngine(async, repository);
        final states = <RemoteLinkState>[];
        repository.onResumeEvents = () =>
            repository.eventsLiveController.add(true);

        engine.session.onAppBackgrounded();
        unawaited(engine.session.onAppForegrounded());
        for (var i = 0; i < 60; i++) {
          async.elapse(const Duration(seconds: 1));
          states.add(engine.session.linkState);
        }

        expect(states.toSet(), {RemoteLinkState.live});
        engine.dispose();
      });
    });

    test('an event batch proves the link is live', () {
      fakeAsync((async) {
        final repository = _RestorableRepository();
        final engine = connectedEngine(async, repository);

        engine.session.onAppBackgrounded();
        unawaited(engine.session.onAppForegrounded());
        async.elapse(const Duration(seconds: 5));
        expect(engine.session.linkState, RemoteLinkState.reconnecting);

        repository.eventsController.add(
          const RemotePortalEventBatch(events: [], nextCursor: 3),
        );
        async.flushMicrotasks();

        expect(engine.session.linkState, RemoteLinkState.live);
        engine.dispose();
      });
    });

    test('a dropped connection warns after the grace', () {
      fakeAsync((async) {
        final repository = _RestorableRepository();
        final engine = connectedEngine(async, repository);

        repository.eventsLiveController.add(false);
        async.elapse(const Duration(seconds: 3));

        expect(engine.session.linkState, RemoteLinkState.reconnecting);
        engine.dispose();
      });
    });

    test('backgrounding clears the warning', () {
      fakeAsync((async) {
        final repository = _RestorableRepository();
        final engine = connectedEngine(async, repository);
        repository.eventsLiveController.add(false);
        async.elapse(const Duration(minutes: 1));
        expect(engine.session.linkState, RemoteLinkState.unreachable);

        engine.session.onAppBackgrounded();
        async.elapse(const Duration(minutes: 1));

        expect(engine.session.linkState, RemoteLinkState.live);
        engine.dispose();
      });
    });
  });

  group('CAN-3643 pairing generation', () {
    test('same-pairing metadata reads keep the generation', () async {
      final repository = _StaleRestoreRepository()
        ..restoreSessionHandler = ((call) => RemoteConnection(
          deviceLabel: 'Desk',
          pairedAt: DateTime(2026, 8, 1),
          sessionId: 'session-1',
          connectionStatus: RemotePortalConnectionStatus.active,
          lastSeenAt: DateTime.utc(2026, 10, 5, 12, 0, call),
        ));
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.restoreIfIdle();
      final generation = engine.session.sessionGeneration;
      final connection = engine.session.connection;

      await engine.session.refreshConnectionMetadata();
      engine.session.onAppBackgrounded();
      await engine.session.onAppForegrounded();
      expect(
        await engine.session.isRemoteSessionGone(engine.session.loadGeneration),
        isFalse,
      );

      expect(repository.restoreSessionCalls, greaterThanOrEqualTo(4));
      expect(engine.session.connection, isNot(same(connection)));
      expect(engine.session.connection?.sessionId, 'session-1');
      expect(engine.session.isConnected, isTrue);
      expect(engine.session.sessionGeneration, generation);
    });

    test('a new pairing advances the generation even when it reuses the '
        'session id', () async {
      final repository = FakeRemoteControlRepository()
        ..connectedSessionId = 'session-1';
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      final generation = engine.session.sessionGeneration;

      await engine.session.connect('654321');

      expect(engine.session.connection?.sessionId, 'session-1');
      expect(engine.session.sessionGeneration, greaterThan(generation));
    });

    test('disconnect advances the generation before the server teardown '
        'completes', () async {
      final repository = _GatedDisconnectRepository();
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      final generation = engine.session.sessionGeneration;

      final disconnect = engine.session.disconnect();
      await pumpEventQueue();
      expect(repository.disconnectCalls, 1);
      expect(engine.session.sessionGeneration, greaterThan(generation));

      repository.teardown.complete();
      await disconnect;
      expect(engine.session.status, RemoteConnectionStatus.disconnected);
      expect(engine.session.sessionGeneration, greaterThan(generation));
    });

    // CAN-4426: the end request can stall on a dead pooled socket. Leaving
    // the pairing must not wait for it.
    test('disconnect resets local state before the server teardown '
        'completes', () async {
      final repository = _GatedDisconnectRepository();
      var notified = 0;
      final engine = buildRemoteEngine(
        repository: repository,
        onChanged: () => notified += 1,
      );
      await engine.session.connect('123456');
      notified = 0;

      final disconnect = engine.session.disconnect();

      expect(engine.session.status, RemoteConnectionStatus.disconnected);
      expect(engine.session.connection, isNull);
      expect(notified, greaterThan(0));
      expect(engine.store.workspaces, isEmpty);
      repository.teardown.complete();
      await disconnect;
      expect(engine.session.status, RemoteConnectionStatus.disconnected);
    });

    test('a late teardown does not clear a newer pairing', () async {
      final repository = _GatedDisconnectRepository();
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      final disconnect = engine.session.disconnect();
      await pumpEventQueue();

      await engine.session.connect('654321');
      final generation = engine.session.sessionGeneration;
      repository.teardown.complete();
      await disconnect;

      expect(engine.session.status, RemoteConnectionStatus.connected);
      expect(engine.session.connection, isNotNull);
      expect(engine.session.sessionGeneration, generation);
    });

    test('a disconnect during a restore leaves no restore pending', () async {
      final repository = _StaleRestoreRepository()
        ..restoreSessionGate = Completer<void>();
      final engine = buildRemoteEngine(repository: repository);
      final restore = engine.session.restoreIfIdle();
      await pumpEventQueue();
      expect(engine.session.isRestoring, isTrue);

      await engine.session.disconnect();
      repository.restoreSessionGate!.complete();
      await restore;

      expect(engine.session.isRestoring, isFalse);
      expect(engine.session.status, RemoteConnectionStatus.disconnected);
      expect(engine.session.connection, isNull);
    });

    test('a session end advances the generation', () async {
      final engine = buildRemoteEngine(
        repository: FakeRemoteControlRepository(),
      );
      await engine.session.connect('123456');
      final generation = engine.session.sessionGeneration;

      engine.session.handleRemoteSessionEnded();

      expect(engine.session.connection, isNull);
      expect(engine.session.sessionGeneration, greaterThan(generation));
    });
  });

  group('a resume after a long background', () {
    const target = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );
    final start = DateTime(2026, 10, 23, 12);

    RemotePortalEventBatch chatRow(String messageId, int cursor) =>
        RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: RemoteChatMessage(
                messageId: messageId,
                chatId: 'chat-1',
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                scope: RemoteChatScope.worktree,
                text: 'done',
              ),
            ),
          ],
          nextCursor: cursor,
        );

    Future<(RemoteClientEngine, _ResumeRecordingRepository)> connected(
      DateTime Function() clock,
    ) async {
      final repository = _ResumeRecordingRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        clock: clock,
      );
      await engine.session.connect('123456');
      repository.eventsController.add(chatRow('m-1', 1));
      await pumpEventQueue();
      expect(engine.transcripts.messagesFor(target), isNotEmpty);
      repository.ops.clear();
      return (engine, repository);
    }

    test('reloads the session instead of replaying the backlog', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);
      final generation = engine.session.sessionGeneration;

      engine.session.onAppBackgrounded();
      now = now.add(kRemoteFreshResumeAfter);
      await engine.session.onAppForegrounded();

      expect(repository.ops, ['pause', 'discard', 'snapshot', 'resume']);
      // Rows the skipped events would have updated reload on demand, the way
      // they do after a relaunch.
      expect(engine.transcripts.messagesFor(target), isEmpty);
      // Same pairing: open views keep their session.
      expect(engine.session.sessionGeneration, generation);
      expect(engine.session.status, RemoteConnectionStatus.connected);
      engine.dispose();
    });

    test(
      'fresh resume reconciles visible PR actions after a raced read',
      () async {
        var now = start;
        final (engine, repository) = await connected(() => now);
        addTearDown(engine.dispose);
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'feature',
        );
        repository
          ..supportsPrActions = true
          ..supportsPrStatusPush = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [worktree],
            standaloneChats: [],
          );
        await engine.refresh();
        final reads = <Completer<Map<String, dynamic>>>[];
        repository.prActionRunner =
            (action, {repoId, identity, confirmUnresolvedComments = false}) {
              final read = Completer<Map<String, dynamic>>();
              reads.add(read);
              return read.future;
            };
        final poll = engine.prState.pollPrState(worktree)..setVisible(true);
        await pumpEventQueue();
        reads.single.complete({'repos': [], 'busy': false});
        await pumpEventQueue();
        poll.setVisible(false);
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        final resume = engine.session.onAppForegrounded();
        poll.setVisible(true);
        await resume;
        expect(reads, hasLength(2));
        reads.last.complete({'repos': [], 'busy': false});
        await pumpEventQueue();
        expect(reads, hasLength(3));
        reads.last.complete({'repos': [], 'busy': false});
        await pumpEventQueue();
        expect(
          engine.prState.cachedPrReposFor(
            worktree.workspaceLocalId,
            worktree.localId,
          ),
          isNotNull,
        );
      },
    );

    test(
      'fresh resume settles waits without claiming command failure',
      () async {
        var now = start;
        final (engine, _) = await connected(() => now);
        addTearDown(engine.dispose);
        String? failure;
        engine.commands.register(
          'pr-create',
          onFailed: (error) => failure = error,
        );
        var settled = false;
        final wait = engine.commands
            .waitForResult('pr-create', timeout: const Duration(minutes: 10))
            .then<void>(
              (_) => fail('Skipped events cannot prove success'),
              onError: (Object error) {
                settled = true;
              },
            );
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        await engine.session.onAppForegrounded();
        await pumpEventQueue();
        expect(settled, isTrue);
        expect(failure, isNull);
        expect(engine.commands.hasFailed('pr-create'), isFalse);
        await wait;
      },
    );

    test(
      'fresh resume keeps an accepted chat send uncertain until its echo',
      () async {
        var now = start;
        final (engine, repository) = await connected(() => now);
        addTearDown(engine.dispose);
        await engine.sends.sendChatMessage(target, 'hello');
        final id =
            repository.sendChatMessageCalls.single.options!.userMessageId!;
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);

        await engine.session.onAppForegrounded();

        expect(engine.messagesFor(target).single.messageId, id);
        expect(
          engine.messagesFor(target).single.delivery,
          ChatDelivery.uncertain,
        );
        expect(engine.commands.hasFailed('fake-cmd'), isFalse);
        expect(repository.sendChatMessageCalls, hasLength(1));
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: id,
                  chatId: 'chat-1',
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  scope: RemoteChatScope.worktree,
                  text: 'hello',
                ),
              ),
            ],
            nextCursor: 2,
          ),
        );
        await pumpEventQueue();
        expect(engine.unsent.byId(id), isNull);
        expect(
          engine.messagesFor(target).single.delivery,
          isNot(ChatDelivery.uncertain),
        );
        expect(repository.sendChatMessageCalls, hasLength(1));
      },
    );

    test(
      'fresh resume releases a queued pipeline start without replaying it',
      () async {
        var now = start;
        final (engine, repository) = await connected(() => now);
        addTearDown(engine.dispose);
        repository.pipelineDispatchError =
            const RemotePipelineDispatchQueuedException('queued-start');
        await engine.pipelineDispatch.dispatch(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          pipelineId: 'deploy',
          inputs: const {},
        );
        expect(
          engine.pipelineDispatch.dispatchState(
            worktreeLocalId: 'wt-1',
            pipelineId: 'deploy',
          ),
          isA<RemotePipelineDispatchSubmitting>(),
        );
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        await engine.session.onAppForegrounded();
        expect(
          engine.pipelineDispatch.dispatchState(
            worktreeLocalId: 'wt-1',
            pipelineId: 'deploy',
          ),
          isA<RemotePipelineDispatchFailed>().having(
            (state) => state.message,
            'unconfirmed outcome',
            kRemotePipelineDispatchUnconfirmed,
          ),
        );
        expect(repository.pipelineDispatches, hasLength(1));
        engine.pipelineDispatch.clearDispatch(
          worktreeLocalId: 'wt-1',
          pipelineId: 'deploy',
        );
        expect(
          engine.pipelineDispatch.dispatchState(
            worktreeLocalId: 'wt-1',
            pipelineId: 'deploy',
          ),
          isNull,
        );
        // A late outcome for the cleared attempt cannot settle the next start.
        repository.pipelineDispatchError = null;
        await engine.pipelineDispatch.dispatch(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          pipelineId: 'deploy',
          inputs: const {},
        );
        engine.commands.handleCompleted('queued-start', {
          'executionId': 'old-run',
        }, projectionSequence: 0);
        expect(
          engine.pipelineDispatch.dispatchState(
            worktreeLocalId: 'wt-1',
            pipelineId: 'deploy',
          ),
          isA<RemotePipelineDispatchSubmitting>(),
        );
      },
    );

    for (final dismiss in [false, true]) {
      test(
        'fresh resume restores an unanswered question, dismiss=$dismiss',
        () async {
          var now = start;
          final (engine, repository) = await connected(() => now);
          addTearDown(engine.dispose);
          repository.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [],
            'worktrees': [],
            'standaloneChats': [],
            'chatMessages': [],
            'chatSummaries': [
              {
                'chatId': 'chat-1',
                'scope': 'worktree',
                'title': 'Chat',
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'pendingQuestions': [
                  {'requestId': 'question', 'answered': false, 'questions': []},
                ],
              },
            ],
          });
          await engine.refresh();
          const worktree = RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          );
          expect(engine.questions.worktreeNeedsAnswer(worktree), isTrue);
          if (dismiss) {
            await engine.questions.dismissQuestion(
              target,
              requestId: 'question',
            );
          } else {
            await engine.questions.answerQuestion(
              target,
              requestId: 'question',
              answers: const [],
            );
          }
          expect(engine.questions.pendingQuestionsFor(target), isEmpty);
          expect(engine.questions.worktreeNeedsAnswer(worktree), isFalse);
          engine.session.onAppBackgrounded();
          now = now.add(kRemoteFreshResumeAfter);
          // The desktop rejected the action in the skipped window; the fresh
          // snapshot is the authority that still lists the unanswered question.
          await engine.session.onAppForegrounded();
          expect(
            engine.questions.pendingQuestionsFor(target).single.requestId,
            'question',
          );
          expect(engine.questions.worktreeNeedsAnswer(worktree), isTrue);
        },
      );
    }

    test('fresh resume preserves clone polling and late completion', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);
      addTearDown(engine.dispose);
      await engine.projectClones.addProject('https://github.com/org/repo.git');
      engine.session.onAppBackgrounded();
      now = now.add(kRemoteFreshResumeAfter);

      await engine.session.onAppForegrounded();
      await pumpEventQueue();

      expect(
        engine.projectClones.clones.single.phase,
        RemoteProjectClonePhase.cloning,
      );
      expect(repository.commandStatusReads, contains('clone-1'));
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteCommandCompletedEvent(
              commandId: 'clone-1',
              result: {'workspaceId': 'new-project'},
            ),
          ],
          nextCursor: 2,
        ),
      );
      await pumpEventQueue();
      expect(
        engine.projectClones.clones.single.phase,
        RemoteProjectClonePhase.awaitingProject,
      );
      expect(repository.createProjectCalls, hasLength(1));
    });

    for (final delivery in [ChatDelivery.notSent, ChatDelivery.uncertain]) {
      test(
        'fresh resume preserves $delivery Advisor text through reseeding',
        () async {
          var now = start;
          final (engine, repository) = await connected(() => now);
          addTearDown(engine.dispose);
          repository.supportsAppAdvisor = true;
          engine.appAdvisor.applySnapshot(
            RemoteAppAdvisorSnapshotEvent(
              chats: [
                RemoteAppAdvisorChat.fromJson({
                  'chatId': 'advisor-chat',
                  'title': 'Advisor',
                }),
              ],
              chatMessages: const [],
            ),
          );
          repository.appAdvisorError = delivery == ChatDelivery.notSent
              ? const RemoteControlException('Rejected')
              : const RemoteChatSendOutcomeUnknownException('No confirmation');
          try {
            await engine.appAdvisor.send(
              chatId: 'advisor-chat',
              text: 'Keep my draft',
            );
          } on RemoteControlException {
            /* The transcript owns recovery. */
          }
          expect(
            engine.appAdvisor.messagesFor('advisor-chat').single.delivery,
            delivery,
          );
          engine.session.onAppBackgrounded();
          now = now.add(kRemoteFreshResumeAfter);
          await engine.session.onAppForegrounded();
          engine.appAdvisor.applySnapshot(
            const RemoteAppAdvisorSnapshotEvent(chats: [], chatMessages: []),
          );
          final message = engine.appAdvisor.messagesFor('advisor-chat').single;
          expect(message.text, 'Keep my draft');
          expect(message.delivery, delivery);
        },
      );
    }

    test(
      'fresh resume reissues pending pipeline detail and log reads',
      () async {
        var now = start;
        final (engine, repository) = await connected(() => now);
        addTearDown(engine.dispose);
        await engine.pipelineRuns.requestPipelineRunDetail(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'run-1',
        );
        await engine.pipelineRuns.requestPipelineStepLog(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'run-2',
          jobId: 'job',
          stepId: 'step',
        );
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        await engine.session.onAppForegrounded();
        expect(repository.pipelineExecutionRequests, hasLength(2));
        expect(repository.pipelineStepLogRequests, hasLength(2));
        expect(engine.pipelineRuns.isPipelineRunPending('run-1'), isTrue);
        expect(engine.pipelineRuns.isPipelineRunPending('run-2'), isTrue);
      },
    );

    test(
      'fresh resume retains a new Advisor send until a later echo binds it',
      () async {
        var now = start;
        final (engine, repository) = await connected(() => now);
        addTearDown(engine.dispose);
        repository.supportsAppAdvisor = true;
        var settled = false;
        final send = engine.appAdvisor
            .send(text: 'New chat draft')
            .then<void>(
              (_) => fail('The chat has not been confirmed'),
              onError: (Object error) {
                settled = true;
              },
            );
        await pumpEventQueue();
        final messageId = engine.appAdvisor.startingMessage!.messageId;
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        await engine.session.onAppForegrounded();
        await send;
        expect(settled, isTrue);
        expect(engine.appAdvisor.messagesFor('').single.text, 'New chat draft');
        expect(
          engine.appAdvisor.messagesFor('').single.delivery,
          ChatDelivery.uncertain,
        );
        engine.appAdvisor.applySnapshot(
          RemoteAppAdvisorSnapshotEvent(
            chats: [
              RemoteAppAdvisorChat.fromJson({
                'chatId': 'named',
                'title': 'Advisor',
              }),
            ],
            chatMessages: [
              RemoteChatMessage(
                messageId: messageId,
                chatId: 'named',
                role: ChatRole.user,
                status: ChatMessageStatus.complete,
                text: 'New chat draft',
              ),
            ],
          ),
        );
        expect(engine.appAdvisor.messagesFor(''), isEmpty);
        expect(engine.appAdvisor.messagesFor('named').single.delivery, isNull);
      },
    );

    test(
      'a late pipeline read failure cannot settle its fresh replacement',
      () async {
        var now = start;
        final (engine, repository) = await connected(() => now);
        addTearDown(engine.dispose);
        final gate = repository.pipelineReadGate = Completer<String>();
        final first = engine.pipelineRuns.requestPipelineRunDetail(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          executionId: 'run-1',
        );
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        await engine.session.onAppForegrounded();
        gate.completeError(const RemoteControlException('Old read failed'));
        await first;
        expect(engine.pipelineRuns.isPipelineRunPending('run-1'), isTrue);
        expect(engine.pipelineRuns.pipelineRunError('run-1'), isNull);
      },
    );

    for (final stop in ['background', 'disconnect', 'dispose']) {
      test('fresh recovery cancels its retry on $stop', () {
        fakeAsync((async) {
          var now = start;
          final repository = _ResumeRecordingRepository();
          final engine = buildRemoteEngine(
            repository: repository,
            clock: () => now,
          );
          unawaited(engine.session.connect('123456'));
          async.flushMicrotasks();
          engine.session.onAppBackgrounded();
          now = now.add(kRemoteFreshResumeAfter);
          repository.snapshotFailures = 100;
          unawaited(engine.session.onAppForegrounded());
          async.flushMicrotasks();
          switch (stop) {
            case 'background':
              engine.session.onAppBackgrounded();
            case 'disconnect':
              unawaited(engine.session.disconnect());
            case 'dispose':
              engine.dispose();
          }
          async.flushMicrotasks();
          final reads = repository.ops.where((op) => op == 'snapshot').length;
          async.elapse(const Duration(minutes: 1));
          expect(
            repository.ops.where((op) => op == 'snapshot'),
            hasLength(reads),
          );
          if (stop != 'dispose') engine.dispose();
        });
      });
    }

    test('fresh resume applies refreshed connection metadata', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);
      addTearDown(engine.dispose);
      repository.sessionMetadataBuilder = () => RemoteConnection(
        deviceLabel: 'Updated desktop',
        pairedAt: start,
        spaceNotificationSettingsEnabled: true,
      );
      engine.session.onAppBackgrounded();
      now = now.add(kRemoteFreshResumeAfter);
      await engine.session.onAppForegrounded();
      expect(engine.session.connection?.deviceLabel, 'Updated desktop');
      expect(
        engine.session.connection?.spaceNotificationSettingsEnabled,
        isTrue,
      );
    });

    test('failed fresh reads report reconnecting and unreachable', () {
      fakeAsync((async) {
        var now = start;
        final repository = _ResumeRecordingRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          clock: () => now,
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        repository.snapshotFailures = 100;
        engine.session.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        unawaited(engine.session.onAppForegrounded());
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 3));
        expect(engine.session.linkState, RemoteLinkState.reconnecting);
        async.elapse(const Duration(seconds: 30));
        expect(engine.session.linkState, RemoteLinkState.unreachable);
        engine.dispose();
      });
    });

    test(
      'fresh retry bypasses pending chat hydration and stops after success',
      () {
        fakeAsync((async) {
          var now = start;
          final repository = _ResumeRecordingRepository();
          final engine = buildRemoteEngine(
            repository: repository,
            clock: () => now,
          );
          unawaited(engine.session.connect('123456'));
          async.flushMicrotasks();
          engine.hydration.ensureChatTranscript(target);
          async.flushMicrotasks();
          expect(engine.hydration.isChatHydrationPending, isTrue);
          engine.session.onAppBackgrounded();
          now = now.add(kRemoteFreshResumeAfter);
          repository.snapshotFailures = 1;
          unawaited(engine.session.onAppForegrounded());
          async.flushMicrotasks();
          final resumes = repository.resumeEventsCalls;
          async.elapse(const Duration(seconds: 5));
          expect(repository.resumeEventsCalls, resumes + 1);
          final reads = repository.snapshotFetches;
          async.elapse(const Duration(seconds: 40));
          expect(repository.snapshotFetches, reads);
          engine.dispose();
        });
      },
    );

    test('a shorter background still replays from the cursor', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);

      engine.session.onAppBackgrounded();
      now = now.add(kRemoteFreshResumeAfter - const Duration(seconds: 1));
      await engine.session.onAppForegrounded();

      expect(repository.ops, isNot(contains('discard')));
      expect(repository.ops.indexOf('resume'), 1);
      expect(engine.transcripts.messagesFor(target), isNotEmpty);
      engine.dispose();
    });

    test('keeps the old state on screen until the reload lands', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);
      final gate = repository.snapshotGate = Completer<void>();

      engine.session.onAppBackgrounded();
      now = now.add(const Duration(minutes: 5));
      final resuming = engine.session.onAppForegrounded();
      await pumpEventQueue();

      expect(engine.transcripts.messagesFor(target), isNotEmpty);
      expect(repository.ops, ['pause', 'discard', 'snapshot']);

      gate.complete();
      await resuming;
      expect(engine.transcripts.messagesFor(target), isEmpty);
      expect(repository.ops.last, 'resume');
      engine.dispose();
    });

    test('a failed reload keeps delivery paused until a read lands', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);
      repository.snapshotFailures = 1;

      engine.session.onAppBackgrounded();
      now = now.add(const Duration(minutes: 5));
      await engine.session.onAppForegrounded();

      expect(repository.ops, ['pause', 'discard', 'snapshot']);
      expect(engine.transcripts.messagesFor(target), isNotEmpty);

      await engine.refresh();

      expect(repository.ops.sublist(3), ['snapshot', 'resume']);
      expect(engine.transcripts.messagesFor(target), isEmpty);
      engine.dispose();
    });

    test('returning again before the reload lands never replays', () async {
      var now = start;
      final (engine, repository) = await connected(() => now);
      final gate = repository.snapshotGate = Completer<void>();

      engine.session.onAppBackgrounded();
      now = now.add(const Duration(minutes: 5));
      final first = engine.session.onAppForegrounded();
      await pumpEventQueue();
      engine.session.onAppBackgrounded();
      now = now.add(const Duration(seconds: 1));
      final second = engine.session.onAppForegrounded();
      await pumpEventQueue();

      // Resuming here would replay the session from the discarded cursor.
      expect(repository.ops, isNot(contains('resume')));

      repository.snapshotGate = null;
      gate.complete();
      await first;
      await second;
      expect(repository.ops.where((op) => op == 'resume'), hasLength(1));
      expect(engine.transcripts.messagesFor(target), isEmpty);
      engine.dispose();
    });
  });
}

/// Records the event-delivery and snapshot calls a resume makes, in order.
/// [snapshotGate] holds snapshot reads; [snapshotFailures] fails the next
/// reads.
final class _ResumeRecordingRepository extends FakeRemoteControlRepository {
  final List<String> ops = [];
  Completer<void>? snapshotGate;
  int snapshotFailures = 0;
  Completer<String>? pipelineReadGate;

  @override
  Future<String> requestPipelineExecution({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) {
    final response = super.requestPipelineExecution(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
    );
    final gate = pipelineReadGate;
    pipelineReadGate = null;
    return gate?.future ?? response;
  }

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    ops.add('snapshot');
    await snapshotGate?.future;
    if (snapshotFailures > 0) {
      snapshotFailures -= 1;
      throw const RemoteControlException('Could not reach the server.');
    }
    return super.fetchSnapshot();
  }

  @override
  void resumeEvents() {
    ops.add('resume');
    super.resumeEvents();
  }

  @override
  void pauseEvents() {
    ops.add('pause');
    super.pauseEvents();
  }

  @override
  void discardEventCursor() {
    ops.add('discard');
    super.discardEventCursor();
  }
}

/// Restores one live session; [onResumeEvents] lets a test answer delivery.
final class _RestorableRepository extends FakeRemoteControlRepository {
  _RestorableRepository() {
    autoLive = false;
  }

  void Function()? onResumeEvents;

  @override
  Future<RemoteConnection?> restoreSession() async =>
      RemoteConnection(deviceLabel: 'Desk', pairedAt: DateTime(2026));

  @override
  void resumeEvents() {
    super.resumeEvents();
    onResumeEvents?.call();
  }
}

final class _SnapshotRetryRepository extends FakeRemoteControlRepository {
  var failNextSnapshot = true;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    snapshotFetches += 1;
    if (failNextSnapshot) {
      failNextSnapshot = false;
      throw const RemoteControlException('snapshot unavailable');
    }
    return const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-recovered',
          name: 'Recovered workspace',
          rootPath: '~/code/recovered',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [],
      standaloneChats: [],
    );
  }
}

final class _RestoreSnapshotRetryRepository extends _SnapshotRetryRepository {
  @override
  Future<RemoteConnection?> restoreSession() async => RemoteConnection(
    deviceLabel: 'Restored Desktop',
    pairedAt: DateTime(2026),
  );
}

final class _RestoreSnapshotFailingRepository
    extends FakeRemoteControlRepository {
  @override
  Future<RemoteConnection?> restoreSession() async => RemoteConnection(
    deviceLabel: 'Restored Desktop',
    pairedAt: DateTime(2026),
  );

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() =>
      throw const RemoteControlException('snapshot unavailable');
}

/// Answers the first [unreachableProbes] session probes as unreachable, then
/// reports a live session.
final class _UnreachableThenRestorableRepository
    extends FakeRemoteControlRepository {
  _UnreachableThenRestorableRepository({required this.unreachableProbes});

  final int unreachableProbes;
  int probeCalls = 0;

  @override
  Future<RemoteSessionProbe> probeSession() async {
    probeCalls += 1;
    if (probeCalls <= unreachableProbes) {
      return (outcome: RemoteSessionProbeOutcome.unknown, connection: null);
    }
    return (
      outcome: RemoteSessionProbeOutcome.renderable,
      connection: RemoteConnection(
        deviceLabel: 'Restored Desktop',
        pairedAt: DateTime(2026),
      ),
    );
  }
}

final class _CountingRestoreRepository extends FakeRemoteControlRepository {
  int restoreCalls = 0;

  @override
  Future<RemoteConnection?> restoreSession() async {
    restoreCalls += 1;
    return null;
  }
}

final class _CountingFailingConnectRepository
    extends FakeRemoteControlRepository {
  int restoreCalls = 0;

  @override
  Future<RemoteConnection> connect(String pairingCode) =>
      throw const RemoteControlException('nope');

  @override
  Future<RemoteConnection?> restoreSession() async {
    restoreCalls += 1;
    return null;
  }
}

final class _StaleRestoreRepository extends FakeRemoteControlRepository {
  /// Sessions handed back by successive [restoreSession] calls, indexed from
  /// zero. Call 0 seeds the restore; later calls model the heartbeat refresh
  /// the view model performs when a live connection degrades.
  RemoteConnection? Function(int call)? restoreSessionHandler;
  int restoreSessionCalls = 0;

  /// When set, [probeSession] reports this instead of deriving the outcome
  /// from [restoreSession] — the two are deliberately different reads, and the
  /// orphan teardown keys off this one.
  RemoteSessionProbeOutcome? probeOutcome;

  /// When set, [restoreSession] blocks on this until a test completes it, so
  /// a second call can be attempted while the first is still in flight.
  Completer<void>? restoreSessionGate;

  @override
  Future<RemoteConnection?> restoreSession() async {
    final call = restoreSessionCalls++;
    final gate = restoreSessionGate;
    if (gate != null) await gate.future;
    final handler = restoreSessionHandler;
    if (handler != null) return handler(call);
    return RemoteConnection(
      deviceLabel: 'Desk',
      pairedAt: DateTime(2026, 8, 1),
      connectionStatus: RemotePortalConnectionStatus.inactive,
    );
  }

  @override
  Future<RemoteSessionProbe> probeSession() async {
    final outcome = probeOutcome;
    if (outcome == null || restoreSessionCalls == 0) {
      return super.probeSession();
    }
    return outcome == RemoteSessionProbeOutcome.renderable
        ? super.probeSession()
        : (outcome: outcome, connection: null);
  }
}

final class _OrderRecordingRepository extends FakeRemoteControlRepository {
  final List<String> ops = [];

  @override
  Future<RemoteConnection?> restoreSession() async => RemoteConnection(
    deviceLabel: 'Restored Desktop',
    pairedAt: DateTime(2026),
  );

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() {
    ops.add('snapshot');
    return super.fetchSnapshot();
  }

  @override
  void resumeEvents() {
    ops.add('resume');
    super.resumeEvents();
  }
}

final class _GatedDisconnectRepository extends FakeRemoteControlRepository {
  final teardown = Completer<void>();

  @override
  Future<void> disconnect() async {
    await super.disconnect();
    await teardown.future;
  }
}
