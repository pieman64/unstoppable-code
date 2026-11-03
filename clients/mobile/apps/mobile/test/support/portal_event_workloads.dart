// Synthetic Portal event workloads (CAN-3372) shared by the transport tests,
// the host benchmark (`tool/portal_event_benchmark.dart`) and the device
// profile harness. Pure Dart: no Flutter imports, so `dart run` can load it.
//
// Every value is synthetic and deterministic. The chat snapshot mirrors the
// live wire shape the desktop projects for a large chat: up to 300 messages
// with tool steps, tool results, attachments and multibyte text, plus the
// chat-tab and PR entities a worktree snapshot carries.
import 'dart:convert';

/// Chat id the snapshot workloads target.
const String workloadChatId = 'chat-bench';
const String workloadWorkspaceId = 'ws-bench';
const String workloadWorktreeId = 'wt-bench';

/// Epoch of the first synthetic message.
const int workloadEpochMs = 1767258000000; // 2026-01-01T09:00:00Z

/// Characters of text in each generated answer; tuned so 300 messages land
/// near the ~600 KiB snapshot the ticket measures.
const int _answerChars = 6900;

/// The ~600 KiB, 300-message chat snapshot from the ticket, in characters.
const int snapshot600KiBChars = 600 * 1024;

String _answerText(int index) {
  // Multibyte characters keep UTF-8 bytes and UTF-16 characters distinct.
  final seed = 'Answer $index: the build passes — café ✓ naïve résumé. ';
  final buffer = StringBuffer();
  while (buffer.length < _answerChars) {
    buffer.write(seed);
  }
  return buffer.toString().substring(0, _answerChars);
}

Map<String, dynamic> _message(int index, {String padding = ''}) {
  final createdAtMs = workloadEpochMs + index * 60000;
  final base = <String, dynamic>{
    'messageId': 'msg-$index',
    'chatId': workloadChatId,
    'scope': 'worktree',
    'status': 'complete',
    'createdAtMs': createdAtMs,
  };
  switch (index % 4) {
    case 0:
      return {
        ...base,
        'role': 'user',
        'text': 'Question $index about the build.$padding',
        if (index % 20 == 0)
          'attachments': [
            {
              'attachmentId': 'att-$index',
              'filename': 'log-$index.txt',
              'mediaType': 'text/plain',
              'size': 2048 + index,
            },
          ],
      };
    case 1:
      return {
        ...base,
        'role': 'assistant',
        'text': 'Checking the workspace for $index.$padding',
        'parts': [
          {
            'kind': 'tool_use',
            'toolFamily': 'bash',
            'data': {
              'toolName': 'Bash',
              'toolUseId': 'tool-$index',
              'input': '{"command":"npm test -- $index"}',
            },
          },
        ],
      };
    case 2:
      return {
        ...base,
        'role': 'assistant',
        'text': padding,
        'parts': [
          {
            'kind': 'tool_result',
            'data': {
              'toolUseId': 'tool-${index - 1}',
              'output': 'ok $index\n${'PASS test/case_$index.dart\n' * 8}',
              'isError': false,
            },
          },
        ],
      };
    default:
      return {
        ...base,
        'role': 'assistant',
        'text': '${_answerText(index)}$padding',
        'updatedAtMs': createdAtMs + 42000,
        'parts': [
          {
            'kind': 'turn_timer',
            'data': {
              'startedAt': createdAtMs,
              'completedAt': createdAtMs + 42000,
            },
          },
        ],
      };
  }
}

Map<String, dynamic> _snapshotEnvelope(
  int messages, {
  required int cursor,
  required String Function(int index) padding,
}) => {
  'type': 'portal.state.snapshot',
  'eventId': 'ev-snapshot-$cursor',
  'cursor': cursor,
  'occurredAt': '2026-01-01T09:00:00Z',
  'payload': {
    'scope': 'chat',
    'target': {
      'workspaceLocalId': workloadWorkspaceId,
      'worktreeLocalId': workloadWorktreeId,
      'chatLocalId': workloadChatId,
    },
    'chatMessagesTruncated': false,
    'chatMessages': [
      for (var i = 0; i < messages; i++) _message(i, padding: padding(i)),
    ],
    'entities': [
      {
        'entityType': 'chat_summary',
        'localId': workloadChatId,
        'payload': {
          'chatId': workloadChatId,
          'scope': 'worktree',
          'workspaceLocalId': workloadWorkspaceId,
          'worktreeLocalId': workloadWorktreeId,
          'title': 'Benchmark chat',
          'active': true,
        },
      },
      {
        'entityType': 'pr_status',
        'localId': workloadWorktreeId,
        'payload': {
          'workspaceLocalId': workloadWorkspaceId,
          'worktreeLocalId': workloadWorktreeId,
          'number': 42,
          'state': 'open',
          'title': 'Synthetic PR',
          'url': 'https://example.test/pr/42',
        },
      },
    ],
  },
};

/// A pipeline update and an unknown envelope ride along in the snapshot
/// batch so the workloads exercise every model family the decoder maps.
List<Map<String, dynamic>> _companionEnvelopes(int cursor) => [
  {
    'type': 'portal.pipeline.event',
    'eventId': 'ev-pipeline-$cursor',
    'payload': {
      'entity': {
        'entityType': 'pipeline_run',
        'localId': 'run-1',
        'payload': {
          'pipelineId': 'pipe-1',
          'pipelineName': 'Synthetic pipeline',
          'status': 'running',
          'workspaceLocalId': workloadWorkspaceId,
          'worktreeLocalId': workloadWorktreeId,
        },
      },
    },
  },
  {
    'type': 'portal.future.event',
    'eventId': 'ev-unknown-$cursor',
    'payload': {'note': 'ignored'},
  },
];

/// `PollBrowserPortalEventsResponse` JSON carrying a [messages]-row chat
/// snapshot. With [targetChars], ASCII padding makes the encoded JSON exactly
/// that many UTF-16 characters: all of it on the last message, or shared by
/// every message with [spreadPadding] so no single row dominates rendering.
String chatSnapshotBatchJson({
  int messages = 300,
  int? targetChars,
  int nextCursor = 100,
  bool spreadPadding = false,
}) {
  String encode(int padding) => jsonEncode({
    'events': [
      _snapshotEnvelope(
        messages,
        cursor: nextCursor,
        padding: (index) {
          if (!spreadPadding) return index == messages - 1 ? 'x' * padding : '';
          final share = padding ~/ messages;
          return 'x' *
              (index == messages - 1
                  ? padding - share * (messages - 1)
                  : share);
        },
      ),
      ..._companionEnvelopes(nextCursor),
    ],
    'nextCursor': nextCursor,
    'connectionStatus': 'active',
  });

  final unpadded = encode(0);
  if (targetChars == null) return unpadded;
  final missing = targetChars - unpadded.length;
  if (missing < 0) {
    throw ArgumentError.value(
      targetChars,
      'targetChars',
      'is smaller than the ${unpadded.length}-character $messages-row batch',
    );
  }
  final padded = encode(missing);
  assert(padded.length == targetChars);
  return padded;
}

/// A small live batch: one streaming chat message after [nextCursor - 1].
String streamingMessageBatchJson({
  required int nextCursor,
  String messageId = 'msg-live',
  String text = 'Streaming update',
}) => jsonEncode({
  'events': [
    {
      'type': 'portal.chat.event',
      'eventId': 'ev-$messageId-$nextCursor',
      'occurredAt': '2026-01-02T09:00:00Z',
      'payload': {
        'scope': 'worktree',
        'chatId': workloadChatId,
        'workspaceLocalId': workloadWorkspaceId,
        'worktreeLocalId': workloadWorktreeId,
        'message': {
          'messageId': messageId,
          'chatId': workloadChatId,
          'role': 'assistant',
          'status': 'streaming',
          'text': text,
          'createdAtMs': workloadEpochMs + 86400000,
        },
      },
    },
  ],
  'nextCursor': nextCursor,
  'connectionStatus': 'active',
});

/// One SSE frame for [data] with the server's framing.
String sseFrame(String data, {String event = 'batch'}) =>
    'event: $event\ndata: $data\n\n';

/// A frame the transport parses but never decodes, sized to exactly
/// [dataChars] payload characters. Isolates parser cost from decode cost.
String inertSseFrame(int dataChars) =>
    sseFrame('x' * dataChars, event: 'bench');

/// Splits [text] into consecutive [size]-character chunks.
List<String> chunkText(String text, int size) => [
  for (var start = 0; start < text.length; start += size)
    text.substring(
      start,
      start + size > text.length ? text.length : start + size,
    ),
];

/// UTF-8 byte length of [text].
int utf8Length(String text) => utf8.encode(text).length;
