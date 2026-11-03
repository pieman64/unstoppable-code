import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/composer_overrides_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_tabs_controller.dart';

/// The worktree chat a composer action applies to (CAN-3922).
///
/// Before its first message a worktree shows no chat, so the first action
/// creates one through [RemoteChatTabsController.create], the same
/// provisional-tab lifecycle as a new tab from the tabs sheet: the tab is
/// selected at once and the draft moves to it. Actions wait until the
/// desktop lists the tab, so no setter reaches a chat it has not created,
/// and fail when the session that created it is replaced first.
final class RemoteComposerChatResolver {
  RemoteComposerChatResolver({
    required this.tabs,
    required this.overrides,
    required this.shownChatId,
  });

  final RemoteChatTabsController tabs;
  final ComposerOverridesController overrides;

  /// The chat the view shows now, if any.
  final String? Function() shownChatId;

  /// The chat shown in [worktree] once the desktop lists it, after creating
  /// the first tab when none is shown. Throws [RemoteControlException] when
  /// the tab cannot be created in this session.
  Future<RemoteWorktreeChatTarget> chatIn(RemoteWorktree worktree) async {
    // A caller can be building, such as a sheet that loads as it opens, and
    // a new tab changes the view, so the chat resolves after that work.
    await Future<void>.value();
    final shown = shownChatId();
    final chatId = shown == null || shown.isEmpty
        ? tabs.create(worktree).chatId
        : shown;
    if (!await tabs.ensureCreated(worktree, chatId)) {
      throw const RemoteControlException('The chat could not be created.');
    }
    return RemoteWorktreeChatTarget(
      workspaceLocalId: worktree.workspaceLocalId,
      worktreeLocalId: worktree.localId,
      chatId: chatId,
    );
  }

  /// Sets [field] to [value] on [worktree]'s chat, as [chatIn] resolves it.
  Future<void> change<T extends Object>(
    RemoteWorktree worktree,
    ComposerField<T> field,
    T value,
  ) async => overrides.change(await chatIn(worktree), field, value);
}
