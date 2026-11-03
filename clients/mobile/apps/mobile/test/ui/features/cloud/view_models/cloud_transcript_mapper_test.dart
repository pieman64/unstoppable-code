// Transliterated from web core-event-mapper and cloud-snapshot Jest suites.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_transcript_mapper.dart';

void main() {
  late CloudTranscriptMapper mapper;
  void feed(String event, Map<String, dynamic> data, [String? id]) =>
      mapper.apply(parseCloudWireFrame(event, data), eventId: id);
  void start([String key = 'turn']) =>
      feed('message.start', {'role': 'assistant', 'sourceKey': key});
  void text(String text, [String? id]) =>
      feed('message.delta', {'textDelta': text}, id);
  void call([String? id = 'tool', String name = 'read_file']) =>
      feed('tool.call', {
        'toolCallId': id,
        'toolName': name,
        'args': {'path': 'a'},
      });
  void result([String id = 'tool']) =>
      feed('tool.result', {'toolCallId': id, 'result': 'ok'});
  List<ChatPart> parts() => mapper.messages.expand((m) => m.parts).toList();
  setUp(() {
    mapper = CloudTranscriptMapper(
      chatId: 'chat',
      now: () => DateTime.fromMillisecondsSinceEpoch(1000),
    );
  });

  test(
    'splits text and tools into ordered stable rows and pins reasoning first',
    () {
      start();
      text('Before');
      call();
      text('After');
      feed('message.reasoning', {'reasoningDelta': 'Think'});
      result();
      expect(mapper.messages.map((m) => m.text), ['Before', '', 'After']);
      expect(mapper.messages.map((m) => m.messageId), [
        'cloud:chat:turn:1:0',
        'cloud:chat:turn:1:1',
        'cloud:chat:turn:1:2',
      ]);
      expect(mapper.messages.first.parts.single.thinkingText, 'Think');
      expect(mapper.messages[1].parts.single.data?['result'], {
        'toolUseId': 'tool',
        'output': 'ok',
        'isError': false,
      });
      feed('message.finish', {
        'sourceKey': 'turn',
        'finalMessage': {'content': 'Before\n\nAfter'},
        'model': 'm',
        'usage': {'inputTokens': 3},
      });
      expect(mapper.messages.map((m) => m.text), ['Before', '', 'After']);
      expect(mapper.messages.last.status, ChatMessageStatus.complete);
      expect(mapper.messages.last.model, {'id': 'm'});
      expect(mapper.messages.last.usage, {'inputTokens': 3});
      expect(mapper.messages.last.cost.kind, CloudCoreCostKind.pending);
      expect(mapper.turnInProgress, false);
    },
  );
  test(
    'result before call collapses at its original step after text transition',
    () {
      start();
      result();
      text('After');
      call();
      expect(mapper.messages, hasLength(2));
      expect(parts().where((p) => p.kind == 'tool_result'), isEmpty);
      expect(mapper.messages.first.parts.single.data?['result'], isNotNull);
      expect(mapper.messages.last.text, 'After');
    },
  );
  test('collapsing an earlier orphan preserves later result correlation', () {
    start();
    result('a');
    call('b');
    call('a');
    result('b');
    expect(parts().map((p) => p.toolUseId), ['b', 'a']);
    expect(parts().every((p) => p.data?['result'] != null), true);
  });
  test(
    'replays do not duplicate calls, results, text, reasoning or starts',
    () {
      start();
      text('A', '1');
      text('A', '1');
      text('A', '2');
      call();
      result();
      call();
      result();
      feed('message.reasoning', {'delta': 'R'}, '3');
      feed('message.reasoning', {'delta': 'R'}, '3');
      start();
      expect(mapper.messages.first.text, 'AA');
      expect(
        parts().where((p) => p.kind == 'thinking').single.thinkingText,
        'R',
      );
      expect(parts().where((p) => p.kind == 'tool_use'), hasLength(1));
      feed('message.finish', {'sourceKey': 'turn'}, '4');
      final ids = mapper.messages.map((m) => m.messageId).toList();
      start();
      text('A', '1');
      feed('message.finish', {'sourceKey': 'turn'}, '4');
      expect(mapper.messages.map((m) => m.messageId), ids);
      expect(mapper.turnInProgress, false);
    },
  );
  test('id-less calls remain distinct unless their SSE id is replayed', () {
    start();
    for (final id in ['1', '1', '2']) {
      feed('tool.call', {'toolName': 'read'}, id);
    }
    call(null);
    call(null);
    expect(parts(), hasLength(4));
    // The shared feed uses a per-part index only when toolUseId is null.
    // Empty-string ids would give every id-less row the same widget key.
    expect(parts().every((part) => part.toolUseId == null), true);
  });
  test('artifacts dedupe by tuple and survive terminal reconciliation', () {
    start();
    call();
    for (final index in [0, 0, 1]) {
      feed('artifact.created', {
        'toolCallId': 'tool',
        'artifactIndex': index,
        'payload': {'filename': 'a', 'content': 'body'},
      });
    }
    feed('message.finish', {
      'sourceKey': 'turn',
      'finalMessage': {'content': 'Answer'},
      'thinking': {
        'reasoningTextAvailable': true,
        'reasoningText': 'Done thinking',
      },
    });
    expect(parts().where((p) => p.kind == 'attachment'), hasLength(2));
    expect(parts().first.thinkingText, 'Done thinking');
    expect(mapper.messages.last.text, 'Answer');
  });
  test(
    'finish-only, missing final text and interrupted turns keep real output',
    () {
      feed('message.finish', {
        'sourceKey': 'one',
        'finalMessage': {'content': 'Only finish'},
      });
      expect(mapper.messages.single.text, 'Only finish');
      start('two');
      text('partial');
      feed('message.finish', {
        'sourceKey': 'two',
        'finishReason': 'interrupted',
        'finalMessage': {'content': 'fallback'},
      });
      expect(mapper.messages.last.text, 'partial');
      expect(mapper.messages.last.status, ChatMessageStatus.cancelled);
      start('three');
      text('keep');
      feed('message.finish', {'sourceKey': 'three'});
      expect(mapper.messages.last.text, 'keep');
    },
  );
  test('terminal reconciliation never emits an empty tail after tools', () {
    start();
    text('Before');
    call();
    feed('message.finish', {
      'sourceKey': 'turn',
      'finalMessage': {'content': 'Before'},
    });
    expect(mapper.messages, hasLength(2));
    expect(mapper.messages.last.parts.single.kind, 'tool_use');
    expect(mapper.messages.last.status, ChatMessageStatus.complete);
  });
  test('stale source keys cannot mutate or finish the current turn', () {
    start('new');
    text('new');
    feed('message.delta', {'sourceKey': 'old', 'textDelta': 'old'});
    feed('message.finish', {'sourceKey': 'old'});
    expect(mapper.terminalDisposition, 'stale');
    expect(mapper.messages.single.text, 'new');
    expect(mapper.turnInProgress, true);
  });
  test('mid-turn resume and tools before start preserve the original row', () {
    call();
    final id = mapper.messages.single.messageId;
    start();
    feed('message.reasoning', {'sourceKey': 'turn', 'delta': 'R'});
    result();
    expect(mapper.messages.single.messageId, id);
    expect(parts().first.thinkingText, 'R');
  });
  test('explicit source-less start is not adopted by a later sourced turn', () {
    feed('message.start', {'role': 'assistant'}, 'source-less-start');
    text('First');
    start('second');
    text('Second');
    expect(mapper.messages.map((m) => m.text), ['First', 'Second']);
    expect(mapper.messages.first.status, ChatMessageStatus.complete);
    expect(mapper.messages.last.sourceKey, 'second');
  });
  test('distinct source-less starts create separate assistant turns', () {
    feed('message.start', {'role': 'assistant'}, 'first-start');
    text('First');
    feed('message.start', {'role': 'assistant'}, 'second-start');
    text('Second');

    expect(mapper.messages.map((m) => m.text), ['First', 'Second']);
    expect(mapper.messages.first.status, ChatMessageStatus.complete);
    expect(mapper.messages.last.status, ChatMessageStatus.streaming);
  });
  test(
    'a superseded source remains settled after its replacement finishes',
    () {
      start('old');
      text('Old');
      start('new');
      text('New');
      feed('message.finish', {'sourceKey': 'new'});
      final ids = mapper.messages.map((m) => m.messageId).toList();

      feed('message.finish', {
        'sourceKey': 'old',
        'finalMessage': {'content': 'Late old output'},
      });

      expect(mapper.terminalDisposition, 'stale');
      expect(mapper.messages.map((m) => m.messageId), ids);
      expect(mapper.messages.map((m) => m.text), ['Old', 'New']);
    },
  );
  test('errors wait for finish, trailing error enriches same failed row', () {
    start();
    text('partial');
    feed('error', {'message': 'failed'});
    expect(mapper.turnInProgress, true);
    feed('message.finish', {
      'sourceKey': 'turn',
      'finishReason': 'error',
      'finalMessage': {'content': 'safe'},
    });
    final id = mapper.messages.last.messageId;
    feed('error', {'errorCode': 'E', 'errorMessage': 'details'});
    expect(mapper.messages.last.messageId, id);
    expect(mapper.messages.last.text, 'safe');
    expect(mapper.messages.last.errorCode, 'E');
    expect(mapper.messages.last.status, ChatMessageStatus.failed);
  });
  test(
    'unparseable frame settles active row as failed; ignored does nothing',
    () {
      start();
      mapper.apply(const CloudWireIgnored('heartbeat'));
      mapper.apply(const CloudWireUnparseable('message.delta', 'bad'));
      expect(mapper.messages.single.status, ChatMessageStatus.failed);
      expect(mapper.turnInProgress, false);
    },
  );
  test('warnings and compactions are replay safe; status is out of band', () {
    start();
    for (var i = 0; i < 2; i++) {
      feed('harness.warning', {
        'warningCode': 'code',
        'warnings': ['a', 'a'],
      }, 'w');
      feed('harness.event', {'kind': 'compaction', 'tokensAfter': 10}, 'c');
    }
    feed('harness.event', {'kind': 'status', 'status': 'compacting'});
    expect(mapper.streamingStatus, 'compacting');
    expect(
      mapper.messages.where((m) => m.role == ChatRole.system),
      hasLength(2),
    );
    expect(mapper.turnInProgress, true);
    feed('harness.event', {'kind': 'status', 'status': null});
    expect(mapper.streamingStatus, null);
  });
  test('accepted reply delta clears transient compaction status', () {
    start();
    feed('harness.event', {'kind': 'status', 'status': 'compacting'});

    text('Reply resumed');

    expect(mapper.streamingStatus, null);
  });
  test('warning details preserve literal mobile-visible punctuation', () {
    feed('harness.warning', {
      'warningCode': 'code',
      'warningMessage': 'Warning',
      'filenames': ['src/app/page.tsx'],
    });
    expect(mapper.messages.single.text, 'Warning\n\n- src/app/page.tsx');
  });
  test('ask-user derives shared questions, clears on result or later user', () {
    start();
    feed('tool.call', {
      'toolCallId': 'ask',
      'toolName': 'AskUserQuestion',
      'args': {
        'questions': [
          {
            'id': 'q',
            'question': 'Choose',
            'options': [
              {'label': 'A', 'description': 'first'},
              'B',
            ],
            'secret': true,
          },
        ],
      },
    });
    final q = mapper.pendingQuestions.single;
    expect(q.requestId, 'ask');
    expect(q.toolUseId, 'ask');
    expect(q.questions.single.options, ['A', 'B']);
    expect(q.questions.single.optionDescriptions, ['first', '']);
    expect(q.questions.single.secret, true);
    result('ask');
    expect(mapper.pendingQuestions, isEmpty);
    feed('tool.call', {
      'toolCallId': 'ask2',
      'toolName': 'request_user_input',
      'args': {
        'questions': [
          {'question': 'Next'},
        ],
      },
    });
    expect(mapper.pendingQuestions, hasLength(1));
    mapper.clearPendingQuestions();
    expect(mapper.pendingQuestions, isEmpty);
  });
  test('hydrate and live share ordered text, reasoning and tool folding', () {
    start();
    text('Before');
    result();
    call();
    text('After');
    feed('message.finish', {
      'sourceKey': 'turn',
      'thinking': {'reasoningTextAvailable': true, 'reasoningText': 'R'},
    });
    final live = shape(mapper.messages);
    final bootstrap = CloudChatBootstrap.fromJson({
      'messages': [
        {
          'id': 'core-id',
          'role': 'ASSISTANT',
          'sourceKey': 'turn',
          'text': 'Before\n\nAfter',
          'reasoningText': 'R',
          'createdAtMs': 1000,
          'contentBlocks': [
            {'type': 'text', 'text': 'Before'},
            {
              'type': 'tool_call',
              'toolCallId': 'tool',
              'toolName': 'read_file',
            },
            {'type': 'text', 'text': 'After'},
          ],
        },
      ],
      'toolActivity': [
        {
          'kind': 'result',
          'result': {'toolCallId': 'tool', 'output': 'ok', 'isError': false},
        },
        {
          'kind': 'call',
          'call': {
            'toolCallId': 'tool',
            'sourceKey': 'turn',
            'toolName': 'read_file',
            'input': '{"path":"a"}',
          },
        },
      ],
    });
    mapper.hydrate(bootstrap);
    expect(shape(mapper.messages), live);
    expect(mapper.messages.map((m) => m.messageId), [
      'core-id:0',
      'core-id:1',
      'core-id:2',
    ]);
    expect(mapper.messages.any((m) => m.messageId.startsWith('cloud:')), false);
  });

  test('legacy hydration keeps agent task replies and tools out of the '
      'root transcript (CAN-5208)', () {
    final rows = mapper.hydrate(
      CloudChatBootstrap.fromJson({
        'messages': [
          {
            'id': 'root',
            'role': 'ASSISTANT',
            'sourceKey': 'turn',
            'text': 'Root',
            'createdAtMs': 1,
            'contentBlocks': [
              {'type': 'tool_call', 'toolCallId': 'spawn', 'toolName': 'Task'},
              {'type': 'text', 'text': 'Root'},
            ],
          },
          {
            'id': 'child',
            'role': 'ASSISTANT',
            'sourceKey': 'turn:task:t1',
            'taskId': 't1',
            'text': 'Child reply',
            'createdAtMs': 2,
            'contentBlocks': [
              {
                'type': 'tool_call',
                'toolCallId': 'child-tool',
                'toolName': 'Read',
              },
              {'type': 'text', 'text': 'Child reply'},
            ],
          },
        ],
        'toolActivity': [
          {
            'kind': 'call',
            'sourceKey': 'turn',
            'call': {
              'sourceKey': 'turn',
              'toolCallId': 'spawn',
              'toolName': 'Task',
              'input': '{}',
            },
          },
          {
            'kind': 'call',
            'call': {
              'sourceKey': 'turn',
              'toolCallId': 'child-tool',
              'toolName': 'Read',
              'input': '{}',
              'taskId': 't1',
            },
          },
          {
            'kind': 'result',
            'result': {
              'toolCallId': 'child-tool',
              'output': 'secret child output',
              'isError': false,
              'taskId': 't1',
            },
          },
        ],
      }),
    );
    expect(rows.map((row) => row.text), ['', 'Root']);
    expect(rows.expand((row) => row.parts).map((p) => p.toolUseId), ['spawn']);
  });

  test('a user watcher message shows only its notice under the payload '
      'label (CAN-4432)', () {
    const envelope =
        '<system_instruction>\nCanopy watcher internal event details.\n\n'
        '<canopy_watcher_event>\n{"label": "Chat completion: Notes", '
        '"secret": "PRIVATE"}\n</canopy_watcher_event>\n'
        '</system_instruction>\n\nCanopy watcher fired.\n'
        'Chat completion: Notes';
    final bootstrap = CloudChatBootstrap.fromJson({
      'messages': [
        {'id': 'u1', 'role': 'USER', 'text': 'Typed by a person'},
        {'id': 'u2', 'role': 'USER', 'text': envelope, 'createdAtMs': 1},
        {
          'id': 'a1',
          'role': 'ASSISTANT',
          'sourceKey': 'a1',
          'text': envelope,
          'createdAtMs': 2,
        },
        {'id': 's1', 'role': 'SYSTEM', 'text': envelope, 'createdAtMs': 3},
      ],
      'toolActivity': <Object>[],
    });
    for (var pass = 0; pass < 2; pass++) {
      final rows = {
        for (final row in mapper.hydrate(bootstrap)) row.messageId: row,
      };
      expect(rows['u1']?.text, 'Typed by a person');
      expect(rows['u1']?.watcherFired, isNull);
      expect(rows['u2']?.text, 'Canopy watcher fired.\nChat completion: Notes');
      expect(rows['u2']?.watcherFired?.kind, 'Chat completion: Notes');
      expect(rows['u2']?.role, ChatRole.user);
      // Only user turns carry watcher messages; other rows are unchanged.
      expect(rows['a1']?.text, envelope);
      expect(rows['a1']?.watcherFired, isNull);
      expect(rows['s1']?.text, envelope);
      expect(rows['s1']?.watcherFired, isNull);
    }
  });
  test(
    'legacy hydration folds tools before text and never guesses an ambiguous join',
    () {
      mapper.hydrate(
        CloudChatBootstrap.fromJson({
          'messages': [
            {'id': 'a', 'role': 'ASSISTANT', 'sourceKey': 'a', 'text': 'A'},
            {'id': 'b', 'role': 'ASSISTANT', 'sourceKey': 'b', 'text': 'B'},
          ],
          'toolActivity': [
            {
              'kind': 'call',
              'call': {
                'sourceKey': 'a',
                'toolCallId': 'same',
                'toolName': 'read',
              },
            },
            {
              'kind': 'call',
              'call': {
                'sourceKey': 'b',
                'toolCallId': 'same',
                'toolName': 'read',
              },
            },
            {
              'kind': 'result',
              'result': {'toolCallId': 'same', 'output': 'ambiguous'},
            },
          ],
        }),
      );
      expect(mapper.messages.map((m) => m.text), ['', 'A', '', 'B']);
      expect(parts().any((p) => p.data?['result'] != null), false);
    },
  );
  test('tool replays return no updates even across live/durable SSE ids', () {
    start();
    call();
    result();
    expect(
      mapper.apply(
        parseCloudWireFrame('tool.call', {
          'toolCallId': 'tool',
          'toolName': 'read_file',
        }),
        eventId: 'durable',
      ),
      isEmpty,
    );
    expect(
      mapper.apply(
        parseCloudWireFrame('tool.result', {
          'toolCallId': 'tool',
          'result': 'ok',
        }),
        eventId: 'durable-result',
      ),
      isEmpty,
    );
    expect(parts(), hasLength(1));
  });
  test(
    'reasoning summary replaces deltas once; absent summary preserves them',
    () {
      start();
      feed('message.reasoning', {'delta': 'partial'});
      call();
      feed('message.finish', {
        'sourceKey': 'turn',
        'thinking': {
          'reasoningTextAvailable': true,
          'reasoningText': 'authoritative',
        },
      });
      expect(parts().first.thinkingText, 'authoritative');
      expect(parts().where((p) => p.kind == 'thinking'), hasLength(1));
      start('next');
      feed('message.reasoning', {'delta': 'keep'});
      feed('message.finish', {
        'sourceKey': 'next',
        'thinking': {'reasoningTextAvailable': false},
      });
      expect(mapper.messages.last.parts.single.thinkingText, 'keep');
    },
  );
  test('replay tracking and tool correlation reset on a new turn', () {
    start('one');
    text('A', 'same');
    call();
    result();
    feed('message.finish', {'sourceKey': 'one'});
    start('two');
    text('B', 'same');
    call();
    expect(mapper.messages.last.parts.single.data?['result'], null);
    expect(mapper.messages.map((m) => m.text), ['A', '', 'B', '']);
  });
  test('terminal accounting appears exactly once across sub-messages', () {
    start();
    text('A');
    call();
    text('B');
    feed('message.finish', {
      'sourceKey': 'turn',
      'cost': {'available': true, 'totalCostUsd': '0.12'},
      'usage': {'totalTokens': 9},
      'model': 'm',
    });
    expect(
      mapper.messages.where((m) => m.cost.kind == CloudCoreCostKind.billable),
      hasLength(1),
    );
    expect(mapper.messages.where((m) => m.usage != null), hasLength(1));
    final snapshot = mapper.messages;
    start('next');
    text('C');
    expect(snapshot.last.text, 'B');
    expect(snapshot.last.cost.amountUsd, '0.12');
  });
  test('new start returns the sealed previous row along with its own row', () {
    start('old');
    text('partial');
    final updates = mapper.apply(
      const CloudMessageStart(isAssistant: true, sourceKey: 'new'),
    );
    expect(updates.map((m) => m.status), [
      ChatMessageStatus.complete,
      ChatMessageStatus.streaming,
    ]);
  });
  test('id-less result replays dedupe on their SSE id only', () {
    start();
    for (final id in ['a', 'a', 'b']) {
      feed('tool.result', {'result': 'orphan'}, id);
    }
    expect(parts(), hasLength(2));
    expect(parts().every((p) => p.kind == 'tool_result'), true);
  });
  test('empty deltas and non-assistant starts never open a row', () {
    feed('message.start', {'role': 'user'});
    feed('message.delta', {'textDelta': ''});
    feed('message.reasoning', {'delta': ''});
    expect(mapper.messages, isEmpty);
    expect(mapper.turnInProgress, false);
  });
  test(
    'hydrate canonical single row preserves user attachments and questions clear after a user',
    () {
      mapper.hydrate(
        CloudChatBootstrap.fromJson({
          'messages': [
            {'id': 'a', 'role': 'ASSISTANT', 'sourceKey': 's', 'text': ''},
            {
              'id': 'u',
              'role': 'USER',
              'text': 'answer',
              'clientRequestId': 'request',
              'attachments': [
                {
                  'attachmentId': 'file',
                  'filename': 'a.txt',
                  'mediaType': 'text/plain',
                  'size': 3,
                },
              ],
            },
          ],
          'toolActivity': [
            {
              'kind': 'call',
              'call': {
                'sourceKey': 's',
                'toolCallId': 'q',
                'toolName': 'AskUserQuestion',
                'input': '{"questions":[{"question":"Pick"}]}',
              },
            },
          ],
        }),
      );
      expect(mapper.messages.map((m) => m.messageId), ['a', 'u']);
      expect(mapper.messages.last.clientRequestId, 'request');
      expect(mapper.messages.last.attachments.single.filename, 'a.txt');
      expect(mapper.pendingQuestions, isEmpty);
    },
  );
  test(
    'hydration creates missing calls from content blocks and folds a sourceless abort',
    () {
      mapper.hydrate(
        CloudChatBootstrap.fromJson({
          'messages': [
            {
              'id': 'a',
              'role': 'ASSISTANT',
              'sourceKey': 's',
              'contentBlocks': [
                {
                  'type': 'tool_call',
                  'toolCallId': 'q',
                  'toolName': 'read_file',
                },
              ],
            },
          ],
          'toolActivity': [
            {
              'kind': 'result',
              'result': {
                'toolCallId': 'q',
                'output': 'expired',
                'isError': true,
              },
            },
          ],
        }),
      );
      expect(parts().single.kind, 'tool_use');
      expect(parts().single.toolName, 'read_file');
      expect(parts().single.data?['result'], {
        'toolUseId': 'q',
        'output': 'expired',
        'isError': true,
      });
    },
  );
  test(
    'artifact-only hydration uses the same attachment projection and dedupe',
    () {
      start();
      final raw = {
        'toolCallId': 't',
        'artifactIndex': 0,
        'payload': {'filename': 'note.md', 'content': 'body'},
      };
      feed('artifact.created', raw);
      feed('message.finish', {'sourceKey': 'turn'});
      final live = shape(mapper.messages);
      mapper.hydrate(
        CloudChatBootstrap.fromJson({
          'messages': [
            {
              'id': 'a',
              'role': 'ASSISTANT',
              'sourceKey': 'turn',
              'artifacts': [
                for (var i = 0; i < 2; i++)
                  {
                    'toolCallId': 't',
                    'artifactIndex': 0,
                    'kind': 'artifact',
                    'label': 'note.md',
                    'storageKind': 'inline',
                    'file': {'name': 'note.md', 'content': 'body'},
                    'metadata': {'filename': 'note.md', 'content': 'body'},
                  },
              ],
            },
          ],
        }),
      );
      expect(shape(mapper.messages), live);
    },
  );
  test(
    'hydrates warning and compaction through the same fold at durable times',
    () {
      mapper.hydrate(
        CloudChatBootstrap.fromJson({
          'messages': [
            {
              'id': 'u',
              'role': 'USER',
              'text': 'Hi',
              'createdAtMs': 100,
              'sequence': 1,
            },
            {
              'id': 'a',
              'role': 'ASSISTANT',
              'text': 'Hi',
              'createdAtMs': 300,
              'sequence': 2,
            },
          ],
          'harnessWarnings': [
            {
              'eventId': 'w',
              'occurredAtMs': 200,
              'warningCode': 'code',
              'warningMessage': 'Warning',
            },
          ],
          'compactions': [
            {'eventId': 'c', 'occurredAtMs': 400, 'tokensAfter': 12},
          ],
        }),
      );
      expect(mapper.messages.map((m) => m.messageId), [
        'u',
        'cloud:chat:harness-warning:w',
        'a',
        'cloud:chat:compaction:c',
      ]);
      expect(mapper.messages.last.parts.single.data?['tokensAfter'], 12);
      expect(
        mapper.apply(const CloudHarnessWarning(code: 'code'), eventId: 'w'),
        isEmpty,
      );
    },
  );
  test('untimed hydration notices sort after every timestamped notice', () {
    mapper.hydrate(
      CloudChatBootstrap.fromJson({
        'messages': [
          {'id': 'u', 'role': 'USER', 'text': 'Hi', 'createdAtMs': 100},
        ],
        'harnessWarnings': [
          {
            'eventId': 'w',
            'occurredAtMs': 500,
            'warningCode': 'code',
            'warningMessage': 'Warning',
          },
        ],
        'compactions': [
          {'eventId': 'c', 'tokensAfter': 12},
        ],
      }),
    );

    expect(mapper.messages.map((m) => m.messageId), [
      'u',
      'cloud:chat:harness-warning:w',
      'cloud:chat:compaction:c',
    ]);
  });
  test('deliverable metadata is checked before it is exposed', () {
    start();
    final payload = {
      'deliverableId': '12345678-1234-1234-1234-123456789012',
      'filename': 'a.txt',
      'mediaType': 'text/plain',
      'sizeBytes': 3,
      'contentSha256': List.filled(64, 'a').join(),
    };
    feed('artifact.created', {
      'kind': 'deliverable',
      'toolCallId': 'a',
      'payload': payload,
    });
    feed('artifact.created', {
      'kind': 'deliverable',
      'toolCallId': 'b',
      'payload': {...payload, 'sizeBytes': -1},
    });
    expect(parts().first.data?['deliverable'], payload);
    expect(parts().last.data?['deliverable'], null);
  });
  test(
    'ask-user aliases tolerate malformed inputs and preserve multi-select',
    () {
      start();
      for (final (index, name) in [
        'request_user_input',
        'mcp__brand__AskUserQuestion',
        'brand_ask_user_question',
      ].indexed) {
        feed('tool.call', {
          'toolCallId': 'q$index',
          'toolName': name,
          'args': {
            'questions': [
              {
                'id': 'id',
                'header': 'H',
                'question': 'Q',
                'multiSelect': true,
                'allowOther': false,
                'options': ['A'],
              },
            ],
          },
        });
      }
      feed('tool.call', {
        'toolCallId': 'bad',
        'toolName': 'AskUserQuestion',
        'args': '{truncated',
      });
      expect(mapper.pendingQuestions, hasLength(3));
      expect(
        mapper.pendingQuestions.every((q) => q.questions.single.multiSelect),
        true,
      );
      expect(mapper.pendingQuestions.first.questions.single.allowOther, false);
    },
  );
  test('generic MCP tools do not collide with built-in tool families', () {
    start();
    call('github-read', 'mcp__github__read_file');
    expect(parts().single.toolFamily, 'unknown');
  });
  test(
    'start and finish with SSE identity replay safely without sourceKey',
    () {
      feed('message.start', {'role': 'assistant'}, 'start');
      text('A', 'delta');
      feed('message.finish', {}, 'finish');
      feed('message.start', {'role': 'assistant'}, 'start');
      text('A', 'delta');
      feed('message.finish', {}, 'finish');
      expect(mapper.messages, hasLength(1));
      expect(mapper.messages.single.text, 'A');
      expect(mapper.turnInProgress, false);
    },
  );
  test('hydrated missing assistant cost stays pending, never zero', () {
    mapper.hydrate(
      CloudChatBootstrap.fromJson({
        'messages': [
          {'id': 'a', 'role': 'ASSISTANT', 'text': 'A'},
        ],
      }),
    );
    expect(mapper.messages.single.cost.kind, CloudCoreCostKind.pending);
  });
  test('stream updates preserve prior rows and emit only changed steps', () {
    start();
    text('before');
    call();
    text('after');
    final first = mapper.messages.first;
    final tool = mapper.messages[1];
    final updates = mapper.apply(const CloudMessageDelta(' more'));
    expect(updates, hasLength(1));
    expect(identical(mapper.messages.first, first), true);
    expect(identical(mapper.messages[1], tool), true);
    final reasoning = mapper.apply(const CloudMessageReasoning('think'));
    expect(reasoning, hasLength(1));
    expect(reasoning.single.messageId, first.messageId);
  });
}

List<Object?> shape(List<ChatMessage> rows) => rows
    .map(
      (m) => {
        'text': m.text,
        'status': m.status,
        'parts': m.parts
            .map(
              (p) => {'kind': p.kind, 'family': p.toolFamily, 'data': p.data},
            )
            .toList(),
      },
    )
    .toList();
