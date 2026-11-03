import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'owned_command_registry.dart';
import 'remote_identity.dart';

/// How long an unread after an applied read waits for the read's own
/// summary, which the desktop projects up to about a second after its
/// completion, before the tracker asks the desktop for a fresh projection.
const Duration kReadSummaryWait = Duration(seconds: 3);

/// Local read receipts for chats the user has seen, relayed to the desktop
/// with retry until the desktop applies them or its projection confirms them.
///
/// Receipts are scoped to the exact output rendered. They outlive navigation
/// so a slow relay cannot lose a read just because the user went back, and
/// they overlay the snapshot's unread flags only while that output is still
/// the chat's latest.
final class ReadReceiptTracker {
  ReadReceiptTracker({
    required this.repository,
    required this.commands,
    required this.notify,
    required this.isConnected,
    required this.isDisposed,
    required this.isBackgrounded,
    required this.isDegraded,
    required this.snapshot,
    required this.messagesFor,
    required this.reprojectOverview,
    RemoteTimerFactory? timer,
  }) : _timer = timer ?? Timer.new;

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final void Function() notify;
  final bool Function() isConnected;
  final bool Function() isDisposed;
  final bool Function() isBackgrounded;

  /// Whether the desktop connection is reconnecting or inactive.
  final bool Function() isDegraded;
  final RemoteSessionSnapshot? Function() snapshot;
  final List<RemoteChatMessage> Function(RemoteChatTarget target) messagesFor;

  /// Asks the desktop to re-project the overview, which carries standalone
  /// chats, then re-reads it. Completes with whether that read is fresh; see
  /// [_projectFresh].
  final Future<bool> Function() reprojectOverview;
  final RemoteTimerFactory _timer;

  final Map<RemoteChatKey, _ReadReceipt> _readReceipts = {};

  /// Whether any receipt is held, so snapshot projection must overlay reads.
  bool get hasReceipts => _readReceipts.isNotEmpty;

  (bool?, String?) _readState(RemoteChatTarget target) {
    final snapshot = this.snapshot();
    if (target case RemoteWorktreeChatTarget(
      :final worktreeLocalId,
      :final chatId,
    )) {
      final summary = snapshot?.chatSummaries
          .where(
            (s) => s.worktreeLocalId == worktreeLocalId && s.chatId == chatId,
          )
          .firstOrNull;
      return (summary?.hasUnread, summary?.lastMessageAt);
    }
    final chat = snapshot?.standaloneChats
        .where((c) => c.localId == target.chatId)
        .firstOrNull;
    return (chat?.hasUnread, chat?.lastMessageAt);
  }

  bool _readStillCurrent(_ReadReceipt receipt) =>
      !receipt.superseded &&
      _readState(receipt.target).$2 == receipt.lastMessageAt &&
      _readOutputMatches(receipt);

  bool _readOutputMatches(_ReadReceipt receipt) {
    final messages = messagesFor(receipt.target);
    final latest = messages
        .where(
          (m) =>
              m.text.isNotEmpty || m.parts.any((p) => p.kind != 'turn_timer'),
        )
        .lastOrNull;
    return !isChatTurnRunning(messages) &&
        latest?.messageId == receipt.messageId &&
        latest?.text == receipt.text;
  }

  /// Whether a receipt for the chat still covers its latest output.
  bool isLocallyRead(RemoteChatScope scope, String chatId) {
    final receipt = _readReceipts[(scope: scope, chatId: chatId)];
    return receipt != null && _readStillCurrent(receipt);
  }

  void _forgetRead(_ReadReceipt receipt) {
    receipt.timer?.cancel();
    receipt.answerWindow?.cancel();
    final key = remoteChatKeyForTarget(receipt.target);
    if (identical(_readReceipts[key], receipt)) _readReceipts.remove(key);
    final commandId = receipt.commandId;
    if (commandId != null) commands.release(commandId);
  }

  /// Folds the desktop's projected unread flag for [chat] into its receipt.
  void reconcileProjection(RemoteChatKey chat, bool? unread) {
    final receipt = _readReceipts[chat];
    if (receipt == null) return;
    if (unread == true && receipt.confirmed) {
      // Keep the old output identity until the fresh transcript arrives.
      // Rebuilding that old reply must not clear a new unread cycle.
      receipt.superseded = true;
      // Another client's read confirmed the receipt before the phone's own
      // read answered, so this unread can predate that read.
      if (receipt.answerWindow?.isActive == true) _recoverSuperseded(receipt);
    } else if (unread == true && receipt.applied) {
      // The unread can predate the applied read: its completion overtakes
      // older summaries, and state reads lag. Or the desktop marked the
      // output unread again. Only a later projection tells them apart.
      _recover(receipt);
    } else if (unread == true && receipt.attempts > 0) {
      // The read's completion and a later desktop unread can arrive before
      // its submit returns, and a state read can cover the read's own
      // summary, so that unread may never follow the read's answer.
      receipt.unreadWhileUnanswered = true;
    } else if (unread == false) {
      _confirm(receipt);
    }
  }

  /// Stops retries. The read's own command stays registered, so its answer
  /// still ends [_ReadReceipt.answerWindow].
  void _confirm(_ReadReceipt receipt) {
    receipt.confirmed = true;
    receipt.recoveryDue = false;
    receipt.recovery = null;
    receipt.timer?.cancel();
  }

  /// A superseded receipt whose own read may have applied after the unread
  /// asks for a fresh projection, unless the read's own summary confirms it.
  void _recoverSuperseded(_ReadReceipt receipt) {
    receipt.recoveryDue = true;
    _armRecovery(receipt);
  }

  /// Asks the desktop to project [receipt]'s chat afresh: once for an
  /// applied read, and with each decline until a projection confirms the
  /// read. An applied read first waits [kReadSummaryWait] for its own
  /// summary, which confirms it.
  void _recover(_ReadReceipt receipt) {
    if (receipt.recoveredFor == receipt.applied) return;
    receipt.recoveredFor = receipt.applied;
    if (receipt.applied) {
      receipt.recoveryDue = true;
      _armRecovery(receipt);
    } else {
      unawaited(_requestRecovery(receipt));
    }
  }

  /// Arms an applied read's pending recovery, with the read retry's backoff
  /// after a failed one; [resumeRetries] re-arms it.
  void _armRecovery(_ReadReceipt receipt) {
    receipt.timer?.cancel();
    if (isBackgrounded()) return;
    final attempts = receipt.recoveryAttempts;
    final delay = attempts == 0
        ? kReadSummaryWait
        : Duration(seconds: 2 << (attempts.clamp(1, 5) - 1));
    receipt.timer = _timer(delay, () {
      receipt.timer = null;
      if (isDisposed() || !receipt.recoveryDue) return;
      unawaited(_requestRecovery(receipt));
    });
  }

  /// A recovery that could not run or settle. An applied or superseded read
  /// retries it; a declined read asks again with the desktop's next answer.
  void _retryRecovery(_ReadReceipt receipt) {
    if (receipt.applied || receipt.superseded) {
      receipt.recoveryDue = true;
      _armRecovery(receipt);
    } else {
      receipt.recoveredFor = null;
    }
  }

  /// Requests the fresh projection, then settles [receipt] on it. It
  /// confirms a read the desktop has. An applied read still projected unread
  /// was marked unread on the desktop. A declined read that stays unread
  /// keeps its bounded retry, and its next decline asks again. Without a
  /// fresh projection the receipt stays, and [_retryRecovery] asks again.
  Future<void> _requestRecovery(_ReadReceipt receipt) async {
    receipt.recoveryDue = false;
    if (isDisposed() ||
        !identical(
          _readReceipts[remoteChatKeyForTarget(receipt.target)],
          receipt,
        )) {
      return;
    }
    if (isBackgrounded() || !isConnected() || isDegraded()) {
      _retryRecovery(receipt);
      return;
    }
    receipt.recoveryAttempts++;
    // The projection follows every read answered or sent so far.
    receipt.answerWindow?.cancel();
    receipt.projectedSinceAccepted = true;
    final token = receipt.recovery = Object();
    bool current() =>
        !isDisposed() &&
        identical(
          _readReceipts[remoteChatKeyForTarget(receipt.target)],
          receipt,
        ) &&
        identical(receipt.recovery, token);
    final fresh = await _projectFresh(receipt.target);
    if (!current()) return;
    receipt.recovery = null;
    if (!fresh) {
      _retryRecovery(receipt);
      return;
    }
    final unread = _readState(receipt.target).$1;
    if (unread == false) {
      _confirm(receipt);
    } else if (receipt.applied) {
      if (unread == true) {
        receipt.superseded = true;
        notify();
      }
    } else {
      // The decline can predate a desktop unread, and a later read can
      // apply with its answer lost.
      receipt.recoveredFor = null;
    }
  }

  /// Completes with whether the desktop's fresh projection of [target]
  /// applied. A chat snapshot carries the worktree's tab summaries, and its
  /// completion follows it. The overview carries standalone chats.
  Future<bool> _projectFresh(RemoteChatTarget target) async {
    if (target is! RemoteWorktreeChatTarget) return reprojectOverview();
    try {
      final commandId = await repository.requestChatTranscript(target);
      if (commandId == null || commandId.isEmpty) return false;
      final settled = Completer<bool>();
      commands.register(
        commandId,
        recordOutcome: false,
        onCompleted: (_) => settled.complete(true),
        onFailed: (_) => settled.complete(false),
      );
      return await settled.future.timeout(
        const Duration(seconds: 30),
        onTimeout: () {
          commands.release(commandId);
          return false;
        },
      );
    } on RemoteControlException {
      return false;
    }
  }

  /// Forgets receipts for chats [snapshot] no longer contains.
  void pruneRemoved(RemoteSessionSnapshot snapshot) {
    for (final receipt in _readReceipts.values.toList()) {
      final removed = switch (receipt.target) {
        RemoteStandaloneChatTarget(:final chatId) =>
          !snapshot.standaloneChats.any((chat) => chat.localId == chatId),
        RemoteWorktreeChatTarget(:final worktreeLocalId, :final chatId) =>
          !snapshot.worktrees.any(
                (worktree) => worktree.localId == worktreeLocalId,
              ) ||
              (snapshot.chatSummaries.any(
                    (summary) => summary.worktreeLocalId == worktreeLocalId,
                  ) &&
                  !snapshot.chatSummaries.any(
                    (summary) =>
                        summary.worktreeLocalId == worktreeLocalId &&
                        summary.chatId == chatId,
                  )),
      };
      if (removed) _forgetRead(receipt);
    }
  }

  void _scheduleReadRetry(_ReadReceipt receipt) {
    receipt.timer?.cancel();
    if (receipt.confirmed || receipt.applied || isBackgrounded()) return;
    final seconds = 2 << (receipt.attempts.clamp(1, 5) - 1);
    receipt.timer = _timer(Duration(seconds: seconds), () {
      if (isDisposed() ||
          !identical(
            _readReceipts[remoteChatKeyForTarget(receipt.target)],
            receipt,
          )) {
        return;
      }
      if (_readState(receipt.target).$1 == false ||
          !_readOutputMatches(receipt)) {
        _forgetRead(receipt);
        notify();
        return;
      }
      // The desktop projects newer output, so this read can never apply.
      // Keep the receipt: rebuilding its output must not acknowledge it again.
      if (_readState(receipt.target).$2 != receipt.lastMessageAt) return;
      unawaited(_sendRead(receipt));
    });
  }

  Future<void> _sendRead(_ReadReceipt receipt) async {
    if (isBackgrounded() || !isConnected() || isDegraded()) {
      _scheduleReadRetry(receipt);
      return;
    }
    final oldCommand = receipt.commandId;
    if (oldCommand != null) commands.release(oldCommand);
    receipt.commandId = null;
    receipt.unreadWhileUnanswered = false;
    receipt.attempts++;
    final attempt = receipt.attempts;
    // Covers both a hung submit and an accepted command with no terminal event.
    receipt.timer?.cancel();
    receipt.timer = _timer(
      const Duration(seconds: 30),
      () => _scheduleReadRetry(receipt),
    );
    try {
      final commandId = await repository.markChatRead(
        receipt.target,
        receipt.messageId,
      );
      if (isDisposed() ||
          !identical(
            _readReceipts[remoteChatKeyForTarget(receipt.target)],
            receipt,
          ) ||
          attempt != receipt.attempts) {
        return;
      }
      receipt.commandId = commandId;
      receipt.projectedSinceAccepted = false;
      receipt.answerWindow?.cancel();
      receipt.answerWindow = _timer(const Duration(seconds: 30), () {});
      // A confirmed receipt stops sending, so an unread superseded this
      // receipt while its read was in flight. That unread can predate the
      // read.
      if (receipt.superseded) _recoverSuperseded(receipt);
      // The desktop's completion settles the read; its summary delta follows
      // separately. A failure retries. A forgotten receipt releases its
      // command first.
      commands.register(
        commandId,
        recordOutcome: false,
        onCompleted: (result) {
          receipt.answerWindow?.cancel();
          if (receipt.superseded) {
            // The answer follows the unread that superseded the receipt. A
            // projection requested since then already follows the read.
            if (!receipt.projectedSinceAccepted) _recoverSuperseded(receipt);
            return;
          }
          if (receipt.confirmed) return;
          if (result?['applied'] == false) {
            // The desktop declines a read it already has, a read of older
            // output, and a read during a turn alike, and projects nothing.
            // A fresh projection tells them apart: it confirms an existing
            // read, or its newer output ends the retries.
            _recover(receipt);
            _scheduleReadRetry(receipt);
            return;
          }
          receipt.applied = true;
          // A recovery for the declined read can predate this one.
          receipt.recovery = null;
          receipt.recoveryDue = false;
          receipt.recoveryAttempts = 0;
          receipt.timer?.cancel();
          if (receipt.unreadWhileUnanswered &&
              _readState(receipt.target).$1 == true) {
            _recover(receipt);
          }
        },
        onFailed: (_) {
          receipt.answerWindow?.cancel();
          _scheduleReadRetry(receipt);
        },
      );
    } on RemoteControlException {
      if (identical(
            _readReceipts[remoteChatKeyForTarget(receipt.target)],
            receipt,
          ) &&
          attempt == receipt.attempts) {
        _scheduleReadRetry(receipt);
      }
    }
  }

  /// Records that the user sees [target]'s latest assistant output
  /// [messageId] and relays the read to the desktop.
  Future<void> acknowledgeVisibleChat(
    RemoteChatTarget target,
    String? messageId,
  ) async {
    if (!isConnected() || !repository.supportsChatMarkRead) return;
    final key = remoteChatKeyForTarget(target);
    if (key == null) return;
    final prior = _readReceipts[key];
    if (_readState(target).$1 != true) {
      if (prior != null && !prior.confirmed) _forgetRead(prior);
      return;
    }
    if (prior != null &&
        prior.messageId == messageId &&
        _readOutputMatches(prior)) {
      return;
    }
    if (prior != null) _forgetRead(prior);
    final latest = messagesFor(target)
        .where(
          (m) =>
              m.text.isNotEmpty || m.parts.any((p) => p.kind != 'turn_timer'),
        )
        .lastOrNull;
    if (latest == null ||
        latest.messageId != messageId ||
        latest.role != ChatRole.assistant ||
        isChatTurnRunning(messagesFor(target))) {
      return;
    }
    final receipt = _ReadReceipt(
      target,
      messageId,
      _readState(target).$2,
      latest.text,
    );
    _readReceipts[key] = receipt;
    notify();
    await _sendRead(receipt);
  }

  /// Stops retries while the app is backgrounded.
  void pauseRetries() {
    for (final receipt in _readReceipts.values) {
      receipt.timer?.cancel();
    }
  }

  /// Re-arms every unconfirmed receipt's retry, or its pending recovery,
  /// after a foreground.
  void resumeRetries() {
    for (final receipt in _readReceipts.values) {
      if (receipt.recoveryDue) {
        _armRecovery(receipt);
      } else {
        _scheduleReadRetry(receipt);
      }
    }
  }

  /// Forgets every receipt and releases its command.
  void reset() {
    for (final receipt in _readReceipts.values.toList()) {
      _forgetRead(receipt);
    }
  }

  void dispose() => reset();
}

/// A local receipt never changes the authoritative snapshot.
class _ReadReceipt {
  _ReadReceipt(this.target, this.messageId, this.lastMessageAt, this.text);
  final RemoteChatTarget target;
  final String? messageId;
  final String? lastMessageAt;
  final String? text;
  bool confirmed = false;

  /// The desktop completed this read. Retries stop; the receipt still
  /// overlays the projection until it confirms the read, or a recovery
  /// shows the desktop marked it unread again.
  bool applied = false;
  bool superseded = false;

  /// The [applied] state of the last recovery. An applied read recovers
  /// once; a declined read again after a projection that kept it unread.
  bool? recoveredFor;

  /// Runs while a read the desktop accepted waits for its answer, for at
  /// most 30 s. The answer or a fresh projection ends it.
  Timer? answerWindow;

  /// Whether the chat projected unread while the latest sent read waited for
  /// its answer.
  bool unreadWhileUnanswered = false;

  /// Whether a fresh projection was requested since the desktop accepted
  /// the read; that projection follows the read.
  bool projectedSinceAccepted = false;

  /// Whether an applied read's recovery waits to be requested.
  bool recoveryDue = false;
  int recoveryAttempts = 0;

  /// The requested recovery, until its projection settles the receipt.
  Object? recovery;
  int attempts = 0;
  String? commandId;
  Timer? timer;
}
