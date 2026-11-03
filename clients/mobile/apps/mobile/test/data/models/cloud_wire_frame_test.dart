// Transliterated frame cases from web core-wire.test.ts.
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_wire_frame.dart';

void main() {
  test(
    'classifies task.upsert and task harness events as ignored, never unparseable',
    () {
      final frame = parseCloudWireFrame('task.upsert', {
        'agentSessionId': 's',
        'task': {'taskId': 't1'},
      });
      expect(frame, isA<CloudWireIgnored>());
      final ignored = frame as CloudWireIgnored;
      expect(ignored.event, 'task.upsert');
      expect(ignored.taskId, null);
      for (final value in [
        null,
        42,
        'json',
        [1],
      ]) {
        expect(parseCloudWireFrame('task.upsert', value).type, 'ignored');
      }
      expect(
        parseCloudWireFrame('harness.event', {'kind': 'task', 'task': {}}).type,
        'ignored',
      );
      final error = {
        'kind': 'task_error',
        'sourceKey': 'turn:task:t1',
        'errorCode': 'usage_limit',
        'errorMessage': 'Limit reached',
      };
      expect(parseCloudWireFrame('harness.event', error).type, 'ignored');
      final taskError = parseCloudWireFrame('harness.event', {
        ...error,
        'taskId': 't1',
      });
      expect(taskError, isA<CloudWireIgnored>());
      expect((taskError as CloudWireIgnored).taskId, 't1');
    },
  );
  test(
    'frames with a taskId are ignored task activity; other taskId values are root',
    () {
      final payloads = <String, Map<String, Object?>>{
        'message.start': {'role': 'assistant'},
        'message.delta': {'textDelta': 'x'},
        'message.reasoning': {},
        'message.finish': {},
        'tool.call': {},
        'tool.result': {},
        'artifact.created': {},
        'error': {},
      };
      for (final entry in payloads.entries) {
        final frame = parseCloudWireFrame(entry.key, {
          ...entry.value,
          'sourceKey': 'turn:task:t1',
          'taskId': 't1',
        });
        expect(frame, isA<CloudWireIgnored>());
        final ignored = frame as CloudWireIgnored;
        expect(ignored.event, entry.key);
        expect(ignored.taskId, 't1');
        expect(ignored.sourceKey, null);
      }
      expect(
        parseCloudWireFrame('message.finish', {
          'taskId': 't1',
          'finalMessage': 7,
        }),
        isA<CloudWireIgnored>(),
      );
      for (final taskId in [null, '', 3]) {
        final frame = parseCloudWireFrame('message.delta', {
          'sourceKey': 'turn',
          'textDelta': 'x',
          'taskId': taskId,
        });
        expect(frame, isA<CloudMessageDelta>());
        final delta = frame as CloudMessageDelta;
        expect(delta.text, 'x');
        expect(delta.sourceKey, 'turn');
      }
    },
  );
  test(
    'classifies every supported frame and never throws on malformed input',
    () {
      final valid = <String, Object?>{
        'message.start': {'role': 'assistant'},
        'message.delta': {},
        'message.reasoning': {},
        'message.finish': {},
        'tool.call': {},
        'tool.result': {},
        'artifact.created': {},
        'error': {},
        'harness.warning': {'warningCode': 'warning'},
        'harness.event': {'kind': 'status', 'status': null},
      };
      for (final entry in valid.entries) {
        expect(parseCloudWireFrame(entry.key, entry.value).type, entry.key);
        for (final malformed in [
          null,
          true,
          42,
          'json',
          [],
          [1],
        ]) {
          expect(
            parseCloudWireFrame(entry.key, malformed).type,
            entry.key == 'harness.event' ? 'ignored' : 'unparseable',
          );
        }
      }
      expect(parseCloudWireFrame('heartbeat', null).type, 'ignored');
    },
  );
  test('tolerates fields and keeps exact source keys and reasoning alias', () {
    final start =
        parseCloudWireFrame('message.start', {'role': 'USER', 'sourceKey': 3})
            as CloudMessageStart;
    expect(start.isAssistant, false);
    expect(start.sourceKey, null);
    final delta =
        parseCloudWireFrame('message.reasoning', {
              'sourceKey': 'turn',
              'delta': 'think',
            })
            as CloudMessageReasoning;
    expect(delta.text, 'think');
    expect(delta.sourceKey, 'turn');
    expect(
      (parseCloudWireFrame('message.delta', {'textDelta': false})
              as CloudMessageDelta)
          .text,
      '',
    );
  });
  test(
    'finish resolves model, nested usage, decimal cost, text and reasoning',
    () {
      final frame =
          parseCloudWireFrame('message.finish', {
                'model': {
                  'id': 'model',
                  'name': 'Model',
                  'contextWindow': 200000,
                },
                'usage': {
                  'inputTokens': 10,
                  'outputTokens': 2,
                  'inputTokenDetails': {
                    'cacheReadTokens': 4,
                    'cacheWriteTokens': 3,
                  },
                  'outputTokenDetails': {'reasoningTokens': 1},
                  'contextTokens': 17,
                },
                'cost': {'available': true, 'totalCostUsd': '0.000123456789'},
                'finalMessage': {
                  'content': [
                    {'type': 'text', 'text': 'A'},
                    {'type': 'image'},
                    {'type': 'text', 'text': 'B'},
                  ],
                },
                'thinking': {
                  'reasoningTextAvailable': true,
                  'reasoningText': 'thought',
                },
              })
              as CloudMessageFinish;
      expect(frame.model, {
        'id': 'model',
        'label': 'Model',
        'contextWindow': 200000,
      });
      expect(frame.usage, {
        'inputTokens': 10,
        'outputTokens': 2,
        'cacheReadTokens': 4,
        'cacheWriteTokens': 3,
        'reasoningTokens': 1,
        'contextTokens': 17,
      });
      expect(frame.cost.amountUsd, '0.000123456789');
      expect(frame.finalText, 'A\n\nB');
      expect(frame.reasoningText, 'thought');
    },
  );
  test('absent and malformed finish metadata never invents a free turn', () {
    for (final cost in [
      null,
      {},
      {'available': false, 'totalCostUsd': 0},
      {'available': true, 'totalCostUsd': '-1'},
      {'available': true, 'totalCostUsd': 'NaN'},
    ]) {
      final f =
          parseCloudWireFrame('message.finish', {
                'cost': cost,
                'model': [],
                'usage': {'inputTokens': -1, 'contextWindow': 0},
                'thinking': {
                  'reasoningTextAvailable': false,
                  'reasoningText': 'hidden',
                },
              })
              as CloudMessageFinish;
      expect(f.cost.kind, CloudCoreCostKind.pending);
      expect(f.usage, null);
      expect(f.model, null);
      expect(f.reasoningText, null);
    }
    expect(
      (parseCloudWireFrame('message.finish', {
                'cost': {'available': true, 'totalCostUsd': '0'},
              })
              as CloudMessageFinish)
          .cost
          .kind,
      CloudCoreCostKind.zero,
    );
  });
  test(
    'tool names, arguments, missing ids and source keys match durable frames',
    () {
      final f =
          parseCloudWireFrame('tool.call', {
                'toolName': 'external',
                'modelToolName': 'read_file',
                'args': {'path': 'a'},
                'sourceKey': 'turn',
              })
              as CloudToolFrame;
      expect(f.activity.toolName, 'read_file');
      expect(f.activity.input, '{"path":"a"}');
      expect(f.activity.toolCallId, null);
      expect(f.sourceKey, 'turn');
    },
  );
  test('unwraps harness and runner failures including clamped envelopes', () {
    for (final value in [
      {'isError': true, 'errorText': 'failed'},
      {'success': false, 'stderr': 'failed'},
      {
        'result': {
          'status': 'failed',
          'error': {'message': 'failed'},
        },
      },
    ]) {
      final f =
          parseCloudWireFrame('tool.result', {'result': value})
              as CloudToolFrame;
      expect(f.activity.output, 'failed');
      expect(f.activity.isError, true);
    }
    for (final output in [
      '{"isError":true, … [truncated]',
      '{"success":false, … [truncated]',
    ]) {
      final f =
          parseCloudWireFrame('tool.result', {'result': output})
              as CloudToolFrame;
      expect(f.activity.isError, true);
      expect(f.activity.output, output);
    }
    final aborted =
        parseCloudWireFrame('tool.result', {
              'status': 'aborted',
              'error': 'expired',
            })
            as CloudToolFrame;
    expect(aborted.activity.output, 'expired');
    expect(aborted.activity.isError, true);
  });
  test('resolves artifact filenames and bodies in web priority order', () {
    final f =
        parseCloudWireFrame('artifact.created', {
              'toolCallId': 't',
              'artifactIndex': 2,
              'sizeBytes': '139',
              'storageKind': 'external',
              'payload': {
                'filePath': '/notes/a.md',
                'filename': 'b',
                'content': 'body',
                'text': 'other',
              },
            })
            as CloudArtifactCreated;
    expect(f.artifact.fileName, 'notes/a.md');
    expect(f.artifact.fileContent, 'body');
    expect(f.artifact.label, 'notes/a.md');
    expect(f.artifact.storageKind, 'inline');
    expect(f.artifact.sizeBytes, '139');
    expect(
      (parseCloudWireFrame('artifact.created', {}) as CloudArtifactCreated)
          .artifact
          .fileName,
      'artifact-unknown',
    );
  });
  test(
    'warnings validate required fields; unknown harness events stay informational',
    () {
      expect(
        parseCloudWireFrame('harness.warning', {'warningCode': ' '}).type,
        'unparseable',
      );
      expect(
        parseCloudWireFrame('harness.warning', {
          'warningCode': 'a',
          'warningMessage': null,
        }).type,
        'unparseable',
      );
      final f =
          parseCloudWireFrame('harness.warning', {
                'warningCode': ' a ',
                'warnings': ['', 1, 'detail'],
              })
              as CloudHarnessWarning;
      expect(f.code, 'a');
      expect(f.warnings, ['detail']);
      expect(
        parseCloudWireFrame('harness.event', {'kind': 'new'}).type,
        'ignored',
      );
      expect(
        parseCloudWireFrame('harness.event', {'kind': 'status'}).type,
        'ignored',
      );
      final c =
          parseCloudWireFrame('harness.event', {
                'kind': 'compaction',
                'summary': '',
                'tokensBefore': -1,
                'tokensAfter': 10,
              })
              as CloudHarnessEvent;
      expect(c.summary, null);
      expect(c.tokensBefore, null);
      expect(c.tokensAfter, 10);
    },
  );
}
