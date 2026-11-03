import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

/// Submits a chat-tab command for [target]. [onFailed] reports the desktop's
/// asynchronous rejection; a transport failure throws
/// [RemoteControlException].
typedef RemoteChatTabCommand =
    Future<String> Function(
      RemoteWorktreeChatTarget target, {
      required void Function() onFailed,
    });

final class _PendingCreate {
  _PendingCreate(this.generation);

  final int generation;
  String? commandId;

  /// This session's create submission, if it asked the desktop for the tab.
  Future<String>? submission;

  /// Rejected while [RemoteChatTabsController.holdFailures] held it.
  bool failed = false;

  /// Whether the desktop listed the tab in this session; false once its
  /// create failed or can no longer settle.
  final created = Completer<bool>();

  void settle(bool listed) {
    if (!created.isCompleted) created.complete(listed);
  }
}

final class _PendingClose {
  _PendingClose({
    required this.wasSelected,
    required this.selectionVersion,
    required this.generation,
  });

  final bool wasSelected;
  final int selectionVersion;
  final int generation;
}

/// Optimistic chat-tab membership and selection for one chat view.
///
/// A created tab is listed at once as a provisional "New chat" row until the
/// desktop projects it or rejects it; a closed tab is hidden at once until
/// the desktop removes it or rejects the close. Command outcomes arrive
/// through the handlers each submission registers, so rendering only reads
/// [rowsFor] and [chatIdFor]. [sync] applies the projection's bookkeeping
/// outside rendering.
///
/// Work from a replaced session cannot change or notify the replacement: its
/// handlers and tab-action transport failures are ignored, its closes stop
/// hiding tabs, its creates stop being awaited, and its provisional tabs
/// remain only as unsubmitted rows the projection can still confirm.
final class RemoteChatTabsController {
  RemoteChatTabsController({
    required this.createTab,
    required this.closeTab,
    required this.mintChatId,
    required this.sessionGeneration,
    required this.onChanged,
    required this.onCreateFailed,
    String? initialChatId,
  }) : _selected = initialChatId,
       _generation = sessionGeneration();

  final RemoteChatTabCommand createTab;
  final RemoteChatTabCommand closeTab;

  /// Mints the client chat id of a new tab.
  final String Function() mintChatId;
  final int Function() sessionGeneration;

  /// Reports a change to what the view renders.
  final void Function() onChanged;

  /// Reports that [chatId]'s provisional tab was dropped after a failed
  /// create, after its selection was released.
  final void Function(String chatId) onCreateFailed;

  final Map<String, _PendingCreate> _creates = {};
  final Map<String, _PendingClose> _closes = {};
  String? _selected;
  int _selectionVersion = 0;
  int _generation;
  String? _held;
  bool _disposed = false;

  /// The chat the user picked, a deep link, or the latched resolution.
  String? get selectedChatId => _selected;

  /// Provisional chats the desktop has not projected yet.
  Set<String> get pendingChatIds => _creates.keys.toSet();

  bool isPending(String chatId) => _creates.containsKey(chatId);

  /// The accepted create command of [chatId]'s provisional tab, if any.
  String? createCommandIdFor(String chatId) => _creates[chatId]?.commandId;

  /// Completes true once the desktop lists [chatId]'s tab, or at once when
  /// it is not provisional. A provisional tab this session has not asked
  /// the desktop for, such as one an earlier session created, is asked for
  /// now; the desktop keeps a tab it already has. Completes false when the
  /// create fails, or as soon as the session changes or this controller is
  /// disposed, even while the submission is unanswered; a transport failure
  /// throws [RemoteControlException].
  Future<bool> ensureCreated(RemoteWorktree worktree, String chatId) async {
    if (_disposed) return false;
    final pending = _creates[chatId];
    if (pending == null) return true;
    final submission = pending.submission ??= _submitCreate(
      worktree,
      chatId,
      pending,
    );
    // Work from a replaced session settles without waiting for its answer.
    await Future.any([
      submission,
      pending.created.future.then(
        (_) => _isObsolete(pending.generation) ? '' : submission,
      ),
    ]);
    return pending.created.future;
  }

  /// Tab rows for [worktree]: [projected] tabs, then provisional ones, minus
  /// tabs being closed.
  List<RemoteChatSummary> rowsFor(
    List<RemoteChatSummary> projected,
    RemoteWorktree worktree,
  ) {
    final projectedIds = {for (final summary in projected) summary.chatId};
    return [
      for (final summary in projected)
        if (!_closes.containsKey(summary.chatId)) summary,
      for (final chatId in _creates.keys)
        if (!projectedIds.contains(chatId) && !_closes.containsKey(chatId))
          RemoteChatSummary(
            chatId: chatId,
            scope: RemoteChatScope.worktree,
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
            title: 'New chat',
          ),
    ];
  }

  /// The chat shown for [rows]: the selection while it is listed, still
  /// provisional, or unverifiable because no rows arrived yet; otherwise the
  /// desktop's active tab, then the first.
  String? chatIdFor(List<RemoteChatSummary> rows) {
    final selected = _selected;
    if (selected != null &&
        (rows.isEmpty ||
            _creates.containsKey(selected) ||
            rows.any((row) => row.chatId == selected))) {
      return selected;
    }
    if (rows.isEmpty) return null;
    for (final row in rows) {
      if (row.active == true) return row.chatId;
    }
    return rows.first.chatId;
  }

  /// Applies the latest projection: confirms projected provisional tabs,
  /// adopts [adopt] chats as provisional tabs, ends closes whose tab is gone,
  /// and latches the resolved selection so later projection churn or the
  /// desktop moving its active tab cannot switch the view. A new session
  /// discards the old session's pending work first. [confirmed] confirms
  /// chats projected outside [projected]. Returns whether a render input
  /// changed.
  bool sync({
    required List<RemoteChatSummary> projected,
    RemoteWorktree? worktree,
    Iterable<String> adopt = const [],
    Iterable<String> confirmed = const [],
  }) {
    if (_disposed) return false;
    final before = _signature();
    _adoptSession();
    for (final summary in projected) {
      _creates.remove(summary.chatId)?.settle(true);
    }
    for (final chatId in confirmed) {
      _creates.remove(chatId)?.settle(true);
    }
    final adopted = adopt.where((id) => !_creates.containsKey(id)).toList();
    for (final chatId in adopted) {
      _creates[chatId] = _PendingCreate(_generation);
    }
    if (_selected == null && projected.isEmpty && adopted.isNotEmpty) {
      _selected = adopted.first;
    }
    if (worktree != null) {
      final listed = {
        for (final summary in projected) summary.chatId,
        ..._creates.keys,
      };
      _closes.removeWhere((chatId, _) => !listed.contains(chatId));
      final rows = rowsFor(projected, worktree);
      final chatId = chatIdFor(rows);
      if (_selected != null && chatId != _selected) _selected = null;
      if (_selected == null && chatId != null && chatId.isNotEmpty) {
        _selected = chatId;
      }
    }
    return _signature() != before;
  }

  String _signature() =>
      [_selected, ..._creates.keys, '|', ..._closes.keys].join('\u0000');

  /// Drops pending work that belongs to a replaced session.
  void _adoptSession() {
    final generation = sessionGeneration();
    if (generation == _generation) return;
    _generation = generation;
    // The old closes can no longer settle; the projection is authoritative.
    _closes.clear();
    // Provisional rows stay reachable, but their old commands no longer can
    // remove them or settle, so whoever waits on them stops waiting.
    for (final MapEntry(key: chatId, value: pending)
        in _creates.entries.toList()) {
      pending.settle(false);
      _creates[chatId] = _PendingCreate(generation);
    }
  }

  /// Selects [chatId] at the user's request.
  void select(String chatId) {
    if (_disposed) return;
    _selectionVersion++;
    _selected = chatId;
    onChanged();
  }

  /// Lists [chatId] as a provisional tab whose creation is already under
  /// way elsewhere, such as a first send that minted it; [select] shows it.
  void addProvisional(String chatId, {bool select = false}) {
    if (_disposed) return;
    _adoptSession();
    _creates.putIfAbsent(chatId, () => _PendingCreate(_generation));
    if (select) _selected = chatId;
    onChanged();
  }

  /// Opens a new tab at the user's request, like [create]. A transport
  /// failure throws [RemoteControlException] only while the session that
  /// submitted it is current.
  Future<void> start(RemoteWorktree worktree) async {
    final generation = sessionGeneration();
    try {
      await create(worktree).submitted;
    } on RemoteControlException {
      if (_isObsolete(generation)) return;
      rethrow;
    }
  }

  /// Mints, lists, and selects a provisional tab in [worktree], then asks
  /// the desktop to create it. [submitted] completes with the command id; a
  /// transport failure drops the tab, then throws [RemoteControlException].
  ({String chatId, Future<String> submitted}) create(RemoteWorktree worktree) {
    final chatId = mintChatId();
    _adoptSession();
    final pending = _PendingCreate(_generation);
    _selectionVersion++;
    _selected = chatId;
    _creates[chatId] = pending;
    onChanged();
    return (
      chatId: chatId,
      submitted: pending.submission = _submitCreate(worktree, chatId, pending),
    );
  }

  Future<String> _submitCreate(
    RemoteWorktree worktree,
    String chatId,
    _PendingCreate pending,
  ) async {
    try {
      final commandId = await createTab(
        RemoteWorktreeChatTarget(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
          chatId: chatId,
        ),
        onFailed: () => _createFailed(chatId, pending),
      );
      // An empty id is a create the session dropped, which cannot settle.
      if (commandId.isEmpty) pending.settle(false);
      if (identical(_creates[chatId], pending)) pending.commandId = commandId;
      return commandId;
    } on RemoteControlException {
      _createFailed(chatId, pending);
      rethrow;
    }
  }

  /// Whether work submitted in [generation] can no longer change or notify
  /// this view.
  bool _isObsolete(int generation) =>
      _disposed || generation != sessionGeneration();

  void _createFailed(String chatId, _PendingCreate pending) {
    if (_isObsolete(pending.generation) ||
        !identical(_creates[chatId], pending)) {
      return;
    }
    if (_held == chatId) {
      pending.failed = true;
      return;
    }
    _creates.remove(chatId);
    pending.settle(false);
    if (_selected == chatId) _selected = null;
    onCreateFailed(chatId);
    onChanged();
  }

  /// Defers dropping [chatId]'s provisional tab after a failed create until
  /// [releaseFailures], so a send in flight to it can settle first.
  void holdFailures(String chatId) => _held = chatId;

  /// Applies a failed create deferred by [holdFailures].
  void releaseFailures() {
    final chatId = _held;
    _held = null;
    final pending = chatId == null ? null : _creates[chatId];
    if (chatId != null && pending != null && pending.failed) {
      _createFailed(chatId, pending);
    }
  }

  /// Hides [chatId]'s tab and asks the desktop to close it. A rejection
  /// lists the tab again and reselects it unless the user selected another
  /// chat since. A transport failure throws [RemoteControlException] while
  /// the session that submitted it is current.
  Future<void> close(RemoteWorktree worktree, String chatId) async {
    if (_disposed || _closes.containsKey(chatId)) return;
    _adoptSession();
    final pending = _PendingClose(
      wasSelected: _selected == chatId,
      selectionVersion: ++_selectionVersion,
      generation: _generation,
    );
    _closes[chatId] = pending;
    if (pending.wasSelected) _selected = null;
    onChanged();
    try {
      await closeTab(
        RemoteWorktreeChatTarget(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
          chatId: chatId,
        ),
        onFailed: () => _restoreClosed(chatId, pending),
      );
    } on RemoteControlException {
      if (_isObsolete(pending.generation)) return;
      _restoreClosed(chatId, pending);
      rethrow;
    }
  }

  void _restoreClosed(String chatId, _PendingClose pending) {
    if (_isObsolete(pending.generation) ||
        !identical(_closes[chatId], pending)) {
      return;
    }
    _closes.remove(chatId);
    if (pending.wasSelected && _selectionVersion == pending.selectionVersion) {
      _selected = chatId;
    }
    onChanged();
  }

  /// Stops reporting changes; late command outcomes are ignored.
  void dispose() {
    _disposed = true;
    for (final pending in _creates.values) {
      pending.settle(false);
    }
  }
}
