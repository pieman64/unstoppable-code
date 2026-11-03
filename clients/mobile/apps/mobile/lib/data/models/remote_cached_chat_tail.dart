import 'remote_chat.dart';

final class RemoteChatTailCoverage {
  const RemoteChatTailCoverage({
    required this.snapshotCursor,
    required this.orderedMessageIds,
  });

  final int snapshotCursor;
  final List<String> orderedMessageIds;

  static RemoteChatTailCoverage? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final cursor = value['snapshotCursor'];
    final ids = value['orderedMessageIds'];
    if (cursor is! int ||
        cursor <= 0 ||
        ids is! List ||
        ids.isEmpty ||
        ids.any((id) => id is! String || id.isEmpty)) {
      return null;
    }
    final parsed = ids.whereType<String>().toList(growable: false);
    if (parsed.toSet().length != parsed.length) return null;
    return RemoteChatTailCoverage(
      snapshotCursor: cursor,
      orderedMessageIds: parsed,
    );
  }
}

/// A server tail and the projection watermark read atomically with it.
/// Device-only tails and legacy responses have no freshness proof.
final class RemoteCachedChatTail {
  const RemoteCachedChatTail({
    this.messages = const [],
    this.eventCursor,
    this.stale = true,
    this.coverage,
  });

  final List<RemoteChatMessage> messages;
  final int? eventCursor;
  final bool stale;
  final RemoteChatTailCoverage? coverage;

  /// Completeness and order come from a completed desktop snapshot, never
  /// from the cache's mutable revision timestamps or the session cursor alone.
  List<RemoteChatMessage>? get orderedMessages {
    final seed = coverage;
    final cursor = eventCursor;
    if (seed == null ||
        cursor == null ||
        seed.snapshotCursor <= 0 ||
        seed.snapshotCursor > cursor ||
        seed.orderedMessageIds.length != messages.length) {
      return null;
    }
    final byId = {for (final row in messages) row.messageId: row};
    if (byId.length != messages.length ||
        seed.orderedMessageIds.toSet().length != byId.length) {
      return null;
    }
    final ordered = <RemoteChatMessage>[];
    for (final id in seed.orderedMessageIds) {
      final row = byId[id];
      if (row == null) return null;
      ordered.add(row);
    }
    return ordered;
  }

  bool covers(int? cursor) =>
      !stale &&
      messages.isNotEmpty &&
      cursor != null &&
      cursor > 0 &&
      eventCursor != null &&
      eventCursor! >= cursor &&
      orderedMessages != null;
}
