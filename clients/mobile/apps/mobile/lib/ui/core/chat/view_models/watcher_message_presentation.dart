/// A fired watcher's combined visible notice, using the same part parser as
/// retained subagent prompts. Steering requests remain a separate message kind.
library;

import 'package:mobile/data/models/chat_message.dart';
import 'visible_message_parts.dart';

({String text, ChatWatcherFiredInfo watcherFired})? watcherMessagePresentation(
  String text,
) {
  final parts = visibleMessageParts(text);
  if (parts.any(
    (part) => part.kind == VisibleMessagePartKind.steeringRequest,
  )) {
    return null;
  }
  final watcher = parts
      .where((part) => part.kind == VisibleMessagePartKind.watcher)
      .firstOrNull;
  if (watcher case VisibleMessagePart(watcherFired: final marker?)) {
    final notice = parts
        .where((part) => part.kind == VisibleMessagePartKind.text)
        .map((part) => part.text.trim())
        .where((text) => text.isNotEmpty)
        .join('\n\n');
    return (text: notice.isEmpty ? watcher.text : notice, watcherFired: marker);
  }
  return null;
}
