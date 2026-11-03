import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';

ChatMessage _user(String id) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: ChatRole.user,
  status: ChatMessageStatus.complete,
  text: 'Prompt $id',
);

ChatMessage _step(String id, String toolUseId) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: '',
  parts: [
    ChatPart(
      kind: 'tool_use',
      toolFamily: 'bash',
      data: {'name': 'Bash', 'toolUseId': toolUseId},
    ),
    ChatPart(
      kind: 'tool_result',
      data: {'toolUseId': toolUseId, 'output': 'ok'},
    ),
  ],
);

ChatMessage _answer(
  String id, {
  ChatMessageStatus status = ChatMessageStatus.complete,
}) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: ChatRole.assistant,
  status: status,
  text: 'Answer $id',
);

ChatMessage _timer(String id, {required bool completed}) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: '',
  parts: [
    ChatPart(
      kind: 'turn_timer',
      data: {'startedAt': 1000, 'completedAt': completed ? 64000 : null},
    ),
  ],
);

/// Two finished turns (steps, answer, completed timer), then a live turn.
List<ChatMessage> _finished() => [
  _user('u-1'),
  _step('s-1', 'tool-1'),
  _answer('a-1'),
  _timer('t-1', completed: true),
  _user('u-2'),
  _step('s-2', 'tool-2'),
  _answer('a-2'),
  _timer('t-2', completed: true),
];

void main() {
  group('TranscriptProjection', () {
    List<TranscriptRow> rows(
      TranscriptProjection projection,
      List<ChatMessage> messages, {
      bool turnInProgress = false,
      int? turnElapsedMs,
      Set<String> expandedTurns = const {},
      Set<String> footerTurns = const {},
    }) => projection.rows(
      messages: messages,
      turnInProgress: turnInProgress,
      turnElapsedMs: turnElapsedMs,
      expandedTurns: expandedTurns,
      footerTurns: footerTurns,
    );

    test('an unchanged transcript projects no turn again', () {
      final projection = TranscriptProjection();
      final messages = _finished();
      final first = rows(projection, messages);
      final projected = projection.projectedTurnCount;
      final grouped = projection.groupedMessageCount;

      final second = rows(projection, messages);

      expect(projection.projectedTurnCount, projected);
      expect(projection.groupedMessageCount, grouped);
      expect(second, [for (final row in first) same(row)]);
    });

    test('streaming projects only the live turn', () {
      final projection = TranscriptProjection();
      final finished = _finished();
      final before = rows(projection, [
        ...finished,
        _user('u-3'),
        _answer('a-3', status: ChatMessageStatus.streaming),
      ], turnInProgress: true);
      final projected = projection.projectedTurnCount;
      final grouped = projection.groupedMessageCount;

      final after = rows(projection, [
        ...finished,
        _user('u-3'),
        _answer('a-3', status: ChatMessageStatus.streaming),
      ], turnInProgress: true);

      expect(projection.projectedTurnCount - projected, 1);
      expect(projection.groupedMessageCount - grouped, 2);
      // Every row of the finished turns is the same object as before.
      final finishedRows = before.indexWhere(
        (row) => row is TranscriptMessageRow && row.message.messageId == 'u-3',
      );
      expect(finishedRows, greaterThan(0));
      expect(after.take(finishedRows), [
        for (final row in before.take(finishedRows)) same(row),
      ]);
    });

    test('streaming keeps the live turn\'s unchanged rows', () {
      final projection = TranscriptProjection();
      final prefix = [..._finished(), _user('u-3'), _step('s-3', 'tool-3')];
      final before = rows(projection, [
        ...prefix,
        _answer('a-3', status: ChatMessageStatus.streaming),
      ], turnInProgress: true);

      final after = rows(projection, [
        ...prefix,
        _answer('a-3', status: ChatMessageStatus.streaming),
      ], turnInProgress: true);

      TranscriptMessageRow row(List<TranscriptRow> rows, String id) => rows
          .whereType<TranscriptMessageRow>()
          .firstWhere((row) => row.message.messageId == id);
      expect(row(after, 's-3'), row(before, 's-3'));
      expect(row(after, 's-3').toolResults['tool-3']?.content, 'ok');
      expect(row(after, 'a-3'), isNot(row(before, 'a-3')));
    });

    test('a changed tool result reaches the live turn\'s rows', () {
      final projection = TranscriptProjection();
      final prefix = [_user('u-1'), _step('s-1', 'tool-1')];
      rows(projection, prefix, turnInProgress: true);

      final failed = rows(projection, [
        ...prefix,
        const ChatMessage(
          messageId: 'r-1',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: '',
          parts: [
            ChatPart(
              kind: 'tool_result',
              data: {'toolUseId': 'tool-1', 'isError': true},
            ),
          ],
        ),
      ], turnInProgress: true);

      final step = failed.whereType<TranscriptMessageRow>().firstWhere(
        (row) => row.message.messageId == 's-1',
      );
      expect(step.toolResults['tool-1'], (content: 'Error', isError: true));
    });

    test('expanding a finished turn reuses its derived facts', () {
      final projection = TranscriptProjection();
      final messages = _finished();
      final collapsed = rows(projection, messages);
      final projected = projection.projectedTurnCount;

      final expanded = rows(projection, messages, expandedTurns: {'u-1'});

      expect(projection.projectedTurnCount, projected);
      final steps = expanded.whereType<TranscriptStepsRow>().first;
      expect(steps.expanded, isTrue);
      final step = expanded.whereType<TranscriptMessageRow>().firstWhere(
        (row) => row.message.messageId == 's-1',
      );
      expect(step.toolResults['tool-1']?.content, 'ok');
      // The second turn did not change, so its rows are the same objects.
      final secondTurn = collapsed.indexWhere(
        (row) => row is TranscriptMessageRow && row.message.messageId == 'u-2',
      );
      expect(expanded.skip(expanded.length - (collapsed.length - secondTurn)), [
        for (final row in collapsed.skip(secondTurn)) same(row),
      ]);
    });

    test('keys every row that has a stable identity', () {
      final projection = TranscriptProjection();
      final projected = rows(projection, [
        ..._finished(),
        _user('u-3'),
      ], turnInProgress: true);

      expect(
        [for (final row in projected) row.key],
        [
          'message-u-1',
          'turn-steps-row-u-1',
          'message-a-1',
          'turn-timer-u-1',
          'message-u-2',
          'turn-steps-row-u-2',
          'message-a-2',
          'turn-timer-u-2',
          'message-u-3',
          'turn-timer-bridge',
        ],
      );
    });

    test('the live timer carries the host duration until it completes', () {
      final projection = TranscriptProjection();
      final live = [_user('u-1'), _timer('t-1', completed: false)];

      final running = rows(
        projection,
        live,
        turnInProgress: true,
        turnElapsedMs: 5000,
      );
      expect(
        running.whereType<TranscriptTimerRow>().single.initialElapsedMs,
        5000,
      );

      final done = rows(projection, [
        _user('u-1'),
        _timer('t-1', completed: true),
      ], turnElapsedMs: 5000);
      final timer = done.whereType<TranscriptTimerRow>().single;
      expect(timer.initialElapsedMs, isNull);
      expect(timer.timer?.completedAt, 64000);
    });

    group('turn footers (CAN-3619)', () {
      String describe(TranscriptRow row) => switch (row) {
        TranscriptTurnFooterRow(:final turnKey) => 'footer:$turnKey',
        TranscriptTimerRow(:final turnKey) => 'timer:${turnKey ?? 'bridge'}',
        TranscriptMessageRow(:final message) => message.messageId,
        _ => row.runtimeType.toString(),
      };

      test('a footer closes its turn, after the turn timer', () {
        final projected = rows(
          TranscriptProjection(),
          _finished(),
          footerTurns: {'u-1', 'u-2'},
        ).map(describe).toList();
        final firstFooter = projected.indexOf('footer:u-1');
        expect(projected[firstFooter - 1], 'timer:u-1');
        expect(projected[firstFooter + 1], 'u-2');
        expect(projected.last, 'footer:u-2');
        expect(projected[projected.length - 2], 'timer:u-2');
      });

      test('a live timerless turn keeps its footer under the working row', () {
        final projected = rows(
          TranscriptProjection(),
          [..._finished(), _user('u-3')],
          turnInProgress: true,
          footerTurns: {'u-3'},
        ).map(describe).toList();
        expect(projected.sublist(projected.length - 2), [
          'timer:bridge',
          'footer:u-3',
        ]);
      });

      test('turns without a footer and unknown keys get no row', () {
        final projected = rows(
          TranscriptProjection(),
          _finished(),
          footerTurns: {'u-gone'},
        );
        expect(projected.whereType<TranscriptTurnFooterRow>(), isEmpty);
      });
    });
  });
}
