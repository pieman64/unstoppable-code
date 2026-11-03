import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/project_clone_coordinator.dart';

const _url = 'https://github.com/org/repo.git';
const _interval = kRemoteProjectCloneStatusInterval;
const _failure =
    'Failed to clone the repository. Check the URL and access, then try again.';

/// The coordinator's ports, each controlled by the test.
final class _Harness {
  _Harness() {
    coordinator = build();
  }

  final commands = OwnedCommandRegistry(notify: () {});
  final createCalls = <String>[];
  final submits = <Completer<RemoteProjectCreateOutcome>>[];
  final statusReads = <String>[];
  Future<BrowserPortalCommandStatusResponse> Function(String commandId) status =
      (id) async => _status(id, BrowserPortalCommandStatus.delivered);
  final projects = <String>{};
  var refreshes = 0;
  var notifications = 0;
  var connected = true;
  var backgrounded = false;
  var generation = 1;
  late ProjectCloneCoordinator coordinator;

  ProjectCloneCoordinator build() => ProjectCloneCoordinator(
    createProject: (url) {
      createCalls.add(url);
      final submit = Completer<RemoteProjectCreateOutcome>();
      submits.add(submit);
      return submit.future;
    },
    readStatus: (id) {
      statusReads.add(id);
      return status(id);
    },
    commands: commands,
    notify: () => notifications++,
    isConnected: () => connected,
    isBackgrounded: () => backgrounded,
    sessionGeneration: () => generation,
    hasProject: projects.contains,
    refreshProjects: () async => refreshes++,
  );

  List<RemoteProjectClonePhase> get phases => [
    for (final clone in coordinator.clones) clone.phase,
  ];

  /// Starts a clone and answers its submit with [outcome].
  Future<String?> add(
    FakeAsync async,
    RemoteProjectCreateOutcome outcome, {
    String url = _url,
  }) {
    final result = coordinator.addProject(url);
    async.flushMicrotasks();
    submits.last.complete(outcome);
    async.flushMicrotasks();
    return result;
  }

  void completed(String commandId, [Map<String, dynamic>? result]) =>
      commands.handleCompleted(commandId, result, projectionSequence: 0);

  void failed(String commandId, String message) =>
      commands.handleFailed(commandId, message, projectionSequence: 0);

  /// A snapshot now lists [workspaceId].
  void project(String workspaceId) {
    projects.add(workspaceId);
    coordinator.reconcile();
  }
}

BrowserPortalCommandStatusResponse _status(
  String commandId,
  BrowserPortalCommandStatus status, {
  Map<String, dynamic>? result,
  String? error,
}) => BrowserPortalCommandStatusResponse(
  commandId: commandId,
  status: status,
  result: result,
  error: error,
);

RemoteProjectCreatePending _pending(String id, {bool queued = false}) =>
    RemoteProjectCreatePending(commandId: id, queuedWhileReconnecting: queued);

void main() {
  test('shows a submitting row named after the repository', () {
    fakeAsync((async) {
      final h = _Harness();
      unawaited(h.coordinator.addProject(_url));
      async.flushMicrotasks();

      expect(h.createCalls, [_url]);
      final clone = h.coordinator.clones.single;
      expect(clone.name, 'repo');
      expect(clone.phase, RemoteProjectClonePhase.submitting);
      expect(clone.isDismissible, isFalse);
    });
  });

  test('refuses to submit while disconnected', () {
    fakeAsync((async) {
      final h = _Harness()..connected = false;
      String? message;
      h.coordinator.addProject(_url).then((value) => message = value);
      async.flushMicrotasks();

      expect(message, isNotNull);
      expect(h.createCalls, isEmpty);
      expect(h.coordinator.clones, isEmpty);
    });
  });

  test('pending clone completes, refreshes once, then is replaced', () {
    fakeAsync((async) {
      final h = _Harness();
      String? message = 'unset';
      h.add(async, _pending('cmd-1')).then((value) => message = value);
      async.flushMicrotasks();
      expect(message, isNull);
      expect(h.phases, [RemoteProjectClonePhase.cloning]);

      h.completed('cmd-1', {'workspaceId': 'ws-new'});
      async.flushMicrotasks();
      expect(h.phases, [RemoteProjectClonePhase.awaitingProject]);
      expect(h.refreshes, 1);

      // An unrelated project does not settle the row, or ask again.
      h.project('ws-other');
      async.elapse(_interval * 3);
      expect(h.phases, [RemoteProjectClonePhase.awaitingProject]);
      expect(h.refreshes, 1);

      h.project('ws-new');
      expect(h.coordinator.clones, isEmpty);
      expect(h.createCalls, hasLength(1));
      // Feature-owned: no Remote Control failure banner either way.
      expect(h.commands.failureMessage, isNull);
    });
  });

  test('a completion that arrives before the submit response wins', () {
    fakeAsync((async) {
      final h = _Harness();
      final result = h.coordinator.addProject(_url);
      async.flushMicrotasks();
      // The terminal event races ahead of the 202.
      h.completed('cmd-1', {'workspaceId': 'ws-new'});
      h.submits.single.complete(_pending('cmd-1'));
      async.flushMicrotasks();
      unawaited(result);

      expect(h.phases, [RemoteProjectClonePhase.awaitingProject]);
      expect(h.refreshes, 1);
      async.elapse(_interval * 2);
      expect(h.statusReads, isEmpty);
      h.project('ws-new');
      expect(h.coordinator.clones, isEmpty);
    });
  });

  test('a failure that arrives before the submit response wins', () {
    fakeAsync((async) {
      final h = _Harness();
      final result = h.coordinator.addProject(_url);
      async.flushMicrotasks();
      h.failed('cmd-1', _failure);
      h.submits.single.complete(_pending('cmd-1'));
      async.flushMicrotasks();
      unawaited(result);

      final clone = h.coordinator.clones.single;
      expect(clone.phase, RemoteProjectClonePhase.failed);
      expect(clone.failure, _failure);
      expect(clone.isDismissible, isTrue);
      expect(h.commands.failureMessage, isNull);
    });
  });

  test('an immediate completion resolves against the snapshot', () {
    fakeAsync((async) {
      final h = _Harness()..projects.add('ws-new');
      h.add(async, const RemoteProjectCreateCompleted(workspaceId: 'ws-new'));

      expect(h.coordinator.clones, isEmpty);
      expect(h.refreshes, 0);
    });
  });

  test('a project listed before its completion settles on completion', () {
    fakeAsync((async) {
      final h = _Harness();
      h.add(async, _pending('cmd-1'));
      // The snapshot lists the project before the completion event names it.
      h.project('ws-new');
      expect(h.phases, [RemoteProjectClonePhase.cloning]);

      h.completed('cmd-1', {'workspaceId': 'ws-new'});
      async.flushMicrotasks();
      expect(h.coordinator.clones, isEmpty);
      expect(h.refreshes, 0);
    });
  });

  // A completion that names no usable project can never match a snapshot.
  const unusableResults = <(String, Map<String, dynamic>?)>[
    ('no result', null),
    ('no project id', {}),
    ('a null project id', {'workspaceId': null}),
    ('an empty project id', {'workspaceId': ''}),
    ('a non-string project id', {'workspaceId': 42}),
  ];
  for (final (label, result) in unusableResults) {
    test('a completion event with $label is unconfirmed, dismissible', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        h.completed('cmd-1', result);
        async.flushMicrotasks();

        final clone = h.coordinator.clones.single;
        expect(clone.phase, RemoteProjectClonePhase.unknown);
        expect(clone.isDismissible, isTrue);
        async.elapse(_interval * 3);
        expect(h.statusReads, isEmpty);
        expect(h.createCalls, hasLength(1));
        expect(h.refreshes, 0);
        h.coordinator.dismiss(clone.id);
        expect(h.coordinator.clones, isEmpty);
      });
    });

    test('a completed status with $label is unconfirmed', () {
      fakeAsync((async) {
        final h = _Harness()
          ..status = ((id) async => _status(
            id,
            BrowserPortalCommandStatus.completed,
            result: result,
          ));
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval);

        expect(h.phases, [RemoteProjectClonePhase.unknown]);
        async.elapse(_interval * 3);
        expect(h.statusReads, hasLength(1));
        expect(h.createCalls, hasLength(1));
        expect(h.refreshes, 0);
      });
    });
  }

  test('a desktop failure response shows a failed row with Dismiss only', () {
    fakeAsync((async) {
      final h = _Harness();
      h.add(async, const RemoteProjectCreateFailed(_failure));

      final clone = h.coordinator.clones.single;
      expect(clone.phase, RemoteProjectClonePhase.failed);
      expect(clone.failure, _failure);
      async.elapse(_interval * 3);
      expect(h.createCalls, hasLength(1));
      expect(h.statusReads, isEmpty);
    });
  });

  test('an unknown outcome asks the user to check and never resubmits', () {
    fakeAsync((async) {
      final h = _Harness();
      String? message = 'unset';
      h
          .add(async, const RemoteProjectCreateUnknown())
          .then((value) => message = value);
      async.flushMicrotasks();

      expect(message, isNull);
      final clone = h.coordinator.clones.single;
      expect(clone.phase, RemoteProjectClonePhase.unknown);
      expect(clone.isDismissible, isTrue);
      async.elapse(_interval * 10);
      expect(h.createCalls, hasLength(1));
      expect(h.statusReads, isEmpty);
    });
  });

  test('a reconnect-queued clone waits, then starts and completes', () {
    fakeAsync((async) {
      final h = _Harness()
        ..status = ((id) async =>
            _status(id, BrowserPortalCommandStatus.queued));
      h.add(async, _pending('cmd-1', queued: true));
      expect(h.phases, [RemoteProjectClonePhase.queued]);

      async.elapse(_interval);
      expect(h.statusReads, ['cmd-1']);
      expect(h.phases, [RemoteProjectClonePhase.queued]);

      h.status = (id) async =>
          _status(id, BrowserPortalCommandStatus.delivered);
      async.elapse(_interval);
      expect(h.phases, [RemoteProjectClonePhase.cloning]);

      h.completed('cmd-1', {'workspaceId': 'ws-new'});
      async.flushMicrotasks();
      h.project('ws-new');
      expect(h.coordinator.clones, isEmpty);
      expect(h.createCalls, hasLength(1));
    });
  });

  group('status fallback', () {
    // CAN-4875: the completion event normally settles a clone. Status reads
    // start only once it is overdue, per clone, and stay 30 seconds apart.
    test('reads no status before the completion is overdue', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        async.elapse(const Duration(seconds: 29));
        expect(h.statusReads, isEmpty);
        async.elapse(const Duration(seconds: 1));
        expect(h.statusReads, ['cmd-1']);
        async.elapse(const Duration(seconds: 29));
        expect(h.statusReads, hasLength(1));
        async.elapse(const Duration(seconds: 1));
        expect(h.statusReads, hasLength(2));
      });
    });

    test('a timely completion reads no status', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        async.elapse(const Duration(seconds: 2));
        h.completed('cmd-1', {'workspaceId': 'ws-new'});
        h.project('ws-new');
        async.elapse(const Duration(minutes: 5));
        expect(h.statusReads, isEmpty);
        expect(h.coordinator.clones, isEmpty);
      });
    });

    test('a newer clone waits for its own overdue time', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        async.elapse(const Duration(seconds: 20));
        h.add(async, _pending('cmd-2'), url: '$_url#2');
        async.elapse(const Duration(seconds: 10));
        expect(h.statusReads, ['cmd-1']);
        async.elapse(const Duration(seconds: 19));
        expect(h.statusReads, ['cmd-1']);
        async.elapse(const Duration(seconds: 1));
        expect(h.statusReads, ['cmd-1', 'cmd-2']);
        async.elapse(const Duration(seconds: 10));
        expect(h.statusReads, ['cmd-1', 'cmd-2', 'cmd-1']);
      });
    });

    test('resolves a missed completion and still waits for the project', () {
      fakeAsync((async) {
        final h = _Harness()
          ..status = ((id) async => _status(
            id,
            BrowserPortalCommandStatus.completed,
            result: {'workspaceId': 'ws-new'},
          ));
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval);

        expect(h.statusReads, ['cmd-1']);
        expect(h.phases, [RemoteProjectClonePhase.awaitingProject]);
        expect(h.refreshes, 1);
        async.elapse(_interval * 3);
        expect(h.statusReads, hasLength(1));
        h.project('ws-new');
        expect(h.coordinator.clones, isEmpty);
      });
    });

    test('resolves a missed failure', () {
      fakeAsync((async) {
        final h = _Harness()
          ..status = ((id) async =>
              _status(id, BrowserPortalCommandStatus.failed, error: _failure));
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval);

        expect(h.coordinator.clones.single.failure, _failure);
        expect(h.phases, [RemoteProjectClonePhase.failed]);
      });
    });

    for (final (label, status)
        in <
          (String, Future<BrowserPortalCommandStatusResponse> Function(String))
        >[
          (
            'an expired command',
            (id) async => _status(id, BrowserPortalCommandStatus.expired),
          ),
          (
            'a missing command',
            (_) async => throw const ApiException(statusCode: 404, body: '{}'),
          ),
        ]) {
      test('treats $label as unconfirmed, not failed', () {
        fakeAsync((async) {
          final h = _Harness()..status = status;
          h.add(async, _pending('cmd-1'));
          async.elapse(_interval);

          expect(h.phases, [RemoteProjectClonePhase.unknown]);
          async.elapse(_interval * 3);
          expect(h.statusReads, hasLength(1));
          expect(h.createCalls, hasLength(1));
        });
      });
    }

    test('keeps the row through transient read errors', () {
      fakeAsync((async) {
        final h = _Harness()
          ..status = ((_) async =>
              throw const ApiException(statusCode: 503, body: '{}'));
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval * 3);

        expect(h.statusReads, hasLength(3));
        expect(h.phases, [RemoteProjectClonePhase.cloning]);
      });
    });

    test('never overlaps reads', () {
      fakeAsync((async) {
        final slow = Completer<BrowserPortalCommandStatusResponse>();
        final h = _Harness()..status = ((_) => slow.future);
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval * 5);

        expect(h.statusReads, hasLength(1));
        slow.complete(_status('cmd-1', BrowserPortalCommandStatus.delivered));
        async.flushMicrotasks();
        async.elapse(_interval);
        expect(h.statusReads, hasLength(2));
      });
    });

    test('a late nonterminal status cannot undo a terminal event', () {
      fakeAsync((async) {
        final slow = Completer<BrowserPortalCommandStatusResponse>();
        final h = _Harness()..status = ((_) => slow.future);
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval);
        h.failed('cmd-1', _failure);
        async.flushMicrotasks();
        slow.complete(_status('cmd-1', BrowserPortalCommandStatus.delivered));
        async.flushMicrotasks();

        expect(h.phases, [RemoteProjectClonePhase.failed]);
        async.elapse(_interval * 3);
        expect(h.statusReads, hasLength(1));
      });
    });

    test('ignores a status answer for another command', () {
      fakeAsync((async) {
        final h = _Harness()
          ..status = ((_) async => _status(
            'cmd-other',
            BrowserPortalCommandStatus.failed,
            error: _failure,
          ));
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval);

        expect(h.phases, [RemoteProjectClonePhase.cloning]);
      });
    });

    test('pauses in the background and reads again on return', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        h.backgrounded = true;
        h.coordinator.pauseStatusReads();
        async.elapse(_interval * 5);
        expect(h.statusReads, isEmpty);

        h.backgrounded = false;
        h.coordinator.resumeStatusReads();
        async.elapse(Duration.zero);
        expect(h.statusReads, ['cmd-1']);
        async.elapse(_interval);
        expect(h.statusReads, hasLength(2));
      });
    });
  });

  test('distinct clones keep their own results', () {
    fakeAsync((async) {
      final h = _Harness();
      h.add(async, _pending('cmd-1'));
      h.add(async, _pending('cmd-2'), url: 'git@github.com:org/api.git');
      expect([for (final c in h.coordinator.clones) c.name], ['repo', 'api']);

      h.failed('cmd-2', _failure);
      async.flushMicrotasks();
      expect(h.phases, [
        RemoteProjectClonePhase.cloning,
        RemoteProjectClonePhase.failed,
      ]);

      h.coordinator.dismiss(h.coordinator.clones.last.id);
      // Dismiss ignores a row that is still cloning.
      h.coordinator.dismiss(h.coordinator.clones.single.id);
      expect(h.phases, [RemoteProjectClonePhase.cloning]);
      expect(h.createCalls, hasLength(2));
    });
  });

  group('lifecycle', () {
    test('a new pairing drops clones and ignores late answers', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        final late = h.coordinator.addProject(_url);
        async.flushMicrotasks();

        h.generation = 2;
        h.coordinator.reset();
        h.commands.reset();
        expect(h.coordinator.clones, isEmpty);

        h.submits.last.complete(_pending('cmd-2'));
        async.flushMicrotasks();
        unawaited(late);
        async.elapse(_interval * 3);
        expect(h.coordinator.clones, isEmpty);
        expect(h.statusReads, isEmpty);
        // The old command is no longer this client's.
        h.completed('cmd-2', {'workspaceId': 'ws-new'});
        expect(h.coordinator.clones, isEmpty);
      });
    });

    test('a status read that outlives its pairing is ignored', () {
      fakeAsync((async) {
        final slow = Completer<BrowserPortalCommandStatusResponse>();
        final h = _Harness()..status = ((_) => slow.future);
        h.add(async, _pending('cmd-1'));
        async.elapse(_interval);
        h.generation = 2;
        h.coordinator.reset();
        h.add(async, _pending('cmd-1'));
        slow.complete(
          _status('cmd-1', BrowserPortalCommandStatus.failed, error: _failure),
        );
        async.flushMicrotasks();

        expect(h.phases, [RemoteProjectClonePhase.cloning]);
      });
    });

    test('dispose stops status reads', () {
      fakeAsync((async) {
        final h = _Harness();
        h.add(async, _pending('cmd-1'));
        h.coordinator.dispose();
        async.elapse(_interval * 3);

        expect(h.statusReads, isEmpty);
        expect(async.pendingTimers, isEmpty);
      });
    });
  });

  test('seeded interleavings keep every clone consistent', () {
    // Each seed interleaves submits, answers, terminal events, late status
    // answers, snapshots and dismissals for four clones; some completions
    // name no project id. After every step:
    // one create per clone, a terminal phase never changes, a row settles
    // only on its own project id, and a settled row never returns.
    const terminalPhases = {
      RemoteProjectClonePhase.awaitingProject,
      RemoteProjectClonePhase.failed,
      RemoteProjectClonePhase.unknown,
    };
    for (var seed = 0; seed < 60; seed++) {
      fakeAsync((async) {
        final random = Random(seed);
        final h = _Harness();
        final commandIds = <int, String>{}; // clone index → command id
        final rowIds = <int, int>{}; // clone index → row id
        final terminal = <int, RemoteProjectClonePhase>{};
        final settled = <int>{};
        final reads =
            <(String, Completer<BrowserPortalCommandStatusResponse>)>[];
        var started = 0;
        h.status = (id) {
          final read = Completer<BrowserPortalCommandStatusResponse>();
          reads.add((id, read));
          return read.future;
        };

        BrowserPortalCommandStatusResponse randomStatus(String id) =>
            switch (random.nextInt(6)) {
              0 => _status(
                id,
                BrowserPortalCommandStatus.completed,
                result: {'workspaceId': 'ws-$id'},
              ),
              1 => _status(
                id,
                BrowserPortalCommandStatus.failed,
                error: _failure,
              ),
              2 => _status(id, BrowserPortalCommandStatus.queued),
              3 => _status(id, BrowserPortalCommandStatus.completed),
              _ => _status(id, BrowserPortalCommandStatus.delivered),
            };

        void check(String step) {
          final reason = 'seed $seed after $step';
          expect(h.createCalls, hasLength(started), reason: reason);
          final byId = {for (final c in h.coordinator.clones) c.id: c};
          for (final MapEntry(key: index, value: rowId) in rowIds.entries) {
            final row = byId[rowId];
            if (row == null) {
              settled.add(index);
              continue;
            }
            expect(settled, isNot(contains(index)), reason: reason);
            final recorded = terminal[index];
            if (recorded != null) {
              expect(row.phase, recorded, reason: reason);
            } else if (terminalPhases.contains(row.phase)) {
              terminal[index] = row.phase;
            }
            // A waiting row has a project id, always `ws-<command id>`, so
            // a waiting row whose project is listed should already be gone.
            final id = commandIds[index];
            if (row.phase == RemoteProjectClonePhase.awaitingProject) {
              expect(id, isNotNull, reason: reason);
              expect(h.projects, isNot(contains('ws-$id')), reason: reason);
            }
          }
        }

        for (var step = 0; step < 80; step++) {
          final action = random.nextInt(8);
          switch (action) {
            case 0 when started < 4:
              final index = started++;
              unawaited(h.coordinator.addProject('$_url#$index'));
              async.flushMicrotasks();
              rowIds[index] = h.coordinator.clones.last.id;
            case 1:
              final open = [
                for (var i = 0; i < h.submits.length; i++)
                  if (!h.submits[i].isCompleted) i,
              ];
              if (open.isEmpty) break;
              final index = open[random.nextInt(open.length)];
              final id = 'cmd-$index';
              commandIds[index] = id;
              h.submits[index].complete(
                _pending(id, queued: random.nextBool()),
              );
            case 2 || 3:
              // Terminal events may race ahead of their submit answer.
              if (started == 0) break;
              final id = 'cmd-${random.nextInt(started)}';
              if (action == 2) {
                // Some completions name no project id.
                h.completed(
                  id,
                  random.nextInt(4) == 0 ? const {} : {'workspaceId': 'ws-$id'},
                );
              } else {
                h.failed(id, _failure);
              }
            case 4:
              async.elapse(_interval);
            case 5:
              // A snapshot lists a clone's project, or an unrelated one.
              final id = started == 0 || random.nextBool()
                  ? 'unrelated-$step'
                  : 'cmd-${random.nextInt(started)}';
              h.project('ws-$id');
            case 6:
              final rows = h.coordinator.clones;
              if (rows.isEmpty) break;
              h.coordinator.dismiss(rows[random.nextInt(rows.length)].id);
            case 7:
              final open = [
                for (final read in reads)
                  if (!read.$2.isCompleted) read,
              ];
              if (open.isEmpty) break;
              final (id, read) = open[random.nextInt(open.length)];
              read.complete(randomStatus(id));
          }
          async.flushMicrotasks();
          check('step $step (action $action)');
        }
        h.coordinator.dispose();
      });
    }
  });
}
