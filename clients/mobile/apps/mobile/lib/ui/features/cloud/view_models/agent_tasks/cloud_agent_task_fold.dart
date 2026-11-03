/// Agent task fold: task rows plus each task's own activity (text, reasoning,
/// tools), from live frames and durable rows. A port of the web fold in
/// `apps/web/src/lib/cloud/agent-task-fold.ts`, without Codex collaboration
/// evidence. No widgets, network, or clocks.
library;

import 'dart:convert';

import 'package:mobile/data/models/cloud_agent_task.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';

/// Per-task bounds, matching the web fold.
const agentTaskEntryLimit = 200;
const agentTaskTextMaxChars = 16000;
const _maxTasks = 256;
const _eventIdMemory = 256;
const _evictedKeyMemory = 4096;

enum AgentTaskEntryKind { text, reasoning, tool }

/// One step of a task's activity.
final class AgentTaskEntry {
  AgentTaskEntry.text(
    this.kind,
    String text, {
    bool truncated = false,
    this.sourceKey,
    this.messageId,
    this.blockKey,
    this.reconciled = false,
  }) : text = text.length > agentTaskTextMaxChars
           ? text.substring(0, agentTaskTextMaxChars)
           : text,
       truncated = truncated || text.length > agentTaskTextMaxChars,
       toolCallId = null;
  AgentTaskEntry.tool({
    this.toolCallId,
    this.sourceKey,
    this.call,
    this.result,
    this.messageId,
    this.turnId,
  }) : kind = AgentTaskEntryKind.tool,
       text = '',
       truncated = false,
       reconciled = false,
       blockKey = null;

  final AgentTaskEntryKind kind;
  final String text;
  final bool truncated;

  /// Live text a task `message.finish` set to its final text. A durable row
  /// from the same source replaces it outright.
  final bool reconciled;
  final String? blockKey;
  final String? toolCallId;
  String? sourceKey, messageId, turnId;
  CloudChatToolActivity? call, result;

  AgentTaskEntry withText(String text, {bool? reconciled}) =>
      AgentTaskEntry.text(
        kind,
        text,
        truncated: truncated,
        sourceKey: sourceKey,
        messageId: messageId,
        blockKey: blockKey,
        reconciled: reconciled ?? this.reconciled,
      );

  /// Keys that identify the entry across replays; live text has none.
  List<String> get evictionKeys => switch (kind) {
    AgentTaskEntryKind.tool =>
      toolCallId == null ? const [] : _toolKeys(sourceKey, toolCallId!),
    _ =>
      messageId != null && blockKey != null
          ? [_durableTextKey(messageId!, blockKey!)]
          : const [],
  };
}

List<String> _toolKeys(String? sourceKey, String toolCallId) => [
  'tool\u0000${sourceKey ?? ''}\u0000$toolCallId',
  'tool-id\u0000$toolCallId',
];
String _durableTextKey(String messageId, String blockKey) =>
    'text\u0000$messageId\u0000$blockKey';

final class AgentTaskActivity {
  List<AgentTaskEntry> entries = [];

  /// Distinct entries dropped past [agentTaskEntryLimit].
  int omitted = 0;
  final evictedKeys = <String>{};
  final appliedEventIds = <String>{};
  final appliedMessageIds = <String>{};
}

void _remember(Set<String> keys, Iterable<String> added, int cap) {
  keys.addAll(added);
  while (keys.length > cap) {
    keys.remove(keys.first);
  }
}

/// A durable task message row (`source: 'agent_task'`).
final class AgentTaskMessage {
  const AgentTaskMessage({
    required this.id,
    required this.taskId,
    this.sourceKey,
    this.turnId,
    this.text = '',
    this.reasoningText,
    this.contentBlocks = const [],
    this.sequence = 0,
    this.createdAtMs = 0,
  });
  final String id, taskId, text;
  final String? sourceKey, turnId, reasoningText;
  final List<Map<String, dynamic>> contentBlocks;
  final int sequence, createdAtMs;
}

/// Mutable fold owned by one chat. [revision] grows with every change, so a
/// projection can be cached against it.
final class CloudAgentTaskFold {
  final _tasks = <String, CloudAgentTask>{};
  final _activity = <String, AgentTaskActivity>{};
  final _taskSourceKeys = <String, String>{};
  final _sourceKeysByTurnId = <String, String>{};
  int _revision = 0;

  int get revision => _revision;
  bool get isEmpty => _tasks.isEmpty;

  /// Tasks, most recently upserted last.
  Iterable<CloudAgentTask> get tasks => _tasks.values;
  CloudAgentTask? task(String taskId) => _tasks[taskId];
  AgentTaskActivity? activity(String taskId) => _activity[taskId];
  String? taskSourceKey(String taskId) => _taskSourceKeys[taskId];
  String? turnSourceKey(String turnId) => _sourceKeysByTurnId[turnId];

  void _changed() => _revision++;

  void clear() {
    _tasks.clear();
    _activity.clear();
    _taskSourceKeys.clear();
    _sourceKeysByTurnId.clear();
    _changed();
  }

  /// Records that [turnId] streams under [sourceKey].
  void turnIdentity(String? turnId, String? sourceKey) {
    if (turnId == null || sourceKey == null) return;
    if (_sourceKeysByTurnId[turnId] == sourceKey) return;
    _sourceKeysByTurnId[turnId] = sourceKey;
    _changed();
  }

  /// Newest `stateVersion` wins; an older row can still supply a missing
  /// spawn source key.
  void upsert(CloudAgentTask task, {String? sourceKey}) {
    if (task.parentTaskId == null) turnIdentity(task.spawnTurnId, sourceKey);
    final previous = _tasks[task.taskId];
    if (previous != null && previous.stateVersion >= task.stateVersion) {
      if (sourceKey != null && !_taskSourceKeys.containsKey(task.taskId)) {
        _taskSourceKeys[task.taskId] = sourceKey;
        _changed();
      }
      return;
    }
    _tasks.remove(task.taskId);
    _tasks[task.taskId] = task;
    if (sourceKey != null) _taskSourceKeys[task.taskId] = sourceKey;
    _retain();
    _changed();
  }

  void _retain() {
    if (_tasks.length <= _maxTasks) return;
    final live = <String>{};
    for (final task in _tasks.values) {
      if (task.terminal) continue;
      String? id = task.taskId;
      final seen = <String>{};
      while (id != null && seen.add(id)) {
        live.add(id);
        id = _tasks[id]?.parentTaskId;
      }
    }
    var excess = _tasks.length - _maxTasks;
    for (final id in _tasks.keys.toList()) {
      if (excess == 0) break;
      if (live.contains(id)) continue;
      _tasks.remove(id);
      _activity.remove(id);
      _taskSourceKeys.remove(id);
      excess--;
    }
  }

  AgentTaskActivity _activityOf(String taskId) =>
      _activity[taskId] ??= AgentTaskActivity();

  void _setEntries(
    AgentTaskActivity activity,
    List<AgentTaskEntry> entries, {
    String? eventId,
  }) {
    final dropped = entries.length - agentTaskEntryLimit;
    if (dropped > 0) {
      activity.omitted += dropped;
      _remember(
        activity.evictedKeys,
        entries.take(dropped).expand((e) => e.evictionKeys),
        _evictedKeyMemory,
      );
      entries = entries.sublist(dropped);
    }
    activity.entries = entries;
    if (eventId != null) {
      _remember(activity.appliedEventIds, [eventId], _eventIdMemory);
    }
    _changed();
  }

  /// Folds one frame of a task's own activity. [eventId] dedupes replays.
  void applyFrame(String taskId, CloudWireFrame frame, {String? eventId}) {
    switch (frame) {
      case CloudToolFrame(:final activity):
        applyTool(taskId, activity, eventId: eventId);
      case CloudMessageDelta(:final text, :final sourceKey):
        _applyDelta(taskId, AgentTaskEntryKind.text, text, sourceKey, eventId);
      case CloudMessageReasoning(:final text, :final sourceKey):
        _applyDelta(
          taskId,
          AgentTaskEntryKind.reasoning,
          text,
          sourceKey,
          eventId,
        );
      case CloudMessageFinish(:final finalText?, :final sourceKey):
        _reconcileFinalText(taskId, sourceKey, finalText);
      default:
        return;
    }
  }

  void _applyDelta(
    String taskId,
    AgentTaskEntryKind kind,
    String delta,
    String? sourceKey,
    String? eventId,
  ) {
    final activity = _activityOf(taskId);
    if (delta.isEmpty ||
        (eventId != null && activity.appliedEventIds.contains(eventId))) {
      return;
    }
    final entries = [...activity.entries];
    final last = entries.lastOrNull;
    if (last != null &&
        last.kind == kind &&
        last.messageId == null &&
        last.sourceKey == sourceKey) {
      entries[entries.length - 1] = last.withText(last.text + delta);
    } else {
      entries.add(AgentTaskEntry.text(kind, delta, sourceKey: sourceKey));
    }
    _setEntries(activity, entries, eventId: eventId);
  }

  /// Folds a task's tool call or result, matching by id and source.
  void applyTool(String taskId, CloudChatToolActivity tool, {String? eventId}) {
    if (tool.kind == CloudToolActivityKind.unknown) return;
    final activity = _activityOf(taskId);
    final id = tool.toolCallId, sourceKey = tool.sourceKey;
    final entries = activity.entries;
    var index = id == null || sourceKey == null
        ? -1
        : entries.indexWhere(
            (e) =>
                e.kind == AgentTaskEntryKind.tool &&
                e.toolCallId == id &&
                e.sourceKey == sourceKey,
          );
    if (id != null && index < 0) {
      final candidates = [
        for (final (i, e) in entries.indexed)
          if (e.kind == AgentTaskEntryKind.tool &&
              e.toolCallId == id &&
              (sourceKey == null || e.sourceKey == null))
            i,
      ];
      if (candidates.length == 1) index = candidates.single;
    }
    final isCall = tool.kind == CloudToolActivityKind.call;
    if (index >= 0) {
      final existing = entries[index];
      final resolved = sourceKey ?? existing.sourceKey;
      final adopted = existing.sourceKey != resolved;
      if (!adopted) {
        if (isCall && existing.call != null) return;
        if (!isCall &&
            existing.result?.output == tool.output &&
            existing.result?.isError == tool.isError) {
          return;
        }
      }
      existing.sourceKey = resolved;
      if (isCall) {
        existing.call = tool;
      } else {
        existing.result = tool;
      }
      _setEntries(activity, [...entries]);
      return;
    }
    if (id != null && _isEvictedTool(activity.evictedKeys, sourceKey, id)) {
      return;
    }
    final replayKey = id == null ? eventId : null;
    if (replayKey != null && activity.appliedEventIds.contains(replayKey)) {
      return;
    }
    _setEntries(activity, [
      ...entries,
      AgentTaskEntry.tool(
        toolCallId: id,
        sourceKey: sourceKey,
        call: isCall ? tool : null,
        result: isCall ? null : tool,
      ),
    ], eventId: replayKey);
  }

  static bool _isEvictedTool(
    Set<String> evicted,
    String? sourceKey,
    String toolCallId,
  ) {
    final keys = _toolKeys(sourceKey, toolCallId);
    return sourceKey == null
        ? evicted.contains(keys[1])
        : evicted.contains(keys[0]) ||
              evicted.contains(_toolKeys(null, toolCallId)[0]);
  }

  /// The live segments of a message keep their place around its tools; the
  /// segment after the last tool becomes what the final text adds.
  void _reconcileFinalText(String taskId, String? sourceKey, String finalText) {
    final activity = _activityOf(taskId);
    final entries = activity.entries;
    bool sameSource(AgentTaskEntry e) =>
        e.kind == AgentTaskEntryKind.text && e.sourceKey == sourceKey;
    if (entries.any((e) => sameSource(e) && e.messageId != null)) return;
    final segments = [
      for (final (i, e) in entries.indexed)
        if (sameSource(e)) (index: i, entry: e),
    ];
    final lastTool = entries.lastIndexWhere(
      (e) => e.kind == AgentTaskEntryKind.tool,
    );
    final trailing = segments.lastOrNull;
    final current = trailing != null && trailing.index > lastTool
        ? trailing
        : null;
    final prior = [
      for (final s in segments)
        if (s != current) s.entry.text,
    ];
    final text = finalTextTail(prior, finalText);
    final next = [...entries];
    if (current == null) {
      if (text.isEmpty) return;
      next.add(
        AgentTaskEntry.text(
          AgentTaskEntryKind.text,
          text,
          sourceKey: sourceKey,
          reconciled: true,
        ),
      );
    } else {
      if (current.entry.text == text) return;
      if (text.isEmpty) {
        next.removeAt(current.index);
      } else {
        next[current.index] = current.entry.withText(text, reconciled: true);
      }
    }
    _setEntries(activity, next);
  }

  /// Folds a task's durable message rows, oldest first. Their text replaces
  /// the matching live text; their `tool_call` blocks place the task's tools.
  void applyMessages(String taskId, List<AgentTaskMessage> rows) {
    final activity = _activityOf(taskId);
    final ids = rows.map((r) => r.id).toSet();
    final durableSources = rows.map((r) => r.sourceKey).nonNulls.toSet();
    final remaining = activity.entries
        .where(
          (e) =>
              e.kind == AgentTaskEntryKind.tool ||
              (!ids.contains(e.messageId) &&
                  !(e.reconciled &&
                      e.sourceKey != null &&
                      durableSources.contains(e.sourceKey))),
        )
        .toList();
    final entries = <AgentTaskEntry>[];
    for (final row in rows) {
      final known = activity.appliedMessageIds.contains(row.id);
      void appendText(AgentTaskEntryKind kind, String text, String blockKey) {
        if (activity.evictedKeys.contains(_durableTextKey(row.id, blockKey))) {
          return;
        }
        final durable = AgentTaskEntry.text(
          kind,
          text,
          messageId: row.id,
          sourceKey: row.sourceKey,
          blockKey: blockKey,
        );
        entries.add(durable);
        if (known) return;
        final index = remaining.indexWhere(
          (e) =>
              e.kind == kind &&
              e.messageId == null &&
              (e.sourceKey == null ||
                  row.sourceKey == null ||
                  e.sourceKey == row.sourceKey) &&
              (durable.text.startsWith(e.text) ||
                  e.text.startsWith(durable.text)),
        );
        if (index < 0) return;
        final live = remaining[index];
        if (live.text.length > durable.text.length) {
          remaining[index] = live.withText(
            live.text.substring(durable.text.length),
          );
        } else {
          remaining.removeAt(index);
        }
      }

      if (row.contentBlocks.isNotEmpty) {
        for (final (i, block) in row.contentBlocks.indexed) {
          final type = block['type'];
          if (type == 'tool_call') {
            final id = block['toolCallId'];
            if (id is! String) continue;
            var index = remaining.indexWhere(
              (e) =>
                  e.kind == AgentTaskEntryKind.tool &&
                  e.toolCallId == id &&
                  (e.messageId == row.id || e.sourceKey == row.sourceKey),
            );
            if (index < 0) {
              // As in applyTool: a lone call of this id whose source is
              // unknown on either side is the same call.
              final loose = [
                for (final (i, e) in remaining.indexed)
                  if (e.kind == AgentTaskEntryKind.tool &&
                      e.toolCallId == id &&
                      (e.sourceKey == null || row.sourceKey == null))
                    i,
              ];
              if (loose.length == 1) index = loose.single;
            }
            if (index >= 0) {
              final tool = remaining.removeAt(index);
              entries.add(
                tool
                  ..sourceKey = tool.sourceKey ?? row.sourceKey
                  ..messageId = row.id
                  ..turnId = row.turnId,
              );
            } else if (!_isEvictedTool(
              activity.evictedKeys,
              row.sourceKey,
              id,
            )) {
              entries.add(
                AgentTaskEntry.tool(
                  toolCallId: id,
                  sourceKey: row.sourceKey,
                  messageId: row.id,
                  turnId: row.turnId,
                  call: _blockCall(block, id, row.sourceKey),
                ),
              );
            }
          } else if ((type == 'text' || type == 'reasoning') &&
              block['text'] is String &&
              (block['text'] as String).isNotEmpty) {
            appendText(
              type == 'text'
                  ? AgentTaskEntryKind.text
                  : AgentTaskEntryKind.reasoning,
              block['text'] as String,
              'block:$i',
            );
          }
        }
      } else {
        if (row.reasoningText case final reasoning? when reasoning.isNotEmpty) {
          appendText(AgentTaskEntryKind.reasoning, reasoning, 'reasoning');
        }
        if (row.text.isNotEmpty) {
          appendText(AgentTaskEntryKind.text, row.text, 'text');
        }
      }
      _remember(activity.appliedMessageIds, [row.id], _eventIdMemory);
    }
    entries.addAll(remaining);
    _setEntries(activity, entries);
  }

  /// Folds reloaded data: task rows attached to spawn calls, the tasks' own
  /// tool activity, and their durable message rows.
  void applyHistory({
    Iterable<CloudChatToolActivity> toolActivity = const [],
    Iterable<AgentTaskMessage> messages = const [],
  }) {
    for (final entry in toolActivity) {
      if (entry.kind == CloudToolActivityKind.call) {
        for (final task in agentTasksOfCall(entry)) {
          upsert(task, sourceKey: entry.sourceKey);
        }
      }
      if (entry.taskId case final taskId?) applyTool(taskId, entry);
    }
    final grouped = <String, List<AgentTaskMessage>>{};
    for (final message in messages) {
      (grouped[message.taskId] ??= []).add(message);
    }
    for (final MapEntry(key: taskId, value: rows) in grouped.entries) {
      rows.sort((a, b) {
        final order = a.sequence.compareTo(b.sequence);
        return order != 0 ? order : a.createdAtMs.compareTo(b.createdAtMs);
      });
      applyMessages(taskId, rows);
    }
  }
}

/// A tool call from a durable `tool_call` block that no tool activity named.
CloudChatToolActivity? _blockCall(
  Map<String, dynamic> block,
  String id,
  String? sourceKey,
) {
  final name = block['toolName'];
  if (name is! String || name.isEmpty) return null;
  final input = block['input'] ?? block['arguments'] ?? block['args'];
  return CloudChatToolActivity(
    kind: CloudToolActivityKind.call,
    rawKind: 'call',
    raw: block,
    sourceKey: sourceKey,
    toolCallId: id,
    toolName: name,
    input: input is String ? input : (input == null ? '' : _json(input)),
  );
}

String _json(Object value) {
  try {
    return jsonEncode(value);
  } on Object {
    return '';
  }
}

/// `agentTask` and `agentTasks` the BFF attaches to a reloaded spawn call.
List<CloudAgentTask> agentTasksOfCall(CloudChatToolActivity call) {
  final payload = call.raw['call'];
  final source = payload is Map ? payload : call.raw;
  final many = source['agentTasks'];
  return [
    ?CloudAgentTask.tryParse(source['agentTask']),
    if (many is List) ...many.map(CloudAgentTask.tryParse).nonNulls,
  ];
}

/// Text a final message adds after its earlier segments: the whole message
/// joined with or without blank lines, or a replacement.
String finalTextTail(List<String> prior, String finalText) {
  if (prior.isEmpty) return finalText;
  final separated = prior.join('\n\n'), compact = prior.join();
  if (finalText == separated || finalText == compact) return '';
  if (finalText.startsWith('$separated\n\n')) {
    return finalText.substring(separated.length + 2);
  }
  if (finalText.startsWith(compact)) return finalText.substring(compact.length);
  return finalText;
}
