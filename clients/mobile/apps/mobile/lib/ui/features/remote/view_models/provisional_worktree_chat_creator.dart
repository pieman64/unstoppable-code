import 'dart:async';

import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';

/// Holds a new task's attachment uploads until the desktop has created its
/// worktree and listed the chat the first message goes to, keeping that
/// policy out of the chat screen. Mirrors
/// `ProvisionalStandaloneChatCreator` for tree workspaces.
///
/// The staged files belong to the pairing current when they were staged.
/// Until the first message is sent, a replacement pairing can take them
/// only for the chat that pairing chose, once it lists that chat. When the
/// chosen chat was refused, or none was chosen, the files go nowhere until
/// they are removed, unless the replacement created the worktree itself.
final class ProvisionalWorktreeChatCreator {
  ProvisionalWorktreeChatCreator({
    required this.createWorktree,
    required this.shownChatId,
    required this.createChat,
    required this.confirmChat,
    required this.isListed,
    required this.firstMessageSent,
    required this.sessionGeneration,
    RemoteTimerFactory? timer,
  }) : _timer = timer ?? Timer.new;

  /// Completes with the worktree once it is ready, and the session that
  /// reported it, retrying a failed create; throws [RemoteControlException]
  /// when it cannot be created.
  final Future<({RemoteWorktree worktree, int generation})> Function()
  createWorktree;

  /// The chat the screen shows, if any.
  final String? Function() shownChatId;

  /// Lists and selects a new tab in the worktree, and asks the desktop for
  /// it; returns its chat id.
  final String Function(RemoteWorktree worktree) createChat;

  /// Completes with whether the desktop lists [chatId] in this session.
  final Future<bool> Function(RemoteWorktree worktree, String chatId)
  confirmChat;

  /// Whether the current session lists [worktree] and its [chatId].
  final bool Function(RemoteWorktree worktree, String chatId) isListed;

  /// Whether the task's first message was sent; later files are not held.
  final bool Function() firstMessageSent;

  final int Function() sessionGeneration;

  final RemoteTimerFactory _timer;

  Future<void>? _preparation;

  /// The pairing the staged files were staged in, and the chat it chose for
  /// them; null chat once that chat was refused.
  ({int generation, String? chatId})? _owner;

  /// Counts batches, so a preparation for removed files cannot choose the
  /// chat of the next ones.
  int _batch = 0;
  bool _disposed = false;

  /// The chat an earlier pairing chose for the staged files, which stays
  /// shown until it is listed again or the first message is sent.
  String? get heldChatId => switch (_owner) {
    (:final generation, :final chatId?)
        when generation != sessionGeneration() && !firstMessageSent() =>
      chatId,
    _ => null,
  };

  /// Starts a new batch when files are added to an empty strip and no pick
  /// is under way, since a pending pick's files join its own batch. It belongs
  /// to the current pairing and the chat shown, even when its uploads wait
  /// behind earlier ones; no earlier batch's preparation applies to it.
  void startBatch() {
    _batch++;
    _owner = (generation: sessionGeneration(), chatId: shownChatId());
    _preparation = null;
  }

  /// Prepares the first chat before an upload. Calls that arrive while a
  /// preparation runs, or before the zero-delay timer after its failure,
  /// share its outcome: files queued behind a failed one fail with it
  /// instead of each retrying the create, and a later Retry starts over.
  /// Throws [RemoteControlException] when the chat cannot be prepared, the
  /// session changed, or the screen is gone.
  Future<void> ensureCreated() {
    final current = _preparation;
    if (current != null) return current;
    final next = _preparation = _prepare();
    void clear() {
      if (identical(_preparation, next)) _preparation = null;
    }

    unawaited(
      next.then(
        (_) => clear(),
        onError: (_) {
          _timer(Duration.zero, clear);
        },
      ),
    );
    return next;
  }

  Future<void> _prepare() async {
    final generation = sessionGeneration();
    final batch = _batch;
    _ensureCurrent(generation);
    // Nothing was staged, so there is nothing to prepare.
    final owner = _owner;
    if (owner == null) throw _notListed;
    final (:worktree, generation: reportedIn) = await createWorktree();
    _ensureCurrent(generation);
    if (owner.generation != generation &&
        reportedIn != generation &&
        !firstMessageSent()) {
      // Another pairing owns these files: only its chat, once listed here.
      final chatId = owner.chatId;
      if (chatId == null ||
          chatId != shownChatId() ||
          !isListed(worktree, chatId)) {
        throw _notListed;
      }
      return;
    }
    final shown = shownChatId();
    if (reportedIn != generation) {
      // An earlier pairing reported the worktree: nothing is created here.
      if (shown == null || !isListed(worktree, shown)) throw _notListed;
      _own(batch, generation, shown);
      return;
    }
    final chatId = shown ?? createChat(worktree);
    _own(batch, generation, chatId);
    var listed = false;
    try {
      listed = await confirmChat(worktree, chatId);
    } finally {
      // A chat this pairing refused cannot take the files in another one,
      // whichever batch they are.
      if (!listed &&
          generation == sessionGeneration() &&
          _owner == (generation: generation, chatId: chatId)) {
        _owner = (generation: generation, chatId: null);
      }
    }
    _ensureCurrent(generation);
    if (!listed) throw _notListed;
  }

  void _own(int batch, int generation, String chatId) {
    if (batch == _batch) _owner = (generation: generation, chatId: chatId);
  }

  void _ensureCurrent(int generation) {
    if (_disposed) {
      throw const RemoteControlException('The chat is no longer open.');
    }
    if (generation != sessionGeneration()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
  }

  static const _notListed = RemoteControlException(
    'The chat could not be created.',
  );

  /// Fails later preparation steps; nothing is created after this.
  void dispose() => _disposed = true;
}
