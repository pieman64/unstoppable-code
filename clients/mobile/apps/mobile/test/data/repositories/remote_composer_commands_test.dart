import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

void main() {
  late List<
    ({String type, Map<String, String> target, Map<String, dynamic> payload})
  >
  calls;
  late List<RemotePortalCommandResult Function()> answers;
  late String? session;
  late bool inventory;

  RemoteComposerCommands commands() => RemoteComposerCommands(
    sessionId: () => session,
    supportsInvocableInventory: () => inventory,
    submit: ({required type, required target, required payload}) async {
      calls.add((type: type, target: target, payload: payload));
      return answers.removeAt(0)();
    },
  );

  RemotePortalCommandResult result(Map<String, dynamic>? value) =>
      RemotePortalCommandResult(commandId: 'cmd', result: value);

  setUp(() {
    calls = [];
    answers = [];
    session = 'session-1';
    inventory = false;
  });

  test('asks the desktop for the worktree and provider', () async {
    answers.add(
      () => result({
        'commands': [
          {
            'name': 'review',
            'description': 'Review changes',
            'displayName': 'Review',
            'insertText': '/review ',
            'category': 'project',
          },
          {'name': 'bare'},
        ],
      }),
    );
    final rows = await commands().list(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      providerType: 'claude',
    );
    expect(calls.single.type, 'portal.editor.list_slash_commands');
    expect(calls.single.target, {
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': 'wt-1',
    });
    expect(calls.single.payload, {
      'projectId': 'ws-1',
      'worktreeId': 'wt-1',
      'providerType': 'claude',
    });
    expect(rows.map((row) => row.name), ['review', 'bare']);
    expect(rows.first.displayName, 'Review');
    expect(rows.first.insertText, '/review ');
    expect(rows.first.category, 'project');
    expect(rows.last.description, '');
    expect(rows.last.insertion('/'), '/bare ');
  });

  test('omits an unknown provider', () async {
    answers.add(() => result({'commands': []}));
    final rows = await commands().list(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
    );
    expect(rows, isEmpty);
    expect(calls.single.payload.containsKey('providerType'), isFalse);
  });

  test('caches answers per session, worktree, and provider', () async {
    final source = commands();
    answers.addAll([
      () => result({'commands': []}),
      () => result({'commands': []}),
      () => result({'commands': []}),
    ]);
    Future<void> list(String provider) => source.list(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      providerType: provider,
    );
    await list('claude');
    await list('claude');
    expect(calls, hasLength(1));
    await list('codex');
    expect(calls, hasLength(2));
    session = 'session-2';
    await list('claude');
    expect(calls, hasLength(3));
  });

  test('a failed answer is not cached, so Retry asks again', () async {
    final source = commands();
    answers.addAll([
      () => throw const RemoteControlException('offline'),
      () => result({'commands': []}),
    ]);
    Future<void> list() =>
        source.list(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
    await expectLater(list(), throwsA(isA<RemoteControlException>()));
    await list();
    expect(calls, hasLength(2));
  });

  test('an older desktop or malformed answer fails', () async {
    final source = commands();
    final failures = <RemotePortalCommandResult Function()>[
      () => result(null),
      () => result({'commands': 'nope'}),
      () => result({
        'commands': [
          {'description': 'no name'},
        ],
      }),
      () => result({
        'commands': [
          {'name': 'x', 'insertText': 4},
        ],
      }),
      () => const RemotePortalCommandResult(
        commandId: 'cmd',
        error: 'Unknown command',
      ),
    ];
    answers.addAll(failures);
    for (var i = 0; i < failures.length; i++) {
      await expectLater(
        source.list(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-$i'),
        throwsA(anyOf(isA<FormatException>(), isA<RemoteControlException>())),
      );
    }
  });

  test(
    'CAN-3922 asks for the plugin catalog and caches it per session',
    () async {
      answers.add(
        () => result({
          'plugins': [
            {
              'marketplaceId': 'market',
              'pluginName': 'github',
              'name': 'GitHub',
            },
          ],
        }),
      );
      final first = commands();
      final catalog = await first.pluginCatalog(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        providerType: 'codex',
      );
      expect(catalog.items.single.name, 'GitHub');
      expect(calls.single.type, 'portal.chat.list_plugin_catalog');
      expect(calls.single.target, {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
      });
      expect(calls.single.payload, {
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'providerType': 'codex',
      });
      await first.pluginCatalog(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        providerType: 'codex',
      );
      expect(calls, hasLength(1));
    },
  );

  test('CAN-3922 a failed or empty catalog answer is not cached', () async {
    final plugins = commands();
    answers
      ..add(() => RemotePortalCommandResult(commandId: 'c', error: 'Unknown'))
      ..add(() => result(null))
      ..add(() => result({'plugins': []}));
    Future<void> load() => plugins.pluginCatalog(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
    );
    await expectLater(load(), throwsA(isA<RemoteControlException>()));
    await expectLater(load(), throwsFormatException);
    await load();
    expect(calls, hasLength(3));
  });
  group('CAN-3925 invocable inventory', () {
    const worktreeChat = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );
    const standaloneChat = RemoteStandaloneChatTarget(
      chatId: 'chat-solo',
      projectLocalId: 'ws-notes',
    );

    test('reports the session capability', () {
      final source = commands();
      expect(source.supportsInvocableInventory, isFalse);
      inventory = true;
      expect(source.supportsInvocableInventory, isTrue);
      expect(source.sessionId, 'session-1');
    });

    test('lists a worktree chat with its nested target, uncached', () async {
      final source = commands();
      final rows = {
        'commands': [
          {'name': 'review', 'section': 'discovered'},
          {'name': 'notes', 'section': 'available', 'entryId': 'e:notes'},
        ],
        'stale': false,
        'rebuilding': false,
      };
      answers.addAll([() => result(rows), () => result(rows)]);
      final listed = await source.invocables(worktreeChat);
      expect(listed.commands.map((row) => row.name), ['review', 'notes']);
      expect(calls.single.type, 'portal.editor.list_invocables');
      expect(calls.single.target, {
        'workspaceLocalId': 'ws-1',
        'worktreeLocalId': 'wt-1',
      });
      expect(calls.single.payload, {
        'target': {
          'kind': 'worktree',
          'projectId': 'ws-1',
          'worktreeId': 'wt-1',
          'chatId': 'chat-1',
        },
      });
      // The rows follow the chat's selection, so every open asks again.
      await source.invocables(worktreeChat);
      expect(calls, hasLength(2));
    });

    test('tracks per chat whether the last list was unsettled', () async {
      final source = commands();
      answers.addAll([
        () => result({'commands': [], 'stale': false, 'rebuilding': true}),
        () => result({'commands': [], 'stale': true, 'rebuilding': false}),
        () => result({'commands': [], 'stale': false, 'rebuilding': false}),
      ]);
      expect(source.invocablesUnsettled(worktreeChat), isFalse);
      await source.invocables(worktreeChat);
      expect(source.invocablesUnsettled(worktreeChat), isTrue);
      expect(source.invocablesUnsettled(standaloneChat), isFalse);
      await source.invocables(worktreeChat);
      expect(source.invocablesUnsettled(worktreeChat), isTrue);
      await source.invocables(worktreeChat);
      expect(source.invocablesUnsettled(worktreeChat), isFalse);
    });

    test('lists a standalone chat by project and chat', () async {
      answers.add(() => result({'commands': []}));
      await commands().invocables(standaloneChat);
      expect(calls.single.target, {'standaloneChatLocalId': 'chat-solo'});
      expect(calls.single.payload, {
        'target': {
          'kind': 'standalone',
          'projectLocalId': 'ws-notes',
          'chatId': 'chat-solo',
        },
      });
    });

    test('resolves an entry and returns the desktop text', () async {
      answers.add(
        () => result({
          'insertText': '/kit:notes ',
          'invocationKey': 'kit:notes',
          'pluginSelections': {'collectionIds': <Object?>[]},
        }),
      );
      final text = await commands().resolveInvocable(
        standaloneChat,
        'entry:skill/notes',
      );
      expect(text, '/kit:notes ');
      expect(calls.single.type, 'portal.editor.resolve_invocable');
      expect(calls.single.target, {'standaloneChatLocalId': 'chat-solo'});
      expect(calls.single.payload, {
        'target': {
          'kind': 'standalone',
          'projectLocalId': 'ws-notes',
          'chatId': 'chat-solo',
        },
        'entryId': 'entry:skill/notes',
      });
    });

    test('a rejected, unanswered, or malformed resolve fails', () async {
      final source = commands();
      answers.addAll([
        () => const RemotePortalCommandResult(
          commandId: 'cmd',
          error: 'Could not enable.',
        ),
        () => result(null),
        () => result({'invocationKey': 'kit:notes'}),
      ]);
      await expectLater(
        source.resolveInvocable(worktreeChat, 'e'),
        throwsA(isA<RemoteControlException>()),
      );
      await expectLater(
        source.resolveInvocable(worktreeChat, 'e'),
        throwsFormatException,
      );
      await expectLater(
        source.resolveInvocable(worktreeChat, 'e'),
        throwsFormatException,
      );
    });

    test('a chat the inventory cannot name is not sent', () async {
      final source = commands();
      await expectLater(
        source.invocables(const RemoteStandaloneChatTarget(chatId: 'solo')),
        throwsA(isA<RemoteControlException>()),
      );
      await expectLater(
        source.resolveInvocable(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          'e',
        ),
        throwsA(isA<RemoteControlException>()),
      );
      expect(calls, isEmpty);
    });

    test('asks for a standalone catalog and caches it per session', () async {
      final source = commands();
      answers.addAll([
        () => result({'plugins': <Object?>[]}),
        () => result({'plugins': <Object?>[]}),
      ]);
      Future<void> load() => source.standalonePluginCatalog(
        projectLocalId: 'ws-notes',
        chatId: 'chat-solo',
        providerType: 'claude',
      );
      await load();
      expect(calls.single.type, 'portal.chat.list_plugin_catalog');
      expect(calls.single.target, {'standaloneChatLocalId': 'chat-solo'});
      expect(calls.single.payload, {
        'projectId': 'ws-notes',
        'providerType': 'claude',
      });
      await load();
      expect(calls, hasLength(1));
      session = 'session-2';
      await load();
      expect(calls, hasLength(2));
    });
  });
}
