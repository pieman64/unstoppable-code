import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';

ChatMessage _message(
  String id, {
  ChatRole role = ChatRole.assistant,
  ChatMessageStatus status = ChatMessageStatus.complete,
  String text = '',
  List<ChatPart> parts = const [],
}) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: role,
  status: status,
  text: text,
  parts: parts,
);

const _bash = ChatPart(
  kind: 'tool_use',
  toolFamily: 'bash',
  data: {'name': 'Bash'},
);
const _read = ChatPart(
  kind: 'tool_use',
  toolFamily: 'read',
  data: {'name': 'Read'},
);
const _timer = ChatPart(kind: 'turn_timer');

void main() {
  _liveTests();
  _summaryTests();
  group('groupChatTurns', () {
    test('splits by user messages; last texty assistant message is final', () {
      final turns = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'do the thing'),
        _message('a1', parts: [_bash]),
        _message('a2', text: 'Working through it', parts: [_read]),
        _message('a3', parts: [_bash, _bash]),
        _message('a4', text: 'Done — all tests pass.'),
        _message('u2', role: ChatRole.user, text: 'thanks, next task'),
        _message('a5', parts: [_bash]),
      ]);

      expect(turns, hasLength(2));
      expect(turns.first.user?.messageId, 'u1');
      expect(turns.first.intermediate.map((m) => m.messageId), [
        'a1',
        'a2',
        'a3',
      ]);
      expect(turns.first.finalMessages.single.messageId, 'a4');

      // The second turn is interrupted/in-progress: no text answer yet, so
      // everything stays intermediate with no final block.
      expect(turns.last.user?.messageId, 'u2');
      expect(turns.last.intermediate.single.messageId, 'a5');
      expect(turns.last.finalMessages, isEmpty);
    });

    test('handles a leading pre-user assistant run', () {
      final turns = groupChatTurns([
        _message('a0', text: 'restored context'),
        _message('u1', role: ChatRole.user, text: 'hi'),
        _message('a1', text: 'hello'),
      ]);

      expect(turns, hasLength(2));
      expect(turns.first.user, isNull);
      expect(turns.first.finalMessages.single.messageId, 'a0');
      expect(turns.last.user?.messageId, 'u1');
    });

    test('a timer-only intermediate is not worth a collapse row', () {
      final turns = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'what is 5+5?'),
        _message('a1', parts: [_timer]),
        _message('a2', text: '10'),
      ]);

      expect(turns.single.hasCollapsibleIntermediate, isFalse);

      final worked = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'run the tests'),
        _message('a1', parts: [_bash]),
        _message('a2', text: 'green'),
      ]);
      expect(worked.single.hasCollapsibleIntermediate, isTrue);
    });
  });

  group('hasRenderableContent', () {
    test('skips timer-only and empty frames, keeps streaming/failed ones', () {
      expect(hasRenderableContent(_message('a1', parts: [_timer])), isFalse);
      expect(hasRenderableContent(_message('a2')), isFalse);
      expect(hasRenderableContent(_message('a3', text: 'hello')), isTrue);
      expect(hasRenderableContent(_message('a4', parts: [_bash])), isTrue);
      expect(
        hasRenderableContent(
          _message('a5', status: ChatMessageStatus.streaming),
        ),
        isTrue,
      );
      expect(
        hasRenderableContent(_message('a6', status: ChatMessageStatus.failed)),
        isTrue,
      );
    });
  });

  group('ChatPart.displayLabel', () {
    test('never surfaces the raw unknown family', () {
      const named = ChatPart(
        kind: 'tool_use',
        toolFamily: 'unknown',
        data: {'name': 'mcp__linear__list_issues'},
      );
      expect(named.displayLabel, 'mcp__linear__list_issues');

      const unnamed = ChatPart(kind: 'tool_use', toolFamily: 'unknown');
      expect(unnamed.displayLabel, 'Tool');

      const familyOnly = ChatPart(kind: 'tool_use', toolFamily: 'grep');
      expect(familyOnly.displayLabel, 'grep');
    });
  });
}

void _liveTests() {
  group('ChatTurn.isLive', () {
    const openTimer = ChatPart(
      kind: 'turn_timer',
      data: {'startedAt': 1, 'completedAt': null},
    );
    const closedTimer = ChatPart(
      kind: 'turn_timer',
      data: {'startedAt': 1, 'completedAt': 2},
    );

    test('is live while any message streams', () {
      final turn = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'go'),
        _message('a1', status: ChatMessageStatus.streaming),
      ]).single;
      expect(turn.isLive, isTrue);
    });

    test('is live while its turn timer has not completed', () {
      final turn = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'go'),
        _message('a1', parts: [_bash]),
        _message('t1', role: ChatRole.system, parts: [openTimer]),
      ]).single;
      expect(turn.isLive, isTrue);
    });

    for (final timerFirst in [false, true]) {
      test(
        'completed timer settles unfinished tools, timerFirst=$timerFirst',
        () {
          final orphan = _message(
            'tool',
            status: ChatMessageStatus.streaming,
            parts: [_bash],
          );
          final completed = _message(
            'timer',
            role: ChatRole.system,
            parts: [closedTimer],
          );
          final turn = groupChatTurns([
            _message('user', role: ChatRole.user, text: 'go'),
            if (timerFirst) completed,
            orphan,
            _message('answer', text: 'done'),
            if (!timerFirst) completed,
          ]).single;
          expect(turn.isLive, isFalse);
          expect(turn.isStreaming, isFalse);
          expect(
            orphan.status,
            ChatMessageStatus.streaming,
            reason: 'Turn completion must not fabricate a tool result',
          );
        },
      );
    }

    test('an old completed turn does not hide a newer running turn', () {
      final turns = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'first'),
        _message('closed', role: ChatRole.system, parts: [closedTimer]),
        _message('u2', role: ChatRole.user, text: 'second'),
        _message(
          'new-tool',
          status: ChatMessageStatus.streaming,
          parts: [_bash],
        ),
        _message('open', role: ChatRole.system, parts: [openTimer]),
      ]);
      expect(turns.last.isLive, isTrue);
    });

    test('settles once the timer completes and nothing streams', () {
      final turn = groupChatTurns([
        _message('u1', role: ChatRole.user, text: 'go'),
        _message('a1', parts: [_bash]),
        _message('a2', text: 'done'),
        _message('t1', role: ChatRole.system, parts: [closedTimer]),
      ]).single;
      expect(turn.isLive, isFalse);
    });
  });
}

void _summaryTests() {
  group('summarizeTurnSteps', () {
    test('counts categories in the desktop chip order', () {
      const thinking = ChatPart(
        kind: 'thinking',
        data: {'text': 'Let me look.'},
      );
      const edit = ChatPart(
        kind: 'tool_use',
        toolFamily: 'edit',
        data: {'name': 'Edit'},
      );
      const mcp = ChatPart(
        kind: 'tool_use',
        data: {'name': 'mcp__linear__list_issues'},
      );
      const mystery = ChatPart(
        kind: 'tool_use',
        data: {'name': 'SomethingNew'},
      );
      final summary = summarizeTurnSteps([
        _message('a1', parts: [mystery, _bash, thinking]),
        _message('a2', text: 'Halfway there.', parts: [edit, _read, _bash]),
        _message('a3', parts: [mcp, _timer]),
      ]);
      expect(summary, [
        (category: TurnStepCategory.messages, count: 1),
        (category: TurnStepCategory.thinking, count: 1),
        (category: TurnStepCategory.bash, count: 2),
        (category: TurnStepCategory.read, count: 1),
        (category: TurnStepCategory.writeEdit, count: 1),
        (category: TurnStepCategory.mcp, count: 1),
        (category: TurnStepCategory.other, count: 1),
      ]);
    });

    test('ignores blank thinking parts and timers', () {
      const blank = ChatPart(kind: 'thinking', data: {'text': '   '});
      expect(
        summarizeTurnSteps([
          _message('a1', parts: [blank, _timer]),
        ]),
        isEmpty,
      );
    });

    test('counts agent parts as agent activity', () {
      const agent = ChatPart(
        kind: 'agent',
        data: {'displayName': 'Researcher'},
      );

      expect(
        summarizeTurnSteps([
          _message('a1', parts: [agent]),
        ]),
        [(category: TurnStepCategory.agent, count: 1)],
      );
    });

    test('maps tool names the wire leaves unfamilied', () {
      ChatPart named(String name) =>
          ChatPart(kind: 'tool_use', data: {'name': name});
      final summary = summarizeTurnSteps([
        _message(
          'a1',
          parts: [
            named('Grep'),
            named('Glob'),
            named('WebSearch'),
            named('Skill'),
            named('TodoWrite'),
            named('Agent'),
            named('AskUserQuestion'),
          ],
        ),
      ]);
      expect(summary.map((e) => e.category), [
        TurnStepCategory.search,
        TurnStepCategory.grep,
        TurnStepCategory.web,
        TurnStepCategory.agent,
        TurnStepCategory.tasks,
        TurnStepCategory.skills,
        TurnStepCategory.askUser,
      ]);
    });

    test('maps unfamilied Computer Use raw names to Computer Use', () {
      const run = ChatPart(
        kind: 'tool_use',
        data: {'toolName': 'mcp__cua_repl__js'},
      );
      const reset = ChatPart(
        kind: 'tool_use',
        data: {'toolName': 'mcp__cua_repl__js_reset'},
      );

      expect(
        summarizeTurnSteps([
          _message('a1', parts: [run, reset]),
        ]),
        [(category: TurnStepCategory.computerUse, count: 2)],
      );
    });

    test('labels read as the desktop aria text', () {
      expect(
        describeTurnStepCounts([
          (category: TurnStepCategory.thinking, count: 2),
          (category: TurnStepCategory.writeEdit, count: 1),
        ]),
        '2 thinking, 1 write/edit',
      );
    });
  });
}
