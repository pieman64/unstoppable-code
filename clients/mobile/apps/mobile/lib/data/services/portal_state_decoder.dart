import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:mobile/data/models/remote_portal_state.dart';

import 'portal_event_decoder.dart' show PortalDecodeRunner, PortalEventDecoder;

/// Moves both JSON decoding and state-model mapping off the UI isolate for
/// large reads, using the same threshold as Portal event frames.
final class PortalStateDecoder {
  const PortalStateDecoder({
    this.offloadThreshold = PortalEventDecoder.defaultOffloadThreshold,
    this.runner = Isolate.run,
  });

  final int offloadThreshold;
  final PortalDecodeRunner runner;

  Future<RemotePortalStateResult> decode(http.Response response) {
    final input = (bytes: response.bodyBytes, headers: response.headers);
    if (input.bytes.length < offloadThreshold) {
      return Future.value(_decode(input));
    }
    return _offload(runner, input);
  }

  // No instance or HTTP request is captured by the isolate entry point.
  static Future<RemotePortalStateResult> _offload(
    PortalDecodeRunner runner,
    ({Uint8List bytes, Map<String, String> headers}) input,
  ) => runner(() => _decode(input), debugName: 'PortalStateDecoder');

  static RemotePortalStateResult _decode(
    ({Uint8List bytes, Map<String, String> headers}) input,
  ) {
    final body = http.Response.bytes(
      input.bytes,
      200,
      headers: input.headers,
    ).body;
    final json = body.isEmpty ? const <String, dynamic>{} : jsonDecode(body);
    return RemotePortalStateResult.fromJson(
      json is Map<String, dynamic> ? json : const {},
    );
  }
}
