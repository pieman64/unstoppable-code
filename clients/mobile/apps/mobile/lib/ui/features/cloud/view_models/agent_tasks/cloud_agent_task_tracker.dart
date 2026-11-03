/// Feeds one chat's agent task fold from both protocols and projects the
/// transcript's spawn rows into agent cards. The chat view model owns one.
library;

import 'package:mobile/data/models/cloud_agent_task.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_fold.dart';
import 'package:mobile/ui/features/cloud/view_models/agent_tasks/cloud_agent_task_projection.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';

final class CloudAgentTaskTracker {
  final fold = CloudAgentTaskFold();
  String? _messagesSignature;
  List<CloudTranscriptMessage>? _projectedFrom, _projected;
  int _projectedRevision = -1;

  void clear() {
    fold.clear();
    _messagesSignature = null;
  }

  /// Protocol-v1 reload: replaces everything with the bootstrap's tasks.
  void legacyBootstrap(CloudChatBootstrap bootstrap) {
    clear();
    fold.applyHistory(
      toolActivity: bootstrap.toolActivity,
      messages: [
        for (final m in bootstrap.messages)
          if (m.taskId case final taskId?)
            AgentTaskMessage(
              id: m.id,
              taskId: taskId,
              sourceKey: m.sourceKey,
              text: m.text,
              reasoningText: m.reasoningText,
              contentBlocks: m.contentBlocks,
              sequence: m.sequence ?? 0,
              createdAtMs: m.createdAtMs,
            ),
      ],
    );
  }

  /// A live stream frame on either protocol. Root `message.start` frames
  /// teach the fold which stream key a turn uses.
  void frame(String event, Object? data, {String? eventId}) {
    if (event == 'message.start' &&
        data is Map<String, dynamic> &&
        data['taskId'] == null) {
      final turnId = data['turnId'], sourceKey = data['sourceKey'];
      if (turnId is String && sourceKey is String) {
        fold.turnIdentity(turnId, sourceKey);
      }
      return;
    }
    switch (parseCloudAgentTaskEvent(event, data)) {
      case CloudAgentTaskUpsert(:final task, :final sourceKey):
        fold.upsert(task, sourceKey: sourceKey);
      case CloudAgentTaskActivity(:final taskId, :final frame):
        fold.applyFrame(taskId, frame, eventId: eventId);
      case null:
        return;
    }
  }

  /// Protocol-v2 task rows and durable tool activity (snapshot, history).
  void conversationTasks(
    Iterable<Object?> tasks, [
    Iterable<Object?> toolActivity = const [],
  ]) {
    for (final task in tasks.map(CloudAgentTask.tryParse).nonNulls) {
      fold.upsert(task);
    }
    fold.applyHistory(
      toolActivity: [
        for (final entry in toolActivity)
          if (entry is Map<String, dynamic>)
            CloudChatToolActivity.fromJson(entry),
      ],
    );
  }

  /// Protocol-v2 messages: root rows name their turns' stream keys; task rows
  /// are the subagents' replies.
  void conversationMessages(Iterable<ConversationMessage> messages) {
    final rows = <AgentTaskMessage>[];
    final signature = StringBuffer();
    for (final m in messages) {
      final taskId = m.taskId;
      if (taskId == null) {
        if (m.role == 'ASSISTANT') fold.turnIdentity(m.turnId, m.sourceKey);
        continue;
      }
      signature.write('${m.id}\u0000${m.json['updatedAt']}\u0001');
      rows.add(
        AgentTaskMessage(
          id: m.id,
          taskId: taskId,
          sourceKey: m.sourceKey,
          turnId: m.turnId,
          text: m.text,
          reasoningText: switch (m.json['thinking']) {
            {'reasoningTextAvailable': true, 'reasoningText': final String text}
                when text.isNotEmpty =>
              text,
            final String text => text,
            _ => null,
          },
          contentBlocks: [
            for (final block in m.json['contentBlocks'] as List? ?? const [])
              if (block is Map<String, dynamic>) block,
          ],
          sequence: m.seq,
          createdAtMs:
              DateTime.tryParse(
                m.json['createdAt'] as String,
              )?.millisecondsSinceEpoch ??
              0,
        ),
      );
    }
    final key = signature.toString();
    if (key == _messagesSignature) return;
    _messagesSignature = key;
    fold.applyHistory(messages: rows);
  }

  /// [rows] with agent cards in place of known spawn rows; cached until
  /// either input changes.
  List<CloudTranscriptMessage> project(List<CloudTranscriptMessage> rows) {
    final previous = _projectedFrom;
    if (previous != null &&
        fold.revision == _projectedRevision &&
        previous.length == rows.length &&
        Iterable<int>.generate(
          rows.length,
        ).every((i) => identical(previous[i], rows[i]))) {
      return _projected!;
    }
    _projectedFrom = rows;
    _projectedRevision = fold.revision;
    return _projected = projectAgentTaskCards(rows, fold);
  }
}
