import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';

import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'remote_control_state.dart';

/// Retry drafts are an in-memory bridge across screen and command lifecycles,
/// not permanent storage. This bounds abandoned batches while leaving ample
/// time to reopen the worktree after a delayed command failure.
const Duration kRemotePendingChatAttachmentRetention = Duration(minutes: 15);
const int _kRemotePendingChatAttachmentMaxBytes =
    kChatAttachmentMaxBytes * kChatAttachmentsMaxPerMessage;

/// Bounded retry drafts retained independently of a chat screen's lifetime.
///
/// Command outcomes reach the store through the engine's handlers: a failed
/// send or a failed provisional chat marks its batches restorable, and a
/// chat view takes them back exactly once with [takeRestorable]. Queries
/// never mutate; expiry and the byte ceiling apply on writes.
final class PendingChatAttachmentStore {
  PendingChatAttachmentStore({DateTime Function()? clock})
    : _clock = clock ?? DateTime.now;
  final DateTime Function() _clock;
  final Map<String, PendingChatAttachments> _pendingChatAttachments = {};
  int _failedChatAttachmentSequence = 0;

  /// Retains the bytes and session-scoped refs for an accepted attachment send
  /// outside the chat screen that initiated it. A failed command can therefore
  /// restore its retry draft even when that screen was closed in the meantime.
  void retainPendingChatAttachments({
    required String commandId,
    required int sessionGeneration,
    required RemoteChatTarget target,
    required List<ChatAttachmentDraft> drafts,
    String? provisionalCreateCommandId,
    bool restoreImmediately = false,
    bool sendFailed = false,
  }) => _retain(
    commandId: commandId,
    sessionGeneration: sessionGeneration,
    target: target,
    drafts: drafts,
    provisionalCreateCommandId: provisionalCreateCommandId,
    restoreImmediately: restoreImmediately,
    sendFailed: sendFailed,
  );

  /// Transfers a staged batch out of its screen before submission awaits the
  /// transport. The returned local id owns the batch until a command id takes
  /// over or submission fails.
  String retainSubmittingChatAttachments({
    required int sessionGeneration,
    required RemoteChatTarget target,
    required List<ChatAttachmentDraft> drafts,
  }) {
    final localId =
        'local-submitting-attachment-${++_failedChatAttachmentSequence}';
    _retain(
      commandId: localId,
      sessionGeneration: sessionGeneration,
      target: target,
      drafts: drafts,
      submitting: true,
    );
    return localId;
  }

  void _retain({
    required String commandId,
    required int sessionGeneration,
    required RemoteChatTarget target,
    required List<ChatAttachmentDraft> drafts,
    String? provisionalCreateCommandId,
    bool restoreImmediately = false,
    bool submitting = false,
    bool sendFailed = false,
  }) {
    final key = remoteChatKeyForTarget(target);
    if (commandId.isEmpty || key == null || drafts.isEmpty) return;
    _prunePendingChatAttachments();
    _pendingChatAttachments.remove(commandId);
    _pendingChatAttachments[commandId] = PendingChatAttachments(
      key: key,
      worktree: switch (target) {
        RemoteWorktreeChatTarget(
          :final workspaceLocalId,
          :final worktreeLocalId,
        ) =>
          remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
        RemoteStandaloneChatTarget() => null,
      },
      sessionGeneration: sessionGeneration,
      drafts: List<ChatAttachmentDraft>.unmodifiable(drafts),
      provisionalCreateCommandId: provisionalCreateCommandId,
      retainedAt: _clock(),
      restoreImmediately: restoreImmediately,
      submitting: submitting,
      sendFailed: sendFailed,
    );
    _prunePendingChatAttachments();
  }

  void markPendingChatAttachmentsForRestore(String commandId) {
    final batch = _pendingChatAttachments[commandId];
    if (batch == null) return;
    _pendingChatAttachments[commandId] = batch.copyWith(
      restoreImmediately: true,
    );
  }

  /// The desktop rejected the send [commandId]. Returns whether a retained
  /// batch became restorable.
  bool markSendFailed(String commandId) {
    final batch = _pendingChatAttachments[commandId];
    if (batch == null || batch.sendFailed) return false;
    _pendingChatAttachments[commandId] = batch.copyWith(sendFailed: true);
    return true;
  }

  /// The desktop rejected creating [chat]'s tab, so its retained batches can
  /// never be delivered there. A send still awaiting its response keeps its
  /// batch and settles it itself. Returns whether any batch changed.
  bool markChatCreateFailed(RemoteChatKey chat) {
    var changed = false;
    for (final MapEntry(key: id, value: batch)
        in _pendingChatAttachments.entries.toList()) {
      if (batch.key != chat || batch.submitting || batch.restoreImmediately) {
        continue;
      }
      _pendingChatAttachments[id] = batch.copyWith(restoreImmediately: true);
      changed = true;
    }
    return changed;
  }

  void _prunePendingChatAttachments() {
    _pendingChatAttachments.removeWhere((_, batch) => _isExpired(batch));
    var retainedBytes = _pendingChatAttachments.values.fold<int>(
      0,
      (total, batch) =>
          total +
          batch.drafts.fold<int>(0, (sum, draft) => sum + draft.bytes.length),
    );
    while (retainedBytes > _kRemotePendingChatAttachmentMaxBytes &&
        _pendingChatAttachments.isNotEmpty) {
      final oldestKey = _pendingChatAttachments.keys.first;
      final oldest = _pendingChatAttachments.remove(oldestKey)!;
      retainedBytes -= oldest.drafts.fold<int>(
        0,
        (sum, draft) => sum + draft.bytes.length,
      );
    }
  }

  bool _isExpired(PendingChatAttachments batch) => !batch.retainedAt
      .add(kRemotePendingChatAttachmentRetention)
      .isAfter(_clock());

  List<PendingChatAttachmentBatch> pendingChatAttachmentsFor(
    RemoteChatTarget target,
  ) {
    final key = remoteChatKeyForTarget(target);
    if (key == null) return const [];
    return [
      for (final entry in _pendingChatAttachments.entries)
        if (entry.value.key == key && !_isExpired(entry.value))
          entry.value.toBatch(entry.key),
    ];
  }

  List<PendingChatAttachmentBatch> pendingChatAttachmentsForWorktree(
    RemoteWorktree worktree,
  ) {
    final key = remoteWorktreeKeyOf(worktree);
    return [
      for (final entry in _pendingChatAttachments.entries)
        if (entry.value.worktree == key && !_isExpired(entry.value))
          entry.value.toBatch(entry.key),
    ];
  }

  /// Whether [takeRestorable] would return any batch now. Never mutates.
  bool hasRestorable({
    required RemoteChatTarget? target,
    required RemoteWorktreeKey? worktree,
    required int sessionGeneration,
    required bool canReupload,
  }) {
    final chat = target == null ? null : remoteChatKeyForTarget(target);
    return _pendingChatAttachments.values.any(
      (batch) =>
          !_isExpired(batch) &&
          _restores(batch, chat, worktree, sessionGeneration, canReupload),
    );
  }

  /// Removes and returns the batches a chat view showing [target] in
  /// [worktree] should put back on its composer, so each batch is delivered
  /// once: immediate restores for [target] or anywhere in [worktree], plus
  /// [target]'s failed sends and batches from an older session. Batches from
  /// an older session stay retained until [canReupload], since their
  /// uploaded refs must be renewed.
  List<PendingChatAttachmentBatch> takeRestorable({
    required RemoteChatTarget? target,
    required RemoteWorktreeKey? worktree,
    required int sessionGeneration,
    required bool canReupload,
  }) {
    _prunePendingChatAttachments();
    final chat = target == null ? null : remoteChatKeyForTarget(target);
    final taken = <PendingChatAttachmentBatch>[];
    for (final MapEntry(key: id, value: batch)
        in _pendingChatAttachments.entries.toList()) {
      if (!_restores(batch, chat, worktree, sessionGeneration, canReupload)) {
        continue;
      }
      _pendingChatAttachments.remove(id);
      taken.add(batch.toBatch(id));
    }
    return taken;
  }

  bool _restores(
    PendingChatAttachments batch,
    RemoteChatKey? chat,
    RemoteWorktreeKey? worktree,
    int sessionGeneration,
    bool canReupload,
  ) {
    final restores =
        (batch.restoreImmediately &&
            (batch.key == chat ||
                (worktree != null && batch.worktree == worktree))) ||
        (batch.key == chat &&
            !batch.submitting &&
            (batch.sendFailed || batch.sessionGeneration != sessionGeneration));
    return restores &&
        (batch.sessionGeneration == sessionGeneration || canReupload);
  }

  void removePendingChatAttachments(String commandId) {
    _pendingChatAttachments.remove(commandId);
  }

  /// Session changes invalidate uploaded refs via each batch's generation,
  /// but preserve bytes so the composer can re-upload the user's retry draft.
  void reset() => _prunePendingChatAttachments();

  void dispose() => _pendingChatAttachments.clear();
}
