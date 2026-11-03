import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';

void main() {
  final now = DateTime.utc(2026, 10, 3, 12);

  UnsentRecord record(String id, {DateTime? at, String surface = 'rc'}) =>
      UnsentRecord(
        id: id,
        surface: surface,
        targetKey: 'rc:sa:chat-1',
        text: 'hello $id',
        createdAt: at ?? now,
        status: UnsentStatus.sending,
      );

  group('DraftTarget keys', () {
    test('are stable and distinct per target kind', () {
      expect(const CloudChatDraftTarget('c1').key, 'cloud:chat:c1');
      expect(const CloudNewChatDraftTarget('w1').key, 'cloud:new:w1');
      expect(
        const RemoteWorktreeChatDraftTarget(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          chatId: 'c1',
        ).key,
        'rc:wt:ws/wt/c1',
      );
      expect(
        const RemoteWorktreeChatDraftTarget(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        ).key,
        'rc:wt:ws/wt/-',
      );
      expect(const RemoteStandaloneChatDraftTarget('c1').key, 'rc:sa:c1');
      expect(const RemoteNewChatDraftTarget('ws').key, 'rc:new:ws');
    });

    test('compare by key', () {
      expect(
        const CloudChatDraftTarget('c1'),
        equals(const CloudChatDraftTarget('c1')),
      );
      expect(
        const CloudChatDraftTarget('c1').hashCode,
        const CloudChatDraftTarget('c1').hashCode,
      );
    });
  });

  group('UnsentRecord JSON', () {
    test('round-trips every field', () {
      final original = record('r1').copyWith(
        status: UnsentStatus.notSent,
        error: 'Your desktop is offline.',
        extra: {'chatId': 'chat-1', 'attempts': 2},
      );
      final decoded = UnsentRecord.fromJson(original.toJson());
      expect(decoded, isNotNull);
      expect(decoded!.id, 'r1');
      expect(decoded.status, UnsentStatus.notSent);
      expect(decoded.error, 'Your desktop is offline.');
      expect(decoded.extra, {'chatId': 'chat-1', 'attempts': 2});
      expect(decoded.createdAt, now);
    });

    test('rejects malformed rows instead of throwing', () {
      expect(UnsentRecord.fromJson('nope'), isNull);
      expect(UnsentRecord.fromJson({'id': 'x'}), isNull);
    });
  });

  group('InMemoryChatDraftStore', () {
    test('setDraft stores text and empty text removes it', () {
      final store = InMemoryChatDraftStore(now: () => now);
      const target = CloudChatDraftTarget('c1');
      store.setDraft(target, 'draft');
      expect(store.draftFor(target), 'draft');
      store.setDraft(target, '');
      expect(store.draftFor(target), '');
      expect(store.state.drafts, isEmpty);
    });

    test('moveDraft re-keys without changing text', () {
      final store = InMemoryChatDraftStore(now: () => now);
      store.setDraft(const CloudNewChatDraftTarget('w1'), 'first');
      store.moveDraft(
        const CloudNewChatDraftTarget('w1'),
        const CloudChatDraftTarget('c1'),
      );
      expect(store.draftFor(const CloudNewChatDraftTarget('w1')), '');
      expect(store.draftFor(const CloudChatDraftTarget('c1')), 'first');
    });

    test('putUnsent clears the given draft in the same step', () {
      final store = InMemoryChatDraftStore(now: () => now);
      const target = RemoteStandaloneChatDraftTarget('chat-1');
      store.setDraft(target, 'hello r1');
      store.putUnsent(record('r1'), clearDraft: target);
      expect(store.draftFor(target), '');
      expect(store.unsentById('r1')?.text, 'hello r1');
      expect(store.unsentFor('rc').single.id, 'r1');
      expect(store.unsentFor('cloud'), isEmpty);
    });

    test('prune drops records older than 30 days and caps counts', () {
      final state = ChatDraftState();
      for (var i = 0; i < chatDraftMaxUnsent + 5; i++) {
        state.unsent['r$i'] = record(
          'r$i',
          at: now.subtract(Duration(minutes: i)),
        );
      }
      state.unsent['old'] = record(
        'old',
        at: now.subtract(const Duration(days: 31)),
      );
      state.prune(now);
      expect(state.unsent.length, chatDraftMaxUnsent);
      expect(state.unsent.containsKey('old'), isFalse);
      // Newest survive: r0 is the newest.
      expect(state.unsent.containsKey('r0'), isTrue);
      expect(state.unsent.containsKey('r104'), isFalse);
    });

    test('state JSON round-trips and rejects unknown versions', () {
      final state = ChatDraftState()
        ..drafts['cloud:chat:c1'] = (text: 'x', updatedAt: now)
        ..unsent['r1'] = record('r1');
      final decoded = ChatDraftState.fromJson(state.toJson());
      expect(decoded, isNotNull);
      expect(decoded!.drafts['cloud:chat:c1']?.text, 'x');
      expect(decoded.unsent['r1']?.text, 'hello r1');
      expect(ChatDraftState.fromJson({'v': 99}), isNull);
    });
  });

  group('draft capability selections', () {
    const target = CloudNewChatDraftTarget('w1');
    const selections = <String, Object?>{
      'collectionIds': <Object?>[],
      'skillRefs': [
        {'sourceId': 'src', 'skillName': 'notes'},
      ],
      'pluginRefs': <Object?>[],
    };

    test('survive the file round trip with their draft', () {
      final store = InMemoryChatDraftStore(now: () => now)
        ..setDraft(target, '/notes ')
        ..setDraftSelections(target, selections);
      final decoded = ChatDraftState.fromJson(
        jsonDecode(jsonEncode(store.state.toJson())),
      )!;
      final restored = ChatDraftStateStore(state: decoded, now: () => now);
      expect(restored.draftFor(target), '/notes ');
      expect(restored.draftSelectionsFor(target), selections);
      restored.setDraft(target, '/notes summarize');
      expect(restored.draftSelectionsFor(target), selections);
    });

    test('a file written before selections still loads', () {
      final decoded = ChatDraftState.fromJson({
        'v': chatDraftEnvelopeVersion,
        'drafts': {
          target.key: {'text': 'hi', 'updatedAt': now.toIso8601String()},
        },
      })!;
      final store = ChatDraftStateStore(state: decoded);
      expect(store.draftFor(target), 'hi');
      expect(store.draftSelectionsFor(target), isNull);
      expect(decoded.toJson().containsKey('draftSelections'), isFalse);
    });

    test('go with the draft text when it is cleared or sent', () {
      final store = InMemoryChatDraftStore(now: () => now)
        ..setDraft(target, '/notes ')
        ..setDraftSelections(target, selections)
        ..setDraft(target, '');
      expect(store.draftSelectionsFor(target), isNull);

      store
        ..setDraft(target, '/notes ')
        ..setDraftSelections(target, selections)
        ..putUnsent(record('r1'), clearDraft: target);
      expect(store.draftSelectionsFor(target), isNull);
    });

    test('CAN-3922 a selection chosen before typing stays when the text is '
        'cleared, and goes when the draft is sent', () {
      // Running /plugins consumes its token, which clears a draft that
      // held only the token.
      final store = InMemoryChatDraftStore(now: () => now)
        ..setDraftSelections(target, selections)
        ..setDraft(target, '/plugins')
        ..setDraft(target, '');
      expect(store.draftSelectionsFor(target), selections);

      // A choice made while the draft has text goes with that text.
      final withText = {
        ...selections,
        'collectionIds': ['kit'],
      };
      store
        ..setDraft(target, 'hi')
        ..setDraftSelections(target, withText)
        ..setDraft(target, '');
      expect(store.draftSelectionsFor(target), isNull);

      const other = CloudNewChatDraftTarget('w2');
      store
        ..setDraftSelections(target, selections)
        ..setDraft(target, 'ship it')
        ..moveDraft(target, other)
        ..setDraft(other, '');
      expect(store.draftSelectionsFor(other), selections);

      store
        ..setDraft(other, 'ship it')
        ..putUnsent(record('r1'), clearDraft: other)
        ..setDraft(other, '/plugins')
        ..setDraft(other, '');
      expect(store.draftSelectionsFor(other), isNull);
    });

    test('move with their draft and are pruned without one', () {
      const other = CloudNewChatDraftTarget('w2');
      final store = InMemoryChatDraftStore(now: () => now)
        ..setDraft(target, '/notes ')
        ..setDraftSelections(target, selections)
        ..moveDraft(target, other);
      expect(store.draftSelectionsFor(target), isNull);
      expect(store.draftSelectionsFor(other), selections);

      store.state.prune(now.add(chatDraftMaxAge + const Duration(days: 1)));
      expect(store.draftSelectionsFor(other), isNull);
    });

    test('CAN-3922 a selection chosen before typing survives a write and '
        'is saved once the draft has text', () {
      final store = InMemoryChatDraftStore(now: () => now)
        ..setDraftSelections(target, selections);
      // A debounced write prunes the state before encoding it.
      store.state.prune(now);
      expect(store.draftSelectionsFor(target), selections);
      expect(store.state.toJson().containsKey('draftSelections'), isFalse);

      store.setDraft(target, 'summarize the week');
      store.state.prune(now);
      final decoded = ChatDraftState.fromJson(
        jsonDecode(jsonEncode(store.state.toJson())),
      )!;
      expect(
        ChatDraftStateStore(state: decoded).draftSelectionsFor(target),
        selections,
      );
    });

    test('CAN-3922 seeded sequences keep selections with their drafts', () {
      for (var seed = 0; seed < 200; seed++) {
        final random = Random(seed);
        var clock = now;
        ChatDraftStateStore store = InMemoryChatDraftStore(now: () => clock);
        const targets = [
          CloudNewChatDraftTarget('w1'),
          CloudNewChatDraftTarget('w2'),
        ];
        // What each key's selection must be: set by a choice, dropped with
        // the draft text it was chosen with, pruned with its draft, and
        // never written without one. A choice made before typing outlives
        // cleared text until the draft goes; only memory knows it was.
        final expected = <String, Map<String, Object?>>{};
        final beforeText = <String>{};
        final steps = <String>[];
        for (var step = 0; step < 40; step++) {
          final target = targets[random.nextInt(targets.length)];
          final key = target.key;
          switch (random.nextInt(7)) {
            case 0:
              final choice = {
                ...selections,
                'collectionIds': ['c$step'],
              };
              if (store.draftFor(target).isEmpty) {
                beforeText.add(key);
              } else {
                beforeText.remove(key);
              }
              store.setDraftSelections(target, choice);
              expected[key] = choice;
              steps.add('select $key');
            case 1:
              store.setDraft(target, 'text $step');
              steps.add('type $key');
            case 2:
              if (store.draftFor(target).isNotEmpty &&
                  !beforeText.contains(key)) {
                expected.remove(key);
              }
              store.setDraft(target, '');
              steps.add('clear $key');
            case 6:
              // Running /plugins in an empty draft: its token is typed, then
              // consumed. The selection never changes.
              if (store.draftFor(target).isNotEmpty) continue;
              store
                ..setDraft(target, '/plugins')
                ..setDraft(target, '');
              steps.add('run /plugins $key');
            case 3:
              store.state.prune(clock);
              steps.add('prune');
            case 4:
              clock = clock.add(const Duration(days: 31));
              final aged = {
                for (final t in targets)
                  if (store.draftFor(t).isNotEmpty) t.key,
              };
              store.state.prune(clock);
              expected.removeWhere((k, _) => aged.contains(k));
              beforeText.removeWhere(aged.contains);
              steps.add('age');
            case 5:
              final json = jsonDecode(jsonEncode(store.state.toJson()));
              expect(
                ((json as Map)['draftSelections'] as Map? ?? {}).keys.every(
                  (k) => (json['drafts'] as Map).containsKey(k),
                ),
                isTrue,
                reason: 'seed $seed: $steps',
              );
              store = ChatDraftStateStore(
                state: ChatDraftState.fromJson(json)!,
                now: () => clock,
              );
              expected.removeWhere((k, _) => store.state.drafts[k] == null);
              beforeText.clear();
              steps.add('reopen');
          }
          for (final t in targets) {
            expect(
              store.draftSelectionsFor(t),
              expected[t.key],
              reason: 'seed $seed: $steps',
            );
          }
        }
      }
    });
  });

  // CAN-2872.
  group('adoptGuestDrafts', () {
    test('copies the guest cloud drafts and keeps the account own', () async {
      final guest = InMemoryChatDraftStore();
      final account = InMemoryChatDraftStore();
      guest
        ..setDraft(const CloudChatDraftTarget('chat-1'), 'guest draft')
        ..setDraftSelections(const CloudChatDraftTarget('chat-1'), {'a': 1})
        ..setDraft(const CloudNewChatDraftTarget('ws-1'), 'new chat draft')
        ..setDraft(const CloudChatDraftTarget('chat-2'), 'guest loses')
        ..setDraft(const RemoteStandaloneChatDraftTarget('r-1'), 'remote');
      account.setDraft(const CloudChatDraftTarget('chat-2'), 'account wins');

      await account.adoptGuestDrafts(guest);

      expect(
        account.draftFor(const CloudChatDraftTarget('chat-1')),
        'guest draft',
      );
      expect(account.draftSelectionsFor(const CloudChatDraftTarget('chat-1')), {
        'a': 1,
      });
      expect(
        account.draftFor(const CloudNewChatDraftTarget('ws-1')),
        'new chat draft',
      );
      expect(
        account.draftFor(const CloudChatDraftTarget('chat-2')),
        'account wins',
      );
      expect(
        account.draftFor(const RemoteStandaloneChatDraftTarget('r-1')),
        '',
      );
      expect(guest.state.drafts, isNotEmpty);
      expect(guest.state.draftSelections, isNotEmpty);
    });
  });
}
