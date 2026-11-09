/// Durable composer drafts and unsent-message records for computer chats (CAN-3556).
///
/// Pure Dart on purpose: the Remote Control engine imports this file, and its
/// import closure may only reach `dart:*`, `http`, and `crypto`
/// (`test/architecture/remote_engine_boundary_test.dart`). The shared chat stack
/// may import it too (`test/architecture/chat_boundary_test.dart`).
library;

const int chatDraftEnvelopeVersion = 1;
const int chatDraftMaxDrafts = 200;
const int chatDraftMaxUnsent = 100;
const Duration chatDraftMaxAge = Duration(days: 30);

/// Where a composer draft belongs. Value equality is by [key].
sealed class DraftTarget {
  const DraftTarget();

  String get key;

  @override
  bool operator ==(Object other) => other is DraftTarget && other.key == key;

  @override
  int get hashCode => key.hashCode;

  @override
  String toString() => 'DraftTarget($key)';
}

/// A Remote Control worktree chat. A null [chatId] is the worktree's composer
/// before it has any chat tab.
final class RemoteWorktreeChatDraftTarget extends DraftTarget {
  const RemoteWorktreeChatDraftTarget({
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    this.chatId,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final String? chatId;

  @override
  String get key => 'rc:wt:$workspaceLocalId/$worktreeLocalId/${chatId ?? '-'}';
}

final class RemoteStandaloneChatDraftTarget extends DraftTarget {
  const RemoteStandaloneChatDraftTarget(this.chatId);

  final String chatId;

  @override
  String get key => 'rc:sa:$chatId';
}

/// The Remote Control new-chat screen for one workspace, before its first send.
final class RemoteNewChatDraftTarget extends DraftTarget {
  const RemoteNewChatDraftTarget(this.workspaceLocalId);

  final String workspaceLocalId;

  @override
  String get key => 'rc:new:$workspaceLocalId';
}

/// A chat reached through a paired computer. The account/environment owns the
/// store; peer identity separates equal project and chat ids on two computers.
final class ComputerChatDraftTarget extends DraftTarget {
  const ComputerChatDraftTarget({
    required this.computerId,
    required this.projectId,
    required this.worktreeId,
    required this.chatId,
  });
  final String computerId, projectId, worktreeId, chatId;
  @override
  String get key => 'computer:chat:$computerId/$projectId/$worktreeId/$chatId';
}

/// A computer's Home composer in one navigation context. The account and
/// environment already scope the containing store.
final class ComputerHomeDraftTarget extends DraftTarget {
  const ComputerHomeDraftTarget({
    required this.computerId,
    required this.contextId,
  });
  final String computerId, contextId;
  @override
  String get key =>
      'computer:home:${Uri.encodeComponent(computerId)}/${Uri.encodeComponent(contextId)}';
}

enum UnsentStatus {
  sending('sending'),
  notSent('notSent'),
  uncertain('uncertain');

  const UnsentStatus(this.wire);

  final String wire;

  static UnsentStatus? fromWire(Object? wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// One message the user tried to send that is not yet confirmed by its host.
/// [surface]  owns [extra]; nothing else reads it.
final class UnsentRecord {
  const UnsentRecord({
    required this.id,
    required this.surface,
    required this.targetKey,
    required this.text,
    required this.createdAt,
    required this.status,
    this.error,
    this.extra = const {},
  });

  final String id;
  final String surface;
  final String targetKey;
  final String text;
  final DateTime createdAt;
  final UnsentStatus status;
  final String? error;
  final Map<String, Object?> extra;

  UnsentRecord copyWith({
    String? targetKey,
    UnsentStatus? status,
    String? error,
    bool clearError = false,
    Map<String, Object?>? extra,
  }) => UnsentRecord(
    id: id,
    surface: surface,
    targetKey: targetKey ?? this.targetKey,
    text: text,
    createdAt: createdAt,
    status: status ?? this.status,
    error: clearError ? null : (error ?? this.error),
    extra: extra ?? this.extra,
  );

  Map<String, Object?> toJson() => {
    'id': id,
    'surface': surface,
    'target': targetKey,
    'text': text,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'status': status.wire,
    'error': ?error,
    'extra': extra,
  };

  static UnsentRecord? fromJson(Object? value) {
    if (value is! Map) return null;
    final id = value['id'];
    final surface = value['surface'];
    final target = value['target'];
    final text = value['text'];
    final createdAt = value['createdAt'];
    final status = UnsentStatus.fromWire(value['status']);
    if (id is! String ||
        surface is! String ||
        target is! String ||
        text is! String ||
        createdAt is! String ||
        status == null) {
      return null;
    }
    final parsedAt = DateTime.tryParse(createdAt);
    if (parsedAt == null) return null;
    final error = value['error'];
    final extra = value['extra'];
    return UnsentRecord(
      id: id,
      surface: surface,
      targetKey: target,
      text: text,
      createdAt: parsedAt,
      status: status,
      error: error is String ? error : null,
      extra: extra is Map
          ? {
              for (final MapEntry(:key, :value) in extra.entries)
                if (key is String) key: value,
            }
          : const {},
    );
  }
}

abstract interface class ChatDraftPort {
  /// The saved text for [target], or `''`.
  String draftFor(DraftTarget target);

  /// Saves [text] for [target]; empty text removes the draft.
  void setDraft(DraftTarget target, String text);

  /// Re-keys the draft at [from] to [to]. Does nothing when [from] is empty.
  void moveDraft(DraftTarget from, DraftTarget to);

  /// Attempts to write pending changes. Returns false when persistence fails;
  /// the changes remain available for a later retry.
  Future<bool> flush();
}

abstract interface class UnsentRecordPort {
  List<UnsentRecord> unsentFor(String surface);

  UnsentRecord? unsentById(String id);

  /// Inserts or replaces the record with the same id, and removes the draft at
  /// [clearDraft] in the same write. Written through immediately.
  void putUnsent(UnsentRecord record, {DraftTarget? clearDraft});

  void removeUnsent(String id);
}

abstract interface class ChatDraftStore
    implements ChatDraftPort, UnsentRecordPort {}

typedef ChatDraftEntry = ({String text, DateTime updatedAt});

/// The store's whole state, independent of where it is persisted.
final class ChatDraftState {
  final Map<String, ChatDraftEntry> drafts = {};
  final Map<String, UnsentRecord> unsent = {};

  /// Drops expired entries, then keeps the newest drafts and unsent records.
  void prune(DateTime now) {
    final cutoff = now.subtract(chatDraftMaxAge);
    drafts.removeWhere((_, entry) => entry.updatedAt.isBefore(cutoff));
    unsent.removeWhere((_, record) => record.createdAt.isBefore(cutoff));
    _keepNewest(drafts, chatDraftMaxDrafts, (entry) => entry.updatedAt);
    _keepNewest(unsent, chatDraftMaxUnsent, (record) => record.createdAt);
  }

  static void _keepNewest<V>(
    Map<String, V> map,
    int max,
    DateTime Function(V value) at,
  ) {
    if (map.length <= max) return;
    final byNewest = map.entries.toList()
      ..sort((a, b) => at(b.value).compareTo(at(a.value)));
    for (final entry in byNewest.skip(max)) {
      map.remove(entry.key);
    }
  }

  Map<String, Object?> toJson() => {
    'v': chatDraftEnvelopeVersion,
    'drafts': {
      for (final MapEntry(:key, :value) in drafts.entries)
        key: {
          'text': value.text,
          'updatedAt': value.updatedAt.toUtc().toIso8601String(),
        },
    },
    'unsent': {
      for (final MapEntry(:key, :value) in unsent.entries) key: value.toJson(),
    },
  };

  /// Null for an unknown version or a non-map; bad rows are skipped.
  static ChatDraftState? fromJson(Object? value) {
    if (value is! Map || value['v'] != chatDraftEnvelopeVersion) return null;
    final state = ChatDraftState();
    final drafts = value['drafts'];
    if (drafts is Map) {
      for (final MapEntry(:key, :value) in drafts.entries) {
        if (key is! String || value is! Map) continue;
        final text = value['text'];
        final updatedAt = value['updatedAt'];
        final parsed = updatedAt is String
            ? DateTime.tryParse(updatedAt)
            : null;
        if (text is String && text.isNotEmpty && parsed != null) {
          state.drafts[key] = (text: text, updatedAt: parsed);
        }
      }
    }
    final unsent = value['unsent'];
    if (unsent is Map) {
      for (final entry in unsent.values) {
        final record = UnsentRecord.fromJson(entry);
        if (record != null) state.unsent[record.id] = record;
      }
    }
    return state;
  }
}

/// Shared mutation logic. [onDraftsChanged] and [onUnsentChanged] let the file
/// store schedule debounced or immediate writes.
base class ChatDraftStateStore implements ChatDraftStore {
  ChatDraftStateStore({ChatDraftState? state, DateTime Function()? now})
    : state = state ?? ChatDraftState(),
      now = now ?? DateTime.now;

  final ChatDraftState state;
  final DateTime Function() now;

  void onDraftsChanged() {}

  void onUnsentChanged() {}

  @override
  String draftFor(DraftTarget target) => state.drafts[target.key]?.text ?? '';

  @override
  void setDraft(DraftTarget target, String text) {
    final current = state.drafts[target.key]?.text ?? '';
    if (current == text) return;
    if (text.isEmpty) {
      state.drafts.remove(target.key);
    } else {
      state.drafts[target.key] = (text: text, updatedAt: now());
    }
    onDraftsChanged();
  }

  @override
  void moveDraft(DraftTarget from, DraftTarget to) {
    if (from == to) return;
    final entry = state.drafts.remove(from.key);
    if (entry == null) return;
    state.drafts[to.key] = (text: entry.text, updatedAt: now());
    onDraftsChanged();
  }

  @override
  List<UnsentRecord> unsentFor(String surface) => List.unmodifiable(
    state.unsent.values.where((record) => record.surface == surface),
  );

  @override
  UnsentRecord? unsentById(String id) => state.unsent[id];

  @override
  void putUnsent(UnsentRecord record, {DraftTarget? clearDraft}) {
    state.unsent[record.id] = record;
    if (clearDraft != null) {
      state.drafts.remove(clearDraft.key);
    }
    onUnsentChanged();
  }

  @override
  void removeUnsent(String id) {
    if (state.unsent.remove(id) != null) onUnsentChanged();
  }

  @override
  Future<bool> flush() async => true;
}

/// Session-only store: tests, and the fallback when the file cannot open.
final class InMemoryChatDraftStore extends ChatDraftStateStore {
  InMemoryChatDraftStore({super.now});
}
