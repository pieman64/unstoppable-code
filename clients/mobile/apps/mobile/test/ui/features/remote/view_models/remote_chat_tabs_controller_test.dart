// Deterministic event sequences for the optimistic tab state machine: each
// names the order in which user actions, command responses, terminal
// outcomes, projections, and session switches arrive.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_tabs_controller.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'main',
);

RemoteChatSummary _summary(String chatId, {bool active = false}) =>
    RemoteChatSummary(
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Chat $chatId',
      active: active,
    );

/// One submitted tab command, held until the test answers or rejects it.
typedef _Command = ({
  RemoteWorktreeChatTarget target,
  Completer<String> response,
  void Function() reject,
});

final class _Harness {
  _Harness({String? initialChatId}) {
    controller = RemoteChatTabsController(
      createTab: (target, {required onFailed}) =>
          _submit(creates, target, onFailed),
      closeTab: (target, {required onFailed}) =>
          _submit(closes, target, onFailed),
      mintChatId: () => 'chat-m${++_minted}',
      sessionGeneration: () => generation,
      onChanged: () => changes++,
      onCreateFailed: failedCreates.add,
      initialChatId: initialChatId,
    );
  }

  late final RemoteChatTabsController controller;
  final creates = <_Command>[];
  final closes = <_Command>[];
  final failedCreates = <String>[];
  var generation = 1;
  var changes = 0;
  var _minted = 0;
  var projected = <RemoteChatSummary>[];

  Future<String> _submit(
    List<_Command> log,
    RemoteWorktreeChatTarget target,
    void Function() onFailed,
  ) {
    final response = Completer<String>();
    log.add((target: target, response: response, reject: onFailed));
    return response.future;
  }

  List<String> get rows => [
    for (final row in controller.rowsFor(projected, _worktree)) row.chatId,
  ];

  String? get shown =>
      controller.chatIdFor(controller.rowsFor(projected, _worktree));

  bool sync({Iterable<String> adopt = const []}) =>
      controller.sync(projected: projected, worktree: _worktree, adopt: adopt);

  /// Starts a create and swallows its transport failure for sequences that
  /// assert on state instead.
  String create() {
    final (:chatId, :submitted) = controller.create(_worktree);
    unawaited(submitted.then((_) {}, onError: (Object _) {}));
    return chatId;
  }

  void close(String chatId) => unawaited(
    controller.close(_worktree, chatId).then((_) {}, onError: (Object _) {}),
  );
}

void main() {
  group('RemoteChatTabsController', () {
    test('a created tab is listed and selected until its projection', () async {
      final harness = _Harness()..projected = [_summary('a', active: true)];
      harness.sync();
      final created = harness.create();

      expect(harness.rows, ['a', created]);
      expect(harness.shown, created);
      expect(harness.controller.isPending(created), isTrue);
      expect(harness.creates.single.target.chatId, created);

      harness.creates.single.response.complete('create-1');
      await pumpEventQueue();
      expect(harness.controller.createCommandIdFor(created), 'create-1');

      harness.projected = [_summary('a', active: true), _summary(created)];
      harness.sync();
      expect(harness.controller.isPending(created), isFalse);
      expect(harness.rows, ['a', created]);
      expect(harness.shown, created);
    });

    test('one failed create cannot remove another', () async {
      final harness = _Harness()..projected = [_summary('a', active: true)];
      harness.sync();
      final older = harness.create();
      final newer = harness.create();
      harness.creates[0].response.complete('create-older');
      harness.creates[1].response.complete('create-newer');
      await pumpEventQueue();

      harness.creates[0].reject();

      expect(harness.rows, ['a', newer]);
      expect(harness.shown, newer);
      expect(harness.failedCreates, [older]);
    });

    test('a rejected selected create falls back to the active tab', () {
      final harness = _Harness()..projected = [_summary('a', active: true)];
      harness.sync();
      final created = harness.create();

      harness.creates.single.reject();

      expect(harness.rows, ['a']);
      expect(harness.shown, 'a');
      expect(harness.failedCreates, [created]);
    });

    test('a transport failure drops the tab, then rethrows', () async {
      final harness = _Harness()..projected = [_summary('a', active: true)];
      harness.sync();
      final (:chatId, :submitted) = harness.controller.create(_worktree);
      harness.creates.single.response.completeError(
        const RemoteControlException('Creation unavailable.'),
      );

      await expectLater(submitted, throwsA(isA<RemoteControlException>()));
      expect(harness.rows, ['a']);
      expect(harness.failedCreates, [chatId]);
    });

    test('a held failure waits for the send in flight to settle', () {
      final harness = _Harness()..projected = [_summary('a', active: true)];
      harness.sync();
      final created = harness.create();
      harness.controller.holdFailures(created);

      harness.creates.single.reject();
      expect(harness.rows, ['a', created]);
      expect(harness.shown, created);
      expect(harness.failedCreates, isEmpty);

      harness.controller.releaseFailures();
      expect(harness.rows, ['a']);
      expect(harness.failedCreates, [created]);
    });

    test(
      'a close hides the tab; a rejection restores it and its selection',
      () {
        final harness = _Harness()
          ..projected = [_summary('a', active: true), _summary('b')];
        harness.sync();
        expect(harness.shown, 'a');

        harness.close('a');
        expect(harness.rows, ['b']);
        expect(harness.shown, 'b');

        harness.closes.single.reject();
        expect(harness.rows, ['a', 'b']);
        expect(harness.shown, 'a');
      },
    );

    test('close rollback respects a later selection', () {
      final harness = _Harness()
        ..projected = [_summary('a', active: true), _summary('b')];
      harness.sync();
      harness.close('a');
      harness.controller.select('b');

      harness.closes.single.reject();

      expect(harness.rows, ['a', 'b']);
      expect(harness.shown, 'b');
    });

    test('a repeated close submits once', () {
      final harness = _Harness()
        ..projected = [_summary('a', active: true), _summary('b')];
      harness.sync();
      harness.close('b');
      harness.close('b');
      expect(harness.closes, hasLength(1));
    });

    test('a close ends once the projection drops the tab', () {
      final harness = _Harness()
        ..projected = [_summary('a', active: true), _summary('b')];
      harness.sync();
      harness.close('b');
      harness.projected = [_summary('a', active: true)];
      harness.sync();

      // A later projection listing it again is authoritative.
      harness.projected = [_summary('a', active: true), _summary('b')];
      harness.sync();
      expect(harness.rows, ['a', 'b']);
    });

    test('an empty projection preserves a deep link; a list without it '
        'falls back', () {
      final harness = _Harness(initialChatId: 'deep');
      harness.sync();
      expect(harness.shown, 'deep');

      harness.projected = [_summary('a'), _summary('b', active: true)];
      harness.sync();
      expect(harness.shown, 'b');
      expect(harness.controller.selectedChatId, 'b');
    });

    test(
      'the resolved chat is latched when the desktop moves its active tab',
      () {
        final harness = _Harness()
          ..projected = [_summary('a', active: true), _summary('b')];
        harness.sync();
        harness.projected = [_summary('a'), _summary('b', active: true)];
        harness.sync();
        expect(harness.shown, 'a');
      },
    );

    test('unsent chats are adopted as provisional tabs', () {
      final harness = _Harness();
      expect(harness.sync(adopt: ['unsent']), isTrue);
      expect(harness.rows, ['unsent']);
      expect(harness.shown, 'unsent');
      expect(harness.sync(adopt: ['unsent']), isFalse);
    });

    // Each sequence names the order of events around a session switch.
    group('session switch', () {
      test('create → switch → late reject: the provisional row stays', () {
        final harness = _Harness()..projected = [_summary('a', active: true)];
        harness.sync();
        final created = harness.create();
        harness.generation++;
        harness.sync();
        final changes = harness.changes;

        harness.creates.single.reject();

        expect(harness.rows, ['a', created]);
        expect(harness.shown, created);
        expect(harness.failedCreates, isEmpty);
        expect(harness.changes, changes);
      });

      test('create → switch → late response: no command is recorded', () async {
        final harness = _Harness()..projected = [_summary('a', active: true)];
        harness.sync();
        final created = harness.create();
        harness.generation++;
        harness.sync();

        harness.creates.single.response.complete('old-create');
        await pumpEventQueue();

        expect(harness.controller.createCommandIdFor(created), isNull);
        harness.projected = [_summary('a', active: true), _summary(created)];
        harness.sync();
        expect(harness.controller.isPending(created), isFalse);
      });

      test('close → switch: the tab is listed again and a late reject '
          'cannot reselect it', () {
        final harness = _Harness()
          ..projected = [_summary('a', active: true), _summary('b')];
        harness.sync();
        harness.close('a');
        harness.generation++;
        harness.sync();
        expect(harness.rows, ['a', 'b']);

        harness.controller.select('b');
        harness.closes.single.reject();

        expect(harness.rows, ['a', 'b']);
        expect(harness.shown, 'b');
      });

      test('close → switch → late transport failure: nothing is reported, '
          'nothing changes', () async {
        final harness = _Harness()
          ..projected = [_summary('a', active: true), _summary('b')];
        harness.sync();
        final closing = harness.controller.close(_worktree, 'a');
        harness.generation++;
        harness.sync();
        harness.controller.select('b');
        final changes = harness.changes;

        harness.closes.single.response.completeError(
          const RemoteControlException('The old close failed.'),
        );

        await expectLater(closing, completes);
        expect(harness.rows, ['a', 'b']);
        expect(harness.shown, 'b');
        expect(harness.changes, changes);
      });

      test('start → switch → late transport failure: nothing is reported, '
          'the provisional row stays', () async {
        final harness = _Harness()..projected = [_summary('a', active: true)];
        harness.sync();
        final starting = harness.controller.start(_worktree);
        final created = harness.creates.single.target.chatId!;
        harness.generation++;
        harness.sync();
        final changes = harness.changes;

        harness.creates.single.response.completeError(
          const RemoteControlException('Creation unavailable.'),
        );

        await expectLater(starting, completes);
        expect(harness.rows, ['a', created]);
        expect(harness.shown, created);
        expect(harness.failedCreates, isEmpty);
        expect(harness.changes, changes);
      });

      test('a current-session start failure still drops the tab and '
          'rethrows', () async {
        final harness = _Harness()..projected = [_summary('a', active: true)];
        harness.sync();
        final starting = harness.controller.start(_worktree);
        final created = harness.creates.single.target.chatId!;

        harness.creates.single.response.completeError(
          const RemoteControlException('Creation unavailable.'),
        );

        await expectLater(starting, throwsA(isA<RemoteControlException>()));
        expect(harness.rows, ['a']);
        expect(harness.failedCreates, [created]);
      });

      test('close → late reject before the switch is observed is ignored', () {
        final harness = _Harness()
          ..projected = [_summary('a', active: true), _summary('b')];
        harness.sync();
        harness.close('b');
        harness.generation++;
        final changes = harness.changes;

        harness.closes.single.reject();

        expect(harness.changes, changes);
      });
    });

    test(
      'projection-before-response and response-before-projection converge',
      () async {
        Future<List<String?>> run({required bool projectFirst}) async {
          final harness = _Harness()..projected = [_summary('a', active: true)];
          harness.sync();
          final created = harness.create();
          void project() {
            harness.projected = [
              _summary('a', active: true),
              _summary(created),
            ];
            harness.sync();
          }

          if (projectFirst) project();
          harness.creates.single.response.complete('create-1');
          await pumpEventQueue();
          if (!projectFirst) project();
          return [...harness.rows, harness.shown];
        }

        expect(await run(projectFirst: true), await run(projectFirst: false));
      },
    );

    group('CAN-3922 ensureCreated', () {
      test('completes once the desktop lists the tab', () async {
        final harness = _Harness();
        harness.sync();
        final created = harness.create();
        bool? outcome;
        unawaited(
          harness.controller
              .ensureCreated(_worktree, created)
              .then((v) => outcome = v),
        );
        harness.creates.single.response.complete('create-1');
        await pumpEventQueue();
        expect(outcome, isNull);

        harness.projected = [_summary(created)];
        harness.sync();
        await pumpEventQueue();
        expect(outcome, isTrue);
        expect(harness.creates, hasLength(1));
      });

      test('a listed tab is created at once', () async {
        final harness = _Harness()..projected = [_summary('a', active: true)];
        harness.sync();

        expect(await harness.controller.ensureCreated(_worktree, 'a'), isTrue);
        expect(harness.creates, isEmpty);
      });

      test('completes false when the desktop rejects the create', () async {
        final harness = _Harness();
        harness.sync();
        final created = harness.create();
        final outcome = harness.controller.ensureCreated(_worktree, created);
        harness.creates.single.response.complete('create-1');

        harness.creates.single.reject();

        expect(await outcome, isFalse);
      });

      test('a transport failure throws', () async {
        final harness = _Harness();
        harness.sync();
        final (:chatId, :submitted) = harness.controller.create(_worktree);
        final outcome = expectLater(
          harness.controller.ensureCreated(_worktree, chatId),
          throwsA(isA<RemoteControlException>()),
        );
        harness.creates.single.response.completeError(
          const RemoteControlException('Creation unavailable.'),
        );

        await expectLater(submitted, throwsA(isA<RemoteControlException>()));
        await outcome;
      });

      test('a held failure completes false once released', () async {
        final harness = _Harness();
        harness.sync();
        final created = harness.create();
        bool? outcome;
        unawaited(
          harness.controller
              .ensureCreated(_worktree, created)
              .then((v) => outcome = v),
        );
        harness.creates.single.response.complete('create-1');
        harness.controller.holdFailures(created);
        harness.creates.single.reject();
        await pumpEventQueue();
        expect(outcome, isNull);

        harness.controller.releaseFailures();
        await pumpEventQueue();
        expect(outcome, isFalse);
      });

      test('completes false when the session changes, and asks the new '
          'session for the same tab, which completes once listed', () async {
        final harness = _Harness();
        harness.sync();
        final created = harness.create();
        harness.creates.single.response.complete('create-1');
        bool? outcome;
        unawaited(
          harness.controller
              .ensureCreated(_worktree, created)
              .then((v) => outcome = v),
        );
        await pumpEventQueue();
        harness.generation = 2;
        harness.sync();
        await pumpEventQueue();
        expect(outcome, isFalse);
        // The provisional tab stays shown.
        expect(harness.rows, [created]);
        expect(harness.shown, created);

        bool? retried;
        unawaited(
          harness.controller
              .ensureCreated(_worktree, created)
              .then((v) => retried = v),
        );
        await pumpEventQueue();
        expect(harness.creates.map((command) => command.target.chatId), [
          created,
          created,
        ]);
        harness.creates.last.response.complete('create-2');
        harness.projected = [_summary(created)];
        harness.sync();
        await pumpEventQueue();
        expect(retried, isTrue);
      });

      // The create's transport can stay unanswered after the session that
      // sent it is replaced or the view goes away. The wait ends then, not
      // when that stale response finally arrives, and the late response
      // changes nothing.
      for (final end in ['switch session', 'dispose']) {
        for (final late in ['respond', 'respond empty', 'transport failure']) {
          test('a $end while the create is still submitting ends the wait '
              'at once, and a late $late is ignored', () async {
            final harness = _Harness();
            harness.sync();
            final (:chatId, :submitted) = harness.controller.create(_worktree);
            unawaited(submitted.then((_) {}, onError: (Object _) {}));
            Object? outcome;
            unawaited(
              harness.controller
                  .ensureCreated(_worktree, chatId)
                  .then((v) => outcome = v, onError: (Object e) => outcome = e),
            );
            await pumpEventQueue();
            expect(outcome, isNull);

            if (end == 'dispose') {
              harness.controller.dispose();
            } else {
              harness.generation = 2;
              harness.sync();
            }
            await pumpEventQueue();
            // The response is still outstanding.
            expect(harness.creates.single.response.isCompleted, isFalse);
            expect(outcome, isFalse);
            final changes = harness.changes;

            final response = harness.creates.single.response;
            switch (late) {
              case 'respond':
                response.complete('create-1');
              case 'respond empty':
                response.complete('');
              case 'transport failure':
                response.completeError(
                  const RemoteControlException('Creation unavailable.'),
                );
            }
            await pumpEventQueue();

            expect(outcome, isFalse);
            expect(harness.failedCreates, isEmpty);
            expect(harness.changes, changes);
            if (end != 'dispose') {
              expect(harness.controller.createCommandIdFor(chatId), isNull);
              // The provisional tab stays shown for a retry.
              expect(harness.rows, [chatId]);
              expect(harness.shown, chatId);
            }
          });
        }
      }

      test('a tab first listed by a send is asked for once', () async {
        final harness = _Harness();
        harness.sync();
        harness.controller.addProvisional('sent', select: true);

        final first = harness.controller.ensureCreated(_worktree, 'sent');
        final second = harness.controller.ensureCreated(_worktree, 'sent');
        await pumpEventQueue();
        expect(harness.creates.single.target.chatId, 'sent');

        harness.creates.single.response.complete('create-1');
        harness.projected = [_summary('sent')];
        harness.sync();
        expect(await first, isTrue);
        expect(await second, isTrue);
      });

      test('completes false when the controller is disposed', () async {
        final harness = _Harness();
        harness.sync();
        final created = harness.create();
        final outcome = harness.controller.ensureCreated(_worktree, created);
        harness.creates.single.response.complete('create-1');
        await pumpEventQueue();

        harness.controller.dispose();

        expect(await outcome, isFalse);
        expect(
          await harness.controller.ensureCreated(_worktree, created),
          isFalse,
        );
      });
    });

    group('CAN-3922 a create\'s created outcome', () {
      // Each sequence orders the submit response against the create's
      // terminal outcome. A rejection replayed before the response, as when
      // its event arrives first, must still settle false, and a session
      // switch ends the wait whatever the new session projects.
      const sequences = {
        'reject, respond': (['reject', 'respond'], false),
        'respond, reject': (['respond', 'reject'], false),
        'project, respond': (['project', 'respond'], true),
        'respond, project': (['respond', 'project'], true),
        'switch session, project, respond': (
          ['switch', 'project', 'respond'],
          false,
        ),
        'respond, switch session, project': (
          ['respond', 'switch', 'project'],
          false,
        ),
        'respond empty': (['respond empty'], false),
        'dispose, respond': (['dispose', 'respond'], false),
      };
      for (final MapEntry(key: name, value: (steps, listed))
          in sequences.entries) {
        test('$name settles $listed', () async {
          final harness = _Harness();
          harness.sync();
          final (:chatId, :submitted) = harness.controller.create(_worktree);
          final created = harness.controller.ensureCreated(_worktree, chatId);
          unawaited(submitted.then((_) {}, onError: (Object _) {}));
          for (final step in steps) {
            switch (step) {
              case 'reject':
                harness.creates.single.reject();
              case 'respond':
                harness.creates.single.response.complete('create-1');
              case 'respond empty':
                harness.creates.single.response.complete('');
              case 'project':
                harness.projected = [_summary(chatId)];
                harness.sync();
              case 'switch':
                harness.generation++;
                harness.sync();
              case 'dispose':
                harness.controller.dispose();
            }
            await pumpEventQueue();
          }

          expect(await created, listed);
        });
      }
    });

    test('a disposed controller ignores late outcomes', () async {
      final harness = _Harness()..projected = [_summary('a', active: true)];
      harness.sync();
      harness.create();
      harness.close('a');
      harness.controller.dispose();
      final changes = harness.changes;

      harness.creates.single.reject();
      harness.closes.single.reject();

      expect(harness.changes, changes);
      expect(harness.failedCreates, isEmpty);
      expect(harness.sync(), isFalse);
    });
  });
}
