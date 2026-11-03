// Seeded sequences for a Cloud chat plugins sheet: the server can keep a
// ref it cannot use, a write can fail in transport, a server can become
// usable again, and the sheet can reopen.
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/repositories/cloud_composer_commands.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_composer_plugins_source.dart';

import '../../../../support/fake_cloud_chat_repository.dart';

const _items = [
  ComposerPluginItem(
    kind: ComposerPluginKind.skill,
    ref: {'sourceId': 'src', 'skillName': 'notes'},
    name: 'Notes',
  ),
  ComposerPluginItem(
    kind: ComposerPluginKind.plugin,
    ref: {'marketplaceId': 'mk', 'pluginName': 'deploy'},
    name: 'Deploy',
  ),
  ComposerPluginItem(
    kind: ComposerPluginKind.mcpServer,
    ref: {'serverId': 'linear', 'configId': 'default'},
    name: 'Linear',
  ),
];

Map<String, Object?> _selection(Set<int> on) => {
  for (final kind in [
    ComposerPluginKind.skill,
    ComposerPluginKind.plugin,
    ComposerPluginKind.mcpServer,
  ])
    kind.selectionKey: [
      for (final index in on)
        if (_items[index].kind == kind) _items[index].ref,
    ],
};

CloudWorkspaceSummary _workspace(Map<String, Object?>? selections) =>
    sampleWorkspace(
      chats: [
        CloudChatSummary(
          externalId: 'chat-1',
          title: 'Chat',
          taskChatExternalId: null,
          modelDefinitionId: 'gpt-5.6-luna',
          thinkingLevel: null,
          coreAgentSessionId: 'session-1',
          createdAtMs: 1,
          capabilitySelections: selections,
        ),
      ],
    );

void main() {
  test('CAN-3922 turning off the last inherited default keeps it off for the '
      'next toggle and after reopening', () async {
    final notes = _items[0];
    final deploy = _items[1];
    // A chat without a bundle that inherits Deploy from its project.
    final repository = FakeCloudChatRepository(
      workspaces: [
        _workspace(_selection({1})),
      ],
    )..capabilityCatalogValue = const ComposerPluginCatalog(items: _items);
    repository.capabilitiesAnswer = (selections) {
      if (!pluginSelectionsContain(selections, notes) &&
          !pluginSelectionsContain(selections, deploy)) {
        // The route's answer for an empty selection on a chat with no
        // bundle: nothing to stage, and no capabilitySelections.
        repository.workspaces = [_workspace(null)];
        return CloudCapabilityWriteResult.fromJson({
          'capabilityBundles': <String, Object?>{},
          'capabilityBundleStateVersion': 1,
          'outcome': 'unchanged',
          'warnings': <Object?>[],
        });
      }
      repository.workspaces = [_workspace(selections)];
      return CloudCapabilityWriteResult(selections: selections);
    };
    final commands = CloudComposerCommands(repository);
    ComposerPluginsController open() => ComposerPluginsController(
      cloudChatPluginsSource(
        commands,
        chatId: 'chat-1',
        workspaceId: 'ws-1',
        summarySelections: null,
        harness: null,
      ),
    );

    var sheet = open();
    await pumpEventQueue();
    expect(sheet.isSelected(deploy), isTrue);

    await sheet.toggle(deploy);
    expect(sheet.errorFor(deploy), isNull);
    expect(sheet.isSelected(deploy), isFalse);

    await sheet.toggle(notes);
    expect(sheet.errorFor(notes), isNull);
    expect(
      pluginSelectionsContain(
        repository.capabilityCalls.last.selections,
        deploy,
      ),
      isFalse,
    );
    expect(sheet.isSelected(notes), isTrue);
    expect(sheet.isSelected(deploy), isFalse);

    sheet.dispose();
    sheet = open();
    await pumpEventQueue();
    expect(sheet.status, ComposerPluginsStatus.ready);
    expect(sheet.isSelected(notes), isTrue);
    expect(sheet.isSelected(deploy), isFalse);
    sheet.dispose();
  });

  test('CAN-3922 seeded sequences show a row on only when the chat can use '
      'it', () async {
    for (var seed = 0; seed < 50; seed++) {
      final random = Random(seed);
      // What the server holds, which items it cannot use, and the sheet.
      var server = <int>{};
      final unusable = <int>{};
      var shown = <int>{};
      var failTransport = false;
      final repository = FakeCloudChatRepository(
        workspaces: [_workspace(_selection(server))],
      )..capabilityCatalogValue = const ComposerPluginCatalog(items: _items);
      repository.capabilitiesAnswer = (selections) {
        if (failTransport) {
          throw const CloudApiException(statusCode: 503, message: 'down');
        }
        // The server keeps every ref and reports the ones it cannot use.
        server = {
          for (var index = 0; index < _items.length; index++)
            if (pluginSelectionsContain(selections, _items[index])) index,
        };
        repository.workspaces = [_workspace(selections)];
        return CloudCapabilityWriteResult(
          selections: selections,
          unusableRefs: [
            for (final index in server.intersection(unusable))
              _items[index].ref,
          ],
        );
      };
      final commands = CloudComposerCommands(repository);
      ComposerPluginsController open() => ComposerPluginsController(
        cloudChatPluginsSource(
          commands,
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          summarySelections: null,
          harness: null,
        ),
      );
      var sheet = open();
      await pumpEventQueue();
      final steps = <String>[];
      for (var step = 0; step < 30; step++) {
        final index = random.nextInt(_items.length);
        var failed = false;
        switch (random.nextInt(5)) {
          case 0:
            unusable.contains(index)
                ? unusable.remove(index)
                : unusable.add(index);
            steps.add('${unusable.contains(index) ? 'break' : 'fix'} $index');
            continue;
          case 1:
            sheet.dispose();
            sheet = open();
            await pumpEventQueue();
            shown = {...server};
            steps.add('reopen');
          case final choice:
            failTransport = choice == 2;
            final turningOn = !shown.contains(index);
            await sheet.toggle(_items[index]);
            failTransport = false;
            failed = choice == 2 || (turningOn && unusable.contains(index));
            if (!failed) {
              shown = turningOn
                  ? {...shown, index}
                  : ({...shown}..remove(index));
            }
            steps.add(
              '${choice == 2 ? 'drop ' : ''}toggle $index '
              '${failed ? 'fails' : 'takes'}',
            );
        }
        final reason = 'seed $seed: $steps';
        expect(sheet.status, ComposerPluginsStatus.ready, reason: reason);
        expect(
          {
            for (var i = 0; i < _items.length; i++)
              if (sheet.isSelected(_items[i])) i,
          },
          shown,
          reason: reason,
        );
        // Only the row that just failed reports it.
        expect(
          {
            for (var i = 0; i < _items.length; i++)
              if (sheet.errorFor(_items[i]) != null) i,
          },
          failed ? {index} : <int>{},
          reason: reason,
        );
      }
      sheet.dispose();
    }
  });
}
