import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_portal_state.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/services/api_client.dart';

import 'portal_state_decoder.dart';

export 'package:mobile/data/models/remote_portal_state.dart';

// `apiErrorMessage` now lives beside `ApiException` in `api_client.dart` so
// non-Portal features can reuse it. Re-exported here so existing importers of
// this library keep resolving it.
export 'package:mobile/data/services/api_client.dart' show apiErrorMessage;

/// Base path of the browser-authenticated Portal routes. Mobile authenticates
/// with its Better Auth bearer session token via [ApiClient]'s tokenProvider —
/// the server's `getCurrentSessionUser` accepts it identically to a browser
/// cookie. Both brands' `web.apiNamespace` is `desktop-app`.
const String portalBrowserBasePath = '/api/v1/desktop-app/portal/browser';
const String portalAttachmentBasePath = '/api/v1/portal/browser';

/// The current user's Portal session as returned by `GET .../session`
/// (`PortalSessionForBrowser`).
class RemotePortalSession {
  const RemotePortalSession({
    required this.id,
    this.status,
    this.connectionStatus,
    this.clientName,
    this.activatedAt,
    this.lastSeenAt,
    this.capabilities = const {},
    this.destructiveActionsEnabled = false,
    this.spaceNotificationSettingsEnabled = false,
  });

  final String id;

  /// Wire `PortalSessionStatus` (`pending_auth | active | inactive`), per
  /// `toWireSessionStatus` in `apps/web/src/lib/portal/api.ts`. Note that
  /// `inactive` is NOT terminal on its own — the server sweep uses it for a
  /// merely-stale-but-revivable session, and [connectionStatus] is the field
  /// that discriminates. See `remote_session_predicates.dart`.
  final String? status;
  final RemotePortalConnectionStatus? connectionStatus;

  /// Desktop device name shown in the connected header.
  final String? clientName;

  /// ISO-8601 timestamp the pairing was approved.
  final String? activatedAt;

  /// ISO-8601 timestamp of the desktop's last heartbeat. Sent by the server;
  /// surfaced so a degraded session can show how stale it is.
  final String? lastSeenAt;

  /// Optional desktop feature flags (`PortalSessionForBrowser.capabilities`,
  /// a name → bool map). Browsers gate protocol features the paired desktop
  /// may predate — e.g. `worktree_chat_summaries_scope` for chat search.
  final Map<String, bool> capabilities;

  /// Server-evaluated archive gate; absent on older servers, so fail closed.
  final bool destructiveActionsEnabled;

  /// Server-evaluated gate for per-space notification choices (CAN-3615);
  /// absent on older servers, so fail closed.
  final bool spaceNotificationSettingsEnabled;

  factory RemotePortalSession.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final status = json['status'];
    final connectionStatus = json['connectionStatus'];
    final clientName = json['clientName'];
    final activatedAt = json['activatedAt'];
    final lastSeenAt = json['lastSeenAt'];
    final rawCapabilities = json['capabilities'];
    return RemotePortalSession(
      id: id is String ? id : '',
      status: status is String ? status : null,
      connectionStatus: RemotePortalConnectionStatus.fromWire(
        connectionStatus is String ? connectionStatus : null,
      ),
      clientName: clientName is String ? clientName : null,
      activatedAt: activatedAt is String ? activatedAt : null,
      lastSeenAt: lastSeenAt is String ? lastSeenAt : null,
      destructiveActionsEnabled: json['destructiveActionsEnabled'] == true,
      spaceNotificationSettingsEnabled:
          json['spaceNotificationSettingsEnabled'] == true,
      capabilities: {
        if (rawCapabilities is Map<String, dynamic>)
          for (final entry in rawCapabilities.entries)
            if (entry.value case final bool value) entry.key: value,
      },
    );
  }
}

/// `POST .../sessions/{id}/commands` response subset
/// (`SubmitBrowserPortalCommandResponse`).
class RemotePortalCommandResult {
  const RemotePortalCommandResult({
    required this.commandId,
    this.chatId,
    this.queuedWhileReconnecting = false,
    this.error,
    this.result,
  });

  final String commandId;

  /// Canonical chat id echoed by chat send commands.
  final String? chatId;
  final bool queuedWhileReconnecting;

  /// Failure message echoed by waited commands that failed synchronously.
  final String? error;

  /// The desktop's terminal command payload, echoed for the commands the
  /// server waits on before responding (`portal.worktree.create` and
  /// `portal.workspace.create`). Absent when the command was merely queued —
  /// a create that timed out server-side still returns a `commandId` with no
  /// `result`, which callers must treat as "pending", not "failed".
  final Map<String, dynamic>? result;
}

/// Typed wrappers over the browser Portal routes used by the mobile Remote
/// Control feature. Maps transport failures to [ApiException]; callers
/// translate to user-presentable copy.
final class RemoteControlApiService {
  const RemoteControlApiService({
    required this.apiClient,
    this.stateDecoder = const PortalStateDecoder(),
  });

  final PortalStateDecoder stateDecoder;

  final ApiClient apiClient;

  /// Returns the user's current Portal session, or null when none exists.
  ///
  /// Transient failures are retried unless [retryTransient] is false; it
  /// defaults to false only with a supplied [httpClient].
  Future<RemotePortalSession?> fetchCurrentSession({
    http.Client? httpClient,
    bool? retryTransient,
  }) async {
    final requestClient = httpClient == null
        ? apiClient
        : apiClient.withHttpClient(httpClient);
    final json = await requestClient.getJson(
      '$portalBrowserBasePath/session',
      // By default a supplied client is the event stream's hard-abortable
      // confirmation probe. Its reconnect state machine owns retries and
      // cancellation.
      retryTransient: retryTransient ?? httpClient == null,
    );
    final session = json['session'];
    if (session is! Map<String, dynamic>) return null;
    final parsed = RemotePortalSession.fromJson(session);
    return parsed.id.isEmpty ? null : parsed;
  }

  /// Redeems a 6-digit pairing [code]; returns the activated session id.
  /// Throws [ApiException] on rejection (the body's `error` field carries the
  /// server's reason).
  Future<String> connect(String code) async {
    final json = await apiClient.postJson(
      '$portalBrowserBasePath/connect',
      body: {'code': code},
    );
    final sessionId = json['sessionId'];
    if (sessionId is! String || sessionId.isEmpty) {
      throw const ApiException(statusCode: 502, body: 'Malformed response');
    }
    return sessionId;
  }

  /// Reads the projected shell state for [sessionId]. Scoped reads
  /// (`scope: 'worktree'`, ...) require the matching [target] query keys
  /// (`PORTAL_TARGET_KEYS`) and return only that scope's entity subtree.
  Future<RemotePortalStateResult> fetchState(
    String sessionId, {
    String scope = 'overview',
    Map<String, String>? target,
    http.Client? httpClient,
  }) async {
    final client = httpClient == null
        ? apiClient
        : apiClient.withHttpClient(httpClient);
    return client.getDecoded(
      '$portalBrowserBasePath/sessions/$sessionId/state',
      query: {'scope': scope, ...?target},
      decode: stateDecoder.decode,
    );
  }

  /// Enqueues one Portal command (`SubmitBrowserPortalCommandRequest`) for the
  /// paired desktop.
  Future<RemotePortalCommandResult> submitCommand(
    String sessionId, {
    required String type,
    Map<String, String>? target,
    required Map<String, dynamic> payload,
  }) async {
    final json = await apiClient.postJson(
      '$portalBrowserBasePath/sessions/$sessionId/commands',
      body: {
        'type': type,
        if (target != null && target.isNotEmpty) 'target': target,
        'payload': payload,
      },
    );
    final commandId = json['commandId'];
    final chatId = json['chatId'];
    final queued = json['queuedWhileReconnecting'];
    final error = json['error'];
    final result = json['result'];
    return RemotePortalCommandResult(
      commandId: commandId is String ? commandId : '',
      chatId: chatId is String ? chatId : null,
      queuedWhileReconnecting: queued is bool && queued,
      error: error is String ? error : null,
      result: result is Map<String, dynamic> ? result : null,
    );
  }

  /// Reads the status of a submitted command
  /// (`GET .../sessions/{sessionId}/commands/{commandId}`), for a result whose
  /// terminal event was missed.
  Future<BrowserPortalCommandStatusResponse> fetchCommandStatus(
    String sessionId,
    String commandId,
  ) async => BrowserPortalCommandStatusResponse.fromJson(
    await apiClient.getJson(
      '$portalBrowserBasePath/sessions/${Uri.encodeComponent(sessionId)}'
      '/commands/${Uri.encodeComponent(commandId)}',
    ),
  );

  /// Uploads one attachment for the paired desktop
  /// (`POST .../sessions/{id}/attachments?filename=&mediaType=`, raw body) and
  /// returns the ready ref the send command carries as `cloudAttachments[]`.
  /// [httpClient] lets the caller own a cancellable transport.
  Future<ChatAttachmentRef> uploadChatAttachment(
    String sessionId, {
    required String filename,
    required String mediaType,
    required Uint8List bytes,
    http.Client? httpClient,
  }) async {
    final requestClient = httpClient == null
        ? apiClient
        : apiClient.withHttpClient(httpClient);
    final json = await requestClient.postBytes(
      '$portalAttachmentBasePath/sessions/$sessionId/attachments',
      bytes: bytes,
      contentType: mediaType,
      query: {'filename': filename, 'mediaType': mediaType},
    );
    final ref = ChatAttachmentRef.fromJson(json);
    if (ref.attachmentId.isEmpty || ref.contentSha256.isEmpty) {
      throw const ApiException(statusCode: 502, body: 'Malformed response');
    }
    return ref;
  }

  /// Removes a not-yet-sent attachment from the server.
  Future<void> deleteChatAttachment(
    String sessionId,
    String attachmentId,
  ) => apiClient.delete(
    '$portalAttachmentBasePath/sessions/$sessionId/attachments/$attachmentId',
  );

  /// Reads one older transcript page (`PortalChatHistoryRequest` →
  /// `PortalChatHistoryChunk`). [before] is the opaque cursor from the
  /// previous chunk; `null` requests the newest historical page. The body
  /// always carries an explicit `before` key — the contract treats it as
  /// required-but-nullable.
  Future<RemoteChatHistoryChunk> fetchChatHistory(
    String sessionId, {
    required String scope,
    required String chatId,
    String? workspaceLocalId,
    String? worktreeLocalId,
    String? before,
    int? limitTurns,
  }) async {
    final json = await apiClient.postJson(
      '$portalBrowserBasePath/sessions/$sessionId/chat/history',
      body: {
        'scope': scope,
        'chatId': chatId,
        'workspaceLocalId': ?workspaceLocalId,
        'worktreeLocalId': ?worktreeLocalId,
        'before': before,
        'limitTurns': ?limitTurns,
      },
    );
    final rawMessages = json['messages'];
    final nextCursor = json['nextCursor'];
    return RemoteChatHistoryChunk(
      messages: rawMessages is List
          ? rawMessages
                .whereType<Map<String, dynamic>>()
                .map(RemoteChatMessage.fromWireJson)
                .toList(growable: false)
          : const [],
      nextCursor: nextCursor is String && nextCursor.isNotEmpty
          ? nextCursor
          : null,
    );
  }

  /// Reads one file's unified diff (`PortalDiffReadPayload` →
  /// `PortalDiffSnapshotPayload`) via `POST .../diff/read`. The route
  /// bridges the request onto the desktop's `portal.diff.read` command and
  /// answers with the resulting snapshot.
  Future<RemoteFileDiff> readDiff(
    String sessionId, {
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String path,
    required RemoteDiffSource source,
    String? repoId,
  }) async {
    final json = await apiClient.postJson(
      '$portalBrowserBasePath/sessions/$sessionId/diff/read',
      body: {
        'workspaceId': workspaceLocalId,
        'worktreeId': worktreeLocalId,
        'repoId': ?repoId,
        'path': path,
        'source': source.wireValue,
      },
    );
    return RemoteFileDiff.fromJson(json);
  }

  /// Ends the Portal session. Best-effort on the caller side.
  /// [httpClient] lets the caller own a cancellable transport.
  Future<void> endSession(String sessionId, {http.Client? httpClient}) async {
    await (httpClient == null
            ? apiClient
            : apiClient.withHttpClient(httpClient))
        .postJson('$portalBrowserBasePath/sessions/$sessionId/end');
  }
}
