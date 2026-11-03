/// Durable Remote Control sends the desktop has not confirmed (CAN-3556).
///
/// A record is written before a text send is submitted and removed only when
/// the desktop projects a user row with the same `userMessageId`. Failed and
/// interrupted sends stay as not-sent or uncertain rows until Resend or
/// Discard. Engine collaborator: pure Dart.
library;

import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';

const String kRemoteUnsentSurface = 'rc';
const String kRemoteOfflineReason = 'Your desktop is offline.';
const String kRemoteSendFailedReason =
    "The desktop didn't receive the message. Try again.";

final class RemoteUnsentRecord {
  const RemoteUnsentRecord({
    required this.userMessageId,
    required this.target,
    required this.text,
    required this.createdAt,
    required this.status,
    this.error,
    this.options = const RemoteChatSendOptions(),
  });

  final String userMessageId;

  /// Always carries a non-empty chat id.
  final RemoteChatTarget target;
  final String text;
  final DateTime createdAt;
  final UnsentStatus status;
  final String? error;

  /// The original send's options other than its id and attachments, replayed
  /// on Resend.
  final RemoteChatSendOptions options;

  RemoteChatKey get key => (scope: target.scope, chatId: target.chatId ?? '');

  RemoteChatMessage toMessage() => RemoteChatMessage(
    messageId: userMessageId,
    chatId: target.chatId ?? '',
    role: ChatRole.user,
    status: ChatMessageStatus.complete,
    text: text,
    scope: target.scope,
    occurredAt: createdAt,
    delivery: switch (status) {
      UnsentStatus.notSent => ChatDelivery.notSent,
      UnsentStatus.uncertain || UnsentStatus.sending => ChatDelivery.uncertain,
    },
    deliveryNote: error,
  );

  static RemoteUnsentRecord? fromRecord(UnsentRecord record) {
    final extra = record.extra;
    final userMessageId = extra['userMessageId'];
    final chatId = extra['chatId'];
    if (userMessageId is! String || chatId is! String || chatId.isEmpty) {
      return null;
    }
    final RemoteChatTarget target;
    switch (extra['scope']) {
      case 'worktree':
        final workspace = extra['workspaceLocalId'];
        final worktree = extra['worktreeLocalId'];
        if (workspace is! String || worktree is! String) return null;
        target = RemoteWorktreeChatTarget(
          workspaceLocalId: workspace,
          worktreeLocalId: worktree,
          chatId: chatId,
        );
      case 'standalone':
        final project = extra['projectLocalId'];
        target = RemoteStandaloneChatTarget(
          chatId: chatId,
          projectLocalId: project is String ? project : null,
        );
      default:
        return null;
    }
    return RemoteUnsentRecord(
      userMessageId: userMessageId,
      target: target,
      text: record.text,
      createdAt: record.createdAt,
      status: record.status,
      error: record.error,
      options: _optionsFrom(extra['options']),
    );
  }
}

/// The replayable part of [options]: everything except the message id and
/// attachments (attachment sends are never recorded).
Map<String, Object?> _optionsJson(RemoteChatSendOptions? options) => {
  'model': ?options?.model,
  'providerType': ?options?.providerType,
  'planMode': ?options?.planMode,
  'thinkingLevel': ?options?.thinkingLevel,
  'fastMode': ?options?.fastMode,
  'inputMode': ?options?.inputMode,
};

RemoteChatSendOptions _optionsFrom(Object? value) {
  if (value is! Map) return const RemoteChatSendOptions();
  String? text(String key) => switch (value[key]) {
    final String text => text,
    _ => null,
  };
  bool? flag(String key) => switch (value[key]) {
    final bool flag => flag,
    _ => null,
  };
  return RemoteChatSendOptions(
    model: text('model'),
    providerType: text('providerType'),
    planMode: flag('planMode'),
    thinkingLevel: text('thinkingLevel'),
    fastMode: flag('fastMode'),
    inputMode: text('inputMode'),
  );
}

String _recordId(String userMessageId) =>
    '$kRemoteUnsentSurface:$userMessageId';

Map<String, Object?> _extraFor(
  RemoteChatTarget target,
  String userMessageId,
  RemoteChatSendOptions? options,
) => {
  ..._scopeExtra(target, userMessageId),
  if (_optionsJson(options) case final json when json.isNotEmpty)
    'options': json,
};

Map<String, Object?> _scopeExtra(
  RemoteChatTarget target,
  String userMessageId,
) => switch (target) {
  RemoteWorktreeChatTarget(
    :final workspaceLocalId,
    :final worktreeLocalId,
    :final chatId,
  ) =>
    {
      'userMessageId': userMessageId,
      'scope': 'worktree',
      'workspaceLocalId': workspaceLocalId,
      'worktreeLocalId': worktreeLocalId,
      'chatId': chatId,
    },
  RemoteStandaloneChatTarget(:final chatId, :final projectLocalId) => {
    'userMessageId': userMessageId,
    'scope': 'standalone',
    'chatId': chatId,
    'projectLocalId': ?projectLocalId,
  },
};

String _targetKey(RemoteChatTarget target) => switch (target) {
  RemoteWorktreeChatTarget(
    :final workspaceLocalId,
    :final worktreeLocalId,
    :final chatId,
  ) =>
    RemoteWorktreeChatDraftTarget(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      chatId: chatId,
    ).key,
  RemoteStandaloneChatTarget(:final chatId) => RemoteStandaloneChatDraftTarget(
    chatId,
  ).key,
};

final class RemoteUnsentSends {
  RemoteUnsentSends({required this._store}) {
    _demoteSending();
  }

  final UnsentRecordPort _store;
  final Map<RemoteChatKey, int> _revisions = {};

  int revisionFor(RemoteChatKey key) => _revisions[key] ?? 0;

  void _touch(RemoteChatKey key) => _revisions[key] = revisionFor(key) + 1;

  /// Turns every in-flight record into an uncertain one. Call when the
  /// session that owned those sends is discarded: nothing will confirm or
  /// fail them any more, so they must show as uncertain rows with Resend.
  void demoteSending() => _demoteSending();

  void _demoteSending() {
    for (final record in _store.unsentFor(kRemoteUnsentSurface)) {
      if (record.status == UnsentStatus.sending) {
        _update(record.copyWith(status: UnsentStatus.uncertain));
      }
    }
  }

  void recordSending({
    required RemoteChatTarget target,
    required String userMessageId,
    required String text,
    required DateTime createdAt,
    RemoteChatSendOptions? options,
    DraftTarget? clearDraft,
  }) {
    _store.putUnsent(
      UnsentRecord(
        id: _recordId(userMessageId),
        surface: kRemoteUnsentSurface,
        targetKey: _targetKey(target),
        text: text,
        createdAt: createdAt,
        status: UnsentStatus.sending,
        extra: _extraFor(target, userMessageId, options),
      ),
      clearDraft: clearDraft,
    );
    if (byId(userMessageId) case final record?) _touch(record.key);
  }

  RemoteUnsentRecord? byId(String userMessageId) {
    final record = _store.unsentById(_recordId(userMessageId));
    return record == null ? null : RemoteUnsentRecord.fromRecord(record);
  }

  /// False when the record is missing or already sending (double tap).
  bool markSending(String userMessageId) {
    final record = _store.unsentById(_recordId(userMessageId));
    if (record == null || record.status == UnsentStatus.sending) return false;
    _update(record.copyWith(status: UnsentStatus.sending, clearError: true));
    return true;
  }

  void markNotSent(String userMessageId, String reason) =>
      _mark(userMessageId, UnsentStatus.notSent, reason);

  void markUncertain(String userMessageId, String reason) =>
      _mark(userMessageId, UnsentStatus.uncertain, reason);

  void _mark(String userMessageId, UnsentStatus status, String reason) {
    final record = _store.unsentById(_recordId(userMessageId));
    if (record == null) return;
    _update(record.copyWith(status: status, error: reason));
  }

  void _update(UnsentRecord record) {
    _store.putUnsent(record);
    if (RemoteUnsentRecord.fromRecord(record) case final typed?) {
      _touch(typed.key);
    }
  }

  void remove(String userMessageId) {
    final typed = byId(userMessageId);
    _store.removeUnsent(_recordId(userMessageId));
    if (typed != null) _touch(typed.key);
  }

  /// Removes the record a host-projected user row confirms, by exact id only.
  void confirmEcho(RemoteChatKey key, RemoteChatMessage message) {
    if (message.role != ChatRole.user) return;
    final typed = byId(message.messageId);
    if (typed == null || typed.key != key) return;
    remove(message.messageId);
  }

  /// Records in [workspaceLocalId]'s worktree [worktreeLocalId], newest
  /// first, across all of its chats. A record's chat may not exist on the
  /// desktop yet (a first send that never reached it).
  List<RemoteUnsentRecord> recordsForWorktree(
    String workspaceLocalId,
    String worktreeLocalId,
  ) => _newestFirst(
    (target) => switch (target) {
      RemoteWorktreeChatTarget() =>
        target.workspaceLocalId == workspaceLocalId &&
            target.worktreeLocalId == worktreeLocalId,
      RemoteStandaloneChatTarget() => false,
    },
  );

  /// Standalone records sent from the flat workspace [projectLocalId],
  /// newest first.
  List<RemoteUnsentRecord> standaloneRecordsForProject(String projectLocalId) =>
      _newestFirst(
        (target) => switch (target) {
          RemoteStandaloneChatTarget() =>
            target.projectLocalId == projectLocalId,
          RemoteWorktreeChatTarget() => false,
        },
      );

  List<RemoteUnsentRecord> _newestFirst(
    bool Function(RemoteChatTarget target) matches,
  ) => [
    for (final record in _store.unsentFor(kRemoteUnsentSurface))
      if (RemoteUnsentRecord.fromRecord(record) case final typed?
          when matches(typed.target))
        typed,
  ]..sort((a, b) => b.createdAt.compareTo(a.createdAt));

  List<RemoteUnsentRecord> recordsFor(RemoteChatTarget target) {
    final key = _targetKey(target);
    return [
      for (final record in _store.unsentFor(kRemoteUnsentSurface))
        if (record.targetKey == key) ?RemoteUnsentRecord.fromRecord(record),
    ]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  }
}
