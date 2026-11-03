import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_command_source.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'main',
);

void main() {
  late List<Map<String, dynamic>> payloads;
  late List<String> types;
  late RemoteComposerCommands commands;
  late bool inventory;
  late String session;
  late int generation;
  Completer<void>? resolveGate;
  Completer<void>? listGate;
  late Map<String, Object?>? selections;
  late List<Map<String, dynamic>> listAnswers;

  setUp(() {
    generation = 1;
    resolveGate = null;
    listGate = null;
    selections = null;
    listAnswers = [];
    payloads = [];
    types = [];
    inventory = false;
    session = 'session-1';
    commands = RemoteComposerCommands(
      sessionId: () => session,
      supportsInvocableInventory: () => inventory,
      submit: ({required type, required target, required payload}) async {
        payloads.add(payload);
        types.add(type);
        if (type == 'portal.editor.resolve_invocable') {
          if (resolveGate case final gate?) await gate.future;
        }
        if (type == 'portal.editor.list_invocables') {
          if (listGate case final gate?) await gate.future;
        }
        return RemotePortalCommandResult(
          commandId: 'c1',
          result: type == 'portal.editor.resolve_invocable'
              ? const {'insertText': '/kit:notes ', 'invocationKey': 'k'}
              : listAnswers.isEmpty
              ? const {'commands': <Object>[]}
              : listAnswers.removeAt(0),
        );
      },
    );
  });

  test('a worktree with no chat and no provider has built-ins only', () {
    final source = remoteComposerCommandSource(
      commands,
      worktree: _worktree,
      chatId: null,
      providerType: null,
      sessionGeneration: () => generation,
      pluginSelections: () => selections,
    );
    expect(source, isNotNull);
    expect(source!.load, isNull);
  });

  test('a worktree with no chat lists commands for a known provider', () async {
    final source = remoteComposerCommandSource(
      commands,
      worktree: _worktree,
      chatId: null,
      providerType: 'claude',
      sessionGeneration: () => generation,
      pluginSelections: () => selections,
    );
    await source!.load!();
    expect(payloads.single, {
      'projectId': 'ws-1',
      'worktreeId': 'wt-1',
      'providerType': 'claude',
    });
  });

  test('a standalone chat without an id has no suggestions', () {
    expect(
      remoteComposerCommandSource(
        commands,
        worktree: null,
        chatId: null,
        providerType: null,
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
      ),
      isNull,
    );
    expect(
      remoteComposerCommandSource(
        commands,
        worktree: null,
        chatId: 'chat-1',
        providerType: 'claude',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
      )?.load,
      isNull,
    );
  });
  group('CAN-3925 with the invocable inventory', () {
    const notes = ComposerCommand(
      name: 'notes',
      entryId: 'entry:skill/notes',
      requiresResolution: true,
      availableToEnable: true,
    );

    setUp(() => inventory = true);

    test('a worktree chat lists and resolves through the inventory', () async {
      final source = remoteComposerCommandSource(
        commands,
        worktree: _worktree,
        chatId: 'chat-1',
        providerType: 'claude',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
      )!;
      await source.load!();
      expect(await source.resolve!(notes), '/kit:notes ');
      expect(types, [
        'portal.editor.list_invocables',
        'portal.editor.resolve_invocable',
      ]);
      const target = {
        'kind': 'worktree',
        'projectId': 'ws-1',
        'worktreeId': 'wt-1',
        'chatId': 'chat-1',
      };
      expect(payloads, [
        {'target': target},
        {'target': target, 'entryId': 'entry:skill/notes'},
      ]);
    });

    test('a projected standalone chat uses its project', () async {
      final source = remoteComposerCommandSource(
        commands,
        worktree: null,
        chatId: 'chat-solo',
        providerType: 'codex',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
        standaloneProjectLocalId: 'ws-notes',
      )!;
      await source.load!();
      expect(payloads.single, {
        'target': {
          'kind': 'standalone',
          'projectLocalId': 'ws-notes',
          'chatId': 'chat-solo',
        },
      });
    });

    // The desktop lists the chat's own harness and rejects another
    // provider, so a model's provider such as Ollama is not sent.
    for (final (name, worktree, project) in [
      ('worktree', _worktree, null),
      ('standalone', null, 'ws-notes'),
    ]) {
      test('an Ollama $name chat lets the desktop pick the provider', () async {
        final source = remoteComposerCommandSource(
          commands,
          worktree: worktree,
          chatId: 'chat-1',
          providerType: 'ollama',
          sessionGeneration: () => generation,
          pluginSelections: () => selections,
          standaloneProjectLocalId: project,
        )!;
        await source.load!();
        expect(await source.resolve!(notes), '/kit:notes ');
        expect(types, [
          'portal.editor.list_invocables',
          'portal.editor.resolve_invocable',
        ]);
        for (final payload in payloads) {
          expect(payload, isNot(contains('providerType')));
        }
      });
    }

    test('a standalone chat not projected yet keeps built-ins only', () {
      final source = remoteComposerCommandSource(
        commands,
        worktree: null,
        chatId: 'chat-new',
        providerType: 'claude',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
      )!;
      expect(source.load, isNull);
      expect(source.resolve, isNull);
    });

    test('a worktree before its first chat keeps the discovery list', () async {
      final source = remoteComposerCommandSource(
        commands,
        worktree: _worktree,
        chatId: null,
        providerType: 'claude',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
      )!;
      expect(source.resolve, isNull);
      await source.load!();
      expect(types.single, 'portal.editor.list_slash_commands');
    });

    test('the scope follows the session, chat, and provider', () {
      Object scope({String chat = 'chat-1', String provider = 'claude'}) =>
          remoteComposerCommandSource(
            commands,
            worktree: _worktree,
            chatId: chat,
            providerType: provider,
            sessionGeneration: () => generation,
            pluginSelections: () => selections,
          )!.scope;
      final first = scope();
      expect(scope(), first);
      expect(scope(chat: 'chat-2'), isNot(first));
      expect(scope(provider: 'codex'), isNot(first));
      session = 'session-2';
      expect(scope(), isNot(first));
      session = 'session-1';
      generation = 2;
      expect(scope(), isNot(first));
      inventory = false;
      expect(scope(), isNot(first));
    });

    test('the rows follow the projected plugin selection', () {
      final revision = remoteComposerCommandSource(
        commands,
        worktree: null,
        chatId: 'chat-solo',
        providerType: 'claude',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
        standaloneProjectLocalId: 'ws-notes',
      )!.revision!;
      final unprojected = revision();
      selections = const {'collectionIds': <Object?>[]};
      final empty = revision();
      expect(empty, isNot(unprojected));
      expect(revision(), empty);
      selections = const {
        'collectionIds': ['c1'],
      };
      expect(revision(), isNot(empty));
    });

    group('a rebuilding inventory', () {
      late TextEditingController draft;
      late ComposerMenuController menu;

      setUp(() {
        draft = TextEditingController();
        menu = ComposerMenuController(draft);
      });

      tearDown(() {
        menu.dispose();
        draft.dispose();
      });

      Map<String, dynamic> answer(
        List<String> names, {
        bool stale = false,
        bool rebuilding = false,
      }) => {
        'commands': [
          for (final name in names) {'name': name, 'section': 'discovered'},
        ],
        'stale': stale,
        'rebuilding': rebuilding,
      };

      // Builds the source again, as each chat screen build does.
      void configure() => menu.configure(
        source: remoteComposerCommandSource(
          commands,
          worktree: _worktree,
          chatId: 'chat-1',
          providerType: 'claude',
          sessionGeneration: () => generation,
          pluginSelections: () => selections,
        ),
        actions: const [],
        enabled: true,
        dollar: false,
      );

      Future<List<String>> open() async {
        draft.value = const TextEditingValue(
          text: '/',
          selection: TextSelection.collapsed(offset: 1),
        );
        configure();
        await pumpEventQueue();
        configure();
        return [
          for (final section in menu.sections)
            for (final entry in section.entries)
              if (entry case ComposerCommandEntry(:final command)) command.name,
        ];
      }

      void close() {
        draft.value = TextEditingValue.empty;
        configure();
      }

      setUp(() {
        configure();
        menu.setFocused(true);
      });

      for (final (name, stale, rebuilding) in [
        ('rebuilding', false, true),
        ('stale', true, false),
      ]) {
        test('a $name answer lists the chat again on the next open', () async {
          listAnswers.addAll([
            answer(const [], stale: stale, rebuilding: rebuilding),
            answer(const ['review']),
          ]);
          expect(await open(), isEmpty);
          // Rebuilds while the list stays open do not poll the desktop.
          configure();
          await pumpEventQueue();
          expect(types, ['portal.editor.list_invocables']);

          close();
          expect(await open(), ['review']);
          expect(types, hasLength(2));
        });
      }

      test(
        'a stale answer keeps its rows until the list opens again',
        () async {
          listAnswers.addAll([
            answer(const ['review'], stale: true, rebuilding: true),
            answer(const ['review', 'notes']),
          ]);
          expect(await open(), ['review']);
          close();
          expect(await open(), ['review', 'notes']);
        },
      );

      test('a stale answer does not poll while the list stays open', () async {
        listAnswers.addAll([
          answer(const ['review'], stale: true),
          answer(const ['review'], stale: true),
        ]);
        expect(await open(), ['review']);
        for (final text in ['/r', '/re', '/']) {
          draft.value = TextEditingValue(
            text: text,
            selection: TextSelection.collapsed(offset: text.length),
          );
          configure();
          await pumpEventQueue();
          configure();
        }
        expect(types, ['portal.editor.list_invocables']);
      });

      test(
        'a plugin selection change lists the chat again while open',
        () async {
          listAnswers.addAll([
            answer(const ['review']),
            answer(const ['review', 'notes']),
          ]);
          expect(await open(), ['review']);
          selections = const {
            'collectionIds': ['c1'],
          };
          configure();
          await pumpEventQueue();
          expect(types, hasLength(2));
          expect(await open(), ['review', 'notes']);
          expect(types, hasLength(2));
        },
      );

      test('a selection change during a list drops its answer', () async {
        listAnswers.addAll([
          answer(const ['review']),
          answer(const ['review', 'notes']),
        ]);
        final gate = listGate = Completer<void>();
        draft.value = const TextEditingValue(
          text: '/',
          selection: TextSelection.collapsed(offset: 1),
        );
        configure();
        expect(types, hasLength(1));
        selections = const {
          'collectionIds': ['c1'],
        };
        configure();
        expect(types, hasLength(2));
        gate.complete();
        expect(await open(), ['review', 'notes']);
        expect(types, hasLength(2));
      });

      test('a current answer is not listed again', () async {
        listAnswers.add(answer(const ['review']));
        expect(await open(), ['review']);
        close();
        expect(await open(), ['review']);
        expect(types, ['portal.editor.list_invocables']);
      });
    });

    test('a resolve answered after a new pairing is dropped', () async {
      final source = remoteComposerCommandSource(
        commands,
        worktree: _worktree,
        chatId: 'chat-1',
        providerType: 'claude',
        sessionGeneration: () => generation,
        pluginSelections: () => selections,
      )!;
      final gate = resolveGate = Completer<void>();
      final resolved = source.resolve!(notes);
      // The server keeps its session id across the pairings.
      generation = 2;
      gate.complete();
      expect(await resolved, isNull);
      expect(types.single, 'portal.editor.resolve_invocable');
    });
  });

  test('an older desktop keeps the discovery list', () async {
    final source = remoteComposerCommandSource(
      commands,
      worktree: _worktree,
      chatId: 'chat-1',
      providerType: 'claude',
      sessionGeneration: () => generation,
      pluginSelections: () => selections,
      standaloneProjectLocalId: 'ignored',
    )!;
    expect(source.resolve, isNull);
    await source.load!();
    expect(types.single, 'portal.editor.list_slash_commands');
  });
}
