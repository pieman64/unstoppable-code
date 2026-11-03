import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_outcome.dart';

ChatMessage _m(
  String id,
  ChatRole role, {
  ChatMessageStatus status = ChatMessageStatus.complete,
  List<ChatPart> parts = const [],
}) => ChatMessage(
  messageId: id,
  chatId: 'c',
  role: role,
  status: status,
  text: id,
  parts: parts,
);

ChatPart _timer({int? completedAt, String? endReason}) => ChatPart(
  kind: 'turn_timer',
  data: {
    'startedAt': 1000,
    'completedAt': ?completedAt,
    'endReason': ?endReason,
  },
);

void main() {
  test('a clean tail after the last user message succeeds', () {
    expect(
      latestTurnSucceeded([
        _m('u0', ChatRole.user),
        _m('a0', ChatRole.assistant, status: ChatMessageStatus.failed),
        _m('u1', ChatRole.user),
        _m('a1', ChatRole.assistant),
      ]),
      isTrue,
    );
  });

  for (final status in [
    ChatMessageStatus.failed,
    ChatMessageStatus.cancelled,
    ChatMessageStatus.streaming,
  ]) {
    test('a $status message in the tail fails the turn', () {
      expect(
        latestTurnSucceeded([
          _m('u1', ChatRole.user),
          _m('a1', ChatRole.assistant),
          _m('a2', ChatRole.assistant, status: status),
        ]),
        isFalse,
      );
    });
  }

  test('a tail with no assistant message does not succeed', () {
    expect(latestTurnSucceeded([_m('u1', ChatRole.user)]), isFalse);
    expect(latestTurnSucceeded(const []), isFalse);
  });

  test('turn timer state is read from turn_timer parts', () {
    final running = _m('t', ChatRole.assistant, parts: [_timer()]);
    final done = _m('t', ChatRole.assistant, parts: [_timer(completedAt: 9)]);
    expect(hasRunningTurnTimer(running), isTrue);
    expect(hasCleanlyCompletedTurnTimer(running), isFalse);
    expect(hasRunningTurnTimer(done), isFalse);
    expect(hasCleanlyCompletedTurnTimer(done), isTrue);
    expect(hasRunningTurnTimer(_m('x', ChatRole.assistant)), isFalse);
  });

  test('a completed timer with an endReason is not a clean completion', () {
    for (final reason in ['cancelled', 'failed']) {
      final stopped = _m(
        't',
        ChatRole.assistant,
        parts: [_timer(completedAt: 9, endReason: reason)],
      );
      expect(hasCleanlyCompletedTurnTimer(stopped), isFalse);
      expect(hasRunningTurnTimer(stopped), isFalse);
    }
    final clean = _m('t', ChatRole.assistant, parts: [_timer(completedAt: 9)]);
    expect(hasCleanlyCompletedTurnTimer(clean), isTrue);
  });
}
