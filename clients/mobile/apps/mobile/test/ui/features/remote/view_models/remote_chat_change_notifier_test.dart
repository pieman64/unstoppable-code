import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../../../../support/fake_remote_control_repository.dart';

const _chat = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-1',
);

RemotePortalEventBatch _batch(List<RemotePortalEvent> events) =>
    RemotePortalEventBatch(events: events, nextCursor: 1);

RemoteChatMessageEvent _live(String chatId) => RemoteChatMessageEvent(
  chatId: chatId,
  scope: RemoteChatScope.worktree,
  message: RemoteChatMessage(
    messageId: 'row-$chatId',
    chatId: chatId,
    scope: RemoteChatScope.worktree,
    role: ChatRole.assistant,
    status: ChatMessageStatus.streaming,
    text: 'streaming',
  ),
);

Future<void> _pump() => Future<void>.delayed(Duration.zero);

void main() {
  Future<(FakeRemoteControlRepository, RemoteControlViewModel)>
  connected() async {
    final repository = FakeRemoteControlRepository();
    final viewModel = RemoteControlViewModel(repository: repository);
    await viewModel.connect('123456');
    return (repository, viewModel);
  }

  test('notifies for its own chat and never for others', () async {
    final (repository, viewModel) = await connected();
    final changes = viewModel.chatChangesFor(_chat);
    var chatNotifications = 0;
    var viewModelNotifications = 0;
    changes.addListener(() => chatNotifications++);
    viewModel.addListener(() => viewModelNotifications++);

    repository.eventsController.add(
      _batch([
        _live('chat-2'),
        const RemoteStateDeltaEvent(
          prProgress: {
            'ws-1:wt-1': RemotePrProgressState(
              creation: RemotePrCreationProgress(
                steps: [],
                currentPhase: RemotePrCreationPhase.pushing,
              ),
            ),
          },
        ),
      ]),
    );
    await _pump();
    expect(viewModelNotifications, greaterThan(0));
    expect(chatNotifications, 0);

    repository.eventsController.add(_batch([_live('chat-1')]));
    await _pump();
    expect(chatNotifications, 1);

    changes.dispose();
    viewModel.dispose();
  });

  test('a chatless target never notifies', () async {
    final (repository, viewModel) = await connected();
    final none = viewModel.chatChangesFor(null);
    final chatless = viewModel.chatChangesFor(
      const RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      ),
    );
    var notifications = 0;
    none.addListener(() => notifications++);
    chatless.addListener(() => notifications++);
    repository.eventsController.add(_batch([_live('chat-1')]));
    await _pump();
    expect(notifications, 0);
    none.dispose();
    chatless.dispose();
    viewModel.dispose();
  });

  test('a session reset notifies even though counters restart', () async {
    final (repository, viewModel) = await connected();
    repository.eventsController.add(_batch([_live('chat-1')]));
    await _pump();
    final changes = viewModel.chatChangesFor(_chat);
    var notifications = 0;
    changes.addListener(() => notifications++);
    await viewModel.disconnect();
    expect(notifications, greaterThan(0));
    changes.dispose();
    viewModel.dispose();
  });

  test('dispose stops delivery, before or after the view model', () async {
    final (repository, viewModel) = await connected();
    final changes = viewModel.chatChangesFor(_chat);
    var notifications = 0;
    changes.addListener(() => notifications++);
    changes.dispose();
    repository.eventsController.add(_batch([_live('chat-1')]));
    await _pump();
    expect(notifications, 0);

    final late = viewModel.chatChangesFor(_chat);
    viewModel.dispose();
    expect(late.dispose, returnsNormally);
  });
}
