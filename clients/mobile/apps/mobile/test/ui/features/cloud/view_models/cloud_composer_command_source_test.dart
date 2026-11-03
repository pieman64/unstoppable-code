import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/repositories/cloud_composer_commands.dart';
import 'package:mobile/ui/core/chat/view_models/composer_command_menu.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_composer_command_source.dart';

import '../../../../support/fake_cloud_chat_repository.dart';

const _skillRef = {'sourceId': 'src', 'skillName': 'notes'};
const _review = ComposerCommand(name: 'review');
const _notes = ComposerCommand(name: 'notes');

void main() {
  late FakeCloudChatRepository repository;
  late CloudComposerCommands commands;
  late TextEditingController draft;
  late ComposerMenuController menu;

  setUp(() {
    repository = FakeCloudChatRepository(
      workspaces: [
        sampleWorkspace(
          chats: const [
            CloudChatSummary(
              externalId: 'chat-1',
              title: 'Chat',
              taskChatExternalId: null,
              modelDefinitionId: 'gpt-5.6-luna',
              thinkingLevel: null,
              coreAgentSessionId: 'session-1',
              createdAtMs: 1,
              capabilitySelections: {},
            ),
          ],
        ),
      ],
    );
    repository.invocableRows = const [_review];
    commands = CloudComposerCommands(repository);
    draft = TextEditingController();
    menu = ComposerMenuController(draft);
  });

  tearDown(() {
    menu.dispose();
    draft.dispose();
  });

  // Builds the source again, as each chat screen build does.
  void configure() => menu.configure(
    source: cloudChatCommandSource(
      commands,
      chatId: 'chat-1',
      modelDefinitionId: 'gpt-5.6-luna',
    ),
    actions: const [],
    enabled: true,
    dollar: false,
  );

  List<String> visible() => [
    for (final section in menu.sections)
      for (final entry in section.entries)
        if (entry case ComposerCommandEntry(:final command)) command.name,
  ];

  void open() {
    configure();
    menu.setFocused(true);
    draft.value = const TextEditingValue(
      text: '/',
      selection: TextSelection.collapsed(offset: 1),
    );
  }

  test(
    'a Plugins change lists the chat again while the list is open',
    () async {
      open();
      await pumpEventQueue();
      expect(visible(), ['review']);

      repository.invocableRows = const [_review, _notes];
      expect(await commands.enableForChat('chat-1', _skillRef), isTrue);
      configure();
      await pumpEventQueue();
      expect(repository.invocableCalls, hasLength(2));
      expect(visible(), ['review', 'notes']);
      configure();
      await pumpEventQueue();
      expect(repository.invocableCalls, hasLength(2));
    },
  );

  test('a Plugins change during a list drops its answer', () async {
    final gate = repository.invocablesGate = Completer<void>();
    open();
    expect(repository.invocableCalls, hasLength(1));

    expect(await commands.enableForChat('chat-1', _skillRef), isTrue);
    repository
      ..invocablesGate = null
      ..invocableRows = const [_review, _notes];
    configure();
    await pumpEventQueue();
    expect(repository.invocableCalls, hasLength(2));
    expect(visible(), ['review', 'notes']);

    // The earlier list answers last, for the old selection.
    repository.invocableRows = const [_review];
    gate.complete();
    await pumpEventQueue();
    expect(visible(), ['review', 'notes']);
  });
}
