// CAN-5208: visual evidence for subagent cards in mobile cloud chats.
//
// What changed: a cloud chat whose agent spawned a subagent showed only the
// spawning `Task` tool row. It now shows an agent card with the subagent's
// type, description and status, and, expanded, its replies, reasoning and
// tools, with a nested subagent inside its parent's card.
//
// Run both stages from `apps/mobile` (the tree must be rebuilt between them):
//
//   git diff origin/develop -- lib > "$TMPDIR/can-5208-lib.patch"
//   git apply -R "$TMPDIR/can-5208-lib.patch"
//   CAN5208_CAPTURE=1 CAN5208_STAGE=before flutter test --no-pub test/capture/can_5208_agent_cards_capture_test.dart --update-goldens
//   git apply "$TMPDIR/can-5208-lib.patch"
//   CAN5208_CAPTURE=1 CAN5208_STAGE=after flutter test --no-pub test/capture/can_5208_agent_cards_capture_test.dart --update-goldens
//
// The chat is a deterministic protocol-v1 bootstrap from the in-memory fake
// repository; no account, agent, or network is involved. Output goes to the
// gitignored `<repo>/.playwright/can-5208/` directory.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:provider/provider.dart';

import '../support/agent_task_fixtures.dart';
import '../support/fake_cloud_chat_repository.dart';

final bool _enabled = Platform.environment['CAN5208_CAPTURE'] == '1';
final String _stage = Platform.environment['CAN5208_STAGE'] == 'before'
    ? 'before'
    : 'after';

String _path(String name, bool dark) =>
    '../../../../.playwright/can-5208/$name-$_stage-${dark ? 'dark' : 'light'}.png';

const _turn = 'turn-source';
const _childTask = 'c2b9d1aa-1f0e-4a52-9a43-3d4c5e6f7a81';

CloudChatBootstrap _bootstrap() => CloudChatBootstrap.fromJson({
  'messages': [
    {
      'id': 'u1',
      'role': 'USER',
      'text': 'Find where the workflow contracts are used.',
      'clientRequestId': 'request-u1',
      'createdAtMs': 1000,
    },
    {
      'id': 'a1',
      'role': 'ASSISTANT',
      'sourceKey': _turn,
      'text': 'The contracts are used by the runner and by Core.',
      'createdAtMs': 2000,
      'contentBlocks': [
        {'type': 'text', 'text': 'I will ask an explorer to map them.'},
        {'type': 'tool_call', 'toolCallId': 'spawn', 'toolName': 'Task'},
        {
          'type': 'text',
          'text': 'The contracts are used by the runner and by Core.',
        },
      ],
    },
    {
      'id': 'c1',
      'role': 'ASSISTANT',
      'sourceKey': agentTaskSourceKey,
      'taskId': agentTaskId,
      'text': '',
      'createdAtMs': 3000,
      'contentBlocks': [
        {'type': 'reasoning', 'text': 'Start from the package index.'},
        {'type': 'tool_call', 'toolCallId': 'child-read', 'toolName': 'Read'},
        {'type': 'tool_call', 'toolCallId': 'nested', 'toolName': 'Task'},
        {
          'type': 'text',
          'text': 'Found 12 modules; the runner imports 9 of them.',
        },
      ],
    },
  ],
  'toolActivity': [
    {
      'kind': 'call',
      'call': {
        'sourceKey': _turn,
        'toolCallId': 'spawn',
        'toolName': 'Task',
        'input':
            '{"subagent_type":"Explore","description":"Map the workflow '
            'contracts","prompt":"List the exported names and their users."}',
        'agentTask': {
          ...agentTaskRow(
            spawnToolCallId: 'spawn',
            status: 'completed',
            stateVersion: '9',
            completedAt: '2026-10-13T10:01:05.500Z',
          ),
          'usage': {'outputTokens': 2400},
        },
      },
    },
    {
      'kind': 'result',
      'result': {
        'sourceKey': _turn,
        'toolCallId': 'spawn',
        'output': 'Found 12 modules; the runner imports 9 of them.',
        'isError': false,
      },
    },
    {
      'kind': 'call',
      'call': {
        'sourceKey': agentTaskSourceKey,
        'toolCallId': 'child-read',
        'toolName': 'Read',
        'input': '{"file_path":"libs/workflow-contracts/src/index.ts"}',
        'taskId': agentTaskId,
      },
    },
    {
      'kind': 'result',
      'result': {
        'sourceKey': agentTaskSourceKey,
        'toolCallId': 'child-read',
        'output': 'export * from "./agent-task";',
        'isError': false,
        'taskId': agentTaskId,
      },
    },
    {
      'kind': 'call',
      'call': {
        'sourceKey': agentTaskSourceKey,
        'toolCallId': 'nested',
        'toolName': 'Task',
        'input':
            '{"subagent_type":"Reviewer","description":"Check the runner '
            'imports"}',
        'taskId': agentTaskId,
        'agentTask': agentTaskRow(
          taskId: _childTask,
          parentTaskId: agentTaskId,
          spawnToolCallId: 'nested',
          status: 'failed',
          summary: null,
          error: {'code': 'failed', 'message': 'The sandbox stopped.'},
          completedAt: '2026-10-13T10:00:40.500Z',
        ),
      },
    },
  ],
});

void main() {
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader('JetBrainsMono')..addFont(
          rootBundle.load(
            'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
          ),
        ))
        .load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    Directory('../../.playwright/can-5208').createSync(recursive: true);
  });

  for (final dark in [false, true]) {
    for (final expanded in [false, true]) {
      final name = expanded ? 'agent-card-expanded' : 'agent-steps';
      testWidgets(
        '$name ${dark ? 'dark' : 'light'}',
        (tester) async {
          tester.view.physicalSize = const Size(390, 844);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.reset);
          final repository = FakeCloudChatRepository(
            workspaces: [
              sampleWorkspace(
                id: 'ws',
                name: 'Workflow',
                chats: [sampleChat(id: 'chat', title: 'Contracts')],
              ),
            ],
          )..bootstraps['chat'] = _bootstrap();
          final list = CloudChatsViewModel(repository: repository);
          final streams = <StreamController<CloudSseFrame>>[];
          final session = CloudChatViewModel(
            repository: repository,
            openStream: (_, {after}) {
              final controller = StreamController<CloudSseFrame>();
              streams.add(controller);
              return controller.stream;
            },
            observeLifecycle: false,
          );
          addTearDown(() async {
            session.dispose();
            list.dispose();
            for (final stream in streams) {
              await stream.close();
            }
          });
          await list.load();
          await tester.pumpWidget(
            MultiProvider(
              providers: [
                ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
                ChangeNotifierProvider<CloudChatViewModel>.value(
                  value: session,
                ),
              ],
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: AppTheme.light,
                darkTheme: AppTheme.dark,
                themeMode: dark ? ThemeMode.dark : ThemeMode.light,
                home: const CloudChatScreen(chatId: 'chat'),
              ),
            ),
          );
          await tester.pump();
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          await tester.tap(find.byKey(const ValueKey('turn-steps-u1')));
          await tester.pump();
          if (expanded) {
            await tester.tap(
              find.byKey(const ValueKey('agent-card-header')).first,
            );
            await tester.pump();
            await tester.tap(
              find.byKey(const ValueKey('agent-card-header')).last,
            );
            await tester.pump();
          }
          await tester.pump(const Duration(milliseconds: 300));
          await expectLater(
            find.byType(CloudChatScreen),
            matchesGoldenFile(_path(name, dark)),
          );
          expect(tester.takeException(), isNull);
        },
        skip: !_enabled || (_stage == 'before' && expanded),
      );
    }
  }
}
