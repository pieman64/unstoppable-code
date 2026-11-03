import 'dart:convert';

import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_session.dart';

int compareConversationDecimal(String a, String b) =>
    BigInt.parse(a).compareTo(BigInt.parse(b));
int _compareTurns(ConversationTurn a, ConversationTurn b) {
  final order = compareConversationDecimal(a.queueOrder, b.queueOrder);
  return order == 0 ? a.turnId.compareTo(b.turnId) : order;
}

/// Canonical v2 state. HTTP receipts reconcile delivery but never advance the
/// stream checkpoint. Only contiguous changes or an authoritative snapshot do.
final class CloudConversationSession {
  CloudConversationSession({
    required this.sessionId,
    this.version = '0',
    this.status = 'OPEN',
    this.streamResume,
    this.historyCursor,
    this.hasMoreHistory = false,
    this.ready = false,
    this.recovering = false,
    Iterable<ConversationMessage> messages = const [],
    Iterable<ConversationTurn> turns = const [],
  }) : messages = List.unmodifiable(
         messages.toList()..sort((a, b) => a.seq.compareTo(b.seq)),
       ),
       turns = List.unmodifiable(turns.toList()..sort(_compareTurns));
  final String sessionId, version, status;
  final String? streamResume, historyCursor;
  final bool hasMoreHistory, ready, recovering;
  final List<ConversationMessage> messages;
  final List<ConversationTurn> turns;
  bool get terminal => const {
    'TIMED_OUT',
    'CANCELLED',
    'COMPLETED',
    'FAILED',
    'STALE',
  }.contains(status);
  ConversationTurn? get running =>
      turns.where((t) => t.status == 'RUNNING').firstOrNull;
  Set<String> get acceptedIds => {
    ...turns.map((t) => t.clientRequestId),
    ...messages
        .where((m) => m.role == 'USER')
        .map((m) => m.clientRequestId)
        .whereType<String>(),
  };

  CloudConversationSession _copy({
    String? version,
    String? status,
    String? streamResume,
    String? historyCursor,
    bool replaceHistoryCursor = false,
    bool? hasMoreHistory,
    bool? ready,
    bool? recovering,
    Iterable<ConversationMessage>? messages,
    Iterable<ConversationTurn>? turns,
  }) => CloudConversationSession(
    sessionId: sessionId,
    version: version ?? this.version,
    status: status ?? this.status,
    streamResume: streamResume ?? this.streamResume,
    historyCursor: replaceHistoryCursor ? historyCursor : this.historyCursor,
    hasMoreHistory: hasMoreHistory ?? this.hasMoreHistory,
    ready: ready ?? this.ready,
    recovering: recovering ?? this.recovering,
    messages: messages ?? this.messages,
    turns: turns ?? this.turns,
  );

  CloudConversationSession requireRecovery() => _copy(recovering: true);
  CloudConversationSession snapshot(ConversationSnapshot value) {
    if (value.sessionId != sessionId) {
      throw const FormatException('Conversation binding changed');
    }
    if (ready && compareConversationDecimal(value.stateVersion, version) < 0) {
      return requireRecovery();
    }
    // Preserve only history proven older than the authoritative snapshot window.
    final sortedTurns = value.turns.toList()..sort(_compareTurns);
    final oldestTurn = sortedTurns.firstOrNull;
    final retained = turns
        .where(
          (t) =>
              !t.pending &&
              oldestTurn != null &&
              _compareTurns(t, oldestTurn) < 0,
        )
        .toList();
    final oldIds = retained.map((t) => t.turnId).toSet();
    final seqs = value.messages.map((m) => m.seq).toList()..sort();
    final older = messages.where(
      (m) =>
          seqs.isNotEmpty &&
          m.seq < seqs.first &&
          (m.turnId == null || oldIds.contains(m.turnId)),
    );
    final sameVersion =
        ready && compareConversationDecimal(value.stateVersion, version) == 0;
    return CloudConversationSession(
      sessionId: sessionId,
      version: value.stateVersion,
      status: value.sessionStatus,
      streamResume: value.streamResume,
      historyCursor: sameVersion ? historyCursor : value.historyCursor,
      hasMoreHistory: sameVersion ? hasMoreHistory : value.hasMoreHistory,
      ready: true,
      messages: _messages(older, value.messages),
      turns: _turns(retained, value.turns),
    );
  }

  CloudConversationSession changed(ConversationChangedEvent event) {
    if (event.sessionId != sessionId ||
        compareConversationDecimal(event.stateVersion, version) <= 0) {
      return this;
    }
    if (recovering ||
        !ready ||
        compareConversationDecimal(event.previousStateVersion, version) != 0) {
      return requireRecovery();
    }
    return _copy(
      version: event.stateVersion,
      status: event.sessionStatus,
      messages: _messages(messages, event.messages),
      turns: _turns(turns, event.turns),
    );
  }

  CloudConversationSession accepted(
    ConversationAcceptedTurn receipt,
    String requestId,
  ) {
    if (receipt.sessionId != sessionId ||
        receipt.turn.clientRequestId != requestId ||
        receipt.message.clientRequestId != requestId ||
        receipt.turn.userMessageId != receipt.message.id ||
        receipt.message.turnId != receipt.turn.turnId ||
        receipt.message.role != 'USER') {
      throw const FormatException('Turn receipt does not match its request');
    }
    if (compareConversationDecimal(receipt.acceptedStateVersion, version) <=
        0) {
      return this;
    }
    return _copy(
      messages: _messages(messages, [receipt.message]),
      turns: _turns(turns, [receipt.turn]),
    );
  }

  CloudConversationSession history(ConversationHistoryPage page) {
    if (page.sessionId != sessionId ||
        compareConversationDecimal(page.snapshotStateVersion, version) > 0) {
      throw const FormatException('History binding changed');
    }
    // Current rows win: pinned history must never resurrect a cancelled turn.
    return _copy(
      messages: _messages(page.messages, messages),
      turns: _turns(page.turns, turns),
      historyCursor: page.historyCursor,
      replaceHistoryCursor: true,
      hasMoreHistory: page.hasMoreHistory,
    );
  }

  CloudConversationSession receipt(ConversationCommandReceipt receipt) {
    if (receipt.sessionId != sessionId) {
      throw const FormatException('Command binding changed');
    }
    if (compareConversationDecimal(receipt.stateVersion, version) <= 0) {
      return this;
    }
    // Command receipts are partial; resnapshot instead of skipping other changes.
    return requireRecovery();
  }

  static Iterable<ConversationMessage> _messages(
    Iterable<ConversationMessage> a,
    Iterable<ConversationMessage> b,
  ) => {
    for (final m in [...a, ...b]) m.id: m,
  }.values;
  static Iterable<ConversationTurn> _turns(
    Iterable<ConversationTurn> a,
    Iterable<ConversationTurn> b,
  ) => {
    for (final t in [...a, ...b]) t.turnId: t,
  }.values;
}

List<CloudSessionEffect> deriveConversationEffects(
  CloudChatSessionState state,
  CloudConversationSession conversation,
  DateTime now,
) {
  if (!conversation.ready ||
      conversation.recovering ||
      state.attachment == CloudAttachmentStatus.stale) {
    return [CloudSessionEffect.bootstrap];
  }
  final head = state.outbox.firstOrNull;
  return [
    if (state.attachment == CloudAttachmentStatus.detached &&
        conversation.streamResume != null)
      CloudSessionEffect.attach,
    if (!conversation.terminal &&
        head?.status == CloudOutboxStatus.queued &&
        !state.outbox.any((e) => e.status == CloudOutboxStatus.posting) &&
        !(head!.nextAttemptAt?.isAfter(now) ?? false))
      CloudSessionEffect.post,
  ];
}

/// Projection adapter into the existing shared feed and tool/question mapper.
CloudChatBootstrap conversationBootstrap(
  CloudConversationSession state, {
  Map<String, Map<String, CloudChatToolActivity>> activityByTurn = const {},
}) {
  final activity = <CloudChatToolActivity>[];
  final messages = <CloudCoreMessage>[];
  for (final message in state.messages) {
    if (message.taskId != null) continue;
    final j = message.json;
    final source = message.sourceKey ?? message.turnId;
    for (final entry
        in activityByTurn[message.turnId]?.values ??
            const <CloudChatToolActivity>[]) {
      activity.add(
        CloudChatToolActivity(
          kind: entry.kind,
          rawKind: entry.rawKind,
          raw: entry.raw,
          sourceKey: source,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          input: entry.input,
          output: entry.output,
        ),
      );
    }
    final blocks = (j['contentBlocks'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    for (final block in blocks) {
      if (block['type'] == 'tool_call' &&
          !activity.any(
            (a) =>
                a.sourceKey == source &&
                a.toolCallId == block['toolCallId'] &&
                a.kind == CloudToolActivityKind.call,
          )) {
        final input = block['input'] ?? block['arguments'];
        activity.add(
          CloudChatToolActivity(
            kind: CloudToolActivityKind.call,
            rawKind: 'call',
            raw: block,
            sourceKey: source,
            toolCallId: block['toolCallId'] as String?,
            toolName: block['toolName'] as String?,
            input: input is String
                ? input
                : input == null
                ? ''
                : jsonEncode(input),
          ),
        );
      }
    }
    if (message.role == 'TOOL') {
      activity.add(
        CloudChatToolActivity(
          kind: CloudToolActivityKind.result,
          rawKind: 'result',
          raw: j,
          sourceKey: source,
          toolCallId: j['toolCallId'] as String?,
          toolName: j['toolName'] as String?,
          output: message.text,
        ),
      );
      continue;
    }
    final cost = j['costUsd'];
    final amount = cost is String ? double.tryParse(cost) : null;
    messages.add(
      CloudCoreMessage.fromJson({
        ...j,
        'artifacts': [
          for (final artifact in j['artifacts'] as List? ?? const [])
            if (artifact is Map<String, dynamic>)
              {
                ...artifact,
                'file': {
                  'name': artifact['payload'] is Map<String, dynamic>
                      ? (artifact['payload']
                                as Map<String, dynamic>)['filename'] ??
                            artifact['label']
                      : artifact['label'],
                  'content': artifact['payload'] is Map<String, dynamic>
                      ? (artifact['payload'] as Map<String, dynamic>)['content']
                      : null,
                },
              },
        ],
        'sequence': message.seq,
        'text': message.text,
        'sourceKey': source,
        'createdAtMs':
            DateTime.tryParse(
              j['createdAt'] as String,
            )?.millisecondsSinceEpoch ??
            0,
        'cost': {
          'kind': cost == null
              ? (message.role == 'USER' ? 'zero' : 'pending')
              : amount == null || !amount.isFinite || amount < 0
              ? 'invalid'
              : amount == 0
              ? 'zero'
              : 'billable',
          'costUsd': cost,
          'raw': cost,
        },
        'reasoningText': j['thinking'] is String ? j['thinking'] : null,
      }),
    );
  }
  return CloudChatBootstrap(
    messages: messages,
    toolActivity: activity,
    activeTurnId: state.running?.turnId,
  );
}

/// Full execution identity for transient frames; turn ids and execution source
/// keys are different namespaces. Stop uses sourceKey, commands use turnId.
final class ConversationExecution {
  ConversationExecution._(
    this.turnId,
    this.userMessageId,
    this.inferenceRunId,
    this.sourceKey,
    this.generation,
  );
  final String turnId, userMessageId, inferenceRunId, sourceKey;
  final int generation;
  int nextStreamIndex = 0;
  bool matches(ConversationExecution other) =>
      turnId == other.turnId &&
      userMessageId == other.userMessageId &&
      inferenceRunId == other.inferenceRunId &&
      sourceKey == other.sourceKey &&
      generation == other.generation;
  bool belongsTo(ConversationTurn? turn) =>
      turn?.status == 'RUNNING' &&
      turn?.turnId == turnId &&
      turn?.userMessageId == userMessageId &&
      turn?.inferenceRunId == inferenceRunId;
  static ConversationExecution? parse(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    for (final k in [
      'turnId',
      'userMessageId',
      'inferenceRunId',
      'sourceKey',
    ]) {
      if (value[k] is! String || (value[k] as String).isEmpty) return null;
    }
    final g = value['executionGeneration'];
    if (g is! int || g < 1 || g > 9007199254740991) return null;
    return ConversationExecution._(
      value['turnId'] as String,
      value['userMessageId'] as String,
      value['inferenceRunId'] as String,
      value['sourceKey'] as String,
      g,
    );
  }
}
