import 'remote_identity.dart';

/// The chat tab last shown in each worktree, so reopening a worktree shows
/// the tab the user left (CAN-3940).
///
/// Memory only: it is not persisted and not sent to the desktop. A new
/// session generation (a new pairing, a disconnect, or an ended session)
/// forgets every remembered tab.
final class LastViewedChatTabs {
  LastViewedChatTabs({required this.sessionGeneration});

  final int Function() sessionGeneration;

  final Map<RemoteWorktreeKey, String> _chatIds = {};

  /// New tabs shown before the desktop listed them. Each replaces the
  /// remembered tab once it is listed, so a failed create is never
  /// remembered.
  final Map<RemoteWorktreeKey, String> _pendingChatIds = {};
  int? _generation;

  /// The chat last shown in [worktree] during this session, if any.
  /// [isListed] tells whether the desktop now lists a chat.
  String? chatIdFor(
    RemoteWorktreeKey worktree, {
    required bool Function(String chatId) isListed,
  }) {
    _adoptSession();
    final pending = _pendingChatIds[worktree];
    if (pending != null && isListed(pending)) {
      _pendingChatIds.remove(worktree);
      _chatIds[worktree] = pending;
    }
    return _chatIds[worktree];
  }

  /// Remembers [chatId] as the chat shown in [worktree]. A [pending] chat,
  /// one the desktop has not listed yet, is remembered once it is listed.
  void record(
    RemoteWorktreeKey worktree,
    String chatId, {
    bool pending = false,
  }) {
    _adoptSession();
    if (pending) {
      _pendingChatIds[worktree] = chatId;
      return;
    }
    _pendingChatIds.remove(worktree);
    _chatIds[worktree] = chatId;
  }

  void _adoptSession() {
    final generation = sessionGeneration();
    if (generation == _generation) return;
    _generation = generation;
    _chatIds.clear();
    _pendingChatIds.clear();
  }
}
