/// Decodes Portal event payloads for [PortalEventStream] (CAN-3372).
///
/// A chat snapshot carries up to ~600 KiB in one batch, and decoding it on
/// the UI isolate drops frames while it arrives. Payloads at or above
/// [PortalEventDecoder.offloadThreshold] therefore run `jsonDecode` and the
/// model mapping in a short-lived isolate ([Isolate.run]) and return the
/// mapped batch; smaller payloads decode inline, where spawning an isolate
/// would cost more than the work it moves.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:mobile/data/models/remote_portal_event.dart';

/// Runs a decode off the calling isolate; [Isolate.run] in production.
typedef PortalDecodeRunner =
    Future<R> Function<R>(
      FutureOr<R> Function() computation, {
      String? debugName,
    });

final class PortalEventDecoder {
  const PortalEventDecoder({
    this.offloadThreshold = defaultOffloadThreshold,
    this.runner = Isolate.run,
  });

  /// Payload size from which decoding leaves the calling isolate: UTF-16
  /// characters of SSE frame data, or bytes of a long-poll body.
  final int offloadThreshold;

  /// Runs decodes at or above [offloadThreshold]; tests substitute it to
  /// control when a decode completes.
  final PortalDecodeRunner runner;

  /// Around 64 Ki characters an inline decode costs about as much as an
  /// isolate round trip (CAN-3372 measurements), so offloading smaller
  /// payloads would only add latency.
  static const int defaultOffloadThreshold = 64 * 1024;

  /// Decodes an SSE `batch` frame. Null when the data is malformed or lacks
  /// the batch's `events` list or numeric `nextCursor`; the frame is skipped.
  Future<RemotePortalEventBatch?> sseBatch(String data) =>
      _decode(data.length, _sseBatch, data);

  /// Reads the HTTP status an SSE `error` frame reports, if any.
  Future<int?> errorStatus(String data) =>
      _decode(data.length, _errorStatus, data);

  /// Decodes a long-poll response body with the charset its [headers] name,
  /// as [http.Response.body] does. Null unless the body is a JSON object.
  Future<RemotePortalEventBatch?> pollBody(
    Uint8List bytes,
    Map<String, String> headers,
  ) => _decode(bytes.length, _pollBody, (bytes: bytes, headers: headers));

  Future<T> _decode<T, A>(int size, T Function(A) decode, A input) {
    if (size < offloadThreshold) {
      return Future.value(
        Timeline.timeSync('PortalEventDecoder.inline', () => decode(input)),
      );
    }
    return _offload(runner, decode, input);
  }

  /// Builds the isolate entry point outside any instance scope, so the
  /// closure captures only the static [decode] function and its [input].
  static Future<T> _offload<T, A>(
    PortalDecodeRunner runner,
    T Function(A) decode,
    A input,
  ) => runner(
    () => Timeline.timeSync('PortalEventDecoder.isolate', () => decode(input)),
    debugName: 'PortalEventDecoder',
  );

  static RemotePortalEventBatch? _sseBatch(String data) {
    try {
      final decoded = jsonDecode(data);
      if (decoded is! Map<String, dynamic>) return null;
      if (decoded['events'] is! List || decoded['nextCursor'] is! num) {
        return null;
      }
      return RemotePortalEventBatch.fromJson(decoded);
    } catch (_) {
      return null;
    }
  }

  static int? _errorStatus(String data) {
    try {
      final decoded = jsonDecode(data);
      if (decoded is Map<String, dynamic>) {
        final status = decoded['status'];
        if (status is num) return status.toInt();
      }
    } catch (_) {
      // Malformed error frame.
    }
    return null;
  }

  static RemotePortalEventBatch? _pollBody(
    ({Uint8List bytes, Map<String, String> headers}) response,
  ) {
    try {
      final body = http.Response.bytes(
        response.bytes,
        200,
        headers: response.headers,
      ).body;
      final decoded = jsonDecode(body);
      if (decoded is! Map<String, dynamic>) return null;
      return RemotePortalEventBatch.fromJson(decoded);
    } catch (_) {
      return null;
    }
  }
}
