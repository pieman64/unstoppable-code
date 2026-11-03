import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'owned_command_registry.dart';
import 'remote_control_state.dart';

/// Optimistic question resolutions and memoized worktree attention state.
final class PendingQuestionTracker {
  PendingQuestionTracker({
    required this.repository,
    required this.notify,
    required this.snapshot,
    required this.commands,
  });
  final RemoteControlRepository repository;
  final void Function() notify;
  final RemoteSessionSnapshot? Function() snapshot;
  final OwnedCommandRegistry commands;

  /// AskUserQuestion requests the user answered/dismissed locally, hidden
  /// optimistically until the desktop re-projects the summary without them.
  final Set<String> _locallyResolvedQuestionRequests = {};

  /// Memo for [_pendingAnswerState]. Keyed by snapshot identity plus
  /// [_localResolutionGeneration], because optimistic answers change the
  /// result without replacing the snapshot.
  var _pendingAnswerMemo = SnapshotMemo<_PendingAnswerState>();
  int _localResolutionGeneration = 0;

  /// Changes whenever a local answer or dismissal is recorded, reverted, or
  /// reset.
  int get resolutionGeneration => _localResolutionGeneration;

  /// Whether [request] still awaits the user, excluding ones already
  /// answered/dismissed locally this session. The single definition of
  /// "pending" shared by the question cards and the attention indicators.
  bool _isQuestionPending(AskUserQuestionState request) =>
      !request.answered &&
      !_locallyResolvedQuestionRequests.contains(request.requestId);

  /// One pass over the summaries, memoized by snapshot identity:
  /// worktree rows read this once per row per rebuild.
  _PendingAnswerState get _pendingAnswerState => _pendingAnswerMemo.read(
    snapshot(),
    _derivePendingAnswerState,
    generation: _localResolutionGeneration,
  );

  _PendingAnswerState _derivePendingAnswerState(
    RemoteSessionSnapshot? snapshot,
  ) {
    final chatIdsByWorktree = <RemoteWorktreeKey, Set<String>>{};
    for (final summary
        in snapshot?.chatSummaries ?? const <RemoteChatSummary>[]) {
      if (!(summary.pendingQuestions?.any(_isQuestionPending) ?? false)) {
        continue;
      }
      final workspaceLocalId = summary.workspaceLocalId;
      final worktreeLocalId = summary.worktreeLocalId;
      if (summary.scope == RemoteChatScope.worktree &&
          workspaceLocalId != null &&
          worktreeLocalId != null) {
        chatIdsByWorktree
            .putIfAbsent(
              remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
              () => <String>{},
            )
            .add(summary.chatId);
      }
    }
    return _PendingAnswerState(
      chatIdsByWorktree: Map.unmodifiable({
        for (final entry in chatIdsByWorktree.entries)
          entry.key: Set.unmodifiable(entry.value),
      }),
    );
  }

  /// Chats in [worktree] needing an answer, using the same optimistic
  /// resolution state as the question cards. Chat ids are parent-local, so
  /// callers must never combine these sets across worktrees.
  Set<String> chatsNeedingAnswerFor(RemoteWorktree worktree) =>
      _pendingAnswerState.chatIdsByWorktree[remoteWorktreeKeyOf(worktree)] ??
      const <String>{};

  bool worktreeNeedsAnswer(RemoteWorktree worktree) =>
      chatsNeedingAnswerFor(worktree).isNotEmpty;

  /// Unanswered AskUserQuestion requests for [target]'s chat, excluding ones
  /// already answered/dismissed locally this session.
  List<AskUserQuestionState> pendingQuestionsFor(RemoteChatTarget target) {
    final chatId = target.chatId;
    if (chatId == null || chatId.isEmpty) return const [];
    final summaries = snapshot()?.chatSummaries ?? const <RemoteChatSummary>[];
    for (final summary in summaries) {
      if (summary.chatId != chatId || summary.scope != target.scope) continue;
      final questions = summary.pendingQuestions;
      if (questions == null) return const [];
      return [
        for (final request in questions)
          if (_isQuestionPending(request)) request,
      ];
    }
    return const [];
  }

  /// Answers an awaiting AskUserQuestion, hiding it optimistically. Reverts
  /// and rethrows on a rejected submit so the card reappears.
  Future<void> answerQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) => _resolveQuestion(
    requestId,
    () => repository.answerChatQuestion(
      target,
      requestId: requestId,
      answers: answers,
    ),
  );

  /// Dismisses an awaiting AskUserQuestion without answering.
  Future<void> dismissQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
  }) => _resolveQuestion(
    requestId,
    () => repository.dismissChatQuestion(target, requestId: requestId),
  );

  Future<void> _resolveQuestion(
    String requestId,
    Future<String> Function() action,
  ) async {
    _locallyResolvedQuestionRequests.add(requestId);
    _localResolutionGeneration++;
    notify();
    try {
      // A failure that raced ahead of the submit response restores the card
      // before the rethrow below restores it again; both are idempotent.
      await commands.submit(
        action,
        throwIfFailed: true,
        onFailed: (_) => _restoreQuestion(requestId),
      );
    } on RemoteControlException {
      _restoreQuestion(requestId);
      notify();
      rethrow;
    }
  }

  void _restoreQuestion(String requestId) {
    _locallyResolvedQuestionRequests.remove(requestId);
    _localResolutionGeneration++;
  }

  void reset() {
    _locallyResolvedQuestionRequests.clear();
    _localResolutionGeneration++;
    _pendingAnswerMemo = SnapshotMemo<_PendingAnswerState>();
  }

  void dispose() => reset();
}

/// Memoized attention state derived from one pass over the chat summaries.
final class _PendingAnswerState {
  const _PendingAnswerState({required this.chatIdsByWorktree});

  final Map<RemoteWorktreeKey, Set<String>> chatIdsByWorktree;
}
