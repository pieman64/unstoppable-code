import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/incremental_turn_groups.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';

ChatMessage _user(String id) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: ChatRole.user,
  status: ChatMessageStatus.complete,
  text: 'Prompt $id',
);

ChatMessage _assistant(
  String id, {
  String text = '',
  ChatMessageStatus status = ChatMessageStatus.complete,
}) => ChatMessage(
  messageId: id,
  chatId: 'chat-1',
  role: ChatRole.assistant,
  status: status,
  text: text,
  parts: const [
    ChatPart(kind: 'tool_use', toolFamily: 'bash', data: {'name': 'Bash'}),
  ],
);

/// Three finished turns and a live one: 4 + 3 + 3 + 3 rows.
List<ChatMessage> _transcript() => [
  _assistant('pre-1', text: 'Session restored.'),
  _user('u-1'),
  _assistant('a-1'),
  _assistant('a-2', text: 'Answer 1'),
  _user('u-2'),
  _assistant('a-3'),
  _assistant('a-4', text: 'Answer 2'),
  _user('u-3'),
  _assistant('a-5'),
  _assistant('a-6', text: 'Answer 3'),
  _user('u-4'),
  _assistant('a-7'),
  _assistant('a-8', text: 'Streaming', status: ChatMessageStatus.streaming),
];

/// Every observable part of a turn, compared by row identity.
void _expectSameTurns(List<ChatTurn> actual, List<ChatTurn> expected) {
  expect(actual, hasLength(expected.length));
  for (var index = 0; index < expected.length; index++) {
    final a = actual[index];
    final e = expected[index];
    final reason = 'turn $index (${e.key})';
    expect(a.user, same(e.user), reason: reason);
    for (final (name, got, want) in [
      ('intermediate', a.intermediate, e.intermediate),
      ('final', a.finalMessages, e.finalMessages),
      ('assistant', a.assistantMessages, e.assistantMessages),
    ]) {
      expect(got, hasLength(want.length), reason: '$reason $name');
      for (var row = 0; row < want.length; row++) {
        expect(got[row], same(want[row]), reason: '$reason $name[$row]');
      }
    }
  }
}

void main() {
  group('IncrementalTurnGroups', () {
    test('an identical list returns the same turns without grouping', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript();
      final turns = groups.update(messages);
      final grouped = groups.groupedMessageCount;

      expect(groups.update(messages), same(turns));
      expect(groups.update(List.of(messages)), same(turns));
      expect(groups.groupedMessageCount, grouped);
    });

    test('a live-tail revision regroups only the live turn', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript();
      final before = groups.update(messages);
      final grouped = groups.groupedMessageCount;

      final revised = [
        ...messages.take(messages.length - 1),
        _assistant(
          'a-8',
          text: 'Streaming more',
          status: ChatMessageStatus.streaming,
        ),
      ];
      final after = groups.update(revised);

      for (var index = 0; index < before.length - 1; index++) {
        expect(after[index], same(before[index]), reason: 'turn $index');
      }
      expect(after.last, isNot(same(before.last)));
      expect(after.last.finalMessages.single.text, 'Streaming more');
      // Only the live turn's rows (u-4, a-7, a-8) were grouped again.
      expect(groups.groupedMessageCount - grouped, 3);
      _expectSameTurns(after, groupChatTurns(revised));
    });

    test('an appended step joins the live turn alone', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript();
      final before = groups.update(messages);
      final grouped = groups.groupedMessageCount;

      final appended = [...messages, _assistant('a-9')];
      final after = groups.update(appended);

      expect(after.take(3), [for (final turn in before.take(3)) same(turn)]);
      expect(groups.groupedMessageCount - grouped, 4);
      _expectSameTurns(after, groupChatTurns(appended));
    });

    test('a new prompt keeps the finished turn and opens a new one', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript();
      final before = groups.update(messages);
      final grouped = groups.groupedMessageCount;

      final next = [...messages, _user('u-5')];
      final after = groups.update(next);

      expect(after, hasLength(before.length + 1));
      expect(after.take(before.length), [
        for (final turn in before) same(turn),
      ]);
      expect(after.last.user?.messageId, 'u-5');
      expect(groups.groupedMessageCount - grouped, 1);
      _expectSameTurns(after, groupChatTurns(next));
    });

    test('a corrected earlier row regroups from its own turn', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript();
      final before = groups.update(messages);

      // An authoritative snapshot republishes the second turn's answer.
      final corrected = [...messages];
      corrected[6] = _assistant('a-4', text: 'Corrected answer 2');
      final after = groups.update(corrected);

      expect(after[0], same(before[0]));
      expect(after[1], same(before[1]));
      expect(after[2], isNot(same(before[2])));
      expect(after[2].finalMessages.single.text, 'Corrected answer 2');
      // Later turns are rebuilt from the same rows, so they keep identity.
      expect(after[3], same(before[3]));
      expect(after[4], same(before[4]));
      _expectSameTurns(after, groupChatTurns(corrected));
    });

    test('older history prepends without replacing loaded turns', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript().skip(1).toList();
      final before = groups.update(messages);

      final older = [_user('u-0'), _assistant('a-0', text: 'Answer 0')];
      final after = groups.update([...older, ...messages]);

      expect(after, hasLength(before.length + 1));
      expect(after.first.user?.messageId, 'u-0');
      expect(after.skip(1), [for (final turn in before) same(turn)]);
      _expectSameTurns(after, groupChatTurns([...older, ...messages]));
    });

    test('a prepend that completes a leading run regroups that turn', () {
      final groups = IncrementalTurnGroups();
      final messages = _transcript();
      final before = groups.update(messages);

      // `pre-1` led the transcript without a prompt; the older page carries
      // the prompt it answered, so the two now form one turn.
      final withPrompt = [_user('u-0'), ...messages];
      final after = groups.update(withPrompt);

      expect(after.first, isNot(same(before.first)));
      expect(after.first.user?.messageId, 'u-0');
      expect(after.skip(1), [for (final turn in before.skip(1)) same(turn)]);
      _expectSameTurns(after, groupChatTurns(withPrompt));
    });

    test('matches full grouping across random revisions', () {
      final random = Random(3371);
      var nextId = 0;
      ChatMessage fresh() {
        final id = 'r-${nextId++}';
        return switch (random.nextInt(4)) {
          0 => _user(id),
          1 => _assistant(id),
          2 => _assistant(id, text: 'Answer $id'),
          _ => _assistant(
            id,
            text: 'Live $id',
            status: ChatMessageStatus.streaming,
          ),
        };
      }

      for (var run = 0; run < 20; run++) {
        final groups = IncrementalTurnGroups();
        var messages = <ChatMessage>[];
        for (var step = 0; step < 60; step++) {
          final next = [...messages];
          final at = next.isEmpty ? 0 : random.nextInt(next.length);
          switch (random.nextInt(8)) {
            case 0 || 1 || 2:
              next.add(fresh());
            case 3 when next.isNotEmpty:
              next.last = fresh();
            case 4 when next.isNotEmpty:
              next[at] = fresh();
            case 5:
              next.insertAll(0, [fresh(), fresh()]);
            case 6 when next.isNotEmpty:
              next.removeAt(at);
            case 7 when next.length > 1:
              next.insert(random.nextInt(next.length), next.removeAt(at));
            default:
              next.insert(at, fresh());
          }
          if (random.nextInt(10) == 0) next.clear();
          messages = next;
          _expectSameTurns(groups.update(messages), groupChatTurns(messages));
        }
      }
    });
  });
}
