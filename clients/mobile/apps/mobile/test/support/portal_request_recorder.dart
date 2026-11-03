/// Counts the HTTP requests the Remote Control client sends (CAN-4872).
///
/// [PortalRequestRecorder.client] hands out [http.Client]s that record every
/// send before a handler answers it, so failed, refused and cancelled
/// requests count too. Each request gets an endpoint key with the session id
/// removed, plus a detail key for the state read's `scope` and the command's
/// `type` with its payload `scope` or PR `action`. Event-stream openings (SSE
/// and long-poll) also count as `event streams`. No headers or message text
/// are kept.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:mobile/data/services/remote_control_api_service.dart';

/// Answers one recorded request, as the synthetic server.
typedef PortalRequestHandler =
    Future<http.StreamedResponse> Function(http.Request request);

/// Count of every request in a window.
const String kRequestsKey = 'requests';

/// Count of event-stream connections (SSE and long-poll) in a window.
const String kEventStreamsKey = 'event streams';

/// A position in the request log and the time it was taken.
typedef PortalRequestMark = ({int index, DateTime at});

/// One request the client sent.
final class PortalRequest {
  PortalRequest({
    required this.at,
    required this.method,
    required this.endpoint,
    this.detail,
    this.opensEventStream = false,
  });

  /// Time on the recorder's clock when the request was sent.
  final DateTime at;
  final String method;

  /// Route below the browser Portal base, with the session id removed.
  final String endpoint;

  /// State scope or command type, when the route has one.
  final String? detail;

  /// Whether this request opens an event stream (SSE or long-poll).
  final bool opensEventStream;

  /// Response status; null until answered, and for a failed request.
  int? status;

  String get endpointKey => '$method $endpoint';

  String get key => detail == null ? endpointKey : '$endpointKey $detail';

  Map<String, Object?> toJson(DateTime start) => {
    'atMs': at.difference(start).inMilliseconds,
    'key': key,
    'status': status,
    if (opensEventStream) 'eventStream': true,
  };
}

final class PortalRequestRecorder {
  PortalRequestRecorder({DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final DateTime Function() _now;

  /// Every recorded request, in send order.
  final List<PortalRequest> requests = [];

  /// A client that records each send, then lets [handler] answer it.
  http.Client client(PortalRequestHandler handler) =>
      _RecordingClient(this, handler);

  /// A checkpoint that starts a measurement window.
  PortalRequestMark mark() => (index: requests.length, at: _now());

  /// The requests sent after [mark].
  Iterable<PortalRequest> requestsSince(PortalRequestMark mark) =>
      requests.skip(mark.index);

  /// Request counts after [mark], keyed for [requestBudgetViolations].
  Map<String, int> countsSince(PortalRequestMark mark) =>
      _countRequests(requestsSince(mark));

  PortalRequest _record(http.Request request) {
    final record = _describe(request, _now());
    requests.add(record);
    return record;
  }
}

/// Totals, endpoint counts and detail counts for [requests].
Map<String, int> _countRequests(Iterable<PortalRequest> requests) {
  final counts = <String, int>{kRequestsKey: 0, kEventStreamsKey: 0};
  void add(String key) => counts[key] = (counts[key] ?? 0) + 1;
  for (final request in requests) {
    add(kRequestsKey);
    if (request.opensEventStream) add(kEventStreamsKey);
    add(request.endpointKey);
    if (request.detail != null) add(request.key);
  }
  return counts;
}

/// Every count above its limit in [budget], as `key: count > limit`, sorted
/// by key. A key the budget does not name has a limit of zero.
List<String> requestBudgetViolations(
  Map<String, int> counts,
  Map<String, int> budget,
) => [
  for (final key in ({...counts.keys, ...budget.keys}.toList()..sort()))
    if ((counts[key] ?? 0) > (budget[key] ?? 0))
      '$key: ${counts[key] ?? 0} > ${budget[key] ?? 0}',
];

final _sessionRoute = RegExp(r'^/sessions/[^/]+/(.+)$');
final _commandStatusRoute = RegExp(r'^commands/[^/]+$');
final _attachmentRoute = RegExp(r'^attachments/[^/]+$');

PortalRequest _describe(http.Request request, DateTime at) {
  final path = request.url.path;
  final route = path.startsWith(portalBrowserBasePath)
      ? path.substring(portalBrowserBasePath.length)
      : path.startsWith(portalAttachmentBasePath)
      ? path.substring(portalAttachmentBasePath.length)
      : null;
  var endpoint = path;
  if (route != null) {
    endpoint = _sessionRoute.firstMatch(route)?.group(1) ?? route.substring(1);
    if (_commandStatusRoute.hasMatch(endpoint)) endpoint = 'commands/:id';
    if (_attachmentRoute.hasMatch(endpoint)) endpoint = 'attachments/:id';
  }
  String? detail;
  if (route != null && endpoint == 'state') {
    detail = 'scope=${request.url.queryParameters['scope']}';
  } else if (route != null && endpoint == 'commands') {
    detail = _commandDetail(request.body);
  }
  return PortalRequest(
    at: at,
    method: request.method,
    endpoint: endpoint,
    detail: detail,
    opensEventStream:
        request.method == 'GET' &&
        (endpoint == 'events' || endpoint == 'events/stream'),
  );
}

String _commandDetail(String body) {
  final Object? json;
  try {
    json = jsonDecode(body);
  } on FormatException {
    return 'unreadable';
  }
  if (json is! Map<String, dynamic>) return 'unreadable';
  final payload = json['payload'];
  final type = '${json['type']}';
  if (payload is! Map<String, dynamic>) return type;
  return switch ((payload['scope'], payload['action'])) {
    (final String scope, _) => '$type scope=$scope',
    (_, final String action) => '$type action=$action',
    _ => type,
  };
}

/// Records each send, and on [close] ends the responses it opened and
/// refuses later sends, as a closed IO client does.
final class _RecordingClient extends http.BaseClient {
  _RecordingClient(this._recorder, this._handler);

  final PortalRequestRecorder _recorder;
  final PortalRequestHandler _handler;
  final Map<StreamController<List<int>>, StreamSubscription<List<int>>> _open =
      {};
  var _closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (_closed) {
      throw http.ClientException('Client closed.', request.url);
    }
    if (request is! http.Request) {
      throw ArgumentError.value(request, 'request', 'is not an http.Request');
    }
    final record = _recorder._record(request);
    final response = await _handler(request);
    record.status = response.statusCode;
    if (_closed) {
      throw http.ClientException('Client closed.', request.url);
    }
    final body = StreamController<List<int>>();
    _open[body] = response.stream.listen(
      body.add,
      onError: body.addError,
      onDone: () {
        _open.remove(body);
        unawaited(body.close());
      },
    );
    body.onCancel = () => _open.remove(body)?.cancel();
    return http.StreamedResponse(
      body.stream,
      response.statusCode,
      contentLength: response.contentLength,
      request: request,
      headers: response.headers,
    );
  }

  @override
  void close() {
    _closed = true;
    for (final MapEntry(key: body, value: upstream) in _open.entries.toList()) {
      _open.remove(body);
      unawaited(upstream.cancel());
      body.addError(http.ClientException('Client closed.'));
      unawaited(body.close());
    }
  }
}
