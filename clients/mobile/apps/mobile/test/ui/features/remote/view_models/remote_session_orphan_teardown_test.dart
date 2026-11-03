// CAN-3624: a paired phone never ends a Remote Control session on its own.
//
// Runs the assembled engine over the production HttpRemoteControlRepository
// against a synthetic Portal server. Desktop A is paired and then sleeps past
// the stale sweep, which leaves its row revivable `inactive`. The account's
// current-session read is not a read of A: while another desktop's row is
// current it returns that row, so it cannot prove A ended and must not
// retarget the pairing to it.
import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pairing_failure.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';

import '../../../../support/remote_engine_harness.dart';
import '../../../../support/remote_session_fake_server.dart';

const _base = portalBrowserBasePath;
const _disconnectedCopy =
    'The desktop is no longer connected. Connect it again to continue.';

void main() {
  late FakePortalSessionServer server;
  late HttpRemoteControlRepository repository;
  late RemoteClientEngine engine;
  late DateTime now;

  setUp(() {
    server = FakePortalSessionServer();
    repository = server.repository();
    now = DateTime.utc(2026, 10, 3, 22);
    engine = buildRemoteEngine(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      clock: () => now,
    );
  });

  tearDown(() {
    engine.dispose();
    server.close();
  });

  /// Pairs with Desktop A, then lets it sleep past the stale sweep. A's row
  /// carries its own cursor and permission gates, distinct from any other
  /// desktop's, so a retarget is observable.
  Future<void> pairWithSleepingDesktopA() async {
    server.addSession(
      id: 'sess-a',
      clientName: 'Desktop A',
      eventCursor: 40,
      capabilities: const {'foreground_worktree_chat': true},
      destructiveActionsEnabled: true,
    );
    await engine.session.restoreIfIdle();
    await pumpEventQueue();
    expect(engine.session.status, RemoteConnectionStatus.connected);
    expect(engine.session.connection?.deviceLabel, 'Desktop A');
    expect(
      server.requests,
      contains('GET $_base/sessions/sess-a/events?after=40&timeoutMs=25000'),
      reason: 'the live long-poll must be held open for A',
    );

    server.sleep('sess-a');
    await pumpEventQueue();
    expect(
      engine.session.portalConnectionStatus,
      RemotePortalConnectionStatus.inactive,
    );
  }

  /// The user returns to the app, then pulls to refresh.
  Future<void> foregroundThenPullToRefresh() async {
    engine.session.onAppBackgrounded();
    await engine.session.onAppForegrounded();
    await pumpEventQueue();
    await engine.refresh();
    await pumpEventQueue();
  }

  void expectStillPairedToSleepingA() {
    expect(engine.session.status, RemoteConnectionStatus.connected);
    expect(engine.session.connection?.deviceLabel, 'Desktop A');
    expect(engine.session.isDegraded, isTrue);
    expect(engine.store.workspaces.single.name, 'Desktop A workspace');
    expect(repository.canArchiveWorktrees, isTrue);
    expect(repository.supportsForegroundChat, isTrue);
  }

  /// The rejected command and the session read that followed it both
  /// happened, so the scenario really reached the teardown decision.
  void expectTeardownDecisionReached() {
    final command = server.requests.lastIndexOf(
      'POST $_base/sessions/sess-a/commands',
    );
    expect(command, isNonNegative, reason: 'the overview command never ran');
    expect(
      server.requests.sublist(command),
      contains('GET $_base/session'),
      reason: 'the rejection did not start a session read',
    );
  }

  group('AC1: another desktop is waiting for its pairing code', () {
    test('keeps the pairing with A and never ends it', () async {
      await pairWithSleepingDesktopA();
      server.addSession(
        id: 'sess-b',
        clientName: 'Desktop B',
        status: 'pending_auth',
        connectionStatus: 'pending',
      );

      await foregroundThenPullToRefresh();

      expectTeardownDecisionReached();
      expect(server.endRequests, isEmpty);
      expect(server.requestsFor('sess-b'), isEmpty);
      expectStillPairedToSleepingA();
    });
  });

  group('AC2: another desktop is active', () {
    test('does not retarget the pairing to it', () async {
      await pairWithSleepingDesktopA();
      server.addSession(
        id: 'sess-b',
        clientName: 'Desktop B',
        eventCursor: 900,
        capabilities: const {'foreground_worktree_chat': false},
      );

      await foregroundThenPullToRefresh();

      expectTeardownDecisionReached();
      expect(server.endRequests, isEmpty);
      expect(server.requestsFor('sess-b'), isEmpty);
      expect(
        server.requests,
        contains('GET $_base/sessions/sess-a/events?after=40&timeoutMs=25000'),
      );
      expectStillPairedToSleepingA();
    });
  });

  group('AC3: no other desktop', () {
    test('keeps A while inactive and heals when it wakes', () async {
      await pairWithSleepingDesktopA();

      await foregroundThenPullToRefresh();

      expectTeardownDecisionReached();
      expect(server.endRequests, isEmpty);
      expectStillPairedToSleepingA();

      // A wakes. The next foreground subscribes again, and the desktop's
      // next heartbeat answers the held long-poll.
      server.heartbeat('sess-a');
      engine.session.onAppBackgrounded();
      await engine.session.onAppForegrounded();
      await pumpEventQueue();
      server.heartbeat('sess-a');
      await pumpEventQueue();

      expect(engine.session.status, RemoteConnectionStatus.connected);
      expect(
        engine.session.portalConnectionStatus,
        RemotePortalConnectionStatus.active,
      );
      expect(server.endRequests, isEmpty);
    });
  });

  /// Answers the session read with [session] verbatim, as a 200.
  void answerSessionRead(Map<String, dynamic>? session) =>
      server.currentSessionOverride = () =>
          (status: 200, body: {'session': session});

  /// A's own row in a state the shell may not render.
  final ownEndedReads = <(String, Map<String, dynamic>? Function())>[
    ('no session', () => null),
    (
      'A as ended',
      () => {...server.row('sess-a').toJson(), 'connectionStatus': 'ended'},
    ),
    (
      'A as pending_auth',
      () => {
        ...server.row('sess-a').toJson(),
        'status': 'pending_auth',
        'connectionStatus': 'pending',
      },
    ),
  ];

  group('AC4: the server reports this pairing ended', () {
    for (final (name, ownRead) in ownEndedReads) {
      void setUpEnded() => answerSessionRead(ownRead());

      test('$name: shows the pairing form without ending it', () async {
        await pairWithSleepingDesktopA();
        setUpEnded();

        engine.session.onAppBackgrounded();
        await engine.session.onAppForegrounded();
        await pumpEventQueue();

        expectTeardownDecisionReached();
        expect(engine.session.status, RemoteConnectionStatus.error);
        expect(engine.session.error.toString(), contains(_disconnectedCopy));
        expect(engine.session.connection, isNull);
        expect(engine.store.snapshot, isNull);
        expect(server.endRequests, isEmpty);
        expect(repository.canArchiveWorktrees, isFalse);
        expect(repository.supportsForegroundChat, isFalse);
      });
    }
  });

  group('AC5: the user disconnects', () {
    test('ends A on the server exactly once', () async {
      await pairWithSleepingDesktopA();

      await engine.session.disconnect();
      await engine.session.disconnect();

      expect(server.endRequests, ['POST $_base/sessions/sess-a/end']);
      expect(engine.session.status, RemoteConnectionStatus.disconnected);
      expect(engine.session.connection, isNull);
    });
  });

  group('AC6: the session read cannot answer', () {
    for (final (name, status, body) in <(String, int, Object)>[
      ('an auth failure', 401, const {'error': 'Unauthorized'}),
      (
        'the feature gate',
        404,
        const {'error': 'Remote Control is not available.'},
      ),
    ]) {
      test('$name keeps the pairing with A', () async {
        await pairWithSleepingDesktopA();
        server.currentSessionOverride = () => (status: status, body: body);

        await foregroundThenPullToRefresh();

        expectTeardownDecisionReached();
        expect(server.endRequests, isEmpty);
        expectStillPairedToSleepingA();
      });
    }
  });

  group('AC7: a later restore after the local teardown', () {
    test('restores only a renderable current session', () async {
      await pairWithSleepingDesktopA();
      answerSessionRead(null);
      engine.session.onAppBackgrounded();
      await engine.session.onAppForegrounded();
      await pumpEventQueue();
      expectTeardownDecisionReached();
      expect(engine.session.status, RemoteConnectionStatus.error);
      final requestsAfterTeardown = server.requests.length;

      // Nothing renderable is current: no restore, and no read of A's shell.
      for (final (_, ownRead) in ownEndedReads) {
        answerSessionRead(ownRead());
        now = now.add(const Duration(seconds: 6));
        await engine.session.restoreIfIdle();
        expect(engine.session.status, RemoteConnectionStatus.error);
        expect(engine.store.snapshot, isNull);
      }
      expect(
        server.requests.sublist(requestsAfterTeardown),
        everyElement('GET $_base/session'),
      );
      expect(
        server.requests.sublist(requestsAfterTeardown),
        hasLength(ownEndedReads.length),
      );

      // A newly paired desktop is current. Restore adopts it, because the
      // local teardown released A.
      server
        ..currentSessionOverride = null
        ..addSession(id: 'sess-b', clientName: 'Desktop B');
      now = now.add(const Duration(seconds: 6));
      await engine.session.restoreIfIdle();

      expect(engine.session.status, RemoteConnectionStatus.connected);
      expect(engine.session.connection?.deviceLabel, 'Desktop B');
      expect(engine.store.workspaces.single.name, 'Desktop B workspace');
      expect(server.endRequests, isEmpty);
    });

    test(
      'after a session-ended event, restore can adopt a new desktop',
      () async {
        server.addSession(id: 'sess-a', clientName: 'Desktop A');
        await engine.session.restoreIfIdle();
        await pumpEventQueue();

        // The live long-poll reports A ended.
        server.end('sess-a');
        await pumpEventQueue();
        expect(engine.session.status, RemoteConnectionStatus.error);
        expect(engine.session.connection, isNull);

        server.addSession(id: 'sess-b', clientName: 'Desktop B');
        now = now.add(const Duration(seconds: 6));
        await engine.session.restoreIfIdle();

        expect(engine.session.status, RemoteConnectionStatus.connected);
        expect(engine.session.connection?.deviceLabel, 'Desktop B');
        expect(engine.store.workspaces.single.name, 'Desktop B workspace');
        expect(server.endRequests, isEmpty);
      },
    );
  });

  // CAN-4426: the desktop can re-arm a code on the session the phone is still
  // ending. The code must not be submitted until this phone's end request has
  // settled, or a late end ends the new pairing on the server.
  group('pairing the same session while its end is in flight (CAN-4426)', () {
    late Completer<void> endGate;

    setUp(() async {
      server.addSession(id: 'sess-a', clientName: 'Desktop A');
      server.connectResponse = (code) => _codeAnswer(server, 'sess-a');
      await engine.session.restoreIfIdle();
      await pumpEventQueue();
      expect(engine.session.connection?.sessionId, 'sess-a');

      endGate = Completer<void>();
      server.endGate = endGate;
      unawaited(engine.session.disconnect());
      await pumpEventQueue();
      expect(engine.session.status, RemoteConnectionStatus.disconnected);
      expect(server.endRequests, ['POST $_base/sessions/sess-a/end']);
    });

    /// Enters a code while the end request is held, then lets the end land.
    /// A pairing the phone reports must still be live on the server.
    Future<void> enterCodeWhileEndIsHeld(Future<void> Function() land) async {
      String? reportedPairing;
      final pairing = engine.session.connect('123456').then((_) {
        if (engine.session.isConnected) {
          reportedPairing = engine.session.connection?.sessionId;
        }
      });
      await pumpEventQueue();
      final codeSentEarly = server.requests.contains('POST $_base/connect');
      final statusWhileHeld = engine.session.status;

      await land();
      await pairing;
      await pumpEventQueue();

      if (reportedPairing case final paired?) {
        expect(
          server.row(paired).connectionStatus,
          isNot('ended'),
          reason: 'the old end request ended the pairing the phone reported',
        );
      }
      expect(
        codeSentEarly,
        isFalse,
        reason: 'the code must wait for the end request to settle',
      );
      expect(statusWhileHeld, RemoteConnectionStatus.connecting);
    }

    test('an end that reaches the server lands before the code', () async {
      await enterCodeWhileEndIsHeld(() async => endGate.complete());

      expect(server.row('sess-a').connectionStatus, 'ended');
      expect(engine.session.isConnected, isFalse);
      expect(engine.session.error, isA<RemoteNoDesktopForCodeException>());
    });

    test('an end that never arrives leaves the new pairing live', () async {
      await enterCodeWhileEndIsHeld(
        () async => endGate.completeError(StateError('never arrived')),
      );

      expect(engine.session.status, RemoteConnectionStatus.connected);
      expect(engine.session.connection?.sessionId, 'sess-a');
      expect(server.row('sess-a').connectionStatus, 'active');
      expect(server.endRequests, hasLength(1));
    });
  });

  // CAN-4426: an explicit Disconnect from an offline desktop. Seeded operation
  // sequences check two invariants after every step:
  //  * no automatic restore reattaches the session the user disconnected,
  //    until the user pairs it again with a code;
  //  * old end requests and restores never clear a newer code pairing.
  group('explicit disconnect sequences (CAN-4426)', () {
    const operations = [
      'disconnect',
      'end-answers',
      'end-fails',
      'restore',
      'foreground',
      'pair-b',
      'pair-a-by-code',
      'a-wakes',
    ];

    Future<List<String>?> runSequence(int seed, {int steps = 12}) async {
      final random = Random(seed);
      final trace = <String>[];
      final pendingEnds = <({String? session, Completer<void> gate})>[];
      String? disconnectedFrom;
      String? pairedByCode;
      var nextConnect = 'sess-b';
      server.connectResponse = (code) => _codeAnswer(server, nextConnect);

      String? violation() {
        final current = engine.session.connection?.sessionId;
        if (disconnectedFrom != null && current == disconnectedFrom) {
          return 'still or again on $disconnectedFrom after Disconnect';
        }
        if (pairedByCode != null &&
            (!engine.session.isConnected || current != pairedByCode)) {
          return 'lost the code pairing $pairedByCode (now $current)';
        }
        if (pairedByCode != null &&
            server.row(pairedByCode).connectionStatus == 'ended') {
          return 'the server ended the code pairing $pairedByCode';
        }
        if (engine.session.isRestoring) return 'a restore stayed pending';
        return null;
      }

      for (var step = 0; step < steps; step += 1) {
        final operation = operations[random.nextInt(operations.length)];
        trace.add(operation);
        switch (operation) {
          case 'disconnect':
            if (!engine.session.isConnected) break;
            final gate = Completer<void>();
            disconnectedFrom = engine.session.connection?.sessionId;
            pendingEnds.add((session: disconnectedFrom, gate: gate));
            server.endGate = gate;
            pairedByCode = null;
            unawaited(engine.session.disconnect());
          case 'end-answers':
            if (pendingEnds.isEmpty) break;
            pendingEnds.removeAt(0).gate.complete();
          case 'end-fails':
            if (pendingEnds.isEmpty) break;
            pendingEnds
                .removeAt(0)
                .gate
                .completeError(StateError('the request never arrived'));
          case 'restore':
            now = now.add(const Duration(seconds: 6));
            await engine.session.restoreIfIdle();
          case 'foreground':
            now = now.add(const Duration(seconds: 6));
            engine.session.onAppBackgrounded();
            await engine.session.onAppForegrounded();
          case 'pair-b' || 'pair-a-by-code':
            if (engine.session.isConnected) break;
            final target = operation == 'pair-b' ? 'sess-b' : 'sess-a';
            if (server.row(target).connectionStatus == 'ended') break;
            // Pairing reads the account's current session for its metadata,
            // which prefers another ACTIVE desktop's row. That multi-desktop
            // gap predates CAN-4426 and is out of its scope.
            if (target == 'sess-a' &&
                server.row('sess-b').connectionStatus == 'active') {
              break;
            }
            nextConnect = target;
            final pairing = engine.session.connect('123456');
            if (pendingEnds.isNotEmpty) {
              // The user enters a code while an end is still in flight.
              final sentBefore = server.requests.length;
              await pumpEventQueue();
              if (server.requests
                  .skip(sentBefore)
                  .contains('POST $_base/connect')) {
                return [
                  ...trace,
                  'violation: code sent before the end settled',
                ];
              }
              while (pendingEnds.isNotEmpty) {
                final end = pendingEnds.removeAt(0);
                if (random.nextBool()) {
                  end.gate.complete();
                } else {
                  end.gate.completeError(StateError('never arrived'));
                }
              }
            }
            await pairing;
            if (engine.session.isConnected) {
              pairedByCode = target;
              if (disconnectedFrom == target) disconnectedFrom = null;
            }
          case 'a-wakes':
            if (server.row('sess-a').connectionStatus == 'ended') break;
            server.heartbeat('sess-a');
        }
        await pumpEventQueue();
        final broken = violation();
        if (broken != null) return [...trace, 'violation: $broken'];
      }
      for (final end in pendingEnds) {
        end.gate.complete();
      }
      await pumpEventQueue();
      return null;
    }

    for (var seed = 0; seed < 40; seed += 1) {
      test('seed $seed keeps both invariants', () async {
        await pairWithSleepingDesktopA();
        server.addSession(id: 'sess-b', clientName: 'Desktop B');
        expect(await runSequence(seed), isNull, reason: 'seed $seed');
      });
    }
  });
}

/// The connect route's answer for a code the desktop of [sessionId] approves.
/// An ended row is not eligible, so the code then finds no desktop.
({int status, Object body}) _codeAnswer(
  FakePortalSessionServer server,
  String sessionId,
) => server.row(sessionId).connectionStatus == 'ended'
    ? (
        status: 404,
        body: const {
          'error':
              'No pending remote control session was found for this '
              'account.',
          'code': 'no_eligible_desktop',
        },
      )
    : (status: 200, body: {'sessionId': sessionId, 'status': 'active'});
