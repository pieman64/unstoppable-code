import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';

enum CloudSessionStatus { live, terminal, unknown }

enum CloudAttachmentStatus { detached, attaching, attached, stale }

enum CloudOutboxStatus { queued, posting, accepted }

class CloudSendPayload {
  const CloudSendPayload({
    required this.text,
    this.modelDefinitionId,
    this.thinkingLevel,
    this.resetThinkingLevel = false,
    this.fastMode,
    this.autoModel = false,
    this.attachments = const [],
  });
  final String text;
  final String? modelDefinitionId;

  /// Ready uploads the message carries as `cloudAttachments`.
  final List<ChatAttachmentRef> attachments;

  /// A new chat is created in Auto; [modelDefinitionId] stays the fallback.
  final bool autoModel;
  final String? thinkingLevel;
  final bool resetThinkingLevel;
  final bool? fastMode;
  CloudSendPayload withText(String text) => CloudSendPayload(
    text: text,
    modelDefinitionId: modelDefinitionId,
    thinkingLevel: thinkingLevel,
    resetThinkingLevel: resetThinkingLevel,
    fastMode: fastMode,
    autoModel: autoModel,
    attachments: attachments,
  );

  CloudSendPayload withAttachments(List<ChatAttachmentRef> attachments) =>
      CloudSendPayload(
        text: text,
        modelDefinitionId: modelDefinitionId,
        thinkingLevel: thinkingLevel,
        resetThinkingLevel: resetThinkingLevel,
        fastMode: fastMode,
        autoModel: autoModel,
        attachments: attachments,
      );
}

class CloudOutboxEntry {
  const CloudOutboxEntry({
    required this.clientRequestId,
    required this.payload,
    required this.enqueuedAt,
    this.status = CloudOutboxStatus.queued,
    this.attempts = 0,
    this.lastError,
    this.nextAttemptAt,
  });
  final String clientRequestId;
  final CloudSendPayload payload;
  final DateTime enqueuedAt;
  final CloudOutboxStatus status;
  final int attempts;
  final CloudSendError? lastError;
  final DateTime? nextAttemptAt;
  CloudOutboxEntry copyWith({
    CloudSendPayload? payload,
    CloudOutboxStatus? status,
    int? attempts,
    CloudSendError? lastError,
    DateTime? nextAttemptAt,
  }) => CloudOutboxEntry(
    clientRequestId: clientRequestId,
    payload: payload ?? this.payload,
    enqueuedAt: enqueuedAt,
    status: status ?? this.status,
    attempts: attempts ?? this.attempts,
    lastError: lastError ?? this.lastError,
    nextAttemptAt: nextAttemptAt ?? this.nextAttemptAt,
  );
}

class CloudLiveTurn {
  const CloudLiveTurn({
    this.turnId,
    required this.userMessageId,
    required this.startedAt,
    this.interrupting = false,
  });
  final String? turnId;
  final String userMessageId;
  final DateTime startedAt;
  final bool interrupting;
}

class CloudCapabilityState {
  const CloudCapabilityState(
    this.version, {
    this.activeDigest,
    this.pendingDigest,
  });
  final BigInt version;
  final String? activeDigest;
  final String? pendingDigest;
}

const _absent = Object();

class CloudChatSessionState {
  CloudChatSessionState({
    required this.chatId,
    required this.cursorEpoch,
    List<CloudTranscriptMessage> transcript = const [],
    this.liveTurn,
    this.cursor,
    this.sessionStatus = CloudSessionStatus.unknown,
    this.capabilityState,
    List<CloudOutboxEntry> outbox = const [],
    Map<String, CloudTranscriptMessage> optimistic = const {},
    this.attachment = CloudAttachmentStatus.detached,
    this.bootstrapError,
    this.terminalReason,
    this.lastFrameAt,
    this.executionHarness,
  }) : transcript = List.unmodifiable(transcript),
       outbox = List.unmodifiable(outbox),
       optimistic = Map.unmodifiable(optimistic);
  final String chatId;
  final String cursorEpoch;
  final List<CloudTranscriptMessage> transcript;
  final CloudLiveTurn? liveTurn;
  final String? cursor;
  final CloudSessionStatus sessionStatus;
  final CloudCapabilityState? capabilityState;
  final List<CloudOutboxEntry> outbox;
  final Map<String, CloudTranscriptMessage> optimistic;
  final CloudAttachmentStatus attachment;
  final String? bootstrapError;
  final String? terminalReason;
  final DateTime? lastFrameAt;

  /// Core's harness binding from the latest bootstrap, when it sent one.
  final String? executionHarness;

  bool get isBusy =>
      liveTurn != null ||
      outbox.any((e) => e.status != CloudOutboxStatus.accepted);
  bool get canInterrupt => liveTurn?.turnId != null && !liveTurn!.interrupting;
  List<CloudTranscriptMessage> get visibleTranscript {
    final canonical = transcript
        .where(
          (m) =>
              m.role == ChatRole.user && !m.messageId.startsWith('optimistic:'),
        )
        .map((m) => m.clientRequestId)
        .toSet();
    return List.unmodifiable(
      mergeCloudMessages(
        transcript,
        optimistic.entries
            .where((e) => !canonical.contains(e.key))
            .map((e) => e.value),
      ),
    );
  }

  CloudChatSessionState copyWith({
    String? cursorEpoch,
    List<CloudTranscriptMessage>? transcript,
    Object? liveTurn = _absent,
    Object? cursor = _absent,
    CloudSessionStatus? sessionStatus,
    Object? capabilityState = _absent,
    List<CloudOutboxEntry>? outbox,
    Map<String, CloudTranscriptMessage>? optimistic,
    CloudAttachmentStatus? attachment,
    Object? bootstrapError = _absent,
    Object? terminalReason = _absent,
    Object? lastFrameAt = _absent,
    Object? executionHarness = _absent,
  }) => CloudChatSessionState(
    chatId: chatId,
    cursorEpoch: cursorEpoch ?? this.cursorEpoch,
    transcript: transcript ?? this.transcript,
    liveTurn: identical(liveTurn, _absent)
        ? this.liveTurn
        : liveTurn as CloudLiveTurn?,
    cursor: identical(cursor, _absent) ? this.cursor : cursor as String?,
    sessionStatus: sessionStatus ?? this.sessionStatus,
    capabilityState: identical(capabilityState, _absent)
        ? this.capabilityState
        : capabilityState as CloudCapabilityState?,
    outbox: outbox ?? this.outbox,
    optimistic: optimistic ?? this.optimistic,
    attachment: attachment ?? this.attachment,
    bootstrapError: identical(bootstrapError, _absent)
        ? this.bootstrapError
        : bootstrapError as String?,
    terminalReason: identical(terminalReason, _absent)
        ? this.terminalReason
        : terminalReason as String?,
    lastFrameAt: identical(lastFrameAt, _absent)
        ? this.lastFrameAt
        : lastFrameAt as DateTime?,
    executionHarness: identical(executionHarness, _absent)
        ? this.executionHarness
        : executionHarness as String?,
  );
}

List<CloudTranscriptMessage> mergeCloudMessages(
  Iterable<CloudTranscriptMessage> current,
  Iterable<CloudTranscriptMessage> incoming,
) {
  final rows = {
    for (final row in [...current, ...incoming]) row.messageId: row,
  };
  final canonical = rows.values
      .where(
        (m) =>
            m.role == ChatRole.user && !m.messageId.startsWith('optimistic:'),
      )
      .map((m) => m.clientRequestId)
      .toSet();
  return rows.values
      .where(
        (m) =>
            !m.messageId.startsWith('optimistic:') ||
            !canonical.contains(m.clientRequestId),
      )
      .toList()
    ..sort((a, b) {
      final order = (a.occurredAt?.millisecondsSinceEpoch ?? 0).compareTo(
        b.occurredAt?.millisecondsSinceEpoch ?? 0,
      );
      return order == 0 ? a.messageId.compareTo(b.messageId) : order;
    });
}

(BigInt, BigInt?)? _position(String cursor) {
  if (RegExp(r'^\d+$').hasMatch(cursor)) return (BigInt.parse(cursor), null);
  final match = RegExp(
    r'^stream:(\d+):[^:]+:(\d+)(?::.*)?$',
  ).firstMatch(cursor);
  return match == null
      ? null
      : (BigInt.parse(match[1]!), BigInt.parse(match[2]!));
}

int? compareCloudCursors(String incoming, String current) {
  if (incoming == current) return 0;
  final a = _position(incoming), b = _position(current);
  if (a == null || b == null) return null;
  if (a.$1 != b.$1) return a.$1.compareTo(b.$1);
  if (a.$2 == b.$2) return null;
  if (a.$2 == null) return -1;
  if (b.$2 == null) return 1;
  return a.$2!.compareTo(b.$2!);
}

String? advanceCloudCursor(String? current, String? incoming) {
  if (incoming == null) return current;
  if (current == null) return incoming;
  final order = compareCloudCursors(incoming, current);
  return order == null || order > 0 ? incoming : current;
}

enum CloudSessionEffect { bootstrap, post, attach }

List<CloudSessionEffect> deriveCloudEffects(
  CloudChatSessionState state,
  DateTime now,
) {
  final detached =
      state.liveTurn != null &&
      state.attachment == CloudAttachmentStatus.detached;
  final head = state.outbox.firstOrNull;
  return [
    if (state.attachment == CloudAttachmentStatus.stale ||
        detached && state.cursor == null ||
        state.sessionStatus == CloudSessionStatus.unknown &&
            state.attachment != CloudAttachmentStatus.attaching)
      CloudSessionEffect.bootstrap,
    if (head?.status == CloudOutboxStatus.queued &&
        !state.outbox.any((e) => e.status == CloudOutboxStatus.posting) &&
        state.liveTurn == null &&
        state.sessionStatus == CloudSessionStatus.live &&
        !(head!.nextAttemptAt?.isAfter(now) ?? false))
      CloudSessionEffect.post,
    if (detached && state.cursor != null) CloudSessionEffect.attach,
  ];
}

void assertCloudSessionInvariants(
  CloudChatSessionState state, [
  CloudChatSessionState? previous,
]) {
  if (state.outbox.where((e) => e.status == CloudOutboxStatus.posting).length >
      1) {
    throw StateError('At most one posting entry is allowed');
  }
  if (state.sessionStatus == CloudSessionStatus.terminal &&
      state.liveTurn != null) {
    throw StateError('Terminal session cannot retain a live turn');
  }
  final ids = {
    ...state.outbox.map((e) => e.clientRequestId),
    ...state.transcript.map((m) => m.clientRequestId),
  };
  if (state.optimistic.keys.any((id) => !ids.contains(id))) {
    throw StateError('Orphan optimistic row');
  }
  if (previous == null || previous.cursorEpoch != state.cursorEpoch) return;
  if (previous.cursor != null &&
      (state.cursor == null ||
          compareCloudCursors(state.cursor!, previous.cursor!) == -1)) {
    throw StateError('Cursor regressed within an epoch');
  }
  if (previous.capabilityState != null &&
      (state.capabilityState == null ||
          state.capabilityState!.version < previous.capabilityState!.version)) {
    throw StateError('Capability version regressed');
  }
}

/// Core's accepted checkpoint covers the whole durable sequence, including
/// legacy and composite stream frame ids (matching the web replay filter).
bool isCloudReplayCursor(String? after, String? eventId) {
  BigInt? sequence(String? value) {
    final match = RegExp(
      r'^(?:stream:)?(\d+)(?::.*)?$',
    ).firstMatch(value ?? '');
    return match == null ? null : BigInt.parse(match[1]!);
  }

  final accepted = sequence(after), received = sequence(eventId);
  return accepted != null && received != null && received <= accepted;
}

/// Bootstrap is the authority for live-turn identity and canonical rows.
///
/// [replaceHistory] is set for the first bootstrap of a continued session:
/// Core copies the prior history under new message ids. The bootstrap is only
/// the latest page, so retain already loaded rows older than that page while
/// replacing the overlapping rows with the new epoch's canonical copies.
CloudChatSessionState reduceCloudBootstrap(
  CloudChatSessionState current,
  CloudChatBootstrap result,
  List<CloudTranscriptMessage> rows,
  DateTime now, {
  bool replaceHistory = false,
}) {
  final ids = rows
      .where((m) => m.role == ChatRole.user)
      .map((m) => m.clientRequestId)
      .toSet();
  final cursor = advanceCloudCursor(current.cursor, result.activeStreamAfter);
  final partial =
      (result.activeTurnId == null) != (result.activeUserMessageId == null);
  final turn = !partial && result.activeTurnId != null
      ? CloudLiveTurn(
          turnId: result.activeTurnId,
          userMessageId: result.activeUserMessageId!,
          startedAt: current.liveTurn?.turnId == result.activeTurnId
              ? current.liveTurn!.startedAt
              : now,
        )
      : null;
  final stale = partial || turn != null && cursor == null;
  final terminal = result.terminalSession;
  final oldestCopiedAt = rows
      .map((row) => row.occurredAt)
      .whereType<DateTime>()
      .fold<DateTime?>(
        null,
        (oldest, at) => oldest == null || at.isBefore(oldest) ? at : oldest,
      );
  return current.copyWith(
    transcript: mergeCloudMessages(
      current.transcript.where(
        (m) => replaceHistory
            ? m.messageId.startsWith('optimistic:') ||
                  oldestCopiedAt == null ||
                  m.occurredAt != null && m.occurredAt!.isBefore(oldestCopiedAt)
            : !(m.role == ChatRole.assistant &&
                  m.messageId.startsWith('cloud:')),
      ),
      rows,
    ),
    outbox: current.outbox
        .where((e) => !ids.contains(e.clientRequestId))
        .toList(),
    optimistic: {...current.optimistic}
      ..removeWhere((id, _) => ids.contains(id)),
    cursor: cursor,
    liveTurn: terminal == null ? turn : null,
    sessionStatus: terminal != null
        ? CloudSessionStatus.terminal
        : stale || result.livenessUnknown
        ? CloudSessionStatus.unknown
        : CloudSessionStatus.live,
    attachment: stale
        ? CloudAttachmentStatus.stale
        : CloudAttachmentStatus.detached,
    bootstrapError: null,
    terminalReason: terminal?.status,
    executionHarness: result.executionHarness,
    lastFrameAt:
        current.liveTurn != null &&
            turn != null &&
            current.liveTurn!.turnId == turn.turnId &&
            current.liveTurn!.userMessageId == turn.userMessageId
        ? current.lastFrameAt
        : null,
  );
}

/// Replays reconcile the row without claiming a new live turn or scalar state.
CloudChatSessionState reduceCloudAccepted(
  CloudChatSessionState current,
  String clientRequestId,
  PostTurnResult result,
  List<CloudTranscriptMessage> rows,
  DateTime now,
) {
  final pending = current.outbox.any(
    (e) => e.clientRequestId == clientRequestId,
  );
  var next = current.copyWith(
    outbox: current.outbox
        .where((e) => e.clientRequestId != clientRequestId)
        .toList(),
    optimistic: {...current.optimistic}..remove(clientRequestId),
    transcript: mergeCloudMessages(current.transcript, rows),
  );
  if (result.replayed) {
    if (current.sessionStatus != CloudSessionStatus.terminal) {
      next = next.copyWith(
        attachment: CloudAttachmentStatus.stale,
        sessionStatus: CloudSessionStatus.unknown,
      );
    }
  } else {
    final version = BigInt.tryParse(result.capabilityBundleStateVersion ?? '');
    if (version != null &&
        (current.capabilityState == null ||
            version > current.capabilityState!.version)) {
      final bundles = result.capabilityBundles;
      String? digest(String key) {
        final bundle = bundles is Map ? bundles[key] : null;
        return bundle is Map && bundle['digest'] is String
            ? bundle['digest'] as String
            : null;
      }

      next = next.copyWith(
        capabilityState: CloudCapabilityState(
          version,
          activeDigest: digest('activeBundle'),
          pendingDigest: digest('pendingBundle'),
        ),
      );
    }
    if (pending && current.sessionStatus != CloudSessionStatus.terminal) {
      next = next.copyWith(
        liveTurn: CloudLiveTurn(
          userMessageId: result.message.id,
          startedAt: now,
        ),
        cursor: advanceCloudCursor(current.cursor, result.streamAfter),
        sessionStatus: result.streamAfter == null
            ? CloudSessionStatus.unknown
            : CloudSessionStatus.live,
        attachment: result.streamAfter == null
            ? CloudAttachmentStatus.stale
            : CloudAttachmentStatus.detached,
        lastFrameAt: null,
      );
    }
  }
  return next;
}

/// Projection rows alone never settle liveness. A terminal must name the bound
/// turn; ambiguous identity demotes the session until bootstrap answers.
CloudChatSessionState reduceCloudFrame(
  CloudChatSessionState s,
  CloudWireFrame frame,
  List<CloudTranscriptMessage> rows, {
  required bool terminal,
  required String? cursor,
  required DateTime now,
}) {
  final source = frame.sourceKey;
  // A finish cannot bind an unbound turn: bootstrap must name its identity.
  if (!terminal &&
      source != null &&
      rows.any((row) => row.sourceKey == source) &&
      (frame is CloudMessageStart && frame.isAssistant ||
          frame is CloudMessageDelta ||
          frame is CloudMessageReasoning ||
          frame is CloudToolFrame)) {
    final turn = s.liveTurn;
    if (turn != null && turn.turnId == null) {
      s = s.copyWith(
        liveTurn: CloudLiveTurn(
          turnId: source,
          userMessageId: turn.userMessageId,
          startedAt: turn.startedAt,
        ),
      );
    } else if (turn?.turnId != source &&
        s.sessionStatus != CloudSessionStatus.terminal) {
      s = s.copyWith(
        liveTurn: CloudLiveTurn(
          turnId: source,
          userMessageId: 'unknown:$source',
          startedAt: now,
        ),
        sessionStatus: CloudSessionStatus.unknown,
        attachment: CloudAttachmentStatus.stale,
      );
    }
  }
  s = s.copyWith(
    transcript: mergeCloudMessages(s.transcript, rows),
    cursor: advanceCloudCursor(s.cursor, cursor),
    lastFrameAt: now,
  );
  if (terminal) {
    if (source == null || s.liveTurn != null && s.liveTurn!.turnId == null) {
      s = s.copyWith(
        attachment: CloudAttachmentStatus.stale,
        sessionStatus: s.sessionStatus == CloudSessionStatus.terminal
            ? CloudSessionStatus.terminal
            : CloudSessionStatus.unknown,
      );
    } else if (s.liveTurn?.turnId == source) {
      s = s.copyWith(liveTurn: null);
    }
  }
  return s;
}
