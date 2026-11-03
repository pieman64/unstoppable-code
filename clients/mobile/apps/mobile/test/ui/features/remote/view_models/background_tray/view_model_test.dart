import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/run_lifetime.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/view_model.dart';

import 'fixtures.dart';

RemoteChatSummary summary({int? delegates}) => RemoteChatSummary(
  chatId: 'chat',
  scope: RemoteChatScope.worktree,
  title: 'Chat',
  backgroundDelegations: delegates,
);

void main() {
  test(
    'counts only unlisted delegates, deduping listed native tasks and old hosts',
    () {
      final model = BackgroundTrayViewModel(onChanged: () {});
      addTearDown(model.dispose);
      final process = task(
        'agent',
        kind: RemoteBackgroundProcessKind.agent,
      ).process;
      final messages = [
        message([nativeAgent(), delegate()]),
      ];
      model.update(
        target: target,
        backgroundProcesses: [process],
        messages: messages,
        chatSummary: summary(delegates: 3),
      );
      expect(model.summary.text, '4 running in the background');
      expect(model.summary.groups.single.items.map((item) => item.id), [
        'claude:tool-agent',
        'managed:d1',
        'unlisted-delegates',
      ]);
      expect(model.summary.kinds.single.count, 4);
      for (final count in <int?>[null, 0, 1]) {
        model.update(
          target: target,
          backgroundProcesses: [process],
          messages: messages,
          chatSummary: summary(delegates: count),
        );
        expect(model.summary.text, '2 running in the background');
        expect(model.summary.groups.single.items, hasLength(2));
      }
    },
  );

  test(
    'scopes process, transcript, summary and pipeline input to the selected chat',
    () {
      final model = BackgroundTrayViewModel(onChanged: () {});
      addTearDown(model.dispose);
      final base = task('foreign').process.toJson();
      model.update(
        target: target,
        backgroundProcesses: [
          for (final entry in {
            'chatId': 'other',
            'workspaceLocalId': 'other',
            'worktreeLocalId': 'other',
          }.entries)
            RemoteBackgroundProcess.fromJson({
              ...base,
              entry.key: entry.value,
            })!,
        ],
        messages: [
          message([delegate()], chatId: 'other'),
          RemoteChatMessage(
            messageId: 'wrong-scope',
            chatId: 'chat',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: '',
            scope: RemoteChatScope.standalone,
            parts: [delegate()],
          ),
        ],
        pipelineRuns: [pipeline('foreign', chatId: 'other')],
        chatSummary: const RemoteChatSummary(
          chatId: 'other',
          scope: RemoteChatScope.worktree,
          title: 'Other',
          backgroundDelegations: 4,
        ),
      );
      expect(model.summary.isHidden, isTrue);
    },
  );

  test(
    'run lifetime survives chat switches, dismiss and restarting a finished run',
    () {
      final model = BackgroundTrayViewModel(onChanged: () {});
      addTearDown(model.dispose);
      const other = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        chatId: 'other',
      );
      model.update(
        target: target,
        pipelineRuns: [
          pipeline('live'),
          pipeline('history', status: 'success'),
        ],
      );
      expect(model.summary.text, '1 running in the background');
      model.dismissRun('canopy:pipeline_run:execution:live');
      expect(model.summary.isHidden, isFalse);
      model.update(
        target: other,
        pipelineRuns: [pipeline('live', status: 'failed', chatId: 'other')],
      );
      expect(model.summary.isHidden, isTrue);
      model.update(
        target: target,
        pipelineRuns: [pipeline('live', status: 'failed')],
      );
      expect(model.summary.text, '1 finished');
      model.dismissRun('canopy:pipeline_run:execution:live');
      expect(model.summary.isHidden, isTrue);
      model.update(
        target: target,
        pipelineRuns: [pipeline('live', status: 'queued')],
      );
      model.update(
        target: target,
        pipelineRuns: [pipeline('live', status: 'success')],
      );
      expect(model.summary.text, '1 finished');
    },
  );

  for (final initiallyHasReceipt in [false, true]) {
    test(
      'finished retention survives receipt ${initiallyHasReceipt ? 'removal' : 'arrival'}',
      () {
        final model = BackgroundTrayViewModel(onChanged: () {});
        addTearDown(model.dispose);
        List<RemoteChatMessage> messages(bool hasReceipt) => [
          if (hasReceipt) message([receipt('live')]),
        ];

        model.update(
          target: target,
          messages: messages(initiallyHasReceipt),
          pipelineRuns: [pipeline('live')],
        );
        model.update(
          target: target,
          messages: messages(!initiallyHasReceipt),
          pipelineRuns: [pipeline('live', status: 'success')],
        );
        expect(model.summary.text, '1 finished');
      },
    );
  }

  for (final initiallyHasReceipt in [false, true]) {
    test(
      'dismissal survives receipt ${initiallyHasReceipt ? 'removal' : 'arrival'}',
      () {
        final model = BackgroundTrayViewModel(onChanged: () {});
        addTearDown(model.dispose);
        List<RemoteChatMessage> messages(bool hasReceipt) => [
          if (hasReceipt) message([receipt('live')]),
        ];

        // Observe the live run in both transcript windows before dismissal.
        for (final hasReceipt in [!initiallyHasReceipt, initiallyHasReceipt]) {
          model.update(
            target: target,
            messages: messages(hasReceipt),
            pipelineRuns: [pipeline('live')],
          );
        }
        model.update(
          target: target,
          messages: messages(initiallyHasReceipt),
          pipelineRuns: [pipeline('live', status: 'success')],
        );
        final runId = model.summary.groups.single.items.single.id;
        model.dismissRun(runId);
        expect(model.summary.isHidden, isTrue);
        model.update(
          target: target,
          messages: messages(!initiallyHasReceipt),
          pipelineRuns: [pipeline('live', status: 'success')],
        );
        expect(model.summary.isHidden, isTrue);
      },
    );
  }

  test(
    'an injected session lifetime survives remount without persisting history',
    () {
      final memory = BackgroundTrayRunLifetime();
      final first = BackgroundTrayViewModel(onChanged: () {}, lifetime: memory);
      first.update(target: target, pipelineRuns: [pipeline('r')]);
      first.dispose();
      final second = BackgroundTrayViewModel(
        onChanged: () {},
        lifetime: memory,
      );
      addTearDown(second.dispose);
      second.update(
        target: target,
        pipelineRuns: [pipeline('r', status: 'success')],
      );
      expect(second.summary.text, '1 finished');
    },
  );

  test(
    'clock stops for hidden trays and new chats and never restarts after dispose',
    () {
      fakeAsync((async) {
        var notifications = 0;
        final model = BackgroundTrayViewModel(
          onChanged: () => notifications++,
          nowMs: () => async.elapsed.inMilliseconds,
        );
        model.setExpanded(true);
        expect(async.periodicTimerCount, 0);
        model.update(
          target: target,
          backgroundProcesses: [task('shell').process],
        );
        model.setExpanded(true);
        expect(model.expanded, isTrue);
        expect(async.periodicTimerCount, 1);
        async.elapse(const Duration(seconds: 1));
        expect(model.now, 1000);
        model.update(target: target);
        expect(model.expanded, isFalse);
        expect(async.periodicTimerCount, 0);
        model.update(
          target: target,
          backgroundProcesses: [task('shell').process],
        );
        model.setExpanded(true);
        model.update(
          target: const RemoteStandaloneChatTarget(chatId: 'chat'),
          messages: [
            message([delegate()]),
          ],
        );
        expect(model.expanded, isFalse);
        expect(async.periodicTimerCount, 0);
        expect(model.summary.text, '1 running in the background');
        model.dispose();
        final before = notifications;
        model.update(
          target: target,
          backgroundProcesses: [task('shell').process],
        );
        model.setExpanded(true);
        async.elapse(const Duration(seconds: 3));
        expect(notifications, before);
        expect(async.periodicTimerCount, 0);
      });
    },
  );

  test('a worktree draft without a chat id has no tray', () {
    final model = BackgroundTrayViewModel(onChanged: () {});
    addTearDown(model.dispose);
    model.update(
      target: const RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
      ),
      backgroundProcesses: [task('shell').process],
    );
    expect(model.summary.isHidden, isTrue);
  });
}
