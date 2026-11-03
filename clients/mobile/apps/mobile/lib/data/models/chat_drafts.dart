/// Durable composer drafts and unsent-message records shared by cloud and
/// Remote Control chats (CAN-3556).
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

final class CloudChatDraftTarget extends DraftTarget {
  const CloudChatDraftTarget(this.chatId);

  final String chatId;

  @override
  String get key => 'cloud:chat:$chatId';
}

/// The cloud new-chat composer for one project.
final class CloudNewChatDraftTarget extends DraftTarget {
  const CloudNewChatDraftTarget(this.workspaceId);

  final String workspaceId;

  @override
  String get key => 'cloud:new:$workspaceId';
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
/// [surface] (`rc` or `cloud`) owns [extra]; nothing else reads it.
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

  /// The capability selection a cloud new-chat draft chose for [target], or
  /// null for the project defaults.
  Map<String, Object?>? draftSelectionsFor(DraftTarget target);

  /// Saves [selections] with [target]'s draft. They are discarded when the
  /// draft is sent or pruned, and when the text they were chosen with is
  /// cleared. A selection chosen while the draft has no text outlives
  /// cleared text, such as a `/plugins` token the composer consumes.
  void setDraftSelections(DraftTarget target, Map<String, Object?> selections);

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

  /// Capability selections by draft key; see
  /// [ChatDraftPort.setDraftSelections].
  final Map<String, Map<String, Object?>> draftSelections = {};

  /// Keys of [draftSelections] chosen while the draft had no text. Kept in
  /// memory only.
  final Set<String> selectionsBeforeText = {};

  /// Drops entries older than [chatDraftMaxAge], then keeps the newest
  /// [chatDraftMaxDrafts] drafts and [chatDraftMaxUnsent] records. The
  /// selections of dropped drafts go with them; a selection chosen before
  /// its draft has text stays in memory (see [toJson]).
  void prune(DateTime now) {
    final before = drafts.keys.toSet();
    final cutoff = now.subtract(chatDraftMaxAge);
    drafts.removeWhere((_, entry) => entry.updatedAt.isBefore(cutoff));
    unsent.removeWhere((_, record) => record.createdAt.isBefore(cutoff));
    _keepNewest(drafts, chatDraftMaxDrafts, (entry) => entry.updatedAt);
    _keepNewest(unsent, chatDraftMaxUnsent, (record) => record.createdAt);
    draftSelections.removeWhere(
      (key, _) => before.contains(key) && !drafts.containsKey(key),
    );
    selectionsBeforeText.retainWhere(draftSelections.containsKey);
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
    // Only drafts with text are kept across launches, so a selection is
    // written with its draft and never alone.
    if (draftSelections.keys.any(drafts.containsKey))
      'draftSelections': {
        for (final MapEntry(:key, :value) in draftSelections.entries)
          if (drafts.containsKey(key)) key: value,
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
    // Absent from files written before drafts kept a selection.
    final selections = value['draftSelections'];
    if (selections is Map) {
      for (final MapEntry(:key, :value) in selections.entries) {
        if (key is! String || value is! Map) continue;
        if (!state.drafts.containsKey(key)) continue;
        state.draftSelections[key] = {
          for (final MapEntry(:key, :value) in value.entries)
            if (key is String) key: value,
        };
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
      if (!state.selectionsBeforeText.contains(target.key)) {
        state.draftSelections.remove(target.key);
      }
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
    if (state.draftSelections.remove(from.key) case final selections?) {
      state.draftSelections[to.key] = selections;
      if (state.selectionsBeforeText.remove(from.key)) {
        state.selectionsBeforeText.add(to.key);
      } else {
        state.selectionsBeforeText.remove(to.key);
      }
    }
    onDraftsChanged();
  }

  @override
  Map<String, Object?>? draftSelectionsFor(DraftTarget target) =>
      state.draftSelections[target.key];

  @override
  void setDraftSelections(DraftTarget target, Map<String, Object?> selections) {
    state.draftSelections[target.key] = selections;
    if (draftFor(target).isEmpty) {
      state.selectionsBeforeText.add(target.key);
    } else {
      state.selectionsBeforeText.remove(target.key);
    }
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
      state.draftSelections.remove(clearDraft.key);
      state.selectionsBeforeText.remove(clearDraft.key);
    }
    onUnsentChanged();
  }

  @override
  void removeUnsent(String id) {
    if (state.unsent.remove(id) != null) onUnsentChanged();
  }

  @override
  Future<bool> flush() async => true;

  /// Copies cloud drafts and recovery records, keeping this account's entries.
  /// The source stays intact until a durable destination confirms its write.
  Future<void> adoptGuestDrafts(ChatDraftStateStore guest) async {
    for (final MapEntry(:key, :value) in guest.state.drafts.entries) {
      if (!key.startsWith(_cloudDraftKeyPrefix)) continue;
      if (state.drafts.containsKey(key)) continue;
      state.drafts[key] = value;
      if (guest.state.draftSelections[key] case final selections?) {
        state.draftSelections[key] = selections;
      }
    }
    for (final MapEntry(:key, :value) in guest.state.unsent.entries) {
      if (value.surface == 'cloud') state.unsent.putIfAbsent(key, () => value);
    }
    onDraftsChanged();
    onUnsentChanged();
  }

  /// [CloudChatDraftTarget] and [CloudNewChatDraftTarget] keys.
  static const _cloudDraftKeyPrefix = 'cloud:';
}

/// Session-only store: tests, and the fallback when the file cannot open.
final class InMemoryChatDraftStore extends ChatDraftStateStore {
  InMemoryChatDraftStore({super.now});
}
