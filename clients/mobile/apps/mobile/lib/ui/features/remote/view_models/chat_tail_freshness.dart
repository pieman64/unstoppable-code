import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';

import 'remote_identity.dart';
import 'chat_transcript_store.dart';

/// Watermarks for chats touched since the overview's projection cursor.
/// A batch boundary is conservative when older servers omit per-row cursors.
final class ChatTailFreshness {
  final Map<RemoteChatKey, int> _cursors = {};
  final Set<RemoteChatKey> _unproven = {};
  final Map<RemoteChatKey, int> _verified = {};

  void verify(RemoteChatKey chat, int cursor) => _verified[chat] = cursor;

  int? requiredCursor(RemoteChatKey chat, int? overviewCursor) {
    if (overviewCursor == null ||
        overviewCursor <= 0 ||
        _unproven.contains(chat)) {
      return null;
    }
    final live = _cursors[chat];
    return live != null && live > overviewCursor ? live : overviewCursor;
  }

  void observe(RemotePortalEventBatch batch) {
    void record(({RemoteChatScope? scope, String chatId}) chat, int cursor) {
      for (final scope
          in chat.scope == null ? RemoteChatScope.values : [chat.scope!]) {
        final key = (scope: scope, chatId: chat.chatId);
        if (cursor <= 0) _unproven.add(key);
        if (cursor > (_cursors[key] ?? 0)) _cursors[key] = cursor;
      }
    }

    for (final event in batch.events) {
      switch (event) {
        case RemoteChatMessageEvent(:final chatId, :final message):
          record((
            scope: event.scope ?? message.scope,
            chatId: chatId,
          ), event.cursor ?? batch.nextCursor);
        case RemoteStateSnapshotEvent():
          final cursor = event.cursor ?? batch.nextCursor;
          if (event.targetChatId case final chatId?) {
            record((scope: event.targetChatScope, chatId: chatId), cursor);
          }
          for (final message in event.chatMessages) {
            record((scope: message.scope, chatId: message.chatId), cursor);
          }
          for (final summary in event.chatSummaries) {
            record((scope: summary.scope, chatId: summary.chatId), cursor);
          }
        case RemoteStateDeltaEvent():
          for (final summary in event.chatSummaries) {
            record((
              scope: summary.scope,
              chatId: summary.chatId,
            ), event.cursor ?? batch.nextCursor);
          }
        default:
          break;
      }
    }
  }

  /// A server read may lead live delivery. Keep replay through its cursor
  /// from replacing those newer rows, without skipping any other chat.
  RemoteTranscriptUpdate? afterCache(
    RemoteTranscriptUpdate update, {
    required RemoteChatResolver resolveChat,
    required void Function(RemoteChatKey) onUnsequencedLive,
    int? cursor,
    int? batchCursor,
  }) {
    if (_verified.isEmpty) return update;
    bool accepts(RemoteChatKey chat, {bool live = false}) {
      final floor = _verified[chat];
      if (floor == null) return true;
      if (cursor != null && cursor > 0) return cursor > floor;
      if (batchCursor != null && batchCursor > 0 && batchCursor <= floor) {
        return false;
      }
      // Older servers cannot order a mixed batch against this read. Resume
      // the existing snapshot path rather than retaining an unprovable floor.
      _verified.remove(chat);
      if (live) onUnsequencedLive(chat);
      return true;
    }

    switch (update) {
      case AuthoritativeTranscriptUpdate(:final chat):
        return accepts(chat) ? update : null;
      case LiveChatMessageUpdate(
        :final chatId,
        :final scope,
        :final message,
        :final keySnapshot,
      ):
        final chat = resolveChat(keySnapshot, chatId, scope ?? message.scope);
        return chat == null || accepts(chat, live: true) ? update : null;
      case IncomingChatRowsUpdate(
        :final rows,
        :final keySnapshot,
        :final fallbackScope,
      ):
        final kept = rows
            .where((row) {
              final chat = resolveChat(
                keySnapshot,
                row.chatId,
                row.scope ?? fallbackScope,
              );
              return chat == null || accepts(chat);
            })
            .toList(growable: false);
        if (kept.length == rows.length) return update;
        return IncomingChatRowsUpdate(
          rows: kept,
          keySnapshot: keySnapshot,
          fallbackScope: fallbackScope,
          authoritativeSnapshot: update.authoritativeSnapshot,
          preserveCacheProvenance: update.preserveCacheProvenance,
        );
    }
  }

  void reset() {
    _cursors.clear();
    _unproven.clear();
    _verified.clear();
  }
}
