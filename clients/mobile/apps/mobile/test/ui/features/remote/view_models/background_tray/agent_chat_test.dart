import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/agent_chat.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'fixtures.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';

void main() {
  test('agent viewer resolves the latest matching nested observation only', () {
    final first = nativeAgent(toolUseId: 'native');
    final latest = nativeAgent(toolUseId: 'native', running: false);
    final messages = [
      message([
        first,
        nativeAgent(
          toolUseId: 'outer',
          subBlocks: [
            {'kind': 'agent', 'data': latest.data},
          ],
        ),
        delegate(id: 'native'),
      ]),
    ];
    const target = BackgroundTrayAgentTarget(
      kind: BackgroundTrayAgentTargetKind.claudeNative,
      id: 'native',
    );
    expect(
      backgroundTrayAgentRuns(messages, target).single.part.data,
      same(latest.data),
    );
    expect(
      backgroundTrayAgentRuns(
        messages,
        const BackgroundTrayAgentTarget(
          kind: BackgroundTrayAgentTargetKind.managed,
          id: 'native',
        ),
      ).single.part.data?['delegation'],
      isA<Map<String, dynamic>>(),
    );
    expect(
      backgroundTrayAgentRuns(
        messages,
        const BackgroundTrayAgentTarget(
          kind: BackgroundTrayAgentTargetKind.managed,
          id: 'missing',
        ),
      ),
      isEmpty,
    );
  });

  test(
    'agent transcript keeps text, tools and final result in observed order',
    () {
      final messages = backgroundTrayAgentMessages(
        const ChatPart(
          kind: 'agent',
          data: {
            'delegation': {
              'prompt': 'Review this change',
              'finalText': 'Review complete',
            },
            'subBlocks': [
              {
                'kind': 'text',
                'data': {'text': 'Reading the patch'},
              },
              {
                'kind': 'tool_use',
                'toolFamily': 'read',
                'data': {
                  'toolName': 'Read',
                  'input': '{"file_path":"patch.dart"}',
                },
              },
              {
                'kind': 'text',
                'data': {'text': 'The patch looks good'},
              },
            ],
          },
        ),
      );
      expect(messages.map((m) => m.text), [
        'Review this change',
        'Reading the patch',
        '',
        'The patch looks good',
        'Review complete',
      ]);
      expect(messages[2].parts.single.toolFamily, 'read');
      expect(
        messages.every((m) => m.status == ChatMessageStatus.complete),
        isTrue,
      );
    },
  );
  test(
    'retained authors keep input roles, attribution and their own turns',
    () {
      final messages = backgroundTrayAgentMessages(
        const ChatPart(
          kind: 'agent',
          data: {
            'prompt': 'Initial task',
            'subBlocks': [
              {
                'kind': 'text',
                'data': {'text': 'Initial reply'},
              },
              {
                'kind': 'text',
                'data': {
                  'text': 'Check cancellation',
                  'delegationAuthorKind': 'user',
                  'delegationDelivery': 'follow_up',
                },
              },
              {
                'kind': 'text',
                'data': {
                  'text': 'Focus on retries',
                  'delegationAuthorKind': 'agent',
                  'delegationAuthorDescription': 'Release coordinator',
                },
              },
              {
                'kind': 'text',
                'data': {
                  'text': 'Use the existing test',
                  'delegationAuthorKind': 'user',
                  'delegationDelivery': 'steer',
                },
              },
              {
                'kind': 'text',
                'data': {'text': 'Final reply'},
              },
            ],
          },
        ),
      );
      expect(messages.map((m) => m.role), [
        ChatRole.user,
        ChatRole.assistant,
        ChatRole.user,
        ChatRole.user,
        ChatRole.user,
        ChatRole.assistant,
      ]);
      expect(messages[2].parts.single.data?['delegationDelivery'], 'follow_up');
      expect(
        messages[3].parts.single.data?['delegationAuthorDescription'],
        'Release coordinator',
      );
      expect(messages[4].parts.single.data?['delegationDelivery'], 'steer');
      expect(groupChatTurns(messages).map((t) => t.user?.text), [
        'Initial task',
        'Check cancellation',
        'Focus on retries',
        'Use the existing test',
      ]);
      final waitingForSteeredReply = groupChatTurns(
        messages.take(messages.length - 1).toList(),
      );
      expect(waitingForSteeredReply.last.user?.text, 'Use the existing test');
      expect(waitingForSteeredReply.last.finalMessages, isEmpty);
    },
  );

  for (final managed in [false, true]) {
    test(
      '${managed ? 'managed' : 'native'} final answer is not repeated from retained text',
      () {
        final messages = backgroundTrayAgentMessages(
          ChatPart(
            kind: 'agent',
            data: {
              if (managed)
                'delegation': {
                  'finalText': ' Done again ',
                  'partialText': 'earlier update',
                }
              else
                'result': ' Done again ',
              'subBlocks': [
                {
                  'kind': 'text',
                  'data': {'text': 'Done again'},
                },
              ],
            },
          ),
        );
        expect(messages.map((m) => m.text), ['Done again']);
      },
    );
  }
  test('a retained authored follow-up is the only copy of its run prompt', () {
    final messages = backgroundTrayAgentMessages(
      const ChatPart(
        kind: 'agent',
        data: {
          'delegation': {'prompt': 'Please check retries'},
          'subBlocks': [
            {
              'kind': 'text',
              'data': {
                'text': ' Please check retries ',
                'delegationAuthorKind': 'user',
                'delegationDelivery': 'follow_up',
              },
            },
            {
              'kind': 'text',
              'data': {'text': 'Retries checked'},
            },
          ],
        },
      ),
    );
    expect(messages.map((m) => m.text.trim()), [
      'Please check retries',
      'Retries checked',
    ]);
    expect(messages.first.parts.single.data?['delegationAuthorKind'], 'user');
  });

  test(
    'a folded watcher follows the authored prompt and never exposes host instructions',
    () {
      final messages = backgroundTrayAgentMessages(
        const ChatPart(
          kind: 'agent',
          data: {
            'delegation': {
              'prompt':
                  'Check retries\n\n<system_instruction>private context</system_instruction>\n\n<system_instruction><canopy_watcher_event>{"label":"Checks finished","kind":"delegation_finished"}</canopy_watcher_event></system_instruction>',
            },
            'subBlocks': [
              {
                'kind': 'text',
                'data': {
                  'text': 'Check retries',
                  'delegationAuthorKind': 'user',
                  'delegationDelivery': 'follow_up',
                },
              },
              {
                'kind': 'text',
                'data': {'text': 'Reviewing the results'},
              },
            ],
          },
        ),
      );
      expect(messages.map((m) => m.text), [
        'Check retries',
        'Checks finished',
        'Reviewing the results',
      ]);
      expect(messages[1].watcherFired?.kind, 'Delegate finished');
    },
  );
  test(
    'managed histories keep the latest observation of every run in generation order',
    () {
      ChatPart run(int generation, String reply) => ChatPart(
        kind: 'agent',
        data: {
          'delegation': {
            'delegationId': 'history',
            'runGeneration': generation,
            'prompt': 'Task $generation',
          },
          'subBlocks': [
            {
              'kind': 'text',
              'data': {'text': reply},
            },
          ],
        },
      );
      final runs = backgroundTrayAgentRuns(
        [
          message([run(2, 'Second reply'), run(1, 'Stale first reply')]),
          message([run(1, 'First reply'), delegate(id: 'unrelated')]),
        ],
        const BackgroundTrayAgentTarget(
          kind: BackgroundTrayAgentTargetKind.managed,
          id: 'history',
        ),
      );
      expect(runs.map((run) => run.generation), [1, 2]);
      final messages = [
        for (final run in runs)
          ...backgroundTrayAgentMessages(
            run.part,
            runGeneration: run.generation,
          ),
      ];
      expect(messages.map((m) => m.text), [
        'Task 1',
        'First reply',
        'Task 2',
        'Second reply',
      ]);
      expect(messages.map((m) => m.messageId).toSet().length, messages.length);
    },
  );
  test(
    'native launch receipts and stop messages are not appended as child answers',
    () {
      for (final status in ['running', 'stopped']) {
        final messages = backgroundTrayAgentMessages(
          ChatPart(
            kind: 'agent',
            data: {
              'taskStatus': status,
              'result': 'Background task receipt',
              'subBlocks': [
                {
                  'kind': 'tool_use',
                  'data': {'toolName': 'Read', 'input': '{}'},
                },
              ],
            },
          ),
        );
        expect(messages.where((m) => m.text.isNotEmpty), isEmpty);
      }
      final messages = backgroundTrayAgentMessages(
        const ChatPart(
          kind: 'agent',
          data: {
            'taskStatus': 'completed',
            'result': 'Old launch receipt',
            'subBlocks': [
              {
                'kind': 'text',
                'data': {'text': 'Actual child answer'},
              },
            ],
          },
        ),
      );
      expect(messages.map((m) => m.text), ['Actual child answer']);
    },
  );

  test(
    'a completed native task with only tool rows can answer with its result',
    () {
      final messages = backgroundTrayAgentMessages(
        const ChatPart(
          kind: 'agent',
          data: {
            'taskStatus': 'completed',
            'result': 'Final answer',
            'subBlocks': [
              {
                'kind': 'tool_use',
                'data': {'toolName': 'Read', 'input': '{}'},
              },
            ],
          },
        ),
      );
      expect(messages.last.text, 'Final answer');
    },
  );

  test(
    'authored retained inputs hide provider instructions before prompt matching',
    () {
      final messages = backgroundTrayAgentMessages(
        const ChatPart(
          kind: 'agent',
          data: {
            'delegation': {'prompt': 'Check retries'},
            'subBlocks': [
              {
                'kind': 'text',
                'data': {
                  'text':
                      'Check retries\n<system_instruction>private context</system_instruction>',
                  'delegationAuthorKind': 'user',
                  'delegationDelivery': 'follow_up',
                },
              },
            ],
          },
        ),
      );
      expect(messages.map((m) => m.text), ['Check retries']);
      expect(
        messages.single.parts.single.data?['delegationDelivery'],
        'follow_up',
      );
    },
  );
}
