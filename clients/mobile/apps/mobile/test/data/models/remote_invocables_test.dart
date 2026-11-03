import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_invocables.dart';

void main() {
  group('remoteInvocableTarget', () {
    test('names a worktree chat by workspace, worktree, and chat', () {
      final wire = remoteInvocableTarget(
        const RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-1',
        ),
      );
      expect(wire?.envelope, {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
      });
      expect(wire?.target, {
        'kind': 'worktree',
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
      });
    });

    test('names a standalone chat by project and chat', () {
      final wire = remoteInvocableTarget(
        const RemoteStandaloneChatTarget(
          chatId: 'chat-solo',
          projectLocalId: 'ws-notes',
        ),
      );
      expect(wire?.envelope, {'standaloneChatLocalId': 'chat-solo'});
      expect(wire?.target, {
        'kind': 'standalone',
        'projectLocalId': 'ws-notes',
        'chatId': 'chat-solo',
      });
    });

    test('names no chat without its id or project', () {
      for (final chat in const <RemoteChatTarget>[
        RemoteWorktreeChatTarget(workspaceLocalId: 'ws', worktreeLocalId: 'wt'),
        RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          chatId: '',
        ),
        RemoteStandaloneChatTarget(chatId: 'chat-solo'),
        RemoteStandaloneChatTarget(chatId: 'chat-solo', projectLocalId: ''),
      ]) {
        expect(remoteInvocableTarget(chat), isNull);
      }
    });
  });

  group('parseRemoteInvocables', () {
    test('keeps host order, sections, and opaque ids', () {
      final rows = parseRemoteInvocables({
        'commands': [
          {
            'name': 'review',
            'description': 'Review the diff',
            'displayName': 'Review',
            'insertText': '/review ',
            'category': 'project',
            'section': 'discovered',
          },
          {
            'name': 'compat',
            'section': 'discovered',
            'entryId': 'entry:codex/compat?x=1',
            'requiresResolution': true,
          },
          {
            'name': 'notes',
            'section': 'available',
            'entryId': 'entry:skill/notes',
          },
          {
            'name': 'notes',
            'section': 'available',
            'entryId': 'entry:other/notes',
            'requiresResolution': true,
          },
        ],
        'stale': true,
        'rebuilding': false,
      });
      expect(rows.stale, isTrue);
      expect(rows.rebuilding, isFalse);
      expect(rows.commands.map((row) => row.name), [
        'review',
        'compat',
        'notes',
        'notes',
      ]);
      final [review, compat, notes, otherNotes] = rows.commands;
      expect(review.displayName, 'Review');
      expect(review.insertText, '/review ');
      expect(review.category, 'project');
      expect(review.requiresResolution, isFalse);
      expect(review.availableToEnable, isFalse);
      expect(compat.entryId, 'entry:codex/compat?x=1');
      expect(compat.requiresResolution, isTrue);
      expect(compat.availableToEnable, isFalse);
      // Available rows always resolve, even without the flag.
      expect(notes.requiresResolution, isTrue);
      expect(notes.availableToEnable, isTrue);
      expect(notes.needsEnable, isFalse);
      expect(otherNotes.entryId, 'entry:other/notes');
    });

    test('reports a stale or rebuilding inventory', () {
      final current = parseRemoteInvocables({'commands': <Object>[]});
      expect((current.stale, current.rebuilding), (false, false));
      final rebuilding = parseRemoteInvocables({
        'commands': <Object>[],
        'stale': true,
        'rebuilding': true,
      });
      expect((rebuilding.stale, rebuilding.rebuilding), (true, true));
      for (final flags in [
        {'stale': 'yes'},
        {'rebuilding': 1},
      ]) {
        expect(
          () => parseRemoteInvocables({'commands': <Object>[], ...flags}),
          throwsFormatException,
          reason: '$flags',
        );
      }
    });

    test('rejects an absent or malformed answer', () {
      for (final result in <Map<String, dynamic>?>[
        null,
        {'commands': 'nope'},
        {
          'commands': [
            {'name': 'review'},
          ],
        },
        {
          'commands': [
            {'name': 'review', 'section': 'other'},
          ],
        },
        {
          'commands': [
            {'name': '', 'section': 'discovered'},
          ],
        },
        {
          'commands': [
            {'name': 'notes', 'section': 'available'},
          ],
        },
        {
          'commands': [
            {
              'name': 'review',
              'section': 'discovered',
              'requiresResolution': 'yes',
            },
          ],
        },
        {
          'commands': [
            {'name': 'review', 'section': 'discovered', 'description': 3},
          ],
        },
        {
          'commands': ['review'],
        },
      ]) {
        expect(
          () => parseRemoteInvocables(result),
          throwsFormatException,
          reason: '$result',
        );
      }
    });
  });

  test('parseRemoteInvocableInsertText requires the returned text', () {
    expect(
      parseRemoteInvocableInsertText({
        'insertText': '/kit:notes ',
        'invocationKey': 'kit:notes',
      }),
      '/kit:notes ',
    );
    for (final result in <Map<String, dynamic>?>[
      null,
      {'invocationKey': 'kit:notes'},
      {'insertText': ''},
      {'insertText': 3},
    ]) {
      expect(
        () => parseRemoteInvocableInsertText(result),
        throwsFormatException,
      );
    }
  });

  group('parseRemoteInvocables identities', () {
    test('maps optional plugin and member identities', () {
      final list = parseRemoteInvocables({
        'commands': [
          {
            'name': 'review',
            'pluginName': 'code-review',
            'memberName': 'review/deep:thing',
            'insertText': '/review ',
            'section': 'available',
            'entryId': 'entry-1',
          },
          {'name': 'legacy', 'section': 'discovered'},
        ],
      });
      final [plugin, legacy] = list.commands;
      expect(plugin.pluginName, 'code-review');
      expect(plugin.memberName, 'review/deep:thing');
      expect(plugin.requiresResolution, isTrue);
      expect(legacy.pluginName, isNull);
      expect(legacy.memberName, isNull);
    });

    test('rejects blank or non-string identities', () {
      for (final (key, value) in [
        ('pluginName', ' '),
        ('memberName', false),
        ('pluginName', null),
        ('memberName', null),
      ]) {
        expect(
          () => parseRemoteInvocables({
            'commands': [
              {'name': 'review', 'section': 'discovered', key: value},
            ],
          }),
          throwsFormatException,
          reason: '$key=$value',
        );
      }
    });
  });
}
