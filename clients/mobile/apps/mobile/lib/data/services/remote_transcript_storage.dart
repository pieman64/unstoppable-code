/// Durable storage port for the Remote Control transcript cache (CAN-3373).
///
/// Pure Dart, so the cache and the Remote Control engine stay free of
/// Flutter and platform plugins; the app supplies a file implementation.
library;

import 'package:mobile/data/models/remote_chat.dart';

/// A chat's identity; the same shape as the engine's `RemoteChatKey`.
typedef RemoteTranscriptChat = ({RemoteChatScope scope, String chatId});

/// Whose transcripts a file holds: the signed-in account (environment and
/// user) and the server pairing session.
typedef RemoteTranscriptOwner = ({String accountScope, String sessionId});

/// One chat's stored tail.
final class PersistedTranscript {
  const PersistedTranscript({
    required this.chat,
    required this.openedAt,
    required this.rows,
  });

  final RemoteTranscriptChat chat;

  /// Logical recency: larger values were opened more recently.
  final int openedAt;

  /// Desktop-projected rows in transcript order, oldest first.
  final List<RemoteChatMessage> rows;
}

/// Durable storage for the transcript cache. Operations run in the order
/// they are issued; failures are cache misses, never errors.
abstract interface class RemoteTranscriptStorage {
  /// [owner]'s stored transcripts. Anything stored for another owner, or
  /// unreadable, is deleted.
  Future<List<PersistedTranscript>> load(RemoteTranscriptOwner owner);

  /// Replaces [transcript]'s stored copy.
  void write(RemoteTranscriptOwner owner, PersistedTranscript transcript);

  /// Deletes [chat]'s stored copy.
  void delete(RemoteTranscriptOwner owner, RemoteTranscriptChat chat);

  /// Deletes every stored transcript of every owner.
  Future<void> clear();

  /// Completes once every operation issued so far has finished.
  Future<void> flush();
}
