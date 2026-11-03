import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_draft_coordinator.dart';

void main() {
  late TextEditingController controller;
  late InMemoryChatDraftStore store;
  late ComposerDraftBinding binding;
  late RemoteChatDraftCoordinator drafts;

  setUp(() {
    controller = TextEditingController();
    store = InMemoryChatDraftStore();
    binding = ComposerDraftBinding(controller: controller, store: store);
    drafts = RemoteChatDraftCoordinator(
      store: store,
      binding: binding,
      composerText: () => controller.text,
    );
  });
  tearDown(() {
    binding.dispose();
    controller.dispose();
  });

  test('new-chat draft follows the first standalone chat', () {
    const workspace = RemoteWorkspace(
      localId: 'ws-1',
      name: 'Workspace',
      type: RemoteWorkspaceType.singleRepo,
    );
    final newChat = drafts.targetFor(
      workspace: workspace,
      worktree: null,
      standaloneChat: null,
      chatId: null,
    );
    expect(newChat, const RemoteNewChatDraftTarget('ws-1'));
    binding.bind(newChat);
    controller.text = 'typed before the chat exists';
    drafts.resumeUnsentFirstChat(const RemoteStandaloneChatDraftTarget('c1'));
    expect(store.draftFor(newChat!), isEmpty);
    expect(
      store.draftFor(const RemoteStandaloneChatDraftTarget('c1')),
      'typed before the chat exists',
    );
    expect(drafts.sentFromNewChat, isTrue);
  });

  test('a created worktree takes the new-chat draft as its own', () {
    const workspace = RemoteWorkspace(
      localId: 'ws-1',
      name: 'Workspace',
      type: RemoteWorkspaceType.singleRepo,
    );
    const created = RemoteWorktree(
      localId: 'wt-2',
      workspaceLocalId: 'ws-1',
      branch: 'canopy/otter',
    );
    binding.bind(
      drafts.targetFor(
        workspace: workspace,
        worktree: null,
        standaloneChat: null,
        chatId: null,
      ),
    );
    controller.text = 'typed while the worktree was created';

    final worktreeTarget = drafts.targetFor(
      workspace: workspace,
      worktree: created,
      standaloneChat: null,
      chatId: null,
    );
    expect(
      worktreeTarget,
      const RemoteWorktreeChatDraftTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-2',
      ),
    );
    drafts.switchTarget(worktreeTarget);

    expect(controller.text, 'typed while the worktree was created');
    expect(store.draftFor(const RemoteNewChatDraftTarget('ws-1')), isEmpty);
    expect(
      store.draftFor(worktreeTarget!),
      'typed while the worktree was created',
    );
    // Text typed afterwards belongs to the worktree, not the next new chat.
    controller.text = 'left unsent';
    expect(store.draftFor(const RemoteNewChatDraftTarget('ws-1')), isEmpty);
    expect(store.draftFor(worktreeTarget), 'left unsent');
  });

  test('only unprojected unsent chats become provisional tabs', () {
    expect(
      drafts.firstUnprojectedChat(['shown', 'lost'], (id) => id == 'shown'),
      'lost',
    );
    expect(
      drafts.adoptableChatIds(
        unsentChatIds: ['shown', 'pending', 'lost'],
        pendingChatIds: {'pending'},
        projectedChatIds: {'shown'},
        isLoading: false,
      ),
      ['lost'],
    );
    expect(
      drafts.adoptableChatIds(
        unsentChatIds: ['lost'],
        pendingChatIds: {},
        projectedChatIds: {},
        isLoading: true,
      ),
      isEmpty,
    );
  });

  test('failed provisional tab preserves typed text in a reachable draft', () {
    const worktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'main',
    );
    const failed = RemoteWorktreeChatDraftTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'failed',
    );
    const selected = RemoteWorktreeChatDraftTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'selected',
    );
    store.setDraft(failed, 'new text');
    store.setDraft(selected, 'existing text');
    drafts.preserveFailedTabDraft(
      worktree: worktree,
      failedChatId: 'failed',
      next: selected,
    );
    expect(store.draftFor(failed), isEmpty);
    expect(store.draftFor(selected), 'new text\nexisting text');
  });
}
