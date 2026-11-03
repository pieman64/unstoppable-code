import 'package:mobile/data/models/chat_message.dart';
import 'items.dart';
import 'package:mobile/ui/core/chat/view_models/visible_message_parts.dart';

typedef BackgroundTrayAgentRun = ({int generation, ChatPart part});

/// Latest observation of each retained run, including nested native agents.
List<BackgroundTrayAgentRun> backgroundTrayAgentRuns(
  Iterable<ChatMessage> messages,
  BackgroundTrayAgentTarget target,
) {
  final found = <int, ChatPart>{};
  void visit(ChatPart part) {
    if (part.kind != 'agent') return;
    final data = part.data;
    if (data == null) return;
    final delegation = data['delegation'];
    final matches = switch (target.kind) {
      BackgroundTrayAgentTargetKind.managed =>
        delegation is Map<String, dynamic> &&
            delegation['delegationId'] == target.id,
      BackgroundTrayAgentTargetKind.claudeNative =>
        delegation == null &&
            data['provider'] != 'codex' &&
            data['toolUseId'] == target.id,
    };
    if (matches) {
      final generation = delegation is Map<String, dynamic>
          ? _generation(delegation['runGeneration'])
          : 1;
      found[generation] = part;
    }
    final children = data['subBlocks'];
    if (children is List) {
      for (final child in children.whereType<Map<String, dynamic>>()) {
        visit(ChatPart.fromJson(child));
      }
    }
  }

  for (final message in messages) {
    for (final part in message.parts) {
      visit(part);
    }
  }
  final runs = found.entries.toList()
    ..sort((left, right) => left.key.compareTo(right.key));
  return [for (final run in runs) (generation: run.key, part: run.value)];
}

/// Reuse the shared read-only feed with generation-aware row identities.
List<ChatMessage> backgroundTrayAgentMessages(
  ChatPart part, {
  int runGeneration = 1,
}) {
  final data = part.data ?? const <String, dynamic>{};
  final delegation = data['delegation'];
  final card = delegation is Map<String, dynamic> ? delegation : data;
  final prompt = card['prompt'];
  final children = data['subBlocks'];
  final retained = [
    if (children is List)
      for (final child in children.whereType<Map<String, dynamic>>())
        ChatPart.fromJson(child),
  ];
  final result = delegation is Map<String, dynamic>
      ? delegation['finalText'] ?? delegation['partialText']
      : _nativeResultIsAnswer(data, retained)
      ? data['result']
      : null;
  final parts = [
    ...retained,
    if (result is String &&
        result.isNotEmpty &&
        !retained.any((child) => _text(child)?.trim() == result.trim()))
      ChatPart(kind: 'text', data: {'text': result}),
  ];
  final prefix = 'run-$runGeneration';
  final body = [
    for (final (index, child) in parts.indexed)
      ..._retainedMessages(child, '$prefix-child-$index'),
  ];
  final shown = {
    for (final message in body)
      if (message.role == ChatRole.user) message.text.trim(),
  };
  final promptParts = visibleMessageParts(prompt is String ? prompt : '');
  final matched = promptParts
      .where(
        (part) =>
            part.kind == VisibleMessagePartKind.text &&
            shown.contains(part.text.trim()),
      )
      .firstOrNull;
  final remaining = promptParts
      .where(
        (part) =>
            part.kind != VisibleMessagePartKind.hidden &&
            !(part.kind == VisibleMessagePartKind.text &&
                shown.contains(part.text.trim())),
      )
      .toList();
  final after = matched == null
      ? -1
      : body.indexWhere(
          (message) =>
              message.role == ChatRole.user &&
              message.text.trim() == matched.text.trim(),
        );
  return [
    ...body.take(after + 1),
    for (final (index, visible) in remaining.indexed)
      ChatMessage(
        messageId: '$prefix-prompt-$index',
        chatId: 'agent',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: visible.text,
        watcherFired: visible.watcherFired,
        parts: [
          ChatPart(
            kind: 'text',
            data: {
              'text': visible.text,
              if (visible.watcherFired == null) 'delegationAuthorKind': 'agent',
              if (visible.requestedBy case final name?)
                'delegationAuthorDescription': name
              else if (card['parentDescription'] case final String description)
                'delegationAuthorDescription': description,
            },
          ),
        ],
      ),
    ...body.skip(after + 1),
    if (body.isEmpty)
      ChatMessage(
        messageId: '$prefix-empty',
        chatId: 'agent',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'No updates yet',
      ),
  ];
}

List<ChatMessage> _retainedMessages(ChatPart part, String id) {
  if (_inputRole(part) != ChatRole.user) {
    return [
      ChatMessage(
        messageId: id,
        chatId: 'agent',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: _text(part) ?? '',
        parts: [part],
      ),
    ];
  }
  final visible = visibleMessageParts(
    _text(part) ?? '',
  ).where((part) => part.kind != VisibleMessagePartKind.hidden).toList();
  return [
    for (final (index, shown) in visible.indexed)
      ChatMessage(
        messageId: index == 0 ? id : '$id-part-$index',
        chatId: 'agent',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: shown.text,
        watcherFired: shown.watcherFired,
        parts: [part],
      ),
  ];
}

// Mirrors Portal's native run observation: launch/stop receipts are not the
// answer when the task has child activity. Legacy tool-only completed runs
// still supply their final answer in result.
bool _nativeResultIsAnswer(Map<String, dynamic> data, List<ChatPart> parts) =>
    parts.isEmpty ||
    (data['taskStatus'] == 'completed' &&
        data['isError'] != true &&
        !parts.any((part) => part.kind == 'text'));

int _generation(Object? value) => switch (value) {
  num generation
      when generation.isFinite &&
          generation >= 1 &&
          generation == generation.truncateToDouble() =>
    generation.toInt(),
  _ => 1,
};

String? _text(ChatPart part) => switch (part) {
  ChatPart(kind: 'text', data: {'text': final String text}) => text,
  _ => null,
};

ChatRole _inputRole(ChatPart part) => switch (part) {
  ChatPart(kind: 'text', data: {'delegationAuthorKind': 'user' || 'agent'}) =>
    ChatRole.user,
  _ => ChatRole.assistant,
};
