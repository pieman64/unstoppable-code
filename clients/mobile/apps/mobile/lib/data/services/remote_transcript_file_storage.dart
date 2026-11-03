/// File [RemoteTranscriptStorage] for the transcript cache (CAN-3373): one versioned JSON
/// file per chat, written to a temp file and renamed so a crash mid-write
/// never leaves a torn file.
///
/// Encoding, decoding, and file I/O run on a worker isolate, one operation
/// at a time, so a long transcript never costs the UI isolate a frame. The
/// directory is injected: the host resolves application support storage and
/// applies platform data protection before anything is written.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';

/// Largest file kept per chat. Beyond it the oldest messages are dropped;
/// a single message that cannot fit stores nothing for the chat.
const int kRemoteTranscriptMaxFileBytes = 1024 * 1024;

const int _formatVersion = 1;

/// Runs [computation] off the UI isolate; [Isolate.run] in the app.
typedef RemoteTranscriptWorker =
    Future<R> Function<R>(FutureOr<R> Function() computation);

Future<R> _isolateWorker<R>(FutureOr<R> Function() computation) =>
    Isolate.run(computation);

/// The file name for [chat] of [owner]. Hashed, so neither the account,
/// the session, nor the chat id appears in a path. Hashing is not
/// encryption: contents rely on platform data protection.
String remoteTranscriptFileName(
  RemoteTranscriptOwner owner,
  RemoteTranscriptChat chat,
) {
  final identity = [
    owner.accountScope,
    owner.sessionId,
    chat.scope.wire,
    chat.chatId,
  ].join('\n');
  return '${sha256.convert(utf8.encode(identity))}.json';
}

final class FileRemoteTranscriptStorage implements RemoteTranscriptStorage {
  FileRemoteTranscriptStorage({
    required this._directory,
    RemoteTranscriptWorker? worker,
    this.maxFileBytes = kRemoteTranscriptMaxFileBytes,
  }) : _worker = worker ?? _isolateWorker;

  /// Resolves the cache directory, created and protected by the host.
  final Future<Directory> Function() _directory;
  final RemoteTranscriptWorker _worker;
  final int maxFileBytes;

  String? _path;
  Future<void> _queue = Future.value();

  /// The queued write per file that has not started yet. A later write of
  /// the file replaces its copy, so a burst of changes costs one write. A
  /// load, delete, or clear ends the burst: writes issued after it queue
  /// anew, and a delete or clear drops the copies it overtakes.
  final Map<String, _UnwrittenCopy> _unwritten = {};

  /// The cache directory, or null while it is unavailable — for example when
  /// its data protection cannot be applied. Nothing is written without it.
  Future<String?> _resolve() async {
    if (_path case final path?) return path;
    try {
      return _path = (await _directory()).path;
    } catch (_) {
      return null;
    }
  }

  Future<T> _enqueue<T>(
    Future<T> Function(String path) operation,
    T miss, {
    void Function()? unavailable,
  }) {
    final result = _queue
        .then((_) async {
          final path = await _resolve();
          if (path != null) return await operation(path);
          unavailable?.call();
          return miss;
        })
        .catchError((Object _) => miss);
    _queue = result.then<void>((_) {});
    return result;
  }

  @override
  Future<List<PersistedTranscript>> load(RemoteTranscriptOwner owner) {
    _unwritten.clear();
    return _enqueue(
      (path) => _worker(_loadJob(path, owner, maxFileBytes)),
      const <PersistedTranscript>[],
    );
  }

  @override
  void write(RemoteTranscriptOwner owner, PersistedTranscript transcript) {
    final name = remoteTranscriptFileName(owner, transcript.chat);
    if (_unwritten[name] case final queued?) {
      queued.copy = transcript;
      return;
    }
    final unwritten = _unwritten[name] = _UnwrittenCopy(owner, transcript);
    void started() {
      if (identical(_unwritten[name], unwritten)) _unwritten.remove(name);
    }

    unawaited(
      _enqueue(
        (path) async {
          started();
          if (unwritten.copy case final copy?) {
            await _worker(
              _writeJob(path, name, unwritten.owner, copy, maxFileBytes),
            );
          }
        },
        null,
        // Dropped like the write itself, so a later write is queued anew.
        unavailable: started,
      ),
    );
  }

  @override
  void delete(RemoteTranscriptOwner owner, RemoteTranscriptChat chat) {
    final name = remoteTranscriptFileName(owner, chat);
    _unwritten.remove(name)?.copy = null;
    unawaited(_enqueue((path) => _worker(_deleteJob(path, name)), null));
  }

  @override
  Future<void> clear() {
    for (final unwritten in _unwritten.values) {
      unwritten.copy = null;
    }
    _unwritten.clear();
    return _enqueue((path) => _worker(_clearJob(path)), null);
  }

  @override
  Future<void> flush() => _enqueue((_) async {}, null);
}

final class _UnwrittenCopy {
  _UnwrittenCopy(this.owner, this.copy);

  final RemoteTranscriptOwner owner;

  /// The newest copy to write; null once a delete or clear overtook it.
  PersistedTranscript? copy;
}

// Jobs are built by top-level functions so each closure sent to the worker
// isolate captures only its own plain arguments.

List<PersistedTranscript> Function() _loadJob(
  String path,
  RemoteTranscriptOwner owner,
  int maxFileBytes,
) =>
    () => _loadTranscripts(path, owner, maxFileBytes);

void Function() _writeJob(
  String path,
  String name,
  RemoteTranscriptOwner owner,
  PersistedTranscript transcript,
  int maxFileBytes,
) =>
    () => _writeTranscript(path, name, owner, transcript, maxFileBytes);

void Function() _deleteJob(String path, String name) => () {
  final file = File('$path${Platform.pathSeparator}$name');
  if (file.existsSync()) file.deleteSync();
};

/// Empties the directory but keeps it: the host applied its data protection,
/// which files created inside it inherit.
void Function() _clearJob(String path) => () {
  final directory = Directory(path);
  if (!directory.existsSync()) return;
  for (final entity in directory.listSync(followLinks: false)) {
    entity.deleteSync(recursive: true);
  }
};

List<PersistedTranscript> _loadTranscripts(
  String path,
  RemoteTranscriptOwner owner,
  int maxFileBytes,
) {
  final directory = Directory(path);
  if (!directory.existsSync()) return const [];
  final transcripts = <PersistedTranscript>[];
  for (final entity in directory.listSync(followLinks: false)) {
    if (entity is! File) continue;
    final name = entity.uri.pathSegments.last;
    PersistedTranscript? transcript;
    try {
      if (name.endsWith('.json') && entity.lengthSync() <= maxFileBytes) {
        transcript = decodeRemoteTranscript(
          entity.readAsStringSync(),
          owner: owner,
          fileName: name,
        );
      }
    } on FileSystemException {
      // Unreadable now, e.g. protected while the device is locked; it may
      // be valid later.
      continue;
    } catch (_) {
      transcript = null;
    }
    if (transcript != null) {
      transcripts.add(transcript);
      continue;
    }
    // Another owner's, unreadable, or an interrupted write's temp file.
    try {
      entity.deleteSync();
    } on FileSystemException {
      // Retried on the next load.
    }
  }
  return transcripts;
}

void _writeTranscript(
  String path,
  String name,
  RemoteTranscriptOwner owner,
  PersistedTranscript transcript,
  int maxFileBytes,
) {
  final file = File('$path${Platform.pathSeparator}$name');
  final encoded = encodeRemoteTranscript(
    owner,
    transcript,
    maxBytes: maxFileBytes,
  );
  if (encoded == null) {
    if (file.existsSync()) file.deleteSync();
    return;
  }
  final temp = File('${file.path}.tmp');
  temp.writeAsBytesSync(encoded, flush: true);
  temp.renameSync(file.path);
}

/// [transcript] as file bytes, keeping the newest messages that fit in
/// [maxBytes]. Null when not even the newest message fits.
List<int>? encodeRemoteTranscript(
  RemoteTranscriptOwner owner,
  PersistedTranscript transcript, {
  int maxBytes = kRemoteTranscriptMaxFileBytes,
}) {
  final envelope = jsonEncode({
    'version': _formatVersion,
    'account': owner.accountScope,
    'session': owner.sessionId,
    'scope': transcript.chat.scope.wire,
    'chatId': transcript.chat.chatId,
    'openedAt': transcript.openedAt,
  });
  // The rows are appended one by one, newest that fit, after the envelope.
  final header = utf8.encode(
    '${envelope.substring(0, envelope.length - 1)},"rows":[',
  );
  final rows = [
    for (final row in transcript.rows) utf8.encode(jsonEncode(_encodeRow(row))),
  ];
  var size = header.length + 2; // `]}`
  var first = rows.length;
  while (first > 0) {
    final next = size + rows[first - 1].length + (first < rows.length ? 1 : 0);
    if (next > maxBytes) break;
    size = next;
    first -= 1;
  }
  if (first == rows.length) return null;
  final bytes = BytesBuilder(copy: false)..add(header);
  for (var i = first; i < rows.length; i++) {
    if (i > first) bytes.addByte(0x2c); // ,
    bytes.add(rows[i]);
  }
  bytes.add(utf8.encode(']}'));
  return bytes.takeBytes();
}

/// The transcript in [source], or null unless it is a current-version file
/// of [owner] stored under its own [fileName] with every row intact.
PersistedTranscript? decodeRemoteTranscript(
  String source, {
  required RemoteTranscriptOwner owner,
  required String fileName,
}) {
  final json = jsonDecode(source);
  if (json is! Map<String, dynamic> ||
      json['version'] != _formatVersion ||
      json['account'] != owner.accountScope ||
      json['session'] != owner.sessionId) {
    return null;
  }
  final scope = RemoteChatScope.fromWire(_string(json['scope']));
  final chatId = _string(json['chatId']);
  final openedAt = json['openedAt'];
  final rows = json['rows'];
  if (scope == null ||
      chatId == null ||
      chatId.isEmpty ||
      openedAt is! int ||
      rows is! List ||
      rows.isEmpty) {
    return null;
  }
  final chat = (scope: scope, chatId: chatId);
  if (remoteTranscriptFileName(owner, chat) != fileName) return null;
  final messages = <RemoteChatMessage>[];
  for (final row in rows) {
    final message = _decodeRow(row);
    // A row that cannot be read would leave a hole in the tail.
    if (message == null || message.chatId != chatId) return null;
    messages.add(message);
  }
  return PersistedTranscript(chat: chat, openedAt: openedAt, rows: messages);
}

Map<String, Object?> _encodeRow(RemoteChatMessage message) => {
  'messageId': message.messageId,
  'chatId': message.chatId,
  'scope': message.scope?.wire,
  'role': message.role?.wire,
  'status': message.status?.wire,
  'text': message.text,
  'parts': [
    for (final part in message.parts)
      {'kind': part.kind, 'toolFamily': part.toolFamily, 'data': part.data},
  ],
  'occurredAt': message.occurredAt?.toIso8601String(),
  'updatedAt': message.updatedAt?.toIso8601String(),
  'orderingAt': message.orderingAt?.toIso8601String(),
  'attachments': [
    for (final attachment in message.attachments)
      {
        'attachmentId': attachment.attachmentId,
        'filename': attachment.filename,
        'mediaType': attachment.mediaType,
        'size': attachment.size,
      },
  ],
  'watcherFired': ?message.watcherFired?.toJson(),
  if (message.continuesTurn) 'continuesTurn': true,
};

RemoteChatMessage? _decodeRow(Object? value) {
  if (value is! Map<String, dynamic>) return null;
  final messageId = _string(value['messageId']);
  final chatId = _string(value['chatId']);
  final text = _string(value['text']);
  final parts = value['parts'];
  final attachments = value['attachments'];
  if (messageId == null ||
      messageId.isEmpty ||
      chatId == null ||
      text == null ||
      parts is! List ||
      attachments is! List) {
    return null;
  }
  final decodedParts = <ChatPart>[];
  for (final part in parts) {
    if (part is! Map<String, dynamic>) return null;
    final kind = _string(part['kind']);
    final data = part['data'];
    if (kind == null || (data != null && data is! Map<String, dynamic>)) {
      return null;
    }
    decodedParts.add(
      ChatPart(
        kind: kind,
        toolFamily: _string(part['toolFamily']),
        data: data as Map<String, dynamic>?,
      ),
    );
  }
  final decodedAttachments = <ChatMessageAttachment>[];
  for (final attachment in attachments) {
    final decoded = ChatMessageAttachment.fromJsonOrNull(attachment);
    if (decoded == null) return null;
    decodedAttachments.add(decoded);
  }
  return RemoteChatMessage(
    messageId: messageId,
    chatId: chatId,
    scope: RemoteChatScope.fromWire(_string(value['scope'])),
    role: ChatRole.fromWire(_string(value['role'])),
    continuesTurn: value['continuesTurn'] == true,
    status: ChatMessageStatus.fromWire(_string(value['status'])),
    text: text,
    parts: List.unmodifiable(decodedParts),
    occurredAt: _date(value['occurredAt']),
    updatedAt: _date(value['updatedAt']),
    orderingAt: _date(value['orderingAt']),
    attachments: List.unmodifiable(decodedAttachments),
    // Rows written before the marker was stored keep it in their parts.
    watcherFired: ChatWatcherFiredInfo.read(
      value['watcherFired'],
      decodedParts,
    ),
  );
}

String? _string(Object? value) => value is String ? value : null;

DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
