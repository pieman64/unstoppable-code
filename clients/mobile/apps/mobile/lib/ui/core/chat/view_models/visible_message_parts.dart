/// Dart port of the shared visible-message-parts contract. Provider-only
/// instructions stay hidden; known host notifications keep their display text.
library;

import 'dart:convert';
import 'package:mobile/data/models/chat_message.dart';

enum VisibleMessagePartKind { text, watcher, steeringRequest, hidden }

final class VisibleMessagePart {
  const VisibleMessagePart({
    required this.kind,
    required this.text,
    this.watcherFired,
    this.requestedBy,
  });
  final VisibleMessagePartKind kind;
  final String text;
  final ChatWatcherFiredInfo? watcherFired;
  final String? requestedBy;
}

final _systemInstruction = RegExp(
  r'<system_instruction>[\s\S]*?(?:</system_instruction>|$)',
  caseSensitive: false,
);
final _watcherEvent = RegExp(
  r'<([a-z][a-z0-9]*)_watcher_event>([\s\S]*?)</\1_watcher_event>',
  caseSensitive: false,
);
final _watcherDeleted = RegExp(
  r'<([a-z][a-z0-9]*)_watcher_deleted>([\s\S]*?)</\1_watcher_deleted>',
  caseSensitive: false,
);
final _subordinateRequest = RegExp(
  r'<subordinate_request>([\s\S]*?)</subordinate_request>',
  caseSensitive: false,
);
final _subordinateSender = RegExp(
  r'A managed subordinate \((.*?)\) requested steering',
);

List<VisibleMessagePart> visibleMessageParts(String text) {
  final blocks = _systemInstruction.allMatches(text).toList();
  if (blocks.isEmpty) {
    return [
      if (text.isNotEmpty)
        VisibleMessagePart(kind: VisibleMessagePartKind.text, text: text),
    ];
  }
  final parts = <VisibleMessagePart>[];
  void addText(String value) {
    if (value.trim().isNotEmpty) {
      parts.add(
        VisibleMessagePart(
          kind: VisibleMessagePartKind.text,
          text: value.trim(),
        ),
      );
    }
  }

  var cursor = 0;
  var hidden = false;
  for (final block in blocks) {
    addText(text.substring(cursor, block.start));
    final part = _hostPart(block[0] ?? '');
    if (part.kind == VisibleMessagePartKind.hidden) {
      hidden = true;
    } else {
      parts.add(part);
    }
    cursor = block.end;
  }
  addText(text.substring(cursor));
  return parts.isEmpty && hidden
      ? [
          const VisibleMessagePart(
            kind: VisibleMessagePartKind.hidden,
            text: '',
          ),
        ]
      : parts;
}

VisibleMessagePart _hostPart(String block) {
  if (_watcherEvent.firstMatch(block) case final event?) {
    final payload = _payload(event[2] ?? '');
    return VisibleMessagePart(
      kind: VisibleMessagePartKind.watcher,
      text: _label(payload) ?? '',
      watcherFired: ChatWatcherFiredInfo(kind: _kind(payload)),
    );
  }
  if (_watcherDeleted.firstMatch(block) case final deleted?) {
    final label = _label(_payload(deleted[2] ?? ''));
    return VisibleMessagePart(
      kind: VisibleMessagePartKind.text,
      text: label == null ? 'Watcher deleted' : 'Watcher deleted: $label',
    );
  }
  if (_subordinateRequest.firstMatch(block) case final request?) {
    final sender = _subordinateSender.firstMatch(block)?[1];
    return VisibleMessagePart(
      kind: VisibleMessagePartKind.steeringRequest,
      text: _unescape(request[1]?.trim() ?? ''),
      requestedBy: sender == null ? null : _unescape(sender),
    );
  }
  return const VisibleMessagePart(
    kind: VisibleMessagePartKind.hidden,
    text: '',
  );
}

String _unescape(String text) => text
    .replaceAll(r'\u003c', '<')
    .replaceAll(r'\u003e', '>')
    .replaceAll(r'\u0026', '&')
    .replaceAll(r'\r', '\r')
    .replaceAll(r'\n', '\n');

Map<String, dynamic>? _payload(String json) {
  try {
    final value = jsonDecode(json);
    return value is Map<String, dynamic> ? value : null;
  } on FormatException {
    return null;
  }
}

String? _label(Map<String, dynamic>? payload) {
  final label = payload?['label'];
  return label is String && label.trim().isNotEmpty ? label.trim() : null;
}

/// Automatic notices and historical delegate watches use the main chat's
/// wording; other watchers carry no kind in their payload, so they are named
/// by their label.
String _kind(Map<String, dynamic>? payload) {
  if (payload?['kind'] == 'delegation_finished') return 'Delegate finished';
  final target = payload?['target'];
  if (target is Map<String, dynamic> &&
      target['kind'] == 'managed_delegation') {
    return target['outcome'] == 'timeout'
        ? 'Delegate watch timed out'
        : 'Delegate watch completed';
  }
  return _label(payload) ?? 'Watcher';
}
