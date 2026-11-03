/// A synthetic browser Portal server for Remote Control session-lifecycle
/// suites. It backs the real [HttpRemoteControlRepository] through a
/// [MockClient], so tests exercise the production probe, command, state and
/// event paths rather than a repository double.
///
/// It mirrors the server behavior those paths depend on:
///  * `GET .../session` returns the *account's* current session, chosen like
///    `findCurrentBrowserPortalSession`: rows that have not ended, newest
///    first, except that an ACTIVE row outranks a newer one (CAN-2981). It is
///    not a read of the phone's own session.
///  * `POST .../sessions/:id/commands` rejects any row whose status is not
///    ACTIVE with the commands route's 404.
///  * The SSE route answers 404, so the client falls back to long-poll.
///  * A long-poll holds while the row is active and answers at once with an
///    `inactive` batch otherwise. [sleep] releases held polls that way.
///
/// Rows and labels are synthetic test data.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

const String fakePortalOrigin = 'https://portal.test';

/// One persisted Portal session row.
final class FakePortalSessionRow {
  FakePortalSessionRow({
    required this.id,
    required this.clientName,
    required this.status,
    required this.connectionStatus,
    required this.eventCursor,
    required this.lastSeenAt,
    this.capabilities = const {},
    this.destructiveActionsEnabled = false,
    this.providerUsage,
    this.shellState,
  });

  final String id;
  final String clientName;

  /// Wire session status: `pending_auth`, `active` or `inactive`.
  String status;

  /// Wire connection status: `pending`, `active`, `reconnecting`,
  /// `inactive` or `ended`.
  String connectionStatus;
  int eventCursor;

  /// ISO-8601 time of the desktop's last heartbeat.
  final String lastSeenAt;
  final Map<String, bool> capabilities;
  final bool destructiveActionsEnabled;

  /// Cached `provider_usage` singleton payload the state read returns in its
  /// raw `snapshot.entities`, as the server does for the overview scope.
  Map<String, dynamic>? providerUsage;

  /// Shell state the state read returns instead of the one-workspace default.
  Map<String, dynamic>? shellState;

  /// Name of the one workspace this desktop projects, so a test can tell
  /// which desktop's shell is on screen.
  String get workspaceName => '$clientName workspace';

  Map<String, dynamic> toJson() => {
    'id': id,
    'status': status,
    'connectionStatus': connectionStatus,
    'clientName': clientName,
    'activatedAt': '2026-10-01T09:00:00Z',
    'lastSeenAt': lastSeenAt,
    'capabilities': capabilities,
    'destructiveActionsEnabled': destructiveActionsEnabled,
  };
}

final class FakePortalSessionServer {
  /// Rows in creation order; the last is the newest.
  final List<FakePortalSessionRow> rows = [];

  /// Every request as `METHOD path?query`, in arrival order.
  final List<String> requests = [];

  /// When set, `GET .../session` answers this instead of selecting a row:
  /// a status code with a body, for read failures and verbatim payloads.
  ({int status, Object body})? Function()? currentSessionOverride;

  final List<({String sessionId, Completer<http.Response> response})>
  _heldPolls = [];
  var _commandSeq = 0;
  final Map<String, List<Map<String, dynamic>>> _pendingEvents = {};

  /// Decoded `POST .../commands` bodies, in arrival order.
  final List<Map<String, dynamic>> commandBodies = [];

  /// When set, command responses wait for it, so a test can observe the
  /// state between a submit and its acknowledgement.
  Completer<void>? commandGate;

  /// When set, `POST .../end` waits for it before ending the row. Completing
  /// it with an error fails the request without ending the row, like a
  /// request that never reached the server.
  Completer<void>? endGate;

  /// Answers `POST .../connect` for a submitted code. When unset, the route
  /// answers its 404 for an account with no desktop that can take a code.
  ({int status, Object body}) Function(String code)? connectResponse;

  FakePortalSessionRow addSession({
    required String id,
    required String clientName,
    String status = 'active',
    String connectionStatus = 'active',
    int eventCursor = 0,
    String lastSeenAt = '2026-10-03T21:00:00Z',
    Map<String, bool> capabilities = const {},
    bool destructiveActionsEnabled = false,
    Map<String, dynamic>? providerUsage,
    Map<String, dynamic>? shellState,
  }) {
    final row = FakePortalSessionRow(
      id: id,
      clientName: clientName,
      status: status,
      connectionStatus: connectionStatus,
      eventCursor: eventCursor,
      lastSeenAt: lastSeenAt,
      capabilities: capabilities,
      destructiveActionsEnabled: destructiveActionsEnabled,
      providerUsage: providerUsage,
      shellState: shellState,
    );
    rows.add(row);
    return row;
  }

  FakePortalSessionRow row(String id) => rows.firstWhere((row) => row.id == id);

  /// The stale-heartbeat sweep: the row becomes revivable `inactive`, and
  /// every held long-poll answers with an `inactive` batch.
  void sleep(String id) {
    final target = row(id)
      ..status = 'inactive'
      ..connectionStatus = 'inactive';
    _releasePolls(id, target);
  }

  /// A desktop heartbeat: any desktop-facing request revives the row, and
  /// held long-polls deliver the next batch.
  void heartbeat(String id) {
    final target = row(id)
      ..status = 'active'
      ..connectionStatus = 'active'
      ..eventCursor += 1;
    _releasePolls(id, target);
  }

  /// Delivers [events] (`PortalEventEnvelope` maps) on the next long-poll
  /// batch, waking a held poll at once. Each event advances the cursor.
  void push(String id, List<Map<String, dynamic>> events) {
    final target = row(id)..eventCursor += events.length;
    _pendingEvents.putIfAbsent(id, () => []).addAll(events);
    _releasePolls(id, target);
  }

  /// Ends the row for good, the way the server's end route or a desktop
  /// replacement does. Ended rows drop out of the current-session read.
  void end(String id) {
    final target = row(id)
      ..status = 'inactive'
      ..connectionStatus = 'ended';
    _releasePolls(id, target);
  }

  /// Request paths addressed to [sessionId]'s per-session routes.
  List<String> requestsFor(String sessionId) => [
    for (final request in requests)
      if (request.contains('/sessions/$sessionId/')) request,
  ];

  /// `POST .../sessions/:id/end` requests, for any session.
  List<String> get endRequests => [
    for (final request in requests)
      if (request.startsWith('POST ') && request.endsWith('/end')) request,
  ];

  /// Long-polls for [id] the server is holding open.
  int heldPolls(String id) =>
      _heldPolls.where((poll) => poll.sessionId == id).length;

  /// A held long-poll timing out with nothing new: it answers an empty batch
  /// at the current cursor, which proves delivery the way the production
  /// stream's primer does. Without it a held poll never reports delivery.
  void answerIdle(String id) => _releasePolls(id, row(id));

  /// Pending event-stream retry pauses; [restoreDelivery] ends them.
  final List<Completer<void>> _retryPauses = [];

  /// This phone loses the server, not the desktop: every held long-poll
  /// fails, and the stream waits to retry until [restoreDelivery]. The rows,
  /// including the desktop's liveness, are untouched.
  void dropDelivery() {
    for (final poll in List.of(_heldPolls)) {
      if (!poll.response.isCompleted) {
        poll.response.complete(http.Response('{}', 503));
      }
    }
    _heldPolls.clear();
  }

  /// Lets the event stream retry after [dropDelivery].
  void restoreDelivery() {
    for (final pause in List.of(_retryPauses)) {
      pause.complete();
    }
    _retryPauses.clear();
  }

  /// Answers every held long-poll so no request outlives the test.
  void close() {
    for (final poll in List.of(_heldPolls)) {
      if (!poll.response.isCompleted) {
        poll.response.complete(http.Response('{}', 503));
      }
    }
    _heldPolls.clear();
  }

  http.Client client() => MockClient(handle);

  /// A production repository whose service, recovery reads and event
  /// stream all reach this server. Retry pauses complete only on
  /// [restoreDelivery], so a test controls every reconnect instead of racing
  /// a backoff timer.
  HttpRemoteControlRepository repository() {
    final client = this.client();
    final apiClient = ApiClient(
      baseUrl: fakePortalOrigin,
      tokenProvider: () => 'token-1',
      httpClient: client,
    );
    return HttpRemoteControlRepository(
      recoveryClientFactory: () => client,
      service: RemoteControlApiService(apiClient: apiClient),
      eventStream: PortalEventStream(
        baseUrl: '$fakePortalOrigin$portalBrowserBasePath',
        headersProvider: apiClient.buildHeaders,
        clientFactory: () => client,
        confirmationClientFactory: () => client,
        wait: (_) {
          final pause = Completer<void>();
          _retryPauses.add(pause);
          return pause.future;
        },
      ),
    );
  }

  Future<http.Response> handle(http.Request request) async {
    final path = request.url.path;
    final query = request.url.hasQuery ? '?${request.url.query}' : '';
    requests.add('${request.method} $path$query');
    if (!path.startsWith(portalBrowserBasePath)) return _json({}, 404);
    final route = path.substring(portalBrowserBasePath.length);
    if (route == '/session' && request.method == 'GET') {
      return _currentSession();
    }
    if (route == '/connect' && request.method == 'POST') {
      final body = jsonDecode(request.body);
      final code = body is Map<String, dynamic> ? '${body['code']}' : '';
      final answer =
          connectResponse?.call(code) ??
          (
            status: 404,
            body: const {
              'error':
                  'No pending remote control session was found for this '
                  'account.',
              'code': 'no_eligible_desktop',
            },
          );
      return _json(answer.body, answer.status);
    }
    final match = RegExp(r'^/sessions/([^/]+)/(.+)$').firstMatch(route);
    if (match == null) return _json({}, 404);
    final sessionId = match.group(1)!;
    final action = match.group(2)!;
    final target = rows.where((row) => row.id == sessionId).firstOrNull;
    switch ((request.method, action)) {
      case ('POST', 'commands'):
        if (target == null || target.status != 'active') {
          return _json({
            'error': 'Active remote control session not found',
          }, 404);
        }
        final body = jsonDecode(request.body);
        if (body is Map<String, dynamic>) commandBodies.add(body);
        final commandId = 'cmd-${++_commandSeq}';
        if (commandGate case final gate?) await gate.future;
        return _json({'commandId': commandId, 'result': <String, dynamic>{}});
      case ('GET', 'state'):
        if (target == null) return _json({'error': 'Not found'}, 404);
        return _json({
          'state': target.shellState ?? _defaultShellState(target),
          'connectionStatus': target.connectionStatus,
          'refreshing': false,
          'eventCursor': target.eventCursor,
          'scope': 'overview',
          'snapshot': {
            'scope': 'overview',
            'entities': [
              {
                'entityType': 'workspace',
                'localId': 'ws-${target.id}',
                'payload': {
                  'name': target.workspaceName,
                  'rootPath': '~/code/${target.id}',
                  'type': 'single-repo',
                },
              },
              if (target.providerUsage case final usage?)
                {
                  'entityType': 'provider_usage',
                  'localId': 'overview',
                  'payload': usage,
                },
            ],
          },
        });
      case ('GET', 'events/stream'):
        return _json({}, 404);
      case ('GET', 'events'):
        if (target == null) return _json({'error': 'Not found'}, 404);
        if (target.connectionStatus == 'active' &&
            (_pendingEvents[sessionId]?.isEmpty ?? true)) {
          final response = Completer<http.Response>();
          _heldPolls.add((sessionId: sessionId, response: response));
          return response.future;
        }
        return _batch(target);
      case ('POST', 'end'):
        if (endGate case final gate?) await gate.future;
        if (target != null) {
          target
            ..status = 'inactive'
            ..connectionStatus = 'ended';
        }
        return _json({'ok': true});
    }
    return _json({}, 404);
  }

  static Map<String, dynamic> _defaultShellState(FakePortalSessionRow target) =>
      {
        'workspaces': [
          {
            'localId': 'ws-${target.id}',
            'name': target.workspaceName,
            'rootPath': '~/code/${target.id}',
            'type': 'single-repo',
          },
        ],
        'worktrees': [],
        'standaloneChats': [],
      };

  http.Response _currentSession() {
    final override = currentSessionOverride?.call();
    if (override != null) return _json(override.body, override.status);
    final candidates = [
      for (final row in rows.reversed)
        if (row.connectionStatus != 'ended') row,
    ];
    final current =
        candidates.where((row) => row.status == 'active').firstOrNull ??
        candidates.firstOrNull;
    return _json({'session': current?.toJson()});
  }

  void _releasePolls(String sessionId, FakePortalSessionRow target) {
    for (final poll in List.of(_heldPolls)) {
      if (poll.sessionId != sessionId) continue;
      _heldPolls.remove(poll);
      if (!poll.response.isCompleted) poll.response.complete(_batch(target));
    }
  }

  http.Response _batch(FakePortalSessionRow target) => _json({
    'events': _pendingEvents.remove(target.id) ?? const [],
    'nextCursor': target.eventCursor,
    'connectionStatus': target.connectionStatus,
  });

  static http.Response _json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status);
}
