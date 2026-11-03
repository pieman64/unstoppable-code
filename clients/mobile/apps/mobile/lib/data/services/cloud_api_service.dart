import 'dart:convert';
import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/data/services/api_client.dart';

const String cloudBasePath = '/api/cloud';

String? _header(Map<String, String> headers, String name) {
  final lowerName = name.toLowerCase();
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == lowerName) return entry.value;
  }
  return null;
}

Duration? _retryAfter(Map<String, String> headers) {
  final raw = _header(headers, 'Retry-After');
  final seconds = raw == null ? null : num.tryParse(raw);
  if (seconds == null) return null;
  final milliseconds = seconds * 1000;
  if (!milliseconds.isFinite) return null;
  return Duration(
    milliseconds: milliseconds.clamp(0, Duration.millisecondsPerDay).round(),
  );
}

({String? code, String message}) _errorBody(Object? body, int status) {
  if (body is Map<String, dynamic>) {
    final error = body['error'];
    if (error is String) return (code: null, message: error);
    if (error is Map<String, dynamic>) {
      return (
        code: error['code'] is String ? error['code'] as String : null,
        message: error['message'] is String
            ? error['message'] as String
            : 'Cloud request failed with status $status',
      );
    }
  }
  return (code: null, message: 'Cloud request failed with status $status');
}

/// The app's own copy for a request refused for AI Credits. A server message
/// could point at buying credits outside the store, which the app must not
/// show (CAN-4435).
const String _outOfCreditsMessage = "You're out of AI Credits.";

String _message(int status, String? code, String message) =>
    status == 402 && code == 'INSUFFICIENT_CREDITS'
    ? _outOfCreditsMessage
    : message;

Object? _decodeBody(String body) {
  if (body.isEmpty) return null;
  try {
    return jsonDecode(body);
  } catch (_) {
    return null;
  }
}

/// Parsed non-2xx response from a `/api/cloud` route.
final class CloudApiException implements Exception {
  const CloudApiException({
    required this.statusCode,
    required this.message,
    this.code,
    this.headerCode,
    this.retryAfter,
  });

  final int statusCode;
  final String message;
  final String? code;
  final String? headerCode;
  final Duration? retryAfter;

  factory CloudApiException.fromApiException(ApiException error) {
    final details = _errorBody(_decodeBody(error.body), error.statusCode);
    final headerCode = _header(error.headers, 'X-Canopy-Error-Code');
    final code = details.code ?? headerCode;
    return CloudApiException(
      statusCode: error.statusCode,
      message: _message(error.statusCode, code, details.message),
      code: code,
      headerCode: headerCode,
      retryAfter: _retryAfter(error.headers),
    );
  }

  @override
  String toString() => 'CloudApiException($statusCode): $message';
}

enum CloudSendErrorKind { definitive, retryable, terminalSession }

final class CloudSendError implements Exception {
  const CloudSendError({
    required this.kind,
    required this.status,
    required this.message,
    this.code,
    this.retryAfter,
    this.coreError,
    this.uncertain = false,
  });

  final ConversationCoreError? coreError;
  final bool uncertain;
  final CloudSendErrorKind kind;
  final int status;
  final String message;
  final String? code;
  final Duration? retryAfter;

  @override
  String toString() => 'CloudSendError($kind, $status): $message';
}

/// Mobile port of the web cloud transport's send-error classifier.
CloudSendError classifyCloudSendError({
  required int status,
  required Object? body,
  Map<String, String> headers = const {},
}) {
  final details = _errorBody(body, status);
  final code = details.code ?? _header(headers, 'X-Canopy-Error-Code');
  final message = _message(status, code, details.message);
  if (status == 409 && code == 'terminal_chat_state_changed') {
    return CloudSendError(
      kind: CloudSendErrorKind.terminalSession,
      status: status,
      code: code,
      message: message,
    );
  }
  if (status == 0 ||
      status == 429 ||
      status >= 500 ||
      (status == 409 && code == 'CLOUD_CAPABILITY_DELIVERY_BUSY')) {
    return CloudSendError(
      kind: CloudSendErrorKind.retryable,
      status: status,
      code: code,
      message: message,
      retryAfter:
          _retryAfter(headers) ??
          Duration(seconds: status == 409 || status == 503 ? 2 : 5),
    );
  }
  return CloudSendError(
    kind: CloudSendErrorKind.definitive,
    status: status,
    code: code,
    message: message,
  );
}

/// Typed bearer-authenticated client for the cloud chat HTTP surface.
final class CloudApiService {
  const CloudApiService({required this.apiClient});

  final ApiClient apiClient;

  Future<T> _request<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on ApiException catch (error) {
      throw CloudApiException.fromApiException(error);
    }
  }

  Future<List<CloudWorkspaceSummary>> listWorkspaces() async {
    final json = await _request(
      () =>
          apiClient.getJson('$cloudBasePath/workspaces', retryTransient: false),
    );
    final rows = json['workspaces'];
    return rows is List
        ? rows
              .whereType<Map<String, dynamic>>()
              .map(CloudWorkspaceSummary.fromJson)
              .toList(growable: false)
        : const [];
  }

  /// Creates the account's first workspace, the same background provision the
  /// web client runs for a brand-new user.
  ///
  /// Idempotent per account: the server derives the workspace id from the
  /// account, so this device and a web tab racing it land on one workspace.
  /// Null means the server declined because the account already had its first
  /// workspace and archived it. A tenancy still being provisioned answers 503
  /// `CLOUD_ACCOUNT_PROVISIONING` with a `Retry-After`; callers retry it.
  Future<CloudWorkspaceSummary?> provisionFirstWorkspace(String name) async {
    final json = await _request(
      () => apiClient.postJson(
        '$cloudBasePath/workspaces',
        body: {'name': name, 'firstWorkspaceOnly': true},
      ),
    );
    final workspace = json['workspace'];
    return workspace is Map<String, dynamic>
        ? CloudWorkspaceSummary.fromJson(workspace)
        : null;
  }

  /// Chat listing is embedded in the canonical workspace summaries.
  Future<List<CloudChatSummary>> listChats(String workspaceId) async {
    final workspaces = await listWorkspaces();
    for (final workspace in workspaces) {
      if (workspace.externalId == workspaceId) return workspace.chats;
    }
    return const [];
  }

  Future<CloudChatSummary> createChat(
    String workspaceId, {
    required String externalId,
    String? title,
    String? prompt,
    String? modelDefinitionId,
    bool autoModel = false,
    String? thinkingLevel,
    bool? fastMode,
    Map<String, Object?>? pluginSelections,
  }) async {
    final encodedWorkspaceId = Uri.encodeComponent(workspaceId);
    final json = await _request(
      () => apiClient.postJson(
        '$cloudBasePath/workspaces/$encodedWorkspaceId/chats',
        body: {
          'externalId': externalId,
          'title': ?title,
          'prompt': ?prompt,
          // Auto is a selection mode; the server rejects it with a model id.
          if (autoModel) 'modelSelectionMode': 'AUTO',
          if (!autoModel) 'modelDefinitionId': ?modelDefinitionId,
          'thinkingLevel': ?thinkingLevel,
          'fastMode': ?fastMode,
          'pluginSelections': ?pluginSelections,
        },
      ),
    );
    return CloudChatSummary.fromJson(_asMap(json['chat']));
  }

  Future<CloudChatSummary> getChat(String chatId) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/chats/$encodedChatId',
        retryTransient: false,
      ),
    );
    return CloudChatSummary.fromJson(_asMap(json['chat']));
  }

  Future<CloudChatSummary> renameChat(String chatId, String? title) =>
      _patchChat(chatId, {'title': title});

  Future<CloudChatSummary> setChatModel(
    String chatId,
    String? modelDefinitionId,
  ) => _patchChat(chatId, {'modelDefinitionId': modelDefinitionId});

  /// Turns on Auto. A later [setChatModel] returns the chat to manual.
  Future<CloudChatSummary> setChatAutoModel(String chatId) =>
      _patchChat(chatId, {'modelSelectionMode': 'AUTO'});

  Future<CloudChatSummary> _patchChat(
    String chatId,
    Map<String, Object?> body,
  ) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final json = await _request(
      () => apiClient.patchJson(
        '$cloudBasePath/chats/$encodedChatId',
        body: body,
      ),
    );
    return CloudChatSummary.fromJson(_asMap(json['chat']));
  }

  Future<void> archiveChat(String chatId) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    await _request(
      () => apiClient.deleteJson(
        '$cloudBasePath/chats/$encodedChatId?mode=archive',
      ),
    );
  }

  /// Moves a chat and its tabs into the workspace's deletion retention
  /// window; the server removes it once that window lapses.
  Future<void> deleteChat(String chatId) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    await _request(
      () => apiClient.deleteJson(
        '$cloudBasePath/chats/$encodedChatId?mode=delete',
      ),
    );
  }

  Future<CloudChatBootstrap> getMessages(String chatId) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/chats/$encodedChatId/messages',
        retryTransient: false,
      ),
    );
    return CloudChatBootstrap.fromJson(json);
  }

  Future<CloudChatStatus> getMessageStatus(String chatId) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/chats/$encodedChatId/messages',
        query: const {'statusOnly': 'true'},
        retryTransient: false,
      ),
    );
    return CloudChatStatus.fromJson(json);
  }

  Future<PostTurnResult> postMessage(
    String chatId, {
    required String text,
    required String clientRequestId,
    String? modelDefinitionId,
    String? thinkingLevel,
    bool resetThinkingLevel = false,
    bool? fastMode,
    bool replayHint = false,
    List<ChatAttachmentRef> cloudAttachments = const [],
  }) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    try {
      final json = await apiClient.postJson(
        '$cloudBasePath/chats/$encodedChatId/messages',
        body: {
          'text': text,
          'clientRequestId': clientRequestId,
          'modelDefinitionId': ?modelDefinitionId,
          if (resetThinkingLevel) 'thinkingLevel': null,
          if (!resetThinkingLevel) 'thinkingLevel': ?thinkingLevel,
          'fastMode': ?fastMode,
          if (replayHint) 'replayHint': true,
          if (cloudAttachments.isNotEmpty)
            'cloudAttachments': [
              for (final ref in cloudAttachments) ref.toJson(),
            ],
        },
      );
      return PostTurnResult.fromJson(json);
    } on ApiException catch (error) {
      throw classifyCloudSendError(
        status: error.statusCode,
        body: _decodeBody(error.body),
        headers: error.headers,
      );
    } catch (error) {
      throw classifyCloudSendError(
        status: 0,
        body: {'error': error.toString()},
      );
    }
  }

  /// Uploads one file to the chat's attachment store
  /// (`POST .../chats/{id}/attachments?filename=&mediaType=`, raw body) and
  /// returns the ready ref a send carries as `cloudAttachments[]`.
  Future<ChatAttachmentRef> uploadChatAttachment(
    String chatId, {
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final json = await _request(
      () => apiClient.postBytes(
        '$cloudBasePath/chats/$encodedChatId/attachments',
        bytes: bytes,
        contentType: 'application/octet-stream',
        query: {'filename': filename, 'mediaType': mediaType},
      ),
    );
    final ref = ChatAttachmentRef.fromJson(json);
    if (ref.attachmentId.isEmpty || ref.contentSha256.isEmpty) {
      throw const CloudApiException(
        statusCode: 502,
        message: 'Attachment upload returned an invalid response',
      );
    }
    return ref;
  }

  /// Removes a not-yet-sent upload from the chat's attachment store.
  Future<void> deleteChatAttachment(String chatId, String attachmentId) =>
      _request(
        () => apiClient.delete(
          '$cloudBasePath/chats/${Uri.encodeComponent(chatId)}'
          '/attachments/${Uri.encodeComponent(attachmentId)}',
        ),
      );

  Future<AgentTurnInterruptResult> interruptTurn(
    String chatId,
    String turnId,
  ) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final encodedTurnId = Uri.encodeComponent(turnId);
    final json = await _request(
      () => apiClient.postJson(
        '$cloudBasePath/chats/$encodedChatId/turns/$encodedTurnId/interrupt',
      ),
    );
    return AgentTurnInterruptResult.fromJson(json);
  }

  Future<CloudChatSummary> continueChat(
    String chatId, {
    required String sourceAgentSessionId,
    bool? fastMode,
  }) async {
    final encodedChatId = Uri.encodeComponent(chatId);
    final json = await _request(
      () => apiClient.postJson(
        '$cloudBasePath/chats/$encodedChatId/fork',
        body: {
          'mode': 'continue',
          'sourceAgentSessionId': sourceAgentSessionId,
          'fastMode': ?fastMode,
        },
      ),
    );
    return CloudChatSummary.fromJson(_asMap(json['chat']));
  }

  String _conversationPath(String chatId) =>
      '$cloudBasePath/chats/${Uri.encodeComponent(chatId)}/conversation';

  Future<ConversationDiscoveryMetadata> discoverConversation(
    String chatId,
  ) async => ConversationDiscoveryMetadata.fromJson(
    await _request(
      () => apiClient.getJson(
        '${_conversationPath(chatId)}/discovery',
        retryTransient: false,
      ),
    ),
  );

  Future<T> _conversationRequest<T>(
    Future<Map<String, dynamic>> Function() request,
    T Function(Object?) parse, {
    bool send = false,
  }) async {
    try {
      return parse(await request());
    } on ApiException catch (error) {
      final body = _decodeBody(error.body);
      final core = ConversationCoreError.tryParse(body);
      final classified = classifyCloudSendError(
        status: error.statusCode,
        body: body,
        headers: error.headers,
      );
      throw CloudSendError(
        kind: core?.code == 'AGENT_SESSION_QUEUE_CAPACITY_EXCEEDED'
            ? CloudSendErrorKind.retryable
            : classified.kind,
        status: error.statusCode,
        message: classified.message,
        code: core?.code ?? classified.code,
        retryAfter: _retryAfter(error.headers) ?? classified.retryAfter,
        coreError: core,
        uncertain: send && error.statusCode >= 500,
      );
    } catch (error) {
      // A malformed successful admission is uncertain too: keep its key.
      throw CloudSendError(
        kind: CloudSendErrorKind.retryable,
        status: 0,
        message: "Couldn't read the conversation response. Try again.",
        uncertain: send,
      );
    }
  }

  Future<ConversationSnapshot> getConversation(String chatId) =>
      _conversationRequest(
        () =>
            apiClient.getJson(_conversationPath(chatId), retryTransient: false),
        ConversationSnapshot.fromJson,
      );

  Future<ConversationHistoryPage> getConversationHistory(
    String chatId,
    String cursor,
  ) => _conversationRequest(
    () => apiClient.getJson(
      _conversationPath(chatId),
      query: {'cursor': cursor},
      retryTransient: false,
    ),
    ConversationHistoryPage.fromJson,
  );

  Future<ConversationAcceptedTurn> postConversationTurn(
    String chatId,
    ConversationSendInput input,
  ) => _conversationRequest(
    () => apiClient.postJson(
      '${_conversationPath(chatId)}/turns',
      body: input.toJson(),
    ),
    ConversationAcceptedTurn.fromJson,
    send: true,
  );

  Future<ConversationCommandReceipt> conversationCommand(
    String chatId,
    String turnId,
    ConversationTurnOperation operation,
    ConversationCommandInput input,
  ) => _conversationRequest(
    () => apiClient.postJson(
      '${_conversationPath(chatId)}/turns/${Uri.encodeComponent(turnId)}/${operation.name}',
      body: input.toJson(),
    ),
    ConversationCommandReceipt.fromJson,
  );

  /// Auto availability for this account. Errors hide Auto at the caller.
  Future<ModelRoutingAvailability> getModelRoutingAvailability() async {
    final json = await _request(
      () => apiClient.getJson(
        '$cloudBasePath/model-routing-availability',
        retryTransient: false,
      ),
    );
    return ModelRoutingAvailability.fromWire(json['state']);
  }

  Future<CloudModelCatalog> getModels() async {
    final json = await _request(
      () => apiClient.getJson('$cloudBasePath/models', retryTransient: false),
    );
    return CloudModelCatalog.fromJson(json);
  }
}

Map<String, dynamic> _asMap(Object? value) =>
    value is Map<String, dynamic> ? value : const {};
