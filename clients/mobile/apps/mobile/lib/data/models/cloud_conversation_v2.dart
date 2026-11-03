/// Mobile wire boundary for cloud-client/transport/conversation-v2-wire.ts.
/// Decimal versions stay strings; history and stream tokens stay opaque.
library;

import 'package:mobile/data/models/chat_attachment.dart';

const conversationSessionStatuses = {
  'QUEUED',
  'STARTING',
  'OPEN',
  'RUNNING',
  'WAITING_FOR_USER',
  'CONTINUE_REQUESTED',
  'TIMED_OUT',
  'CANCELLING',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'STALE',
};

Map<String, dynamic> _object(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const FormatException('Expected object');
  }
  return Map.unmodifiable(value);
}

String _string(Object? value) {
  if (value is! String || value.isEmpty) {
    throw const FormatException('Expected nonempty string');
  }
  return value;
}

String _decimal(Object? value) {
  final text = _string(value);
  if (!RegExp(r'^\d+$').hasMatch(text)) {
    throw const FormatException('Expected decimal string');
  }
  return text;
}

String? _nullableString(Object? value) {
  if (value != null && value is! String) {
    throw const FormatException('Expected nullable string');
  }
  return value as String?;
}

int _count(Object? value) {
  if (value is! int || value < 0 || value > 9007199254740991) {
    throw const FormatException('Expected safe nonnegative integer');
  }
  return value;
}

bool _bool(Object? value) {
  if (value is! bool) throw const FormatException('Expected boolean');
  return value;
}

List<T> _list<T>(Object? value, T Function(Object?) parse) {
  if (value is! List) throw const FormatException('Expected array');
  return List.unmodifiable(value.map(parse));
}

/// Entries of an optional array, or none; their readers drop bad entries.
List<Object?> _optionalList(Object? value) =>
    value is List ? List.unmodifiable(value) : const [];

String _enum(Object? value, Set<String> values) {
  if (!values.contains(value)) throw const FormatException('Unknown status');
  return value as String;
}

void _envelope(Map<String, dynamic> json) {
  if (json['protocolVersion'] != 2) {
    throw const FormatException('Expected protocol v2');
  }
  _string(json['sessionId']);
}

final class ConversationDiscoveryMetadata {
  const ConversationDiscoveryMetadata({
    required this.sessionId,
    required this.protocolVersion,
  });
  final String sessionId;
  final int protocolVersion;
  factory ConversationDiscoveryMetadata.fromJson(Object? value) {
    final json = _object(value);
    // Older Core discovery omitted this field. An explicit unknown version is
    // never downgraded to legacy.
    final version = json.containsKey('protocolVersion')
        ? json['protocolVersion']
        : 1;
    if (version != 1 && version != 2) {
      throw const FormatException('Unsupported conversation protocol');
    }
    return ConversationDiscoveryMetadata(
      sessionId: _string(json['sessionId']),
      protocolVersion: version as int,
    );
  }
}

final class ConversationMessage {
  ConversationMessage._(this.json, this.seq, this.role, this.turnId);
  final Map<String, dynamic> json;
  final int seq;
  final String role;
  final String? turnId;
  String get id => json['id'] as String;
  String? get clientRequestId => json['clientRequestId'] as String?;
  String? get sourceKey => json['sourceKey'] as String?;

  /// Set on an agent task (subagent) reply, which is not a root message.
  String? get taskId => switch (json['taskId']) {
    final String id when id.isNotEmpty => id,
    _ => null,
  };
  Object? get content => json['content'];
  String get text => conversationContentText(content);
  factory ConversationMessage.fromJson(Object? value) {
    final j = _object(value);
    for (final key in ['id', 'createdAt', 'updatedAt']) {
      _string(j[key]);
    }
    if (!j.containsKey('content') || !j.containsKey('turnId')) {
      throw const FormatException('Missing message content or turn identity');
    }
    for (final key in [
      'clientRequestId',
      'source',
      'sourceKey',
      'toolCallId',
      'toolName',
      'costUsd',
      'incurredCostUsd',
      'copiedHistoricalCostUsd',
    ]) {
      _nullableString(j[key]);
    }
    if (j.containsKey('contentBlocks')) _list(j['contentBlocks'], (v) => v);
    if (j.containsKey('costBilledViaLlmProxy') &&
        j['costBilledViaLlmProxy'] != true) {
      throw const FormatException('Invalid billing flag');
    }
    if (j.containsKey('artifacts')) {
      _list(j['artifacts'], (v) {
        final a = _object(v);
        for (final key in [
          'id',
          'toolCallId',
          'toolName',
          'kind',
          'createdAt',
        ]) {
          _string(a[key]);
        }
        _count(a['artifactIndex']);
        if (a.containsKey('order')) _count(a['order']);
        _enum(a['storageKind'], {'inline', 'blob', 'external'});
        if (!a.containsKey('sizeBytes') || !a.containsKey('payload')) {
          throw const FormatException('Invalid artifact');
        }
        if (a['sizeBytes'] != null) _decimal(a['sizeBytes']);
        return a;
      });
    }
    return ConversationMessage._(
      j,
      _count(j['seq']),
      _enum(j['role'], {'USER', 'ASSISTANT', 'SYSTEM', 'TOOL'}),
      _nullableString(j['turnId']),
    );
  }
}

String conversationContentText(Object? value) {
  if (value is String) return value;
  if (value is List) return value.map(conversationContentText).join();
  if (value is Map && value['text'] is String) return value['text'] as String;
  return '';
}

final class ConversationTurn {
  ConversationTurn._(this.json);
  final Map<String, dynamic> json;
  String get turnId => json['turnId'] as String;
  String get queueOrder => json['queueOrder'] as String;
  String get clientRequestId => json['clientRequestId'] as String;
  String get userMessageId => json['userMessageId'] as String;
  String? get inferenceRunId => json['inferenceRunId'] as String?;
  String? get assistantMessageId => json['assistantMessageId'] as String?;
  String? get startedAt => json['startedAt'] as String?;
  String get status => json['status'] as String;
  bool get pending => status == 'RUNNING' || status == 'QUEUED';
  factory ConversationTurn.fromJson(Object? value) {
    final j = _object(value);
    for (final k in ['turnId', 'clientRequestId', 'userMessageId']) {
      _string(j[k]);
    }
    _decimal(j['queueOrder']);
    for (final k in ['inferenceRunId', 'assistantMessageId']) {
      if (!j.containsKey(k)) {
        throw const FormatException('Missing execution identity');
      }
      _nullableString(j[k]);
    }
    _nullableString(j['startedAt']);
    _enum(j['status'], {
      'QUEUED',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'INTERRUPTED',
      'CANCELLED',
    });
    return ConversationTurn._(j);
  }
}

final class ConversationSnapshot {
  ConversationSnapshot._(this.json, this.messages, this.turns);
  final Map<String, dynamic> json;
  final List<ConversationMessage> messages;
  final List<ConversationTurn> turns;
  String get sessionId => json['sessionId'] as String;
  String get stateVersion => json['stateVersion'] as String;
  String get sessionStatus => json['sessionStatus'] as String;
  String get streamResume => json['streamResume'] as String;
  String get eventAfter => json['eventAfter'] as String;
  String? get historyCursor => json['historyCursor'] as String?;
  bool get hasMoreHistory => json['hasMoreHistory'] as bool;

  /// Agent task rows and durable tool activity, read by the task fold.
  List<Object?> get tasks => _optionalList(json['tasks']);
  List<Object?> get toolActivity => _optionalList(json['toolActivity']);
  factory ConversationSnapshot.fromJson(Object? value) {
    final j = _object(value);
    _envelope(j);
    _decimal(j['stateVersion']);
    _enum(j['sessionStatus'], conversationSessionStatuses);
    _count(j['pendingTurnCount']);
    _bool(j['hasMoreHistory']);
    if (!j.containsKey('historyCursor')) {
      throw const FormatException('Missing history cursor');
    }
    _nullableString(j['historyCursor']);
    _string(j['eventAfter']);
    _string(j['streamResume']);
    return ConversationSnapshot._(
      j,
      _list(j['messages'], ConversationMessage.fromJson),
      _list(j['turns'], ConversationTurn.fromJson),
    );
  }
}

final class ConversationHistoryPage {
  ConversationHistoryPage._(this.json, this.messages, this.turns);
  final Map<String, dynamic> json;
  final List<ConversationMessage> messages;
  final List<ConversationTurn> turns;
  String get sessionId => json['sessionId'] as String;
  String get snapshotStateVersion => json['snapshotStateVersion'] as String;
  String get messageWatermark => json['messageWatermark'] as String;
  String get eventAfter => json['eventAfter'] as String;
  String? get historyCursor => json['historyCursor'] as String?;
  bool get hasMoreHistory => json['hasMoreHistory'] as bool;
  List<Object?> get tasks => _optionalList(json['tasks']);
  List<Object?> get toolActivity => _optionalList(json['toolActivity']);
  factory ConversationHistoryPage.fromJson(Object? value) {
    final j = _object(value);
    _envelope(j);
    if (j['@type'] != 'agent_conversation_history_page' ||
        !j.containsKey('historyCursor')) {
      throw const FormatException('Invalid history page');
    }
    _decimal(j['snapshotStateVersion']);
    _decimal(j['messageWatermark']);
    _string(j['eventAfter']);
    _bool(j['hasMoreHistory']);
    _nullableString(j['historyCursor']);
    return ConversationHistoryPage._(
      j,
      _list(j['messages'], ConversationMessage.fromJson),
      _list(j['turns'], ConversationTurn.fromJson),
    );
  }
}

final class ConversationAcceptedTurn {
  ConversationAcceptedTurn._(this.json, this.turn, this.message);
  final Map<String, dynamic> json;
  final ConversationTurn turn;
  final ConversationMessage message;
  String get sessionId => json['sessionId'] as String;
  String get acceptedStateVersion => json['acceptedStateVersion'] as String;
  bool get replayed => json['replayed'] as bool;

  /// The selection mode (`auto` or `manual`) and model the server saved with
  /// this turn; null when it did not say.
  String? get modelSelectionMode => switch (json['modelSelectionMode']) {
    final String value => value,
    _ => null,
  };
  String? get modelDefinitionId => switch (json['modelDefinitionId']) {
    final String value => value,
    _ => null,
  };

  factory ConversationAcceptedTurn.fromJson(Object? value) {
    final j = _object(value);
    _envelope(j);
    _decimal(j['acceptedStateVersion']);
    _bool(j['replayed']);
    if (j.containsKey('capabilityBundleStateVersion') &&
        (j['capabilityBundleStateVersion'] is! num ||
            !(j['capabilityBundleStateVersion'] as num).isFinite)) {
      throw const FormatException('Invalid capability version');
    }
    return ConversationAcceptedTurn._(
      j,
      ConversationTurn.fromJson(j['turn']),
      ConversationMessage.fromJson(j['message']),
    );
  }
}

enum ConversationTurnOperation { edit, cancel, promote }

final class ConversationCommandInput {
  const ConversationCommandInput({
    required this.commandId,
    required this.expectedStateVersion,
    this.content,
  });
  final String commandId, expectedStateVersion;
  final Object? content;
  Map<String, dynamic> toJson() => {
    'commandId': commandId,
    'expectedStateVersion': expectedStateVersion,
    if (content != null) 'content': content,
  };
}

final class ConversationSendInput {
  const ConversationSendInput({
    required this.clientRequestId,
    required this.content,
    this.retryUncertain = false,
    this.modelDefinitionId,
    this.thinkingEffort,
    this.resetThinkingEffort = false,
    this.fastMode,
    this.cloudAttachments = const [],
  });
  final String clientRequestId;
  final Object? content, thinkingEffort;
  final bool retryUncertain, resetThinkingEffort;
  final String? modelDefinitionId;
  final bool? fastMode;
  final List<ChatAttachmentRef> cloudAttachments;
  Map<String, dynamic> toJson() => {
    'clientRequestId': clientRequestId,
    'content': content,
    if (retryUncertain) 'retryUncertain': true,
    'modelDefinitionId': ?modelDefinitionId,
    if (resetThinkingEffort) 'thinkingEffort': null,
    if (!resetThinkingEffort) 'thinkingEffort': ?thinkingEffort,
    'fastMode': ?fastMode,
    if (cloudAttachments.isNotEmpty)
      'cloudAttachments': [for (final ref in cloudAttachments) ref.toJson()],
  };
}

final class ConversationCommandReceipt {
  ConversationCommandReceipt._(this.json, this.turns, this.message);
  final Map<String, dynamic> json;
  final List<ConversationTurn> turns;
  final ConversationMessage? message;
  String get sessionId => json['sessionId'] as String;
  String get stateVersion => json['stateVersion'] as String;
  String get commandId => json['commandId'] as String;
  factory ConversationCommandReceipt.fromJson(Object? value) {
    final j = _object(value);
    _envelope(j);
    _decimal(j['stateVersion']);
    _string(j['commandId']);
    _bool(j['replayed']);
    final kind = _enum(j['kind'], {'edited', 'cancelled', 'promoted'});
    return ConversationCommandReceipt._(
      j,
      kind == 'promoted'
          ? _list(j['turns'], ConversationTurn.fromJson)
          : [ConversationTurn.fromJson(j['turn'])],
      kind == 'edited' ? ConversationMessage.fromJson(j['message']) : null,
    );
  }
}

final class ConversationChangedEvent {
  ConversationChangedEvent._(
    this.json,
    this.messages,
    this.turns,
    this.sessionStatus,
    this.tasks,
  );
  final Map<String, dynamic> json;
  final List<ConversationMessage> messages;
  final List<ConversationTurn> turns;
  final String? sessionStatus;

  /// Raw `task.upsert` task rows, read by the task fold.
  final List<Object?> tasks;
  String get sessionId => json['sessionId'] as String;
  String get previousStateVersion => json['previousStateVersion'] as String;
  String get stateVersion => json['stateVersion'] as String;
  factory ConversationChangedEvent.fromJson(Object? value) {
    final j = _object(value);
    _envelope(j);
    _decimal(j['previousStateVersion']);
    _decimal(j['stateVersion']);
    final messages = <ConversationMessage>[], turns = <ConversationTurn>[];
    final tasks = <Object?>[];
    String? status;
    _list(j['changes'], (v) {
      final c = _object(v);
      switch (c['type']) {
        case 'message.upsert':
          messages.add(ConversationMessage.fromJson(c['message']));
        case 'turn.upsert':
          turns.add(ConversationTurn.fromJson(c['turn']));
        case 'session.lifecycle':
          _string(c['sessionId']);
          _enum(c['status'], conversationSessionStatuses);
          if (c['sessionId'] == j['sessionId']) status = c['status'] as String;
        case 'task.upsert':
          tasks.add(c['task']);
        default:
          // Newer change types must never cost the client its stream.
          break;
      }
      return c;
    });
    if (j['command'] != null) {
      final command = ConversationCommandReceipt.fromJson(j['command']);
      if (command.sessionId == j['sessionId'] &&
          command.stateVersion == j['stateVersion']) {
        turns.addAll(command.turns);
        if (command.message != null) messages.add(command.message!);
      }
    }
    if (j['completion'] != null) {
      final c = _object(j['completion']);
      _envelope(c);
      _decimal(c['stateVersion']);
      final turn = ConversationTurn.fromJson(c['turn']),
          message = ConversationMessage.fromJson(c['message']);
      for (final k in [
        'completionRequestId',
        'sourceKey',
        'inferenceRunId',
        'assistantMessageId',
      ]) {
        _string(c[k]);
      }
      _bool(c['replayed']);
      _enum(_object(c['outcome'])['status'], {
        'COMPLETED',
        'FAILED',
        'INTERRUPTED',
      });
      if (c['sessionId'] == j['sessionId'] &&
          c['stateVersion'] == j['stateVersion'] &&
          turn.inferenceRunId == c['inferenceRunId'] &&
          turn.assistantMessageId == message.id &&
          message.id == c['assistantMessageId'] &&
          message.turnId == turn.turnId &&
          message.role == 'ASSISTANT') {
        turns.add(turn);
        messages.add(message);
      }
    }
    return ConversationChangedEvent._(
      j,
      List.unmodifiable(messages),
      List.unmodifiable(turns),
      status,
      List.unmodifiable(tasks),
    );
  }
}

final class ConversationRecoveryRequired {
  ConversationRecoveryRequired._(this.sessionId, this.reason);
  final String sessionId, reason;
  factory ConversationRecoveryRequired.fromJson(Object? value) {
    final j = _object(value);
    _envelope(j);
    final boundary = _object(j['safeBoundary']);
    if (j['@type'] != 'agent_conversation_recovery_required' ||
        j['action'] != 'RESNAPSHOT' ||
        j['preserveOutbox'] != true ||
        boundary['kind'] != 'SNAPSHOT') {
      throw const FormatException('Invalid recovery requirement');
    }
    _string(boundary['endpoint']);
    return ConversationRecoveryRequired._(
      j['sessionId'] as String,
      _enum(j['reason'], {
        'CURSOR_INVALID',
        'CURSOR_UNAVAILABLE',
        'EPOCH_MISMATCH',
      }),
    );
  }
}

final class ConversationCoreError {
  ConversationCoreError._(this.code, this.metadata);
  final String code;
  final Map<String, dynamic> metadata;
  String get sessionId => metadata['sessionId'] as String;
  static ConversationCoreError? tryParse(Object? value) {
    try {
      final j = _object(value), m = _object(j['metadata']);
      final code = _string(j['code']);
      switch (code) {
        case 'AGENT_CONVERSATION_PROTOCOL_MISMATCH':
          ConversationDiscoveryMetadata.fromJson(m);
        case 'CONVERSATION_VERSION_CONFLICT':
          _envelope(m);
          _decimal(m['expectedStateVersion']);
          _decimal(m['stateVersion']);
        case 'TURN_NOT_QUEUED':
          _envelope(m);
          _decimal(m['stateVersion']);
          ConversationTurn.fromJson(m['turn']);
        case 'AGENT_SESSION_QUEUE_CAPACITY_EXCEEDED':
          _envelope(m);
          _count(m['queueCapacity']);
          _count(m['pendingTurnCount']);
          if (m['retryable'] != true) return null;
        default:
          return null;
      }
      return ConversationCoreError._(code, m);
    } on Object {
      return null;
    }
  }
}

sealed class ConversationWireFrame {
  const ConversationWireFrame();
}

final class ConversationChangedFrame extends ConversationWireFrame {
  const ConversationChangedFrame(this.value);
  final ConversationChangedEvent value;
}

final class ConversationRecoveryFrame extends ConversationWireFrame {
  const ConversationRecoveryFrame(this.value);
  final ConversationRecoveryRequired value;
}

final class ConversationErrorFrame extends ConversationWireFrame {
  const ConversationErrorFrame(this.value);
  final ConversationCoreError value;
}

final class ConversationOtherFrame extends ConversationWireFrame {
  const ConversationOtherFrame();
}

final class ConversationMalformedFrame extends ConversationWireFrame {
  const ConversationMalformedFrame();
}

/// Total stream parser: malformed data requests recovery instead of throwing
/// through a subscription callback.
ConversationWireFrame parseConversationWireFrame(String event, Object? value) {
  try {
    if (event == 'conversation.changed') {
      return ConversationChangedFrame(ConversationChangedEvent.fromJson(value));
    }
    if (event == 'conversation.recovery_required') {
      return ConversationRecoveryFrame(
        ConversationRecoveryRequired.fromJson(value),
      );
    }
    if (event == 'error') {
      final error = ConversationCoreError.tryParse(value);
      if (error != null) return ConversationErrorFrame(error);
    }
    return const ConversationOtherFrame();
  } on Object {
    return const ConversationMalformedFrame();
  }
}
