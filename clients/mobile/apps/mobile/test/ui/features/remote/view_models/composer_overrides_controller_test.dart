// Deterministic event sequences for the optimistic composer state machine:
// user choices, submit responses, terminal outcomes, projections, and
// session switches arrive in each named order.
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';

const _chat = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-1',
);
const _other = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-2',
);
const _standalone = RemoteStandaloneChatTarget(chatId: 'cc-1');

/// One submitted composer command, held until the test answers it.
typedef _Command = ({
  ComposerField<Object> field,
  Object value,
  Completer<String> response,
  void Function(int completedAt) complete,
  void Function() reject,
});

final class _Harness {
  _Harness() {
    controller = ComposerOverridesController(
      submit:
          (target, field, value, {required onCompleted, required onFailed}) {
            final response = Completer<String>();
            commands.add((
              field: field,
              value: value,
              response: response,
              complete: onCompleted,
              reject: onFailed,
            ));
            return response.future;
          },
      sessionGeneration: () => generation,
      projectionSequence: (target) => projections[target.chatId],
      onChanged: () => changes++,
    );
  }

  late final ComposerOverridesController controller;
  final commands = <_Command>[];
  final projections = <String?, int>{};
  final errors = <Object>[];
  var generation = 1;
  var changes = 0;

  void change<T extends Object>(
    RemoteChatTarget target,
    ComposerField<T> field,
    T value, {
    bool local = false,
  }) => unawaited(
    controller
        .change(target, field, value, local: local)
        .then((_) {}, onError: errors.add),
  );

  bool? plan([String chatId = 'chat-1']) =>
      controller.valueOf(chatId, ComposerField.planMode);

  bool sync() => controller.sync();
}

void main() {
  group('ComposerOverridesController', () {
    test('a choice holds through a matching pre-completion projection', () {
      final harness = _Harness()..projections['chat-1'] = 1;
      harness.change(_chat, ComposerField.planMode, true);
      expect(harness.plan(), isTrue);

      harness.projections['chat-1'] = 2;
      harness.sync();

      expect(harness.plan(), isTrue);
    });

    test('completion plus a newer projection releases the value, whatever '
        'that projection says', () async {
      final harness = _Harness()..projections['chat-1'] = 1;
      harness.change(_chat, ComposerField.planMode, true);
      harness.commands.single.response.complete('cmd-1');
      await pumpEventQueue();

      harness.commands.single.complete(3);
      harness.projections['chat-1'] = 3;
      expect(harness.sync(), isFalse);
      expect(harness.plan(), isTrue);

      harness.projections['chat-1'] = 4;
      expect(harness.sync(), isTrue);
      expect(harness.plan(), isNull);
    });

    test(
      'a completion observed before a newer projection releases at once',
      () {
        final harness = _Harness()..projections['chat-1'] = 5;
        harness.change(_chat, ComposerField.planMode, true);
        final changes = harness.changes;

        // The terminal raced the submit response: its completion was recorded
        // at sequence 4, and projection 5 has already arrived.
        harness.commands.single.complete(4);

        expect(harness.plan(), isNull);
        expect(harness.changes, changes + 1);
      },
    );

    test('the latest choice wins over an older answer', () async {
      final harness = _Harness();
      harness.change(_chat, ComposerField.planMode, true);
      harness.change(_chat, ComposerField.planMode, false);

      harness.commands.first.reject();
      harness.commands.first.response.completeError(
        const RemoteControlException('Old submit rejected'),
      );
      await pumpEventQueue();

      expect(harness.plan(), isFalse);
      expect(harness.errors, isEmpty);
    });

    test(
      'a rejected latest choice returns to the projection and reports',
      () async {
        final harness = _Harness();
        harness.change(_chat, ComposerField.planMode, true);
        harness.commands.single.response.completeError(
          const RemoteControlException('Rejected'),
        );
        await pumpEventQueue();

        expect(harness.plan(), isNull);
        expect(harness.errors.single, isA<RemoteControlException>());
      },
    );

    test('an asynchronous rejection returns to the projection', () async {
      final harness = _Harness();
      harness.change(_chat, ComposerField.model, 'gpt-5-codex');
      harness.commands.single.response.complete('cmd-1');
      await pumpEventQueue();

      harness.commands.single.reject();

      expect(harness.controller.valueOf('chat-1', ComposerField.model), isNull);
      expect(harness.errors, isEmpty);
    });

    test('an empty command id discards the value', () async {
      final harness = _Harness();
      harness.change(_chat, ComposerField.thinkingLevel, 'high');
      harness.commands.single.response.complete('');
      await pumpEventQueue();

      expect(
        harness.controller.valueOf('chat-1', ComposerField.thinkingLevel),
        isNull,
      );
    });

    test('fields and chats are isolated', () async {
      final harness = _Harness();
      harness.change(_chat, ComposerField.planMode, true);
      harness.change(_chat, ComposerField.fastMode, true);
      harness.change(_other, ComposerField.planMode, false);

      harness.commands[0].reject();

      expect(harness.plan(), isNull);
      expect(
        harness.controller.valueOf('chat-1', ComposerField.fastMode),
        isTrue,
      );
      expect(harness.plan('chat-2'), isFalse);
    });

    test('local values are never submitted nor released by projections', () {
      final harness = _Harness();
      harness.change(
        _standalone,
        ComposerField.thinkingLevel,
        'off',
        local: true,
      );
      harness.projections['cc-1'] = 9;
      harness.generation++;
      harness.sync();

      expect(harness.commands, isEmpty);
      expect(
        harness.controller.valueOf('cc-1', ComposerField.thinkingLevel),
        'off',
      );
    });

    // Each sequence names the order of events around a session switch.
    group('session switch', () {
      test('choice → switch: the value returns to the projection', () {
        final harness = _Harness();
        harness.change(_chat, ComposerField.planMode, true);
        harness.generation++;

        expect(harness.sync(), isTrue);
        expect(harness.plan(), isNull);
      });

      for (final late in ['response', 'rejection', 'completion', 'failure']) {
        test('choice → switch → late $late changes nothing', () async {
          final harness = _Harness()..projections['chat-1'] = 1;
          harness.change(_chat, ComposerField.planMode, true);
          final command = harness.commands.single;
          harness.generation++;
          harness.sync();
          // The replacement session's own choice must survive old answers.
          harness.change(_chat, ComposerField.planMode, false);
          final changes = harness.changes;

          switch (late) {
            case 'response':
              command.response.complete('old-cmd');
            case 'rejection':
              command.response.completeError(
                const RemoteControlException('Old submit rejected'),
              );
            case 'completion':
              harness.projections['chat-1'] = 2;
              command.complete(0);
            case 'failure':
              command.reject();
          }
          await pumpEventQueue();

          expect(harness.plan(), isFalse);
          expect(harness.errors, isEmpty);
          expect(harness.changes, changes);
        });
      }
    });

    // Auto and a concrete model are one choice (CAN-3917).
    group('Auto', () {
      bool auto(_Harness harness, {required bool projected}) =>
          harness.controller.autoSelected('chat-1', projected: projected);
      void chooseAuto(_Harness harness) => unawaited(
        harness.controller
            .chooseAuto(_chat)
            .then((_) {}, onError: harness.errors.add),
      );
      void chooseModel(_Harness harness, String model) => unawaited(
        harness.controller
            .chooseModel(_chat, model)
            .then((_) {}, onError: harness.errors.add),
      );

      test('select → reject returns to the manual projection', () async {
        final harness = _Harness();
        chooseAuto(harness);
        expect(auto(harness, projected: false), isTrue);
        expect(harness.commands.single.field, ComposerField.autoModel);
        expect(harness.commands.single.value, isTrue);

        harness.commands.single.reject();
        await pumpEventQueue();

        expect(auto(harness, projected: false), isFalse);
      });

      test('select → completion → newer projection releases to the desktop '
          'mode', () async {
        final harness = _Harness()..projections['chat-1'] = 1;
        chooseAuto(harness);
        harness.commands.single.response.complete('cmd-1');
        await pumpEventQueue();
        harness.commands.single.complete(2);
        harness.projections['chat-1'] = 3;
        expect(harness.sync(), isTrue);

        expect(
          harness.controller.valueOf('chat-1', ComposerField.autoModel),
          isNull,
        );
        expect(auto(harness, projected: true), isTrue);
      });

      test('Auto → model before the answer: the model wins and the late '
          'Auto answer changes nothing', () async {
        final harness = _Harness()..projections['chat-1'] = 1;
        chooseAuto(harness);
        final autoCommand = harness.commands.single;
        chooseModel(harness, 'claude-opus');

        expect(auto(harness, projected: false), isFalse);
        expect(
          harness.controller.valueOf('chat-1', ComposerField.model),
          'claude-opus',
        );
        final changes = harness.changes;
        autoCommand.response.complete('cmd-auto');
        await pumpEventQueue();
        autoCommand.complete(2);
        autoCommand.reject();

        expect(harness.changes, changes);
        expect(auto(harness, projected: false), isFalse);
      });

      test(
        'a model pick on an Auto chat shows manual until rejected',
        () async {
          final harness = _Harness();
          chooseModel(harness, 'claude-opus');
          expect(auto(harness, projected: true), isFalse);

          harness.commands.single.reject();
          await pumpEventQueue();

          expect(auto(harness, projected: true), isTrue);
        },
      );

      test('model → Auto drops the pending model', () {
        final harness = _Harness();
        chooseModel(harness, 'claude-opus');
        chooseAuto(harness);

        expect(
          harness.controller.valueOf('chat-1', ComposerField.model),
          isNull,
        );
        expect(auto(harness, projected: false), isTrue);
      });

      test('select → session switch returns to the projection', () {
        final harness = _Harness();
        chooseAuto(harness);
        harness.generation++;

        expect(harness.sync(), isTrue);
        expect(auto(harness, projected: false), isFalse);
      });
    });

    test('a disposed controller ignores late outcomes', () async {
      final harness = _Harness();
      harness.change(_chat, ComposerField.planMode, true);
      harness.controller.dispose();
      final changes = harness.changes;

      harness.commands.single.reject();
      harness.commands.single.response.completeError(
        const RemoteControlException('Rejected'),
      );
      await pumpEventQueue();

      expect(harness.changes, changes);
      expect(harness.errors, isEmpty);
      expect(harness.controller.sync(), isFalse);
    });

    group('CAN-3922 settle outcomes', () {
      const selections = <String, Object?>{
        'collectionIds': ['kit'],
      };

      List<bool> watch(_Harness harness, {RemoteChatTarget target = _chat}) {
        final outcomes = <bool>[];
        unawaited(
          harness.controller
              .change(
                target,
                ComposerField.pluginSelections,
                selections,
                onSettled: outcomes.add,
              )
              .then((_) {}, onError: harness.errors.add),
        );
        return outcomes;
      }

      test('completion reports applied once and holds the value', () async {
        final harness = _Harness();
        final outcomes = watch(harness);
        expect(
          harness.controller.valueOf('chat-1', ComposerField.pluginSelections),
          selections,
        );
        harness.commands.single.response.complete('cmd-1');
        await Future<void>.delayed(Duration.zero);
        harness.commands.single.complete(4);
        harness.projections['chat-1'] = 5;
        harness.sync();
        expect(outcomes, [true]);
      });

      test(
        'a rejection, an empty id, and a transport error report false',
        () async {
          final rejected = _Harness();
          final rejectedOutcomes = watch(rejected);
          rejected.commands.single.response.complete('cmd-1');
          await Future<void>.delayed(Duration.zero);
          rejected.commands.single.reject();
          expect(rejectedOutcomes, [false]);
          expect(
            rejected.controller.valueOf(
              'chat-1',
              ComposerField.pluginSelections,
            ),
            isNull,
          );

          final empty = _Harness();
          final emptyOutcomes = watch(empty);
          empty.commands.single.response.complete('');
          await Future<void>.delayed(Duration.zero);
          expect(emptyOutcomes, [false]);

          final failed = _Harness();
          final failedOutcomes = watch(failed);
          failed.commands.single.response.completeError(
            const RemoteControlException('offline'),
          );
          await Future<void>.delayed(Duration.zero);
          expect(failedOutcomes, [false]);
          expect(failed.errors, hasLength(1));
        },
      );

      test(
        'a newer choice or a new session supersedes a pending one',
        () async {
          final harness = _Harness();
          final first = watch(harness);
          final second = watch(harness);
          expect(first, [false]);
          expect(second, isEmpty);
          harness.generation = 2;
          harness.sync();
          expect(second, [false]);
          // A late answer for the superseded choice reports nothing more.
          harness.commands.first.response.complete('cmd-1');
          await Future<void>.delayed(Duration.zero);
          harness.commands.first.reject();
          expect(first, [false]);
        },
      );

      test('a chat with no id cannot hold a choice', () {
        final harness = _Harness();
        final outcomes = watch(
          harness,
          target: const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        expect(outcomes, [false]);
        expect(harness.commands, isEmpty);
      });
    });
  });
}
