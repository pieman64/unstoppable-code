import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_event_decoder.dart';

import '../../support/portal_event_workloads.dart';

/// Counts the decodes a [PortalEventDecoder] hands off, running them inline.
final class _CountingRunner {
  var calls = 0;

  Future<R> run<R>(FutureOr<R> Function() computation, {String? debugName}) {
    calls += 1;
    return Future.sync(computation);
  }
}

/// A stable description of a decoded batch: the models implement no
/// equality, so equivalence compares every field the fixtures populate.
Object? _describe(RemotePortalEventBatch batch) => {
  'nextCursor': batch.nextCursor,
  'connectionStatus': batch.connectionStatus,
  'events': [
    for (final event in batch.events)
      switch (event) {
        RemoteStateSnapshotEvent() => {
          'type': 'snapshot',
          'eventId': event.eventId,
          'cursor': event.cursor,
          'scope': event.scope,
          'targetChatId': event.targetChatId,
          'targetChatScope': event.targetChatScope,
          'truncated': event.chatMessagesTruncated,
          'summaries': [
            for (final summary in event.chatSummaries)
              [summary.chatId, summary.title, summary.active],
          ],
          'prStatuses': {
            for (final entry in event.prStatuses.entries)
              entry.key: [
                for (final pr in entry.value) [pr.prNumber, pr.state, pr.url],
              ],
          },
          'messages': [
            for (final message in event.chatMessages)
              [
                message.messageId,
                message.chatId,
                message.scope,
                message.role,
                message.status,
                message.text,
                message.occurredAt,
                message.updatedAt,
                [
                  for (final part in message.parts)
                    [part.kind, part.toolFamily, jsonEncode(part.data)],
                ],
                [
                  for (final attachment in message.attachments)
                    [
                      attachment.attachmentId,
                      attachment.filename,
                      attachment.mediaType,
                      attachment.size,
                    ],
                ],
              ],
          ],
        },
        RemotePipelineRunEvent() => {
          'type': 'pipeline',
          'localId': event.run.localId,
          'status': event.run.status,
          'name': event.run.pipelineName,
        },
        RemoteChatMessageEvent() => {
          'type': 'chat',
          'chatId': event.chatId,
          'messageId': event.message.messageId,
          'text': event.message.text,
        },
        RemoteUnknownPortalEvent() => {'type': 'unknown:${event.type}'},
        _ => {'type': event.runtimeType.toString()},
      },
  ],
};

void main() {
  group('PortalEventDecoder', () {
    test('decodes below the threshold inline and offloads from it', () async {
      final runner = _CountingRunner();
      final decoder = PortalEventDecoder(
        offloadThreshold: 2000,
        runner: runner.run,
      );
      final below = chatSnapshotBatchJson(messages: 1, targetChars: 1999);
      final at = chatSnapshotBatchJson(messages: 1, targetChars: 2000);

      final inline = await decoder.sseBatch(below);
      expect(runner.calls, 0);
      final offloaded = await decoder.sseBatch(at);
      expect(runner.calls, 1);

      expect(inline!.nextCursor, 100);
      expect(offloaded!.nextCursor, 100);
      await decoder.errorStatus('{"status":403}');
      expect(runner.calls, 1);
      expect(
        await decoder.errorStatus('{"status":404,"pad":"${'x' * 2000}"}'),
        404,
      );
      expect(runner.calls, 2);
    });

    test('measures long-poll bodies in bytes', () async {
      final runner = _CountingRunner();
      final decoder = PortalEventDecoder(
        offloadThreshold: 2000,
        runner: runner.run,
      );
      // 1000 characters of 'é' are 2000 UTF-8 bytes.
      final body = utf8.encode(
        jsonEncode({'events': [], 'nextCursor': 4, 'pad': 'é' * 994}),
      );
      expect(body.length, greaterThanOrEqualTo(2000));

      final batch = await decoder.pollBody(body, const {
        'content-type': 'application/json',
      });

      expect(runner.calls, 1);
      expect(batch!.nextCursor, 4);
    });

    test('keeps the default 64 Ki threshold', () {
      expect(PortalEventDecoder.defaultOffloadThreshold, 64 * 1024);
      expect(
        const PortalEventDecoder().offloadThreshold,
        PortalEventDecoder.defaultOffloadThreshold,
      );
    });

    test(
      'maps a 600 KiB snapshot in a real isolate to identical models',
      () async {
        final json = chatSnapshotBatchJson(targetChars: snapshot600KiBChars);
        final inline = RemotePortalEventBatch.fromJson(
          jsonDecode(json) as Map<String, dynamic>,
        );
        String? isolateName;
        final decoder = PortalEventDecoder(
          runner: <R>(computation, {debugName}) {
            isolateName = debugName;
            return Isolate.run(computation, debugName: debugName);
          },
        );

        final offloaded = await decoder.sseBatch(json);

        expect(isolateName, 'PortalEventDecoder');
        expect(_describe(offloaded!), _describe(inline));
        final snapshot = offloaded.events.first as RemoteStateSnapshotEvent;
        expect(snapshot.chatMessages, hasLength(300));
      },
    );

    test('the default decoder maps large SSE and poll payloads', () async {
      final json = chatSnapshotBatchJson(messages: 24, targetChars: 200 * 1024);
      final bytes = Uint8List.fromList(utf8.encode(json));
      const decoder = PortalEventDecoder();

      final sse = await decoder.sseBatch(json);
      final poll = await decoder.pollBody(bytes, const {
        'content-type': 'application/json',
      });

      final expected = _describe(
        RemotePortalEventBatch.fromJson(
          jsonDecode(json) as Map<String, dynamic>,
        ),
      );
      expect(_describe(sse!), expected);
      expect(_describe(poll!), expected);
    });

    for (final threshold in [1 << 30, 0]) {
      final mode = threshold == 0 ? 'off-isolate' : 'inline';
      group('validation ($mode)', () {
        final decoder = PortalEventDecoder(offloadThreshold: threshold);

        test('an SSE batch needs an events list and numeric cursor', () async {
          expect(await decoder.sseBatch('not json'), isNull);
          expect(await decoder.sseBatch('[1]'), isNull);
          expect(await decoder.sseBatch('{"nextCursor":1}'), isNull);
          expect(await decoder.sseBatch('{"events":[]}'), isNull);
          expect(
            await decoder.sseBatch('{"events":{},"nextCursor":1}'),
            isNull,
          );
          final batch = await decoder.sseBatch(
            '{"events":[{"type":"portal.future"}],"nextCursor":2.0}',
          );
          expect(batch!.nextCursor, 2);
          expect(batch.events.single, isA<RemoteUnknownPortalEvent>());
        });

        test('a poll body only needs to be a JSON object', () async {
          Uint8List bytes(String text) => Uint8List.fromList(utf8.encode(text));
          expect(await decoder.pollBody(bytes('nope'), const {}), isNull);
          expect(await decoder.pollBody(bytes('[]'), const {}), isNull);
          final batch = await decoder.pollBody(bytes('{}'), const {});
          expect(batch!.nextCursor, 0);
          expect(batch.events, isEmpty);
        });

        test('a poll body decodes with its declared charset', () async {
          final body = Uint8List.fromList(
            utf8.encode(
              jsonEncode({
                'events': [
                  {
                    'type': 'portal.chat.event',
                    'payload': {
                      'chatId': 'chat-1',
                      'message': {'messageId': 'm', 'text': 'café ✓'},
                    },
                  },
                ],
                'nextCursor': 1,
              }),
            ),
          );
          String text(RemotePortalEventBatch? batch) =>
              (batch!.events.single as RemoteChatMessageEvent).message.text;

          expect(
            text(
              await decoder.pollBody(body, const {
                'content-type': 'application/json',
              }),
            ),
            'café ✓',
          );
          // Like `http.Response.body`, a missing charset on a non-JSON
          // content type falls back to Latin-1.
          expect(
            text(await decoder.pollBody(body, const {})),
            latin1.decode(utf8.encode('café ✓')),
          );
        });

        test('an error frame reports a numeric status only', () async {
          expect(await decoder.errorStatus('{"status":401}'), 401);
          expect(await decoder.errorStatus('{"status":"401"}'), isNull);
          expect(await decoder.errorStatus('oops'), isNull);
        });
      });
    }
  });
}
