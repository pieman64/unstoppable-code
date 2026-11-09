/// Pure helpers for deciding whether a chat turn ended cleanly. Shared by the
/// computer chat clients; like the rest
/// of the shared chat stack it imports no feature or data-access code (see
/// `test/architecture/chat_boundary_test.dart`), and it stays Flutter-free
/// because the engine's import closure must (see
/// `test/architecture/remote_engine_boundary_test.dart`).
library;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';

/// True when the turn at the tail of [transcript] — every message after the
/// last user message — has at least one assistant message and nothing that
/// is still streaming, failed, or cancelled.
bool latestTurnSucceeded(List<ChatMessage> transcript) {
  var sawAssistant = false;
  for (var i = transcript.length - 1; i >= 0; i -= 1) {
    final message = transcript[i];
    if (message.role == ChatRole.user) break;
    switch (message.status) {
      case ChatMessageStatus.streaming:
      case ChatMessageStatus.failed:
      case ChatMessageStatus.cancelled:
        return false;
      case ChatMessageStatus.complete:
      case null:
        break;
    }
    if (message.role == ChatRole.assistant) sawAssistant = true;
  }
  return sawAssistant;
}

/// True when [message] carries a turn timer that has not completed.
bool hasRunningTurnTimer(ChatMessage message) => message.parts.any((part) {
  final timer = TurnTimer.fromPart(part);
  return timer != null && timer.completedAt == null;
});

/// True when [message] carries a completed turn timer that records no abnormal
/// end. The desktop completes the timer row even when the user stopped the
/// turn or it failed, and marks those with an `endReason`, so a completed
/// timer with an `endReason` is not a clean completion.
bool hasCleanlyCompletedTurnTimer(ChatMessage message) => message.parts.any((
  part,
) {
  final timer = TurnTimer.fromPart(part);
  return timer != null && timer.completedAt != null && timer.endReason == null;
});
