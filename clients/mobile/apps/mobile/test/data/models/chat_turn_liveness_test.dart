import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/data/models/remote_chat.dart';

ChatMessage message(
  String id, {
  ChatRole role = ChatRole.system,
  int? at,
  bool streaming = false,
  List<ChatPart> parts = const [],
}) => ChatMessage(
  messageId: id,
  chatId: 'chat',
  role: role,
  text: '',
  status: streaming ? ChatMessageStatus.streaming : ChatMessageStatus.complete,
  occurredAt: at == null ? null : DateTime.fromMillisecondsSinceEpoch(at),
  parts: parts,
);
ChatMessage timer(String id, int start, {int? end, String? reason}) => message(
  id,
  parts: [
    ChatPart(
      kind: 'turn_timer',
      data: {'startedAt': start, 'completedAt': end, 'endReason': reason},
    ),
  ],
);

void main() {
  for (final continuation in [true, false]) {
    test(
      'wire continuation=$continuation preserves only the current timer',
      () {
        final steering = RemoteChatMessage.fromWireJson({
          'messageId': 'steering',
          'chatId': 'chat',
          'role': 'user',
          'status': 'complete',
          'text': 'Use the other approach',
          'continuesTurn': continuation,
          'createdAtMs': 1500,
        });
        for (final row in [
          steering,
          steering.withAttachments(const []),
          steering.withOrderingAt(DateTime.fromMillisecondsSinceEpoch(1500)),
          steering.withUpdatedAt(DateTime.fromMillisecondsSinceEpoch(1600)),
        ]) {
          expect(
            isChatTurnRunning([
              timer('open', 1000),
              row,
              message('interim', role: ChatRole.assistant, at: 1700),
            ]),
            continuation,
          );
          expect(
            isChatTurnRunning([
              timer('open', 1000),
              row,
              message('interim', role: ChatRole.assistant, at: 1700),
              timer('done', 1000, end: 2000),
            ]),
            isFalse,
          );
        }
      },
    );
  }

  test('a streaming tool remains live without completion evidence', () {
    expect(isChatTurnRunning([message('tool', streaming: true)]), isTrue);
  });

  test('a running timer remains live without a streaming row', () {
    expect(isChatTurnRunning([timer('open', 1000)]), isTrue);
  });

  for (final reason in [null, 'cancelled', 'failed']) {
    test('a terminal timer settles undated and dated orphan rows: $reason', () {
      expect(
        isChatTurnRunning([
          message('prompt', role: ChatRole.user, at: 1000),
          timer('completed', 1001, end: 2000, reason: reason),
          message('undated-tool', streaming: true),
          message('tool', at: 1500, streaming: true),
        ]),
        isFalse,
      );
    });
  }

  test('a new prompt starts fresh work after an unfinished older tool', () {
    expect(
      isChatTurnRunning([
        message('old-tool', streaming: true),
        timer('completed', 1000, end: 2000),
        message('prompt', role: ChatRole.user, at: 3000),
        message('new-tool', streaming: true),
      ]),
      isTrue,
    );
  });

  test('a late completion from an older turn cannot settle a new prompt', () {
    expect(
      isChatTurnRunning([
        message('prompt', role: ChatRole.user, at: 3000),
        message('new-tool', streaming: true),
        timer('old-completion', 1000, end: 2000),
      ]),
      isTrue,
    );
  });

  test(
    'activity positioned after completion can continue without a new prompt',
    () {
      expect(
        isChatTurnRunning([
          timer('completed', 1000, end: 2000),
          message('new-activity', at: 2001, streaming: true),
        ]),
        isTrue,
      );
      expect(
        isChatTurnRunning([
          timer('completed', 1000, end: 2000),
          timer('next-timer', 2001),
        ]),
        isTrue,
      );
    },
  );

  test('an old timer replay cannot reopen the completed turn', () {
    expect(
      isChatTurnRunning([
        timer('completed', 1000, end: 2000),
        timer('replayed', 1000),
      ]),
      isFalse,
    );
  });

  test('a revised tool retains its original turn position', () {
    final revised = RemoteChatMessage(
      messageId: 'tool',
      chatId: 'chat',
      role: ChatRole.system,
      status: ChatMessageStatus.streaming,
      text: '',
      occurredAt: DateTime.fromMillisecondsSinceEpoch(3000),
      orderingAt: DateTime.fromMillisecondsSinceEpoch(1500),
    );
    expect(
      isChatTurnRunning([revised, timer('completed', 1000, end: 2000)]),
      isFalse,
    );
    expect(revised.status, ChatMessageStatus.streaming);
  });

  test(
    'equal timestamps distinguish a zero-duration turn from an older timer',
    () {
      expect(
        isChatTurnRunning([
          message('prompt', role: ChatRole.user, at: 2000),
          message('tool', streaming: true),
          timer('current', 2000, end: 2000),
        ]),
        isFalse,
      );
      expect(
        isChatTurnRunning([
          message('prompt', role: ChatRole.user, at: 2000),
          message('new-tool', streaming: true),
          timer('old', 1000, end: 2000),
        ]),
        isTrue,
      );
    },
  );

  test('an older streaming row does not keep the next idle turn running', () {
    expect(
      isChatTurnRunning([
        message('old-tool', streaming: true),
        message('new-prompt', role: ChatRole.user),
        message('reply', role: ChatRole.assistant),
      ]),
      isFalse,
    );
  });
}
