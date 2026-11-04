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

/// A fired watcher's message whose event block the host stored apart from its
/// visible [notice], as cloud chats deliver it. The host's [marker] names the
/// watcher when it sent one; otherwise the stored [event] block does. A block
/// inline in the text alone could have been typed by anyone, so it is only
/// hidden and earns no watcher title.
({String text, ChatWatcherFiredInfo? watcherFired})?
storedWatcherMessagePresentation(
  String notice, {
  ChatWatcherFiredInfo? marker,
  String? event,
}) {
  final legacy = watcherMessagePresentation(notice);
  if (marker == null && event == null) {
    return legacy == null ? null : (text: legacy.text, watcherFired: null);
  }
  final fromEvent = event == null
      ? null
      : visibleMessageParts(event)
            .where((part) => part.kind == VisibleMessagePartKind.watcher)
            .firstOrNull
            ?.watcherFired;
  return (
    text: legacy?.text ?? notice,
    watcherFired:
        marker ??
        fromEvent ??
        legacy?.watcherFired ??
        const ChatWatcherFiredInfo(kind: 'Watcher'),
  );
}
