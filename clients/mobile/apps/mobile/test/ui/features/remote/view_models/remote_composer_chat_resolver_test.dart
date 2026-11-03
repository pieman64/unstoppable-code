import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_tabs_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_chat_resolver.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'main',
);

RemoteChatSummary _summary(String chatId) => RemoteChatSummary(
  chatId: chatId,
  scope: RemoteChatScope.worktree,
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  title: 'Chat $chatId',
);

final class _Harness {
  _Harness() {
    tabs = RemoteChatTabsController(
      createTab: (target, {required onFailed}) async {
        creates.add(target);
        rejectCreate = onFailed;
        // As the send coordinator does, a response that arrives after the
        // session changed is dropped with an empty id.
        final submittedIn = generation;
        final commandId =
            await (submitCreate?.call(onFailed) ??
                Future.value('create-${creates.length}'));
        return submittedIn == generation ? commandId : '';
      },
      closeTab: (target, {required onFailed}) => Future.value('close'),
      mintChatId: () => 'chat-m${creates.length + 1}',
      sessionGeneration: () => generation,
      onChanged: () {},
      onCreateFailed: (_) {},
    );
    final overrides = ComposerOverridesController(
      submit:
          (target, field, value, {required onCompleted, required onFailed}) {
            submitted.add((target.chatId, field, value));
            return Future.value('set-${submitted.length}');
          },
      sessionGeneration: () => generation,
      projectionSequence: (_) => null,
      onChanged: () {},
    );
    resolver = RemoteComposerChatResolver(
      tabs: tabs,
      overrides: overrides,
      shownChatId: () => tabs.chatIdFor(tabs.rowsFor(projected, _worktree)),
    );
  }

  late final RemoteChatTabsController tabs;
  late final RemoteComposerChatResolver resolver;
  final creates = <RemoteWorktreeChatTarget>[];
  final submitted = <(String?, ComposerField<Object>, Object)>[];
  void Function()? rejectCreate;

  /// Answers a create submission in place of an immediate acceptance.
  Future<String> Function(void Function() onFailed)? submitCreate;
  var projected = <RemoteChatSummary>[];
  var generation = 1;

  void project(String chatId) {
    projected = [_summary(chatId)];
    tabs.sync(projected: projected, worktree: _worktree);
  }

  /// A new paired session, which the view applies on its next sync.
  void replaceSession() {
    generation++;
    tabs.sync(projected: projected, worktree: _worktree);
  }

  /// Starts a plan-mode change and records how it ends.
  List<Object?> changePlan() {
    final outcome = <Object?>[];
    unawaited(
      resolver
          .change(_worktree, ComposerField.planMode, true)
          .then((_) => outcome.add('done'), onError: outcome.add),
    );
    return outcome;
  }
}

void main() {
  group('RemoteComposerChatResolver', () {
    test('a shown chat resolves without creating a tab', () async {
      final harness = _Harness()..project('a');

      final target = await harness.resolver.chatIn(_worktree);

      expect(target.chatId, 'a');
      expect(harness.creates, isEmpty);
    });

    test('actions before the first message share one created tab', () async {
      final harness = _Harness();
      String? first;
      String? second;
      unawaited(
        harness.resolver.chatIn(_worktree).then((t) => first = t.chatId),
      );
      unawaited(
        harness.resolver.chatIn(_worktree).then((t) => second = t.chatId),
      );
      await pumpEventQueue();
      expect(harness.creates, hasLength(1));
      expect(first, isNull);

      harness.project(harness.creates.single.chatId!);
      await pumpEventQueue();

      expect(first, harness.creates.single.chatId);
      expect(second, first);
    });

    test('a change waits for the desktop to list the new tab', () async {
      final harness = _Harness();
      unawaited(
        harness.resolver.change(_worktree, ComposerField.planMode, true),
      );
      await pumpEventQueue();
      expect(harness.submitted, isEmpty);

      final chatId = harness.creates.single.chatId!;
      harness.project(chatId);
      await pumpEventQueue();

      expect(harness.submitted.single, (chatId, ComposerField.planMode, true));
    });

    test('a rejected create throws and submits nothing', () async {
      final harness = _Harness();
      final change = harness.resolver.change(
        _worktree,
        ComposerField.planMode,
        true,
      );
      await pumpEventQueue();

      harness.rejectCreate!();

      await expectLater(change, throwsA(isA<RemoteControlException>()));
      expect(harness.submitted, isEmpty);
    });

    test('a create rejected before its submission settles throws and submits '
        'nothing', () async {
      // A terminal event that arrives before the submit response is
      // replayed while the command registers, before `submitted` settles.
      final harness = _Harness()
        ..submitCreate = (onFailed) async {
          await Future<void>.value();
          onFailed();
          return 'create-1';
        };

      final change = harness.resolver.change(
        _worktree,
        ComposerField.planMode,
        true,
      );

      await expectLater(change, throwsA(isA<RemoteControlException>()));
      expect(harness.creates, hasLength(1));
      expect(harness.tabs.pendingChatIds, isEmpty);
      expect(harness.submitted, isEmpty);
    });

    // Session replacement can leave the create's submission unanswered,
    // drop it (an empty command id) or leave it unlisted; either way the
    // waiting actions end at once with an error the user can retry, and
    // nothing is written for the old session.
    for (final (during, late) in [
      ('after the create is accepted', null),
      ('while the create is submitted', 'a late acceptance'),
      ('while the create is submitted', 'a late transport failure'),
    ]) {
      test('a session replaced $during fails the waiting actions'
          '${late == null ? '' : ' before $late'}, and a retry creates the '
          'same tab again', () async {
        final submission = Completer<String>();
        final harness = _Harness();
        if (late != null) harness.submitCreate = (_) => submission.future;
        final first = harness.changePlan();
        final second = harness.changePlan();
        await pumpEventQueue();
        final chatId = harness.creates.single.chatId!;

        harness.replaceSession();
        await pumpEventQueue();

        expect(submission.isCompleted, isFalse);
        expect(first, [isA<RemoteControlException>()]);
        expect(second, [isA<RemoteControlException>()]);
        expect(harness.submitted, isEmpty);
        // The provisional tab stays shown.
        expect(harness.tabs.pendingChatIds, {chatId});

        // The old session's answer arrives late and changes nothing.
        if (late == 'a late acceptance') submission.complete('create-1');
        if (late == 'a late transport failure') {
          submission.completeError(
            const RemoteControlException('Desktop offline'),
          );
        }
        await pumpEventQueue();
        expect(first, hasLength(1));
        expect(second, hasLength(1));
        expect(harness.submitted, isEmpty);
        expect(harness.tabs.pendingChatIds, {chatId});

        harness.submitCreate = null;
        final retry = harness.changePlan();
        await pumpEventQueue();
        expect(harness.creates.map((target) => target.chatId), [
          chatId,
          chatId,
        ]);
        expect(retry, isEmpty);

        harness.project(chatId);
        await pumpEventQueue();
        expect(retry, ['done']);
        expect(harness.submitted.single, (
          chatId,
          ComposerField.planMode,
          true,
        ));
      });
    }

    test('a view disposed while waiting for the listing throws and submits '
        'nothing', () async {
      final harness = _Harness();
      final outcome = harness.changePlan();
      await pumpEventQueue();
      expect(outcome, isEmpty);

      harness.tabs.dispose();
      await pumpEventQueue();

      expect(outcome, [isA<RemoteControlException>()]);
      expect(harness.submitted, isEmpty);
    });

    test('a view disposed while the create is submitted throws and submits '
        'nothing', () async {
      final submission = Completer<String>();
      final harness = _Harness()..submitCreate = (_) => submission.future;
      final change = harness.resolver.change(
        _worktree,
        ComposerField.planMode,
        true,
      );
      await pumpEventQueue();

      Object? outcome;
      unawaited(change.then((_) {}, onError: (Object e) => outcome = e));

      harness.tabs.dispose();
      await pumpEventQueue();
      // The wait ends before the submission is answered.
      expect(submission.isCompleted, isFalse);
      expect(outcome, isA<RemoteControlException>());

      submission.complete('create-1');
      await pumpEventQueue();
      expect(harness.submitted, isEmpty);
    });
  });
}
