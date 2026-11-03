/// A synthetic browser Portal server whose event channel keeps the production
/// cursor semantics: every event is appended to one log, and a long-poll
/// `GET .../events?after=N` answers at most [CursorPortalServer.pageSize]
/// events after cursor `N`, so a client that falls behind drains its backlog
/// page by page. State reads report the current cursor. A chat-scope
/// `portal.state.request` command is answered the way the desktop does, with
/// a `portal.state.snapshot` event carrying the chat's current transcript.
///
/// It backs the real [HttpRemoteControlRepository] through a [MockClient],
/// so a device run exercises the production probe, state, command and event
/// paths with one standalone chat and no desktop. Rows and text are
/// synthetic test data.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

const String _origin = 'https://portal.test';

final class CursorPortalServer {
  CursorPortalServer({this.pollLatency = Duration.zero, this.pageSize = 25});

  static const sessionId = 'sess-1';
  static const projectId = 'ws-1';
  static const chatId = 'chat-1';

  /// Round trip added to every event poll and state read, standing in for
  /// the phone's network.
  final Duration pollLatency;

  /// Most events one poll returns (`PORTAL_BROWSER_EVENT_PAGE_MAX_COUNT`).
  final int pageSize;

  final List<Map<String, dynamic>> _log = [];
  final Map<String, Map<String, dynamic>> _transcript = {};
  final List<Completer<void>> _waiters = [];
  var _commandSeq = 0;

  /// Holds metadata or overview reads to reproduce overlapping foregrounds.
  Completer<void>? sessionReadGate;
  Completer<void>? overviewReadGate;
  int sessionReads = 0;

  /// Event polls answered, and the cursor each one asked after.
  final List<int> pollCursors = [];

  /// Overview state reads answered.
  int stateReads = 0;

  /// Chat transcript requests answered.
  int transcriptRequests = 0;

  /// The cursor of the newest event.
  int get cursor => _log.length;

  /// Adds or revises [message] in the chat and emits its live event.
  void upsertMessage(Map<String, dynamic> message) {
    _transcript[message['messageId'] as String] = message;
    _append({
      'type': 'portal.chat.event',
      'payload': {'chatId': chatId, 'scope': 'standalone', 'message': message},
    });
  }

  void _append(Map<String, dynamic> envelope) {
    _log.add({...envelope, 'eventId': 'evt-${_log.length + 1}'});
    for (final waiter in List.of(_waiters)) {
      if (!waiter.isCompleted) waiter.complete();
    }
    _waiters.clear();
  }

  /// A production repository whose service, recovery reads and event stream
  /// all reach this server.
  HttpRemoteControlRepository repository() {
    final client = MockClient(_handle);
    final apiClient = ApiClient(
      baseUrl: _origin,
      tokenProvider: () => 'token-1',
      httpClient: client,
    );
    return HttpRemoteControlRepository(
      recoveryClientFactory: () => client,
      service: RemoteControlApiService(apiClient: apiClient),
      eventStream: PortalEventStream(
        baseUrl: '$_origin$portalBrowserBasePath',
        headersProvider: apiClient.buildHeaders,
        clientFactory: () => client,
        confirmationClientFactory: () => client,
      ),
    );
  }

  /// Answers every held poll, so no request outlives the run.
  void close() {
    for (final waiter in _waiters) {
      if (!waiter.isCompleted) waiter.complete();
    }
    _waiters.clear();
  }

  Future<http.Response> _handle(http.Request request) async {
    final path = request.url.path;
    if (!path.startsWith(portalBrowserBasePath)) return _json({}, 404);
    final route = path.substring(portalBrowserBasePath.length);
    if (route == '/session' && request.method == 'GET') {
      sessionReads += 1;
      await sessionReadGate?.future;
      return _json({'session': _sessionJson});
    }
    final match = RegExp(r'^/sessions/([^/]+)/(.+)$').firstMatch(route);
    if (match == null || match.group(1) != sessionId) {
      return _json({'error': 'Not found'}, 404);
    }
    switch ((request.method, match.group(2))) {
      case ('GET', 'state'):
        return _state(request.url.queryParameters['scope']);
      case ('GET', 'events/stream'):
        // No SSE: the client falls back to the long-poll below.
        return _json({}, 404);
      case ('GET', 'events'):
        return _poll(request.url.queryParameters);
      case ('POST', 'commands'):
        return _command(request.body);
    }
    return _json({}, 404);
  }

  Future<http.Response> _state(String? scope) async {
    await Future<void>.delayed(pollLatency);
    if (scope == 'chat') {
      // The cached tail is best effort; the pushed snapshot owns the chat.
      return _json({
        'state': {'chatMessages': <Object>[]},
        'eventCursor': cursor,
        'refreshing': false,
        'scope': 'chat',
      });
    }
    if (scope != null && scope != 'overview') {
      return _json({'state': <String, Object>{}, 'refreshing': false});
    }
    stateReads += 1;
    await overviewReadGate?.future;
    return _json({
      'state': {
        'workspaces': [
          {
            'localId': projectId,
            'name': 'release-tools',
            'rootPath': '~/code/release-tools',
            'type': 'single-repo',
          },
        ],
        'worktrees': <Object>[],
        'standaloneChats': [
          {
            'localId': chatId,
            'projectLocalId': projectId,
            'title': 'Release build',
          },
        ],
      },
      'connectionStatus': 'active',
      'refreshing': false,
      'eventCursor': cursor,
      'scope': 'overview',
      'snapshot': {'scope': 'overview', 'entities': <Object>[]},
    });
  }

  Future<http.Response> _poll(Map<String, String> query) async {
    final after = int.tryParse(query['after'] ?? '') ?? 0;
    pollCursors.add(after);
    await Future<void>.delayed(pollLatency);
    if (after >= cursor) {
      final waiter = Completer<void>();
      _waiters.add(waiter);
      final timeoutMs = int.tryParse(query['timeoutMs'] ?? '') ?? 25000;
      await waiter.future.timeout(
        Duration(milliseconds: timeoutMs),
        onTimeout: () {},
      );
    }
    final start = after.clamp(0, cursor);
    final end = (start + pageSize).clamp(0, cursor);
    final page = [
      for (var i = start; i < end; i++) {..._log[i], 'cursor': i + 1},
    ];
    return _json({
      'events': page,
      'nextCursor': page.isEmpty ? cursor : end,
      'connectionStatus': 'active',
    });
  }

  Future<http.Response> _command(String body) async {
    final decoded = jsonDecode(body);
    final command = decoded is Map<String, dynamic>
        ? decoded
        : const <String, dynamic>{};
    final payload = command['payload'];
    final commandId = 'cmd-${++_commandSeq}';
    if (command['type'] == 'portal.state.request' &&
        payload is Map<String, dynamic> &&
        payload['scope'] == 'chat') {
      transcriptRequests += 1;
      // The desktop answers the request on the event channel.
      unawaited(
        Future<void>.delayed(pollLatency, () {
          _append({
            'type': 'portal.state.snapshot',
            'commandId': commandId,
            'payload': {
              'scope': 'chat',
              'target': payload['target'],
              'chatMessages': _transcript.values.toList(),
            },
          });
        }),
      );
    }
    return _json({'commandId': commandId, 'result': <String, dynamic>{}});
  }

  static const Map<String, Object> _sessionJson = {
    'id': sessionId,
    'status': 'active',
    'connectionStatus': 'active',
    'clientName': 'Studio Mac',
    'activatedAt': '2026-10-23T09:00:00Z',
    'lastSeenAt': '2026-10-23T12:00:00Z',
    'capabilities': <String, bool>{},
    'destructiveActionsEnabled': false,
  };

  static http.Response _json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status);
}
