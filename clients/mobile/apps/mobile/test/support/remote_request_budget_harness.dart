/// A synthetic Portal server and paired desktop for the Remote Control
/// request budgets (CAN-4872). Every client the real
/// [HttpRemoteControlRepository] uses comes from one [PortalRequestRecorder],
/// so the budgets count what the production client sends.
///
/// The server follows the production routes the client relies on:
///  * `GET .../session` returns the one paired session.
///  * `GET .../events/stream` opens SSE with the server's primer, a
///    `: keepalive` every 10 seconds, and a batch for each new event. While
///    the desktop is inactive it sends one inactive batch and ends the
///    response, as the server does. [BudgetDesktop.wake] makes the next
///    stream report the desktop active; [BudgetDesktop.failStreams] fails
///    the next streams with 503.
///  * `GET .../events` long-polls: it answers at once with new events or
///    while the desktop is inactive, and otherwise holds for 25 seconds.
///  * `GET .../state` answers the overview, worktree, pipelines and chat
///    scopes from the desktop's current state. The overview's chat summary
///    is the server's cache: the last summary the desktop projected.
///  * `POST .../commands` answers while the session is active. The server
///    waits for `portal.state.request` and `portal.chat.send`, so their
///    events come first and the state request returns its result inline. The
///    desktop runs other commands 100 ms after the acknowledgement. Events
///    reach every open stream. [BudgetDesktop.holdChatSnapshot] keeps chat
///    state requests waiting, as for a slow desktop.
///
/// `portal.hook.pause` and `portal.hook.resume` send the desktop's
/// `portal.hook.event` descriptor upserts, then the completion.
/// `portal.worktree.create` answers with its command id only, as when the
/// desktop outlives the server's wait; the desktop then sends the new
/// worktree's delta and the completion carrying its id.
/// `portal.workspace.create` clones a project the same way: the desktop
/// sends the workspace delta and the completion, unless
/// [BudgetDesktop.loseCloneCompletion] drops them. `GET .../commands/:id`
/// then reports the clone completed.
///
/// [BudgetDesktop.addStandaloneChat] adds an active standalone chat to the
/// shell. [BudgetDesktop.startStandaloneActivity] then sends its
/// `standalone_chat` delta every five seconds, as the desktop does while the
/// chat works.
///
/// Any other route answers 404 and lands in [BudgetDesktop.unexpected].
/// Rows, labels and messages are synthetic test data.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

import 'portal_event_workloads.dart' show sseFrame;
import 'portal_request_recorder.dart';
import 'portal_transport_driver.dart';

const String budgetChatId = 'chat-1';
const String budgetWorkspaceName = 'Budget workspace';
const String budgetStandaloneChatId = 'sc-1';
const String budgetStandaloneTitle = 'Budget standalone chat';
const String budgetWorkspaceId = 'ws-1';
const String budgetHookKey = 'hook-lint';
const String budgetHookName = 'Lint on save';
const String budgetCreatedWorktreeId = 'wt-2';
const String budgetClonedWorkspaceId = 'ws-2';
const String budgetClonedWorkspaceName = 'Cloned workspace';
const String _origin = 'https://budget.test';
const String _sessionId = 'sess-budget';
const String _workspaceId = budgetWorkspaceId;
const String _worktreeId = 'wt-1';
const String _worktreeLabel = 'koala';
const String _coworkProjectId = 'ws-cowork';

/// The desktop capabilities the fixture announces: foreground chat
/// hydration, read receipts and PR actions, so the visible chat's PR poll
/// runs. Every other capability is off.
const Map<String, bool> budgetCapabilities = {
  'foreground_worktree_chat': true,
  'chat_mark_read': true,
  'pr_worktree_actions': true,
};

/// Fixed settle window after each action: covers the 1200 ms overview
/// debounce and the 2 s read-receipt recheck.
const Duration budgetSettle = Duration(seconds: 5);

const Duration _keepaliveInterval = Duration(seconds: 10);

/// How long the long-poll route holds a request with nothing to send.
const Duration _longPollHold = Duration(seconds: 25);

/// How long the desktop takes to run a command the server does not wait on.
const Duration _desktopLatency = Duration(milliseconds: 100);

/// How often an active standalone chat sends its row while it works.
const Duration _standaloneActivityInterval = Duration(seconds: 5);

final class BudgetDesktop {
  BudgetDesktop({required DateTime Function() now})
    : _now = now,
      recorder = PortalRequestRecorder(now: now),
      _lastSeenAt = now();

  final DateTime Function() _now;
  final PortalRequestRecorder recorder;

  /// Requests no route answered, as `METHOD path`.
  final List<String> unexpected = [];

  /// Decoded `POST .../commands` bodies, in arrival order.
  final List<Map<String, dynamic>> commands = [];
  String diffPatch = '@@ -1 +1 @@\n-old\n+new\n';

  /// The desktop's transcript of [budgetChatId], in the live wire shape.
  final List<Map<String, dynamic>> messages = [
    _message('msg-1', 'user', 'Count the requests each flow makes.', 0),
    _message('msg-2', 'assistant', 'Each flow now has a pinned budget.', 1),
  ];

  /// Whether the chat has output the user has not read.
  bool get chatUnread => _chatUnread;

  String get lastMessageText => messages.last['text'] as String;

  /// Cold or stale chat caches still require the desktop projection.
  List<Map<String, dynamic>>? cachedChatRows;
  bool chatCacheMissing = false;
  bool chatCacheStale = false;
  bool overviewRefreshing = false;
  bool supportsSpeculativeWork = false;

  var _chatUnread = false;

  /// The unread flag of the last summary the desktop projected, which is
  /// all the server's state cache knows.
  var _projectedChatUnread = false;
  String _connectionStatus = 'active';
  DateTime _lastSeenAt;
  int _cursor = 40;
  var _commandSeq = 0;
  final List<Map<String, dynamic>> _events = [];
  final Set<_EventStream> _streams = {};
  final Set<_HeldPoll> _polls = {};
  Completer<void>? _chatSnapshotHold;
  var _heldChatRequests = 0;
  var _failingStreams = 0;
  var _announceActive = false;
  String? _standaloneLastMessageAt;
  Timer? _standaloneActivity;
  var _hookPaused = false;
  String? _createdWorktreeAt;
  String? _cloneCommandId;

  /// Whether the desktop's events for the next clone are lost, as when the
  /// stream drops while it runs.
  bool loseCloneCompletion = false;

  bool pushesPrStatus = false;

  /// `standalone_chat` deltas sent by [startStandaloneActivity].
  int standaloneDeltas = 0;

  /// The standalone chat's last activity time, as its row reports it.
  String? get standaloneLastMessageAt => _standaloneLastMessageAt;

  /// A production repository whose API, recovery, event-stream and
  /// confirmation clients all come from [recorder].
  HttpRemoteControlRepository repository() {
    http.Client client() => recorder.client(_handle);
    final apiClient = ApiClient(
      baseUrl: _origin,
      tokenProvider: () => 'token-budget',
      httpClient: client(),
    );
    return HttpRemoteControlRepository(
      service: RemoteControlApiService(apiClient: apiClient),
      recoveryClientFactory: client,
      eventStream: PortalEventStream(
        baseUrl: '$_origin$portalBrowserBasePath',
        headersProvider: apiClient.buildHeaders,
        clientFactory: client,
        confirmationClientFactory: client,
        now: _now,
        // Fixed jitter keeps any backoff deterministic.
        random: () => 0.5,
      ),
    );
  }

  /// The desktop stops heartbeating: the session turns inactive, and each
  /// open stream gets the inactive batch and ends.
  void sleep() {
    _connectionStatus = 'inactive';
    _lastSeenAt = _now();
    _deliverAll();
  }

  /// The desktop heartbeats again: the session turns active, and the next
  /// stream gets one batch reporting it, as the server's next poll cycle
  /// does.
  void wake() {
    _connectionStatus = 'active';
    _lastSeenAt = _now();
    _announceActive = true;
  }

  /// The next [count] event-stream connections fail with 503, as during a
  /// network change.
  void failStreams(int count) => _failingStreams = count;

  /// The assistant answers in [budgetChatId]; the chat turns unread.
  void reply(String text) {
    final message = _message(
      'msg-${messages.length + 1}',
      'assistant',
      text,
      messages.length,
    );
    messages.add(message);
    _chatUnread = true;
    _push([_chatEvent(message), _summaryDelta()]);
  }

  /// Another client reads [budgetChatId]. Its summary projection fails, so
  /// the phone and the server's state cache keep the old unread flag.
  void readElsewhere() => _chatUnread = false;

  /// Whether a completed read loses its summary delta.
  bool loseReadSummary = false;

  /// Whether a summary projected before a completed read arrives after its
  /// completion, in a later batch, with the old unread flag.
  bool sendStaleSummaryAfterRead = false;

  /// Whether another client's read and then a desktop unread, both before a
  /// completed read applied, arrive ahead of its completion.
  bool confirmElsewhereBeforeRead = false;

  /// Whether a read's completion and summary reach the server 2 seconds
  /// after the acknowledgement, as when the desktop is busy.
  bool delayReadCompletion = false;

  /// The desktop marks [budgetChatId] unread; its output stays the same.
  void markUnread() {
    _chatUnread = true;
    _push([_summaryDelta()]);
  }

  /// Keeps each chat `portal.state.request` waiting until
  /// [releaseChatSnapshot], so the client shows the cached chat state first.
  void holdChatSnapshot() => _chatSnapshotHold ??= Completer<void>();

  /// Lets the held chat state requests finish; returns how many waited.
  int releaseChatSnapshot() {
    _chatSnapshotHold?.complete();
    _chatSnapshotHold = null;
    final held = _heldChatRequests;
    _heldChatRequests = 0;
    return held;
  }

  /// Adds [budgetStandaloneChatId], a working standalone chat, to the shell.
  void addStandaloneChat() =>
      _standaloneLastMessageAt = _now().toUtc().toIso8601String();

  /// Sends the standalone chat's row every five seconds, with its latest
  /// activity time, until [stopStandaloneActivity].
  void startStandaloneActivity() {
    _standaloneActivity = Timer.periodic(_standaloneActivityInterval, (_) {
      _standaloneLastMessageAt = _now().toUtc().toIso8601String();
      standaloneDeltas += 1;
      _push([
        {
          'type': 'portal.state.delta',
          'payload': {
            'scope': 'standalone_chat',
            'target': {'standaloneChatLocalId': budgetStandaloneChatId},
            'entities': [_standaloneEntity()],
          },
        },
      ]);
    });
  }

  void stopStandaloneActivity() => _standaloneActivity?.cancel();

  /// Whether the desktop has [budgetHookKey] paused in the worktree.
  bool get hookPaused => _hookPaused;

  /// Ends every open stream and long-poll so no timer outlives the test.
  void close() {
    stopStandaloneActivity();
    for (final stream in _streams.toList()) {
      _drop(stream);
    }
    for (final poll in _polls.toList()) {
      _answer(poll, _json({'error': 'Service unavailable'}, 503));
    }
  }

  Future<http.StreamedResponse> _handle(http.Request request) async {
    final path = request.url.path;
    if (request.method == 'GET' && path == '$portalBrowserBasePath/session') {
      return _json({'session': _session()});
    }
    final prefix = '$portalBrowserBasePath/sessions/$_sessionId/';
    final route = path.startsWith(prefix) ? path.substring(prefix.length) : '';
    switch ((request.method, route)) {
      case ('GET', 'events/stream') when _failingStreams > 0:
        _failingStreams -= 1;
        return _json({'error': 'Service unavailable'}, 503);
      case ('GET', 'events/stream'):
        final after = int.tryParse(request.url.queryParameters['after'] ?? '');
        return _openStream(after ?? 0);
      case ('GET', 'events'):
        final after = int.tryParse(request.url.queryParameters['after'] ?? '');
        return _poll(after ?? 0);
      case ('GET', 'state'):
        if (_state(request.url.queryParameters['scope']) case final state?) {
          return _json(state);
        }
      case ('POST', 'diff/read'):
        final payload = jsonDecode(request.body) as Map<String, dynamic>;
        return _json({'filePath': payload['path'], 'patch': diffPatch});
      case ('POST', 'commands'):
        return _command(request.body);
      case ('GET', final status) when status == 'commands/$_cloneCommandId':
        return _json({
          'commandId': _cloneCommandId,
          'status': 'COMPLETED',
          'result': {'workspaceId': budgetClonedWorkspaceId},
        });
    }
    unexpected.add('${request.method} $path');
    return _json({'error': 'Not found'}, 404);
  }

  Map<String, dynamic> _session() => {
    'id': _sessionId,
    'status': _connectionStatus,
    'connectionStatus': _connectionStatus,
    'clientName': 'Budget Desktop',
    'activatedAt': '2015-01-01T00:00:00Z',
    'lastSeenAt': _lastSeenAt.toUtc().toIso8601String(),
    'capabilities': {
      ...budgetCapabilities,
      'pr_status_push_v1': pushesPrStatus,
      'app_advisor': supportsSpeculativeWork,
      'worktree_chat_summaries_scope': supportsSpeculativeWork,
    },
    'destructiveActionsEnabled': false,
  };

  http.StreamedResponse _openStream(int after) {
    late final _EventStream stream;
    stream = _EventStream(
      PortalSseResponse(onCancel: () => _drop(stream)),
      after,
    );
    _streams.add(stream);
    stream.body.write('retry: 3000\n: connected\n\n');
    stream.keepalive = Timer.periodic(
      _keepaliveInterval,
      (_) => stream.body.write(': keepalive\n\n'),
    );
    // Hand the response back before the first batch, as the server does.
    scheduleMicrotask(() => _deliver(stream));
    return stream.body.response;
  }

  /// Sends [stream] the events after its cursor; while the desktop is
  /// inactive, sends that batch even when empty and ends the stream.
  void _deliver(_EventStream stream) {
    if (!_streams.contains(stream)) return;
    final batch = _batchAfter(stream.cursor);
    if (batch == null) return;
    stream.cursor = _cursor;
    stream.body.write('id: $_cursor\n${sseFrame(batch)}');
    if (_connectionStatus != 'active') _drop(stream);
  }

  /// The batch after [cursor], or null while the desktop is active with
  /// nothing new to say.
  String? _batchAfter(int cursor, {bool always = false}) {
    final events = [
      for (final event in _events)
        if ((event['cursor'] as int) > cursor) event,
    ];
    final active = _connectionStatus == 'active';
    if (events.isEmpty && active && !_announceActive && !always) return null;
    _announceActive = false;
    return jsonEncode({
      'events': events,
      'nextCursor': _cursor,
      'connectionStatus': _connectionStatus,
    });
  }

  /// Holds a long-poll until there is a batch for it, or answers it empty
  /// after the server's hold, as the long-poll route does.
  Future<http.StreamedResponse> _poll(int after) {
    final poll = _HeldPoll(after);
    _polls.add(poll);
    poll.hold = Timer(_longPollHold, () {
      _answer(poll, _batchResponse(_batchAfter(after, always: true)!));
    });
    _deliverPoll(poll);
    return poll.response.future;
  }

  void _deliverPoll(_HeldPoll poll) {
    if (_batchAfter(poll.after) case final batch?) {
      _answer(poll, _batchResponse(batch));
    }
  }

  void _answer(_HeldPoll poll, http.StreamedResponse response) {
    if (!_polls.remove(poll)) return;
    poll.hold.cancel();
    poll.response.complete(response);
  }

  static http.StreamedResponse _batchResponse(String batch) =>
      http.StreamedResponse(
        Stream.value(utf8.encode(batch)),
        200,
        headers: const {'content-type': 'application/json'},
      );

  void _deliverAll() {
    for (final stream in _streams.toList()) {
      _deliver(stream);
    }
    for (final poll in _polls.toList()) {
      _deliverPoll(poll);
    }
  }

  void _drop(_EventStream stream) {
    if (!_streams.remove(stream)) return;
    stream.keepalive.cancel();
    if (stream.body.isOpen) unawaited(stream.body.close());
  }

  /// The server stores [events] in order; its state cache keeps each
  /// projected summary of [budgetChatId].
  void _push(List<Map<String, dynamic>> events) {
    for (final event in events) {
      final payload = event['payload'];
      if (payload is Map<String, dynamic> &&
          payload['entities'] is List<Object?>) {
        for (final entity in payload['entities'] as List<Object?>) {
          if (entity case {
            'entityType': 'chat_summary',
            'payload': {'hasUnread': final bool unread},
          }) {
            _projectedChatUnread = unread;
          }
        }
      }
      _cursor += 1;
      _events.add({
        ...event,
        'eventId': 'ev-$_cursor',
        'cursor': _cursor,
        'occurredAt': _now().toUtc().toIso8601String(),
      });
    }
    _deliverAll();
  }

  Map<String, dynamic>? _state(String? scope) {
    final state = switch (scope) {
      'overview' => _shell(),
      'worktree' => _worktreeSlices(),
      'pipelines' => <String, dynamic>{'pipelineRuns': <Object>[]},
      'chat' => {
        'chatMessages': chatCacheMissing
            ? <Object>[]
            : cachedChatRows ?? messages.map(_messageView).toList(),
      },
      _ => null,
    };
    if (state == null) return null;
    return {
      'state': state,
      'connectionStatus': _connectionStatus,
      'refreshing':
          (scope == 'chat' && chatCacheStale) ||
          (scope == 'overview' && overviewRefreshing),
      'eventCursor': _cursor,
      'scope': scope,
      if (scope == 'chat')
        'chatTailCoverage': {
          'snapshotCursor': 40,
          'orderedMessageIds': [
            for (final message in messages) message['messageId'],
          ],
        },
      'snapshot': {
        'scope': scope,
        'entities': [if (scope == 'overview') _workspaceEntity()],
      },
    };
  }

  Future<http.StreamedResponse> _command(String body) async {
    if (_connectionStatus != 'active') {
      return _json({'error': 'Active remote control session not found'}, 404);
    }
    final command = jsonDecode(body) as Map<String, dynamic>;
    commands.add(command);
    final type = command['type'] as String;
    final payload = command['payload'] as Map<String, dynamic>? ?? const {};
    if (_chatSnapshotHold case final hold?
        when type == 'portal.state.request' && payload['scope'] == 'chat') {
      _heldChatRequests += 1;
      await hold.future;
    }
    final commandId = 'cmd-${++_commandSeq}';
    final events = <Map<String, dynamic>>[];
    var result = <String, dynamic>{};
    switch (type) {
      case 'portal.state.request':
        events.add(_snapshot(payload, commandId));
      case 'portal.chat.send':
        final message = _message(
          payload['userMessageId'] as String? ?? 'msg-${messages.length + 1}',
          'user',
          payload['text'] as String? ?? '',
          messages.length,
        );
        messages.add(message);
        events.add(_chatEvent(message));
      case 'portal.chat.mark_read':
        // The desktop completes the read, then its sidebar refresh sends
        // the summary delta. An already-read chat sends no delta.
        if (!_chatUnread) result = {'ok': true, 'applied': false};
        _chatUnread = false;
        if (sendStaleSummaryAfterRead && result['applied'] != false) {
          final stale = _summaryDelta(unread: true);
          Timer(_desktopLatency * 2, () => _push([stale]));
        }
        if (confirmElsewhereBeforeRead && result['applied'] != false) {
          _push([_summaryDelta(unread: false), _summaryDelta(unread: true)]);
        }
      case 'portal.pr.action':
        result = {
          'repos': [_prRepo()],
          'busy': false,
        };
      case 'portal.hook.pause' || 'portal.hook.resume':
        // The desktop upserts every hook descriptor, then completes.
        _hookPaused = type == 'portal.hook.pause';
        events.add({
          'type': 'portal.hook.event',
          'commandId': commandId,
          'payload': {'kind': 'upsert', 'entity': _hookEntity()},
        });
        result = {
          'projectId': _workspaceId,
          'worktreeId': _worktreeId,
          'pausedHookKeys': [if (_hookPaused) budgetHookKey],
        };
      case 'portal.worktree.create':
        _createdWorktreeAt = _now().toUtc().toIso8601String();
        events.add({
          'type': 'portal.state.delta',
          'payload': {
            'scope': 'worktree',
            'target': {
              'workspaceLocalId': _workspaceId,
              'worktreeLocalId': budgetCreatedWorktreeId,
            },
            'entities': [_createdWorktreeEntity()],
          },
        });
        result = {'id': budgetCreatedWorktreeId};
      case 'portal.workspace.create':
        _cloneCommandId = commandId;
        if (loseCloneCompletion) {
          return _json({'commandId': commandId});
        }
        events.add({
          'type': 'portal.state.delta',
          'payload': {
            'scope': 'workspace',
            'entities': [_clonedWorkspaceEntity()],
          },
        });
        result = {'workspaceId': budgetClonedWorkspaceId};
    }
    events.add({
      'type': 'portal.command.completed',
      'commandId': commandId,
      'payload': {'commandId': commandId, 'result': result},
    });
    if (type == 'portal.chat.mark_read' &&
        result['applied'] != false &&
        !loseReadSummary) {
      events.add(_summaryDelta());
    }
    // The server waits for these results before it answers; the desktop
    // runs other commands after the acknowledgement.
    if (type == 'portal.state.request' || type == 'portal.chat.send') {
      _push(events);
    } else {
      final slow = delayReadCompletion && type == 'portal.chat.mark_read';
      Timer(slow ? const Duration(seconds: 2) : _desktopLatency, () {
        _push(events);
      });
    }
    return _json({
      'commandId': commandId,
      if (type == 'portal.state.request') 'result': result,
      if (type == 'portal.chat.send') 'chatId': payload['chatId'],
    });
  }

  Map<String, dynamic> _snapshot(
    Map<String, dynamic> payload,
    String commandId,
  ) {
    final scope = payload['scope'];
    return {
      'type': 'portal.state.snapshot',
      'commandId': commandId,
      'payload': {
        'scope': scope,
        'target': ?payload['target'],
        if (scope == 'chat') ...{
          'chatMessages': messages,
          'chatMessagesTruncated': false,
          'selectedChatOnly': payload['selectedChatOnly'] == true,
        },
        'entities': [
          if (scope == 'overview') ...[
            _workspaceEntity(),
            if (_cloneCommandId != null) _clonedWorkspaceEntity(),
            _worktreeEntity(),
            if (_createdWorktreeAt != null) _createdWorktreeEntity(),
            if (_standaloneLastMessageAt != null) _standaloneEntity(),
          ],
          if (scope != 'pipelines') _summaryEntity(),
        ],
      },
    };
  }

  Map<String, dynamic> _chatEvent(Map<String, dynamic> message) => {
    'type': 'portal.chat.event',
    'payload': {
      'scope': 'worktree',
      'chatId': budgetChatId,
      'workspaceLocalId': _workspaceId,
      'worktreeLocalId': _worktreeId,
      'message': message,
    },
  };

  Map<String, dynamic> _summaryDelta({bool? unread}) => {
    'type': 'portal.state.delta',
    'payload': {
      'scope': 'worktree',
      'target': {
        'workspaceLocalId': _workspaceId,
        'worktreeLocalId': _worktreeId,
      },
      'entities': [_summaryEntity(unread: unread), _worktreeEntity()],
    },
  };

  Map<String, dynamic> _shell() => {
    'workspaces': [
      {'localId': _workspaceId, ..._workspace()},
      if (_cloneCommandId != null)
        {'localId': budgetClonedWorkspaceId, ..._clonedWorkspace()},
    ],
    'worktrees': [
      {'localId': _worktreeId, ..._worktree()},
      if (_createdWorktreeAt != null)
        {'localId': budgetCreatedWorktreeId, ..._createdWorktree()},
    ],
    'standaloneChats': [
      if (_standaloneLastMessageAt != null)
        {'localId': budgetStandaloneChatId, ..._standaloneChat()},
    ],
    'chatSummaries': [_summary(unread: _projectedChatUnread)],
  };

  Map<String, dynamic> _worktreeSlices() => {
    'changedFiles': {
      _worktreeId: {
        'worktreeLocalId': _worktreeId,
        'revision': 'diff-revision-1',
        'uncommitted': [
          {
            'filePath': 'lib/request_budget.dart',
            'status': 'modified',
            'insertions': 12,
            'deletions': 3,
          },
        ],
        'committed': <Object>[],
      },
    },
    'todoLists': [
      {
        'worktreeLocalId': _worktreeId,
        'chatId': budgetChatId,
        'items': [
          {'id': 'todo-1', 'content': 'Pin each flow', 'status': 'completed'},
        ],
      },
    ],
    'hookDescriptors': [_hook()],
  };

  /// The worktree's one hook, as `PortalHookSummary`.
  Map<String, dynamic> _hook() => {
    'workspaceLocalId': _workspaceId,
    'worktreeLocalId': _worktreeId,
    'hookId': budgetHookKey,
    'hookKey': budgetHookKey,
    'name': budgetHookName,
    'triggerName': 'pre_task',
    'target': 'project',
    'paused': _hookPaused,
  };

  Map<String, dynamic> _hookEntity() => {
    'entityType': 'hook_descriptor',
    'localId': budgetHookKey,
    'parentLocalId': '$_workspaceId:$_worktreeId',
    'payload': _hook(),
  };

  Map<String, dynamic> _clonedWorkspace() => {
    'name': budgetClonedWorkspaceName,
    'rootPath': '~/code/cloned',
    'type': 'single-repo',
  };

  Map<String, dynamic> _clonedWorkspaceEntity() => {
    'entityType': 'workspace',
    'localId': budgetClonedWorkspaceId,
    'payload': _clonedWorkspace(),
  };

  Map<String, dynamic> _createdWorktree() => {
    'workspaceLocalId': _workspaceId,
    'branch': 'feature/otter',
    'label': 'otter',
    'status': 'active',
    'createdAt': _createdWorktreeAt,
  };

  Map<String, dynamic> _createdWorktreeEntity() => {
    'entityType': 'worktree',
    'localId': budgetCreatedWorktreeId,
    'parentLocalId': _workspaceId,
    'payload': _createdWorktree(),
  };

  Map<String, dynamic> _workspace() => {
    'name': budgetWorkspaceName,
    'rootPath': '~/code/budget',
    'type': 'single-repo',
  };

  Map<String, dynamic> _worktree() => {
    'workspaceLocalId': _workspaceId,
    'branch': 'feature/request-budget',
    'label': _worktreeLabel,
    'status': 'active',
    'hasUnread': _chatUnread,
    'lastKnownPrStatus': {
      'repos': [_prRepo()],
    },
  };

  Map<String, dynamic> _prRepo() => {
    'repoId': '__workspace_root__',
    'status': {'prNumber': 4872, 'state': 'open'},
  };

  Map<String, dynamic> _summary({bool? unread}) => {
    'chatId': budgetChatId,
    'scope': 'worktree',
    'workspaceLocalId': _workspaceId,
    'worktreeLocalId': _worktreeId,
    'title': 'Request budgets',
    'active': true,
    'hasUnread': unread ?? _chatUnread,
    'lastMessageAt': messages.last['createdAt'],
  };

  Map<String, dynamic> _workspaceEntity() => {
    'entityType': 'workspace',
    'localId': _workspaceId,
    'payload': _workspace(),
  };

  Map<String, dynamic> _worktreeEntity() => {
    'entityType': 'worktree',
    'localId': _worktreeId,
    'parentLocalId': _workspaceId,
    'payload': _worktree(),
  };

  Map<String, dynamic> _standaloneChat() => {
    'projectLocalId': _coworkProjectId,
    'title': budgetStandaloneTitle,
    'hasActiveChat': true,
    'lastMessageAt': _standaloneLastMessageAt,
  };

  Map<String, dynamic> _standaloneEntity() => {
    'entityType': 'standalone_chat',
    'localId': budgetStandaloneChatId,
    'parentLocalId': _coworkProjectId,
    'payload': _standaloneChat(),
  };

  Map<String, dynamic> _summaryEntity({bool? unread}) => {
    'entityType': 'chat_summary',
    'localId': budgetChatId,
    'payload': _summary(unread: unread),
  };

  static Map<String, dynamic> _message(
    String id,
    String role,
    String text,
    int index,
  ) {
    final createdAt = DateTime.utc(2015).add(Duration(minutes: index));
    return {
      'messageId': id,
      'chatId': budgetChatId,
      'scope': 'worktree',
      'role': role,
      'status': 'complete',
      'text': text,
      'createdAtMs': createdAt.millisecondsSinceEpoch,
      'createdAt': createdAt.toIso8601String(),
    };
  }

  /// [message] as the server's state projection (`PortalChatMessageView`)
  /// that `GET .../state` returns.
  static Map<String, dynamic> _messageView(Map<String, dynamic> message) => {
    'scope': message['scope'],
    'localChatId': message['chatId'],
    'localMessageId': message['messageId'],
    'workspaceLocalId': _workspaceId,
    'worktreeLocalId': _worktreeId,
    'role': message['role'],
    'status': message['status'],
    'content': message['text'],
    'occurredAt': message['createdAt'],
  };

  static http.StreamedResponse _json(Object body, [int status = 200]) =>
      http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(body))),
        status,
        headers: const {'content-type': 'application/json'},
      );
}

final class _HeldPoll {
  _HeldPoll(this.after);

  final int after;
  final response = Completer<http.StreamedResponse>();
  late final Timer hold;
}

final class _EventStream {
  _EventStream(this.body, this.cursor);

  final PortalSseResponse body;
  int cursor;
  late final Timer keepalive;
}

/// One flow's fixture: the desktop, the real view model on its repository,
/// and the Remote tab at phone width.
final class RequestBudgetFixture {
  RequestBudgetFixture._(this.desktop, this.viewModel)
    : start = desktop.recorder.mark();

  final BudgetDesktop desktop;
  final RemoteControlViewModel viewModel;

  /// Taken before the Remote tab first mounts.
  final PortalRequestMark start;

  /// Every count above its budget in the windows [measure] checked, as
  /// `window: key: count > limit`.
  final List<String> overBudget = [];

  /// Checks the requests sent since [mark] against [budget], and prints the
  /// window's counts and requests so each run reports its numbers.
  void measure(String window, PortalRequestMark mark, Map<String, int> budget) {
    final counts = recorder.countsSince(mark);
    final report = jsonEncode({
      'window': window,
      'counts': counts,
      'requests': [
        for (final request in recorder.requestsSince(mark))
          request.toJson(mark.at),
      ],
    });
    // ignore: avoid_print
    print('REQUEST_BUDGET $report');
    overBudget.addAll([
      for (final violation in requestBudgetViolations(counts, budget))
        '$window: $violation',
    ]);
  }

  PortalRequestRecorder get recorder => desktop.recorder;

  /// Mounts the Remote tab on a fresh client and waits for the first
  /// overview. [prepare] sets up the desktop's state before the client
  /// connects.
  static Future<RequestBudgetFixture> connect(
    WidgetTester tester, {
    void Function(BudgetDesktop desktop)? prepare,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final now = tester.binding.clock.now;
    final desktop = BudgetDesktop(now: now);
    prepare?.call(desktop);
    final viewModel = RemoteControlViewModel(
      repository: desktop.repository(),
      clock: now,
    );
    final fixture = RequestBudgetFixture._(desktop, viewModel);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          navigatorObservers: [appRouteObserver],
          home: const RemoteScreen(),
        ),
      ),
    );
    await fixture.settle(tester);
    expect(find.text(budgetWorkspaceName), findsOneWidget);
    return fixture;
  }

  /// Advances fake time by [duration] in [step]s, so every timer and the
  /// work it starts run in order.
  ///
  /// Each step also yields one real event-loop turn, with no real delay.
  /// Under the test's fake time, the end of a response that passes through
  /// `Stream.timeout`, as every SSE response does, reaches the client only
  /// on a real turn. Without it an ended stream would look open until the
  /// 30-second idle timeout.
  Future<void> advance(
    WidgetTester tester,
    Duration duration, {
    Duration step = const Duration(milliseconds: 100),
  }) async {
    var left = duration;
    while (left > Duration.zero) {
      final next = left < step ? left : step;
      await tester.pump(next);
      await tester.runAsync(() async {});
      left -= next;
    }
  }

  /// The fixed post-action settle window.
  Future<void> settle(WidgetTester tester) => advance(tester, budgetSettle);

  /// Taps the worktree row, expanding its workspace first when the phone
  /// list shows it collapsed, and waits for the transcript.
  Future<void> openChat(WidgetTester tester) async {
    if (find.text(_worktreeLabel).evaluate().isEmpty) {
      await tester.tap(find.text(budgetWorkspaceName));
      await tester.pump();
    }
    await tester.tap(find.text(_worktreeLabel));
    await settle(tester);
    expect(find.text(desktop.lastMessageText), findsOneWidget);
  }

  /// Leaves the chat for the overview.
  Future<void> closeChat(WidgetTester tester) async {
    await tester.pageBack();
    await settle(tester);
    expect(find.text(budgetWorkspaceName), findsOneWidget);
  }

  /// Unmounts, then checks nothing is still sending.
  Future<void> dispose(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    viewModel.dispose();
    desktop.close();
    final mark = recorder.mark();
    await tester.pump(const Duration(minutes: 1));
    expect(recorder.countsSince(mark)[kRequestsKey], 0);
    expect(desktop.unexpected, isEmpty);
    expect(tester.takeException(), isNull);
  }
}
