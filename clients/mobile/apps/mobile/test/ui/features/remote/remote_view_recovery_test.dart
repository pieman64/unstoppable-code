import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show kRemoteFreshResumeAfter;

import '../../../support/fake_remote_control_repository.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'main',
);
const _target = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-1',
);
const _summary = RemoteChatSummary(
  chatId: 'chat-1',
  scope: RemoteChatScope.worktree,
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  title: 'Existing chat',
);

void main() {
  test(
    'fresh recovery settles a submitted standalone composer choice',
    () async {
      var now = DateTime(2026, 10, 24, 12);
      final vm = RemoteControlViewModel(
        repository: FakeRemoteControlRepository(),
        clock: () => now,
      );
      addTearDown(vm.dispose);
      await vm.connect('123456');
      final overrides = vm.composerOverrides(onChanged: () {});
      addTearDown(overrides.dispose);
      await overrides.chooseModel(
        const RemoteStandaloneChatTarget(chatId: 'standalone-1'),
        'claude-sonnet',
      );
      var settled = false;
      unawaited(
        overrides.settled('standalone-1', ComposerField.model).then((_) {
          settled = true;
        }),
      );
      vm.onAppBackgrounded();
      now = now.add(kRemoteFreshResumeAfter);
      await vm.onAppForegrounded();
      overrides.sync();
      await pumpEventQueue();
      expect(overrides.valueOf('standalone-1', ComposerField.model), isNull);
      expect(settled, isTrue);
    },
  );

  for (final fresh in [true, false]) {
    test(
      '${fresh ? 'fresh' : 'warm'} recovery reconciles view-owned commands',
      () async {
        var now = DateTime(2026, 10, 24, 12);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [_worktree],
            chatSummaries: [_summary],
          );
        final vm = RemoteControlViewModel(
          repository: repository,
          clock: () => now,
        );
        addTearDown(vm.dispose);
        await vm.connect('123456');
        final pairing = vm.sessionGeneration;
        final tabs = vm.chatTabs(onChanged: () {}, onCreateFailed: (_) {});
        final overrides = vm.composerOverrides(onChanged: () {});
        addTearDown(tabs.dispose);
        addTearDown(overrides.dispose);
        void sync() {
          tabs.sync(projected: [_summary], worktree: _worktree);
          overrides.sync();
        }

        sync();
        // Keep a provisional tab and its local send option through recovery.
        tabs.addProvisional('draft-tab');
        await overrides.change(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: 'draft-tab',
          ),
          ComposerField.fastMode,
          true,
          local: true,
        );
        await tabs.close(_worktree, 'chat-1');
        repository.setPlanModeHandler = (_) async => 'override-old';
        await overrides.change(_target, ComposerField.planMode, true);
        var settled = false;
        unawaited(
          overrides.settled('chat-1', ComposerField.planMode).then((_) {
            settled = true;
          }),
        );
        expect(tabs.rowsFor([_summary], _worktree).map((r) => r.chatId), [
          'draft-tab',
        ]);
        expect(overrides.valueOf('chat-1', ComposerField.planMode), isTrue);

        vm.onAppBackgrounded();
        // No terminal command event is delivered during the skipped window.
        now = now.add(
          fresh ? kRemoteFreshResumeAfter : const Duration(seconds: 5),
        );
        await vm.onAppForegrounded();
        sync();
        await pumpEventQueue();

        expect(vm.sessionGeneration, pairing);
        expect(
          tabs.rowsFor([_summary], _worktree).map((r) => r.chatId),
          fresh ? ['chat-1', 'draft-tab'] : ['draft-tab'],
        );
        expect(
          overrides.valueOf('chat-1', ComposerField.planMode),
          fresh ? isNull : isTrue,
        );
        expect(settled, fresh);
        expect(tabs.isPending('draft-tab'), isTrue);
        expect(overrides.valueOf('draft-tab', ComposerField.fastMode), isTrue);
        expect(repository.closeChatTabTargets, hasLength(1));
        expect(repository.setPlanModeTargets, hasLength(1));
        if (fresh) {
          final oldClose = repository.closeChatTabCommandIds.single;
          await tabs.close(_worktree, 'chat-1');
          repository.setPlanModeHandler = (_) async => 'override-new';
          await overrides.change(_target, ComposerField.planMode, false);
          // Late outcomes from commands submitted before recovery must not
          // settle the replacement close or the newer composer choice.
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteCommandFailedEvent(
                  commandId: oldClose,
                  message: 'Late close',
                ),
                const RemoteCommandFailedEvent(
                  commandId: 'override-old',
                  message: 'Late override',
                ),
              ],
              nextCursor: 1,
            ),
          );
          await pumpEventQueue();
          sync();
          expect(tabs.rowsFor([_summary], _worktree).map((r) => r.chatId), [
            'draft-tab',
          ]);
          expect(overrides.valueOf('chat-1', ComposerField.planMode), isFalse);
        }
      },
    );
  }
}
