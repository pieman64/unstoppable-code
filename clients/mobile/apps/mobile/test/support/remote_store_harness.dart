import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/chat_transcript_store.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_store.dart';

/// One deterministic input to the Remote Control stores.
sealed class RemoteStoreStep {
  const RemoteStoreStep();
}

/// One event batch from the portal stream.
final class ApplyEvents extends RemoteStoreStep {
  const ApplyEvents(this.events);
  final List<RemotePortalEvent> events;
}

/// A snapshot read over HTTP, applied without a read baseline.
final class ApplySnapshotRead extends RemoteStoreStep {
  const ApplySnapshotRead(this.snapshot);
  final RemoteSessionSnapshot snapshot;
}

/// The server's cached tail, painted while a chat's transcript hydrates.
final class SeedCachedTail extends RemoteStoreStep {
  const SeedCachedTail(this.chat, this.rows);
  final RemoteChatKey chat;
  final List<RemoteChatMessage> rows;
}

/// Starts an older-history read for [target]. Its page arrives with the next
/// [FinishOlderHistory].
final class BeginOlderHistory extends RemoteStoreStep {
  const BeginOlderHistory(this.target);
  final RemoteChatTarget target;
}

/// Answers the read started by [BeginOlderHistory].
final class FinishOlderHistory extends RemoteStoreStep {
  const FinishOlderHistory(this.chunk);
  final RemoteChatHistoryChunk chunk;
}

/// The paired session is discarded, as on disconnect or session end.
final class ResetSession extends RemoteStoreStep {
  const ResetSession();
}

/// Drives [RemoteSessionStore] and [ChatTranscriptStore] the way the Remote
/// Control facade does — each reducer step's transcript updates reach the
/// transcript store right after the step — and records what they emit.
///
/// Pure Dart, so engine-level suites can replay the same sequences.
final class RemoteStoresHarness {
  RemoteStoresHarness() {
    transcripts = ChatTranscriptStore(
      notify: () => notifications++,
      isConnected: () => connected,
      fetchHistory: _fetchHistory,
      onEvidence: (chat, message) =>
          evidence.add((chat: chat, messageId: message.messageId)),
      onTranscriptChanged: (_) {},
    );
    session = RemoteSessionStore(
      // Transport order: the facade injects locale-aware collation.
      orderWorktrees: List.unmodifiable,
      knownChatKeys: () => transcripts.chatKeys,
      isLocallyRead: (_, _) => false,
      hasLocalReads: () => false,
    );
  }

  late final ChatTranscriptStore transcripts;
  late final RemoteSessionStore session;

  bool connected = true;
  int notifications = 0;

  /// Every reducer step's effects, in order.
  final effects = <RemoteSessionEffects>[];

  /// Every row the transcript store offered as turn evidence, in order.
  final evidence = <({RemoteChatKey chat, String messageId})>[];

  /// The `before` cursor of every older-history read, in order.
  final historyCursors = <String?>[];

  Completer<RemoteChatHistoryChunk>? _historyPage;
  Future<void>? _historyLoad;

  Future<RemoteChatHistoryChunk> _fetchHistory(
    RemoteChatTarget target, {
    String? before,
  }) {
    historyCursors.add(before);
    return (_historyPage = Completer()).future;
  }

  RemoteSessionEffects apply(RemotePortalEvent event) => route(switch (event) {
    RemoteChatMessageEvent() => session.applyChatMessage(event),
    RemoteStateSnapshotEvent() => session.applySnapshotEvent(event),
    RemoteStateDeltaEvent() => session.applyDelta(event),
    _ => RemoteSessionEffects.none,
  });

  /// Applies [events] as one portal batch ending at [cursor], the way the
  /// facade brackets each batch it receives.
  List<RemoteSessionEffects> applyBatch(
    List<RemotePortalEvent> events, {
    required int cursor,
  }) {
    session.beginEventBatch(cursor);
    try {
      return [for (final event in events) apply(event)];
    } finally {
      session.endEventBatch();
    }
  }

  RemoteSessionEffects applySnapshot(
    RemoteSessionSnapshot snapshot, {
    RemoteSnapshotReadBaseline? baseline,
  }) => route(session.applySnapshot(snapshot, baseline: baseline));

  /// Records [step] and hands its transcript updates to the transcript store.
  RemoteSessionEffects route(RemoteSessionEffects step) {
    effects.add(step);
    for (final update in step.transcriptUpdates) {
      transcripts.applyUpdate(update, resolveChat: session.chatKeyIn);
    }
    return step;
  }

  void reset() {
    session.reset();
    transcripts.reset();
  }

  /// Runs [steps] in order.
  Future<void> run(Iterable<RemoteStoreStep> steps) async {
    for (final step in steps) {
      switch (step) {
        case ApplyEvents(:final events):
          events.forEach(apply);
        case ApplySnapshotRead(:final snapshot):
          applySnapshot(snapshot);
        case SeedCachedTail(:final chat, :final rows):
          transcripts.seedFromCache(chat, rows);
        case BeginOlderHistory(:final target):
          _historyLoad = transcripts.loadOlderMessages(target);
        case FinishOlderHistory(:final chunk):
          _historyPage!.complete(chunk);
          await _historyLoad;
        case ResetSession():
          reset();
      }
    }
  }

  /// The ids of [target]'s rendered rows, in order.
  List<String> rowIds(RemoteChatTarget target) => [
    for (final message in transcripts.messagesFor(target)) message.messageId,
  ];
}
