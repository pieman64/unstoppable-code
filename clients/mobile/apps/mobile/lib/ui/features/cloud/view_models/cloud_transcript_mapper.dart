/// Core protocol-v1 transcript projection. No network or Remote Control state.
library;

import 'dart:convert';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import 'package:mobile/ui/core/chat/view_models/watcher_message_presentation.dart';

/// Cloud-only identity and accounting metadata alongside the shared row shape.
final class CloudTranscriptMessage extends ChatMessage {
  const CloudTranscriptMessage({
    required super.messageId,
    required super.chatId,
    required super.role,
    required super.status,
    required super.text,
    super.parts,
    super.occurredAt,
    super.attachments,
    super.delivery,
    super.deliveryNote,
    super.watcherFired,
    this.sourceKey,
    this.clientRequestId,
    this.model,
    this.usage,
    this.cost = const CloudCoreCost(kind: CloudCoreCostKind.pending),
    this.errorCode,
    this.errorMessage,
  });
  final String? sourceKey;
  final String? clientRequestId;
  final Map<String, dynamic>? model;
  final Map<String, dynamic>? usage;
  final CloudCoreCost cost;
  final String? errorCode;
  final String? errorMessage;
}

/// Stateful fold scoped to one chat. `apply` emits replacement snapshots keyed
/// only by messageId. `hydrate` replaces the transcript atomically; it never
/// matches a live cloud: row against a canonical Core row by text/sourceKey.
class CloudTranscriptMapper {
  CloudTranscriptMapper({required this.chatId, DateTime Function()? now})
    : _now = now ?? DateTime.now;
  final String chatId;
  final DateTime Function() _now;
  final _rows = <String, CloudTranscriptMessage>{};
  final _seenArtifacts = <(String, int)>{};
  final _seenNotices = <String>{};
  final _settledSources = <String>{};
  final _dismissedQuestions = <String>{};
  _Turn? _active;
  _Turn? _failedTurn;
  _Turn? _lastSettled;
  CloudWireError? _error;
  int _turn = 0;
  int _notice = 0;
  String? _streamingStatus;
  String? _terminalDisposition;

  List<CloudTranscriptMessage> get messages => List.unmodifiable(_rows.values);
  bool get turnInProgress => _active != null;
  String? get streamingStatus => _streamingStatus;

  /// Accepted/stale for the most recent apply call, null for non-finish frames.
  String? get terminalDisposition => _terminalDisposition;

  List<AskUserQuestionState> get pendingQuestions {
    final pending = <String, AskUserQuestionState>{};
    for (final row in _rows.values) {
      if (row.role == ChatRole.user) pending.clear();
      for (final part in row.parts) {
        final id = part.toolUseId;
        if (id == null || id.isEmpty) continue;
        if (part.kind == 'tool_result' || part.data?['result'] != null) {
          pending.remove(id);
        } else if (part.toolFamily == 'ask-user' &&
            !_dismissedQuestions.contains(id)) {
          final questions = _questions(part.toolInput);
          if (questions.isNotEmpty) {
            pending[id] = AskUserQuestionState(
              requestId: id,
              toolUseId: id,
              questions: questions,
            );
          }
        }
      }
    }
    return List.unmodifiable(pending.values);
  }

  /// Called when a later user turn/structured answer supersedes these requests.
  /// Does not put raw answers (including secrets) into transcript state.
  void clearPendingQuestions() =>
      _dismissedQuestions.addAll(pendingQuestions.map((q) => q.requestId));

  _Turn _newTurn(String? source, {bool synthesizedBeforeStart = false}) {
    _turn++;
    return _Turn(
      sourceKey: source,
      idPrefix: 'cloud:$chatId:${source ?? 'assistant'}:$_turn',
      at: _now(),
      synthesizedBeforeStart: synthesizedBeforeStart,
    );
  }

  List<CloudTranscriptMessage> _publish(_Turn turn) {
    final result = <CloudTranscriptMessage>[];
    for (final (index, step) in turn.steps.indexed) {
      final last = index == turn.steps.length - 1;
      final status = last ? turn.status : ChatMessageStatus.complete;
      final reasoning = index == 0 ? turn.reasoning : '';
      final model = last ? turn.model : null;
      final usage = last ? turn.usage : null;
      final cost = last
          ? turn.cost
          : const CloudCoreCost(kind: CloudCoreCostKind.pending);
      final text = step.text.isEmpty && status == ChatMessageStatus.failed
          ? turn.error?.message ?? ''
          : step.text;
      final previous = _rows['${turn.idPrefix}:$index'];
      // A delta changes only its current step. Preserve earlier row identity
      // so a long tool-heavy turn does not rebuild every part on each token.
      if (previous != null &&
          previous.text == text &&
          previous.status == status &&
          previous.sourceKey == turn.sourceKey &&
          identical(previous.model, model) &&
          identical(previous.usage, usage) &&
          identical(previous.cost, cost) &&
          previous.errorCode == turn.error?.code &&
          previous.errorMessage == turn.error?.message &&
          identical(step.publishedParts, step.parts) &&
          step.publishedReasoning == reasoning) {
        continue;
      }
      final row = CloudTranscriptMessage(
        messageId: '${turn.idPrefix}:$index',
        chatId: chatId,
        sourceKey: turn.sourceKey,
        role: ChatRole.assistant,
        status: status,
        text: text,
        parts: List.unmodifiable([
          if (index == 0 && turn.reasoning.isNotEmpty)
            ChatPart(kind: 'thinking', data: {'text': turn.reasoning}),
          ...step.parts,
        ]),
        occurredAt: turn.at,
        attachments: index == 0 ? turn.attachments : const [],
        // Accounting belongs to the terminal row, never every sub-message.
        model: model,
        usage: usage,
        cost: cost,
        errorCode: turn.error?.code,
        errorMessage: turn.error?.message,
      );
      _rows[row.messageId] = row;
      step.publishedParts = step.parts;
      step.publishedReasoning = reasoning;
      result.add(row);
    }
    return List.unmodifiable(result);
  }

  List<CloudTranscriptMessage> apply(CloudWireFrame frame, {String? eventId}) {
    _terminalDisposition = null;
    if (frame is CloudWireIgnored) return const [];
    if (frame is CloudHarnessWarning || frame is CloudHarnessEvent) {
      return _harness(frame, eventId);
    }
    if (frame is CloudWireError) {
      if (_active == null && _failedTurn != null) {
        _failedTurn!.error = frame;
        return _publish(_failedTurn!);
      }
      _error = frame;
      return const [];
    }
    if (frame is CloudWireUnparseable) {
      final turn = _active;
      if (turn == null) return const [];
      turn.status = ChatMessageStatus.failed;
      _settle(turn);
      return _publish(turn);
    }
    if (frame is CloudArtifactCreated) {
      final turn = _active;
      if (turn == null ||
          !_seenArtifacts.add((
            frame.artifact.toolCallId,
            frame.artifact.artifactIndex,
          ))) {
        return const [];
      }
      turn.steps.last.parts = [
        ...turn.steps.last.parts,
        _artifactPart(frame.artifact),
      ];
      return _publish(turn);
    }
    if (frame is CloudMessageStart && !frame.isAssistant) return const [];
    final source = frame.sourceKey;
    if (source != null && _settledSources.contains(source)) {
      if (frame is CloudMessageFinish) _terminalDisposition = 'stale';
      return const [];
    }
    if (frame is CloudMessageStart) {
      if (eventId != null &&
          ((_active != null &&
                  _active!.sourceKey == source &&
                  _active!.eventIds.contains(eventId)) ||
              (_active == null &&
                  _lastSettled?.eventIds.contains(eventId) == true))) {
        return const [];
      }
      final active = _active;
      final adoptedSource =
          active != null &&
          active.sourceKey == null &&
          source != null &&
          active.synthesizedBeforeStart;
      if (active != null &&
          ((source != null && active.sourceKey == source) || adoptedSource)) {
        _active!.sourceKey ??= source;
        _active!.synthesizedBeforeStart = false;
        if (eventId != null) _active!.eventIds.add(eventId);
        return adoptedSource ? _publish(_active!) : const [];
      }
      // A new start seals any incomplete prior turn rather than leaving a
      // permanent streaming row behind it.
      final previous = _active;
      final sealed = <CloudTranscriptMessage>[];
      if (previous != null) {
        previous.status = ChatMessageStatus.complete;
        _settle(previous);
        sealed.addAll(_publish(previous));
      }
      _active = _newTurn(source);
      if (eventId != null) _active!.eventIds.add(eventId);
      _error = null;
      _failedTurn = null;
      return [...sealed, ..._publish(_active!)];
    }
    if (_active?.sourceKey != null &&
        source != null &&
        _active!.sourceKey != source) {
      if (frame is CloudMessageFinish) _terminalDisposition = 'stale';
      return const [];
    }
    if (frame is CloudMessageDelta && frame.text.isEmpty ||
        frame is CloudMessageReasoning && frame.text.isEmpty) {
      return const [];
    }
    // A reconnect can redeliver the tail after finish, without a source key.
    // Keep the last turn's identities until a new start establishes a new
    // scope. Never collapse equal payload text: distinct deltas can be equal.
    if (_active == null && _lastSettled != null) {
      if (eventId != null && _lastSettled!.eventIds.contains(eventId)) {
        return const [];
      }
      if (frame is CloudToolFrame &&
          frame.activity.toolCallId != null &&
          _lastSettled!.steps.any(
            (s) => s.parts.any((p) => p.toolUseId == frame.activity.toolCallId),
          )) {
        return const [];
      }
    }
    final turn = _active ??= _newTurn(source, synthesizedBeforeStart: true);
    turn.sourceKey ??= source;
    if (eventId != null && !turn.eventIds.add(eventId)) return const [];
    switch (frame) {
      case CloudMessageDelta():
        _streamingStatus = null;
        turn.addText(frame.text);
      case CloudMessageReasoning():
        turn.reasoning += frame.text;
      case CloudToolFrame():
        if (!turn.addTool(frame.activity)) return const [];
      case CloudMessageFinish():
        final cancelled =
            frame.finishReason == 'interrupted' ||
            frame.finishReason == 'cancelled';
        if (frame.finalText != null &&
            (!cancelled || turn.steps.last.text.isEmpty)) {
          turn.finishText(frame.finalText!);
        }
        if (frame.reasoningText != null &&
            (!cancelled || turn.reasoning.isEmpty)) {
          turn.reasoning = frame.reasoningText!;
        }
        turn.model = frame.model;
        turn.usage = frame.usage;
        turn.cost = frame.cost;
        turn.error = _error;
        turn.status = cancelled
            ? ChatMessageStatus.cancelled
            : frame.finishReason == 'error' || _error != null
            ? ChatMessageStatus.failed
            : ChatMessageStatus.complete;
        _terminalDisposition = 'accepted';
        _settle(turn);
      default:
        return const [];
    }
    return _publish(turn);
  }

  void _settle(_Turn turn) {
    _lastSettled = turn;
    if (turn.sourceKey != null) _settledSources.add(turn.sourceKey!);
    _active = null;
    _error = null;
    _streamingStatus = null;
    _failedTurn = turn.status == ChatMessageStatus.failed ? turn : null;
  }

  List<CloudTranscriptMessage> _harness(
    CloudWireFrame frame,
    String? eventId, {
    DateTime? occurredAt,
  }) {
    if (frame is CloudHarnessEvent && frame.kind == 'status') {
      _streamingStatus = frame.status;
      return const [];
    }
    final kind = frame is CloudHarnessWarning
        ? 'harness-warning'
        : 'compaction';
    if (eventId != null && !_seenNotices.add('$kind:$eventId')) return const [];
    final prefix = chatId.startsWith('cloud:') ? chatId : 'cloud:$chatId';
    final id = '$prefix:$kind:${eventId ?? 'live-${++_notice}'}';
    final at = occurredAt ?? _now();
    final row = CloudTranscriptMessage(
      messageId: id,
      chatId: chatId,
      role: ChatRole.system,
      status: ChatMessageStatus.complete,
      occurredAt: at,
      text: frame is CloudHarnessWarning ? _warningText(frame) : '',
      parts: frame is CloudHarnessEvent
          ? [
              ChatPart(
                kind: 'compaction',
                data: {
                  'occurredAt': at.millisecondsSinceEpoch,
                  'trigger': ?frame.trigger,
                  'summary': ?frame.summary,
                  'tokensBefore': ?frame.tokensBefore,
                  'tokensAfter': ?frame.tokensAfter,
                },
              ),
            ]
          : const [],
    );
    _rows[id] = row;
    return [row];
  }

  /// Reloads from authoritative Core rows. Ordered content blocks use the same
  /// turn/fold operations as live frames. Older rows only record flattened text:
  /// their permanent fallback is tools followed by text. Cross-kind artifact
  /// timing is not persisted; reload attaches artifacts to the final step.
  List<CloudTranscriptMessage> hydrate(
    CloudChatBootstrap bootstrap, {
    bool preserveSequenceOrder = false,
  }) {
    _rows.clear();
    _seenArtifacts.clear();
    _seenNotices.clear();
    _settledSources.clear();
    _dismissedQuestions.clear();
    _active = null;
    _failedTurn = null;
    _lastSettled = null;
    _error = null;
    _streamingStatus = null;
    _terminalDisposition = null;
    final grouped = _groupActivity(bootstrap);
    for (final message in bootstrap.messages) {
      if (message.taskId != null) continue;
      final at = DateTime.fromMillisecondsSinceEpoch(message.createdAtMs);
      if (message.role != 'ASSISTANT') {
        final user = message.role == 'USER';
        // A fired watcher posts its instruction block into the user turn;
        // show only its notice under the watcher title.
        final watcher = user ? watcherMessagePresentation(message.text) : null;
        _rows[message.id] = CloudTranscriptMessage(
          messageId: message.id,
          chatId: chatId,
          role: user ? ChatRole.user : ChatRole.system,
          status: ChatMessageStatus.complete,
          text: watcher?.text ?? message.text,
          watcherFired: watcher?.watcherFired,
          occurredAt: at,
          attachments: ChatMessageAttachment.listFromJson(message.attachments),
          clientRequestId: message.clientRequestId,
          cost: message.cost,
        );
        continue;
      }
      final cost =
          message.cost.kind == CloudCoreCostKind.unknown &&
              message.cost.raw == null
          ? const CloudCoreCost(kind: CloudCoreCostKind.pending)
          : message.cost;
      final turn = _Turn(
        sourceKey: message.sourceKey,
        idPrefix: message.id,
        at: at,
      );
      final activity =
          grouped[message.sourceKey] ?? const <CloudChatToolActivity>[];
      final referenced = <String>{};
      for (final block in message.contentBlocks) {
        switch (block['type']) {
          case 'text':
            if (block['text'] is String) turn.addText(block['text'] as String);
          case 'reasoning':
            if (block['text'] is String) {
              turn.reasoning += block['text'] as String;
            }
          case 'tool_call':
            final id = block['toolCallId'];
            if (id is! String || !referenced.add(id)) continue;
            final matches = activity.where((a) => a.toolCallId == id).toList();
            for (final entry in matches) {
              turn.addTool(entry);
            }
            if (!matches.any((a) => a.kind == CloudToolActivityKind.call)) {
              turn.addTool(
                CloudChatToolActivity(
                  kind: CloudToolActivityKind.call,
                  rawKind: 'call',
                  raw: const {},
                  toolCallId: id,
                  toolName: block['toolName'] is String
                      ? block['toolName'] as String
                      : 'tool',
                  input: '',
                ),
              );
            }
        }
      }
      for (final entry in activity) {
        if (!referenced.contains(entry.toolCallId)) turn.addTool(entry);
      }
      if (message.contentBlocks.isEmpty) turn.addText(message.text);
      if (turn.reasoning.isEmpty) turn.reasoning = message.reasoningText ?? '';
      for (final artifact in message.artifacts) {
        if (_seenArtifacts.add((artifact.toolCallId, artifact.artifactIndex))) {
          turn.steps.last.parts.add(_artifactPart(artifact));
        }
      }
      turn.attachments = ChatMessageAttachment.listFromJson(
        message.attachments,
      );
      turn.model = message.model;
      turn.usage = message.usage;
      turn.cost = cost;
      turn.status = ChatMessageStatus.complete;
      // A single durable row without ordered blocks keeps its canonical id.
      final projected = _publish(turn);
      if (message.contentBlocks.isEmpty && turn.steps.length == 1) {
        final row = projected.single;
        _rows.remove(row.messageId);
        _rows[message.id] = CloudTranscriptMessage(
          messageId: message.id,
          chatId: chatId,
          role: row.role,
          status: row.status,
          text: row.text,
          parts: row.parts,
          occurredAt: row.occurredAt,
          sourceKey: message.sourceKey,
          model: message.model,
          usage: message.usage,
          cost: cost,
          attachments: ChatMessageAttachment.listFromJson(message.attachments),
        );
      }
      if (message.sourceKey != null &&
          message.sourceKey != bootstrap.activeTurnId) {
        _settledSources.add(message.sourceKey!);
      }
    }
    final lastTime = _rows.values.fold<int>(0, (latest, row) {
      final time = row.occurredAt?.millisecondsSinceEpoch ?? 0;
      return time > latest ? time : latest;
    });
    final notices = [
      ...bootstrap.harnessWarnings.map((w) => ('harness.warning', w)),
      ...bootstrap.compactions.map(
        (c) => ('harness.event', {...c, 'kind': 'compaction'}),
      ),
    ];
    var fallbackTime = notices.fold<int>(lastTime, (latest, notice) {
      final timestamp = notice.$2['occurredAtMs'];
      if (timestamp is! num || !timestamp.isFinite) return latest;
      final time = timestamp.toInt();
      return time > latest ? time : latest;
    });
    for (final (event, raw) in notices) {
      final frame = parseCloudWireFrame(event, raw);
      if (frame is! CloudHarnessWarning && frame is! CloudHarnessEvent) {
        continue;
      }
      final timestamp = raw['occurredAtMs'];
      final time = timestamp is num && timestamp.isFinite
          ? timestamp.toInt()
          : ++fallbackTime;
      _harness(
        frame,
        raw['eventId'] is String ? raw['eventId'] as String : null,
        occurredAt: DateTime.fromMillisecondsSinceEpoch(time),
      );
    }
    // V2 rows arrive in canonical sequence order. V1 can carry sequence values
    // too, but its durable notices still need chronological insertion.
    final ordered = _rows.values.indexed.toList();
    if (!preserveSequenceOrder) {
      ordered.sort((a, b) {
        final order = a.$2.occurredAt!.compareTo(b.$2.occurredAt!);
        return order == 0 ? a.$1.compareTo(b.$1) : order;
      });
    }
    _rows
      ..clear()
      ..addEntries(
        ordered.map((entry) => MapEntry(entry.$2.messageId, entry.$2)),
      );
    return messages;
  }
}

class _Step {
  String text = '';
  List<ChatPart> parts = [];
  List<ChatPart>? publishedParts;
  String? publishedReasoning;
  bool get hasTools =>
      parts.any((p) => p.kind == 'tool_use' || p.kind == 'tool_result');
}

class _Turn {
  _Turn({
    required this.sourceKey,
    required this.idPrefix,
    required this.at,
    this.synthesizedBeforeStart = false,
  });
  String? sourceKey;
  final String idPrefix;
  final DateTime at;
  bool synthesizedBeforeStart;
  final steps = [_Step()];
  final eventIds = <String>{};
  String reasoning = '';
  ChatMessageStatus status = ChatMessageStatus.streaming;
  Map<String, dynamic>? model;
  Map<String, dynamic>? usage;
  CloudCoreCost cost = const CloudCoreCost(kind: CloudCoreCostKind.pending);
  CloudWireError? error;
  List<ChatMessageAttachment> attachments = const [];

  void addText(String text) {
    if (text.isEmpty) return;
    if (steps.last.hasTools) steps.add(_Step());
    steps.last.text += text;
  }

  bool addTool(CloudChatToolActivity activity) {
    if (activity.kind == CloudToolActivityKind.unknown) return false;
    final id = activity.toolCallId;
    _Step? owner;
    if (id != null) {
      for (final step in steps) {
        if (step.parts.any(
          (p) =>
              p.toolUseId == id &&
              (p.kind == 'tool_use' || p.kind == 'tool_result'),
        )) {
          owner = step;
          break;
        }
      }
    }
    if (owner == null) {
      if (steps.last.text.isNotEmpty) steps.add(_Step());
      owner = steps.last;
    }
    final folded = foldCloudToolActivity(owner.parts, activity);
    if (folded == null) return false;
    owner.parts = folded;
    return true;
  }

  void finishText(String finalText) {
    final prior = steps
        .take(steps.length - (steps.last.hasTools ? 0 : 1))
        .map((s) => s.text)
        .where((t) => t.isNotEmpty)
        .toList();
    var tail = finalText;
    if (prior.isNotEmpty) {
      final separated = prior.join('\n\n');
      final compact = prior.join();
      if (finalText == separated || finalText == compact) {
        tail = '';
      } else if (finalText.startsWith('$separated\n\n')) {
        tail = finalText.substring(separated.length + 2);
      } else if (finalText.startsWith(compact)) {
        tail = finalText.substring(compact.length);
      }
    }
    if (steps.last.hasTools) {
      if (tail.isEmpty) return;
      steps.add(_Step());
    }
    steps.last.text = tail;
  }
}

/// Shared live/reload tool fold. Null means a replay changed nothing.
/// Id-less tools are never correlated; the caller handles their SSE identity.
List<ChatPart>? foldCloudToolActivity(
  List<ChatPart> parts,
  CloudChatToolActivity activity,
) {
  final id = activity.toolCallId;
  final callIndex = id == null
      ? -1
      : parts.indexWhere((p) => p.kind == 'tool_use' && p.toolUseId == id);
  final orphanIndex = id == null
      ? -1
      : parts.indexWhere((p) => p.kind == 'tool_result' && p.toolUseId == id);
  final next = [...parts];
  if (activity.kind == CloudToolActivityKind.call) {
    if (callIndex >= 0) return null;
    final result = orphanIndex >= 0 ? next.removeAt(orphanIndex).data : null;
    next.add(
      ChatPart(
        kind: 'tool_use',
        toolFamily: _toolFamily(activity.toolName ?? 'tool'),
        data: {
          'toolUseId': ?id,
          'toolName': activity.toolName ?? 'tool',
          'input': activity.input ?? '',
          'result': ?result,
        },
      ),
    );
  } else if (activity.kind == CloudToolActivityKind.result) {
    final data = <String, dynamic>{
      'toolUseId': ?id,
      'output': activity.output ?? '',
      'isError': activity.isError == true,
    };
    if (callIndex >= 0) {
      final call = parts[callIndex];
      final old = call.data?['result'];
      if (old is Map &&
          old['output'] == data['output'] &&
          old['isError'] == data['isError']) {
        return null;
      }
      next[callIndex] = ChatPart(
        kind: call.kind,
        toolFamily: call.toolFamily,
        data: {...?call.data, 'result': data},
      );
    } else {
      if (orphanIndex >= 0) return null;
      next.add(ChatPart(kind: 'tool_result', data: data));
    }
  } else {
    return null;
  }
  return next;
}

Map<String, List<CloudChatToolActivity>> _groupActivity(
  CloudChatBootstrap bootstrap,
) {
  final keys = <String, String?>{};
  void record(String? id, String? source) {
    if (id == null || source == null) return;
    if (!keys.containsKey(id)) {
      keys[id] = source;
    } else if (keys[id] != source) {
      keys[id] = null;
    }
  }

  for (final message in bootstrap.messages) {
    if (message.role != 'ASSISTANT' || message.taskId != null) continue;
    for (final block in message.contentBlocks) {
      if (block['type'] == 'tool_call' && block['toolCallId'] is String) {
        record(block['toolCallId'] as String, message.sourceKey);
      }
    }
  }
  final rootActivity = bootstrap.toolActivity.where((a) => a.taskId == null);
  for (final a in rootActivity) {
    record(a.toolCallId, a.sourceKey);
  }
  final grouped = <String, List<CloudChatToolActivity>>{};
  for (final a in rootActivity) {
    final source = a.sourceKey ?? keys[a.toolCallId];
    if (source != null) (grouped[source] ??= []).add(a);
  }
  return grouped;
}

ChatPart _artifactPart(CloudCoreArtifact artifact) {
  final header = artifact.label == artifact.fileName
      ? artifact.label
      : '${artifact.label} (${artifact.fileName})';
  final content = artifact.fileContent;
  return ChatPart(
    kind: 'attachment',
    data: {
      'text': content == null || content.isEmpty
          ? header
          : '$header\n\n$content',
      'label': artifact.label,
      'deliverable': ?_deliverable(artifact),
      'artifact': {
        'id': ?artifact.id,
        'toolCallId': artifact.toolCallId,
        'artifactIndex': artifact.artifactIndex,
        'kind': artifact.kind,
        'label': artifact.label,
        'storageKind': artifact.storageKind,
        'sizeBytes': ?artifact.sizeBytes,
        'file': {'name': artifact.fileName, 'content': ?artifact.fileContent},
        'metadata': ?artifact.metadata,
      },
    },
  );
}

String _toolFamily(String name) {
  final mcpSegments = name.split('__');
  if (mcpSegments.length == 3 &&
      mcpSegments.first == 'mcp' &&
      mcpSegments.last == 'AskUserQuestion') {
    return 'ask-user';
  }
  if (name.startsWith('mcp__')) return 'unknown';
  final normalized = name
      .split('__')
      .last
      .replaceAll(RegExp('[^a-zA-Z0-9]'), '')
      .toLowerCase();
  if (name.endsWith('_ask_user_question')) return 'ask-user';
  if ([
    'askuserquestion',
    'requestuserinput',
    'requestuserinputasync',
    'askuser',
    'canopyaskuserquestion',
  ].contains(normalized)) {
    return 'ask-user';
  }
  return switch (normalized) {
    'read' || 'readfile' || 'readlines' || 'readmanyfiles' => 'read',
    'write' || 'writefile' || 'writeartifact' => 'write',
    'edit' ||
    'editfile' ||
    'applypatch' ||
    'multiedit' ||
    'replace' ||
    'filechange' => 'edit',
    'bash' ||
    'shell' ||
    'execcommand' ||
    'powershell' ||
    'runcommand' ||
    'runshellcommand' ||
    'command' => 'bash',
    'glob' || 'listfiles' || 'listdirectory' || 'toolsearch' => 'glob',
    'grep' || 'searchfiles' || 'grepsearch' => 'grep',
    'websearch' || 'webfetch' || 'googlewebsearch' => 'web',
    'task' ||
    'spawnagent' ||
    'sendmessage' ||
    'agent' ||
    'taskoutput' ||
    'workflow' => 'agent',
    'todowrite' ||
    'todoread' ||
    'updateplan' ||
    'writetodos' ||
    'taskcreate' ||
    'taskupdate' ||
    'tasklist' ||
    'taskget' ||
    'taskstop' => 'todo',
    'skill' => 'skill',
    'claudemodelchange' => 'claude',
    'schedulewakeup' || 'monitor' => 'monitor',
    'enterplanmode' || 'exitplanmode' => 'plan',
    _ => 'unknown',
  };
}

List<AskUserQuestion> _questions(String? input) {
  if (input == null) return const [];
  try {
    final decoded = jsonDecode(input);
    if (decoded is! Map || decoded['questions'] is! List) return const [];
    final result = <AskUserQuestion>[];
    for (final q in decoded['questions'] as List) {
      if (q is! Map<String, dynamic>) continue;
      final text = q['question'] ?? q['title'];
      if (text is! String || text.trim().isEmpty) continue;
      final options = <String>[];
      final descriptions = <String>[];
      for (final option
          in q['options'] is List ? q['options'] as List : const []) {
        final label = option is String
            ? option
            : option is Map
            ? option['label']
            : null;
        if (label is! String) continue;
        options.add(label);
        descriptions.add(
          option is Map && option['description'] is String
              ? option['description'] as String
              : '',
        );
      }
      result.add(
        AskUserQuestion.fromJson({
          ...q,
          'question': text,
          'options': options,
          'optionDescriptions': descriptions,
        }),
      );
    }
    return result;
  } on Object {
    return const [];
  }
}

String _warningText(CloudHarnessWarning warning) {
  final headline =
      warning.message ??
      'The agent reported a warning (${warning.code.replaceAll('_', ' ').trim()}).';
  final details = {...warning.warnings, ...warning.filenames}
      .map((s) => s.replaceAll(RegExp(r'[\r\n]+'), ' ').trim())
      .where((s) => s.isNotEmpty)
      .toSet();
  if (details.isEmpty) return headline;
  return '$headline\n\n${details.map((s) => '- $s').join('\n')}';
}

Map<String, dynamic>? _deliverable(CloudCoreArtifact artifact) {
  final m = artifact.metadata;
  if (artifact.kind != 'deliverable' || m == null) return null;
  final id = m['deliverableId'];
  final size = m['sizeBytes'];
  final hash = m['contentSha256'];
  if (id is! String ||
      !RegExp(
        r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
      ).hasMatch(id) ||
      size is! num ||
      !size.isFinite ||
      size < 0 ||
      size > 9007199254740991 ||
      size != size.truncateToDouble() ||
      hash is! String ||
      !RegExp(r'^[a-f0-9]{64}$').hasMatch(hash) ||
      m['filename'] is! String ||
      (m['filename'] as String).isEmpty ||
      m['mediaType'] is! String ||
      (m['mediaType'] as String).isEmpty) {
    return null;
  }
  return {
    for (final key in [
      'deliverableId',
      'filename',
      'sizeBytes',
      'mediaType',
      'contentSha256',
    ])
      key: m[key],
  };
}
