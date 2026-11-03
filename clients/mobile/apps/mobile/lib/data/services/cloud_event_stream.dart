/// Raw SSE transport for mobile cloud chats.
///
/// The server intentionally ends each connection after a bounded lifetime, so
/// this client owns reconnect and cursor management rather than exposing each
/// HTTP response to callers. It shares the Portal parser and pacing policy but
/// never falls back to long-polling.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';

const String _idPresentMetadataPrefix = '__canopy_sse_id_present__:';

/// One raw frame from the cloud chat Core event stream.
final class CloudSseFrame {
  const CloudSseFrame({required this.event, required this.data, this.id});

  final String? event;
  final String data;

  /// This block's own durable id, or null when the block had no `id:` field.
  final String? id;
}

enum CloudEventStreamErrorKind { authentication, cloudUnavailable }

/// A terminal response from the cloud event-stream route.
final class CloudEventStreamException implements Exception {
  const CloudEventStreamException({
    required this.kind,
    required this.statusCode,
  });

  final CloudEventStreamErrorKind kind;
  final int statusCode;

  @override
  String toString() => 'CloudEventStreamException($kind, $statusCode)';
}

/// Raw SSE transport for one cloud chat.
final class CloudEventStream {
  CloudEventStream({
    required this.apiClient,
    http.Client Function()? clientFactory,
    DateTime Function()? now,
    double Function()? random,
    Future<void> Function(Duration delay)? wait,
  }) : _clientFactory = clientFactory ?? http.Client.new,
       _now = now ?? DateTime.now,
       _random = random ?? _defaultRandom,
       _wait = wait ?? _defaultWait;

  final ApiClient apiClient;
  final http.Client Function() _clientFactory;
  final DateTime Function() _now;
  final double Function() _random;
  final Future<void> Function(Duration delay) _wait;

  static final math.Random _sharedRandom = math.Random();

  static double _defaultRandom() => _sharedRandom.nextDouble();

  static Future<void> _defaultWait(Duration delay) =>
      Future<void>.delayed(delay);

  /// Connections that live at least this long are healthy. Their intentional
  /// server-side close reconnects immediately and resets the churn backoff.
  static const Duration minHealthyStreamLifetime = Duration(seconds: 10);

  static const int shortStreamBackoffBaseMs = 250;
  static const int shortStreamBackoffCapMs = 8000;

  Duration _shortStreamBackoff(int shortLivedStreak) {
    final exponent = math.min(shortLivedStreak - 1, 6);
    final exponentialMs = math.min(
      shortStreamBackoffCapMs,
      shortStreamBackoffBaseMs * (1 << exponent),
    );
    return Duration(
      milliseconds: (exponentialMs * (0.5 + _random() * 0.5)).round(),
    );
  }

  /// Opens the event channel for [chatId], optionally resuming after [after].
  ///
  /// Every subscription owns one [http.Client]. Cancelling closes that client
  /// immediately, which hard-aborts a held-open socket.
  Stream<CloudSseFrame> open(String chatId, {String? after}) {
    late StreamController<CloudSseFrame> controller;
    http.Client? client;
    var running = true;

    Future<void> run() async {
      final activeClient = _clientFactory();
      client = activeClient;
      var cursor = after;
      var shortLivedStreak = 0;

      try {
        while (running) {
          final connectedAt = _now();
          http.StreamedResponse response;
          try {
            response = await activeClient.send(
              _request(chatId: chatId, cursor: cursor),
            );
          } catch (_) {
            if (!running) return;
            shortLivedStreak += 1;
            await _wait(_shortStreamBackoff(shortLivedStreak));
            continue;
          }

          if (response.statusCode == 401 || response.statusCode == 403) {
            controller.addError(
              CloudEventStreamException(
                kind: CloudEventStreamErrorKind.authentication,
                statusCode: response.statusCode,
              ),
            );
            return;
          }
          if (response.statusCode == 404) {
            controller.addError(
              const CloudEventStreamException(
                kind: CloudEventStreamErrorKind.cloudUnavailable,
                statusCode: 404,
              ),
            );
            return;
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            await _consume(
              response,
              isRunning: () => running,
              emit: (frame) {
                if (!running) return;
                if (frame.id != null) cursor = frame.id;
                controller.add(frame);
              },
            );
          } else {
            try {
              await response.stream.drain<void>();
            } catch (_) {
              // A failed error-body stream is another transient transport
              // failure; reconnect using the same pacing policy below.
            }
          }
          if (!running) return;

          final lifetime = _now().difference(connectedAt);
          if (lifetime >= minHealthyStreamLifetime) {
            shortLivedStreak = 0;
          } else {
            shortLivedStreak += 1;
            await _wait(_shortStreamBackoff(shortLivedStreak));
          }
        }
      } finally {
        activeClient.close();
        if (!controller.isClosed) await controller.close();
      }
    }

    controller = StreamController<CloudSseFrame>(
      onListen: () => unawaited(run()),
      onCancel: () {
        running = false;
        client?.close();
      },
    );
    return controller.stream;
  }

  http.Request _request({required String chatId, required String? cursor}) {
    final encodedChatId = Uri.encodeComponent(chatId);
    final uri = Uri.parse(
      '${apiClient.baseUrl}/api/cloud/chats/$encodedChatId/events/stream',
    ).replace(queryParameters: cursor == null ? null : {'after': cursor});
    final request = http.Request('GET', uri);
    request.headers.addAll(
      apiClient.buildHeaders({
        'Accept': 'text/event-stream',
        'Last-Event-ID': ?cursor,
      }),
    );
    return request;
  }

  Future<void> _consume(
    http.StreamedResponse response, {
    required bool Function() isRunning,
    required void Function(CloudSseFrame frame) emit,
  }) async {
    var buffer = '';
    try {
      await for (final chunk in response.stream.transform(utf8.decoder)) {
        if (!isRunning()) return;
        var offset = 0;
        while (offset < chunk.length) {
          final capacity = kMaxPortalSseBufferChars - buffer.length;
          if (capacity <= 0) return;
          final remaining = chunk.length - offset;
          final take = math.min(remaining, capacity);
          buffer += chunk.substring(offset, offset + take);
          offset += take;

          final parsed = parsePortalSseFrames(buffer);
          buffer = parsed.remainder;
          for (final frame in parsed.frames) {
            emit(_stripProxyMetadata(frame));
          }

          // The current incomplete frame filled the entire bounded buffer.
          // Reconnect from the previous accepted cursor instead of retaining
          // unbounded input.
          if (buffer.length >= kMaxPortalSseBufferChars) return;
        }
      }
    } catch (_) {
      // Transport loss is recovered by the outer reconnect loop. Terminal
      // HTTP responses are handled before this method is entered.
    }
  }

  static CloudSseFrame _stripProxyMetadata(SseFrame frame) {
    final separator = frame.data.lastIndexOf('\n');
    if (separator == -1) {
      return CloudSseFrame(event: frame.event, data: frame.data, id: frame.id);
    }

    final metadata = frame.data.substring(separator + 1);
    if (metadata == '${_idPresentMetadataPrefix}1') {
      return CloudSseFrame(
        event: frame.event,
        data: frame.data.substring(0, separator),
        id: frame.id,
      );
    }
    if (metadata == '${_idPresentMetadataPrefix}0') {
      return CloudSseFrame(
        event: frame.event,
        data: frame.data.substring(0, separator),
      );
    }
    return CloudSseFrame(event: frame.event, data: frame.data, id: frame.id);
  }
}
