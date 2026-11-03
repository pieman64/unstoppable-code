import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_read_client.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

// Mirrors the existing Portal asset wire limits. Mobile keeps a smaller cap
// because a decoded image also consumes memory outside its compressed bytes.
const portalAssetChunkBytes = 192 * 1024;
const remoteImageMaxBytes = 20 * 1024 * 1024;

/// File reads over the existing browser Portal routes. Borrows the repository's
/// pool so backgrounding, disconnecting and changing sessions abort the entire
/// transfer, including retries and late-result polls.
final class PortalFileClient {
  PortalFileClient({
    required this.apiClient,
    required this.reads,
    this.timeout = const Duration(minutes: 3),
    DateTime Function()? now,
    Future<void> Function(Duration)? delay,
  }) : _now = now ?? DateTime.now,
       _delay = delay ?? Future<void>.delayed;

  final ApiClient apiClient;
  final PortalReadClient reads;
  final Duration timeout;
  final DateTime Function() _now;
  final Future<void> Function(Duration) _delay;

  // Match the browser's three-transfer limit before allocating image buffers.
  // Entries after the first three wait inside their cancellable pooled read.
  final _assetReads = <Completer<void>>[];

  String _base(String sessionId) =>
      '$portalBrowserBasePath/sessions/${Uri.encodeComponent(sessionId)}';

  Future<T> _run<T>(Future<T> Function(ApiClient, http.Client) action) async {
    try {
      return await reads.run(
        timeout,
        (client) => action(apiClient.withHttpClient(client), client),
      );
    } on RemoteFileException {
      rethrow;
    } on TimeoutException {
      throw const RemoteFileException(
        RemoteFileFailure.timeout,
        'The desktop file read timed out.',
      );
    } on ApiException catch (error) {
      throw _failure(apiErrorMessage(error), status: error.statusCode);
    } on FormatException {
      throw _invalid;
    } on http.ClientException {
      throw const RemoteFileException(
        RemoteFileFailure.unavailable,
        'The desktop file read was interrupted. Reconnect and try again.',
      );
    }
  }

  Future<RemoteFileContents> readFile(
    String sessionId,
    RemoteFileRequest request,
  ) => _run((api, _) async {
    final body = await api.postJson(
      '${_base(sessionId)}/file/read',
      body: request.toJson(),
    );
    if (body['error'] case final String error) throw _failure(error);
    final content = body['content'];
    final truncated = body['truncated'];
    final unsupported = body['unsupported'];
    if (content is! String ||
        truncated is! bool ||
        (unsupported != null && unsupported is! bool)) {
      throw _invalid;
    }
    if (content.contains('\u0000')) {
      throw const RemoteFileException(
        RemoteFileFailure.binaryFile,
        'Binary files cannot be read as text.',
      );
    }
    return RemoteFileContents(
      contents: content,
      truncated: truncated,
      unsupported: unsupported == true,
    );
  });

  Future<RemoteFileLink?> resolveLink(
    String sessionId, {
    required String projectId,
    required String worktreeId,
    required String href,
  }) => _run((api, client) async {
    // This endpoint legitimately returns JSON null for an unresolved link.
    final response = await client.post(
      Uri.parse('${api.baseUrl}${_base(sessionId)}/file/resolve'),
      headers: api.buildHeaders({'Content-Type': 'application/json'}),
      body: jsonEncode({
        'projectId': projectId,
        'worktreeId': worktreeId,
        'href': href,
      }),
    );
    final body = _decode(response);
    if (body == null) return null;
    if (body is! Map<String, dynamic>) throw _invalid;
    if (body['error'] case final String error) throw _failure(error);
    final root = body['fileRootLocalId'];
    final path = body['relativePath'];
    if (root is! String ||
        root.isEmpty ||
        path is! String ||
        !_safePath(path)) {
      throw _invalid;
    }
    return RemoteFileLink(fileRootLocalId: root, relativePath: path);
  });

  Future<RemoteFileAsset> readAsset(
    String sessionId,
    RemoteFileRequest request, {
    required Map<String, bool> capabilities,
  }) async {
    if (capabilities['chat_assets_v1'] != true) {
      throw const RemoteFileException(
        RemoteFileFailure.unsupportedDesktop,
        'Update the connected desktop to read images.',
      );
    }
    final slot = Completer<void>();
    _assetReads.add(slot);
    if (_assetReads.length <= 3) slot.complete();
    try {
      return await _run((api, client) async {
        await slot.future;
        final path = '${_base(sessionId)}/commands';
        _AssetChunk? metadata;
        Uint8List? bytes;
        var offset = 0;
        String? acknowledgement;
        DateTime? busySince;
        while (true) {
          final response = await client.post(
            Uri.parse('${api.baseUrl}$path'),
            headers: api.buildHeaders({
              'Content-Type': 'application/json',
              'X-Portal-Asset-Acknowledgement': ?acknowledgement,
            }),
            body: jsonEncode({
              'type': 'portal.file.asset.read',
              'target': {
                'workspaceLocalId': request.projectId,
                'worktreeLocalId': request.worktreeId,
              },
              'payload': {
                ...request.toJson(),
                'offset': offset,
                if (metadata != null) 'version': metadata.version,
              },
            }),
          );
          if (response.statusCode == 429) {
            busySince ??= _now();
            if (_now().difference(busySince) >= const Duration(seconds: 65)) {
              throw const RemoteFileException(
                RemoteFileFailure.timeout,
                'Desktop file reads are busy. Wait a moment and retry.',
              );
            }
            await _delay(const Duration(seconds: 1));
            continue;
          }
          busySince = null;
          var reply = _object(_decode(response));
          if (reply['errorCode'] == 'portal_asset_read_pending') {
            reply = await _lateResult(api, path, reply);
          }
          if (reply['error'] case final String error) throw _failure(error);
          final chunk = _AssetChunk.parse(reply['result']);
          if (chunk.size > remoteImageMaxBytes) {
            throw const RemoteFileException(
              RemoteFileFailure.tooLarge,
              'This image exceeds the 20 MiB mobile limit.',
            );
          }
          if (metadata != null && !metadata.sameFile(chunk)) {
            throw const RemoteFileException(
              RemoteFileFailure.changed,
              'The desktop file changed while loading. Try again.',
            );
          }
          if (chunk.offset != offset) throw _invalid;
          final decoded = base64Decode(chunk.dataBase64);
          final end = offset + decoded.length;
          if (decoded.length > portalAssetChunkBytes ||
              end > chunk.size ||
              (chunk.nextOffset == null
                  ? end != chunk.size
                  : chunk.nextOffset != end ||
                        end <= offset ||
                        end >= chunk.size)) {
            throw _invalid;
          }
          if (sha256.convert(decoded).toString() != chunk.contentSha256) {
            throw const RemoteFileException(
              RemoteFileFailure.integrity,
              'The desktop file failed its integrity check. Try again.',
            );
          }
          metadata ??= chunk;
          bytes ??= Uint8List(chunk.size);
          bytes.setRange(offset, end, decoded);
          acknowledgement = switch (reply['commandId']) {
            final String id => id,
            _ => null,
          };
          offset = end;
          if (chunk.nextOffset == null) break;
        }
        if (acknowledgement != null) {
          await api.delete('$path/${Uri.encodeComponent(acknowledgement)}');
        }
        return RemoteFileAsset(
          bytes: bytes,
          filename: metadata.filename,
          mediaType: metadata.mediaType,
          version: metadata.version,
        );
      });
    } finally {
      final index = _assetReads.indexOf(slot);
      _assetReads.removeAt(index);
      if (index < 3 && _assetReads.length >= 3 && !_assetReads[2].isCompleted) {
        _assetReads[2].complete();
      }
    }
  }

  Future<Map<String, dynamic>> _lateResult(
    ApiClient api,
    String path,
    Map<String, dynamic> pending,
  ) async {
    final commandId = pending['commandId'];
    if (commandId is! String || commandId.isEmpty) throw _invalid;
    final deadline = _now().add(const Duration(seconds: 45));
    var delay = const Duration(milliseconds: 250);
    while (_now().isBefore(deadline)) {
      await _delay(delay);
      delay = Duration(milliseconds: (delay.inMilliseconds * 2).clamp(0, 2000));
      final status = await api.getJson(
        '$path/${Uri.encodeComponent(commandId)}',
        retryTransient: false,
      );
      if (status['commandId'] != commandId) throw _invalid;
      if (status['status'] == 'COMPLETED') {
        return {'commandId': commandId, 'result': status['result']};
      }
      if (status['status'] != 'QUEUED' && status['status'] != 'DELIVERED') {
        throw _failure(switch (status['error']) {
          final String message => message,
          _ => null,
        });
      }
    }
    throw const RemoteFileException(
      RemoteFileFailure.timeout,
      'The desktop file read timed out.',
    );
  }
}

const _invalid = RemoteFileException(
  RemoteFileFailure.invalidResponse,
  'The desktop returned an invalid file response.',
);

bool _safePath(String path) =>
    path.isNotEmpty &&
    !path.startsWith('/') &&
    !path.contains('\\') &&
    !path.contains('\u0000') &&
    !path.split('/').contains('..');

Object? _decode(http.Response response) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw ApiException(statusCode: response.statusCode, body: response.body);
  }
  return jsonDecode(response.body);
}

Map<String, dynamic> _object(Object? value) {
  if (value is! Map<String, dynamic>) throw _invalid;
  return value;
}

RemoteFileException _failure(String? message, {int? status}) {
  final text = (message ?? '').toLowerCase();
  final kind =
      status == 401 ||
          status == 403 ||
          text.contains('no longer authorized') ||
          text.contains('permission')
      ? RemoteFileFailure.permissionDenied
      : text.contains('outside') || text.contains('excluded root')
      ? RemoteFileFailure.outsideRoot
      : text.contains('binary')
      ? RemoteFileFailure.binaryFile
      : text.contains('no longer available') || text.contains('not found')
      ? RemoteFileFailure.notFound
      : status == 408 || status == 504 || text.contains('timed out')
      ? RemoteFileFailure.timeout
      : text.contains('changed')
      ? RemoteFileFailure.changed
      : RemoteFileFailure.unavailable;
  return RemoteFileException(
    kind,
    message ?? 'The desktop file is unavailable.',
  );
}

final class _AssetChunk {
  const _AssetChunk(
    this.assetId,
    this.filename,
    this.mediaType,
    this.size,
    this.version,
    this.offset,
    this.dataBase64,
    this.contentSha256,
    this.nextOffset,
  );

  final String assetId;
  final String filename;
  final String mediaType;
  final int size;
  final String version;
  final int offset;
  final String dataBase64;
  final String contentSha256;
  final int? nextOffset;

  bool sameFile(_AssetChunk other) =>
      assetId == other.assetId &&
      filename == other.filename &&
      mediaType == other.mediaType &&
      size == other.size &&
      version == other.version;

  static _AssetChunk parse(Object? value) {
    final json = _object(value);
    final assetId = json['assetId'];
    final filename = json['filename'];
    final mediaType = json['mediaType'];
    final size = json['size'];
    final version = json['version'];
    final offset = json['offset'];
    final data = json['dataBase64'];
    final hash = json['contentSha256'];
    final next = json['nextOffset'];
    if (assetId is! String ||
        assetId.isEmpty ||
        filename is! String ||
        filename.trim().isEmpty ||
        utf8.encode(filename).length > 255 ||
        filename == '.' ||
        filename == '..' ||
        RegExp(r'[\\/\x00-\x1f\x7f]').hasMatch(filename) ||
        mediaType is! String ||
        !RegExp(r'^[\w!#$&^.+-]+/[\w!#$&^.+-]+$').hasMatch(mediaType) ||
        size is! int ||
        size < 0 ||
        size > 100 * 1024 * 1024 ||
        version is! String ||
        version.isEmpty ||
        offset is! int ||
        offset < 0 ||
        data is! String ||
        data.length > ((portalAssetChunkBytes + 2) ~/ 3) * 4 ||
        !RegExp(
          r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
        ).hasMatch(data) ||
        hash is! String ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(hash) ||
        (next != null && next is! int)) {
      throw _invalid;
    }
    return _AssetChunk(
      assetId,
      filename,
      mediaType,
      size,
      version,
      offset,
      data,
      hash,
      next is int ? next : null,
    );
  }
}
