import 'dart:async';
import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'conversation_v2_fixtures.dart';

/// Scripted in-memory [CloudChatRepository] for view-model and widget tests.
///
/// Mirrors the availability contract of `HttpCloudChatRepository`: a 404 on
/// the workspaces probe marks cloud chats unsupported and yields no
/// workspaces, while every other failure is rethrown untouched. Mutations
/// update the in-memory catalog so a screen re-reading the list sees them.
final class FakeCloudChatRepository implements CloudChatRepository {
  FakeCloudChatRepository({
    List<CloudWorkspaceSummary> workspaces = const [],
    CloudModelCatalog? catalog,
  }) : _workspaces = List.of(workspaces),
       catalog = catalog ?? sampleCatalog;

  Map<String, dynamic>? conversation;
  final conversationSends = <ConversationSendInput>[];

  /// Extra top-level fields of every accepted v2 turn, such as the
  /// `modelSelectionMode` the server saved.
  Map<String, Object?> acceptedTurnFields = {};

  /// When set, [postConversationTurn] waits on this before answering, holding
  /// the v2 send in flight.
  Completer<void>? conversationSendCompleter;

  /// Thrown by [postConversationTurn] when set; thrown once, then cleared.
  Object? conversationSendError;

  @override
  Future<ConversationDiscoveryMetadata> discoverConversation(
    String chatId,
  ) async => ConversationDiscoveryMetadata(
    sessionId:
        _workspaces
            .expand((w) => w.chats)
            .where((c) => c.externalId == chatId)
            .firstOrNull
            ?.coreAgentSessionId ??
        'session-1',
    protocolVersion: conversation == null ? 1 : 2,
  );
  @override
  Future<ConversationSnapshot> getConversation(String chatId) async =>
      ConversationSnapshot.fromJson(conversation);
  @override
  Future<ConversationHistoryPage> getConversationHistory(
    String chatId,
    String cursor,
  ) async => throw UnimplementedError();
  @override
  Future<ConversationAcceptedTurn> postConversationTurn(
    String chatId,
    ConversationSendInput input,
  ) async {
    conversationSends.add(input);
    await conversationSendCompleter?.future;
    final error = conversationSendError;
    if (error != null) {
      conversationSendError = null;
      throw error;
    }
    final accepted = v2Accepted(
      input.clientRequestId,
      input.content as String,
      session: _chat(chatId).coreAgentSessionId,
    );
    if (input.cloudAttachments.isNotEmpty) {
      accepted['message'] = {
        ...Map<String, dynamic>.from(accepted['message'] as Map),
        'attachments': [for (final ref in input.cloudAttachments) ref.toJson()],
      };
    }
    return ConversationAcceptedTurn.fromJson(
      accepted..addAll(acceptedTurnFields),
    );
  }

  @override
  Future<ConversationCommandReceipt> conversationCommand(
    String chatId,
    String turnId,
    ConversationTurnOperation operation,
    ConversationCommandInput input,
  ) async => throw UnimplementedError();

  List<CloudWorkspaceSummary> _workspaces;
  List<CloudWorkspaceSummary> get workspaces => List.unmodifiable(_workspaces);
  set workspaces(List<CloudWorkspaceSummary> value) =>
      _workspaces = List.of(value);

  CloudModelCatalog catalog;

  /// When true the workspaces probe answers 404, the server-side gate.
  bool cloudUnavailable = false;

  /// Thrown by [listWorkspaces] when set; takes precedence over the gate.
  Object? listError;

  /// Optional deferred response used by stale-request regression tests.
  Completer<List<CloudWorkspaceSummary>>? listCompleter;

  /// Optional deferred response used by stale-catalog regression tests.
  Completer<CloudModelCatalog>? modelsCompleter;

  /// Thrown by [getModels] when set.
  Object? modelsError;

  /// Optional per-model gates used by model-selection race regression tests.
  final Map<String?, Completer<void>> setModelCompleters = {};

  /// Thrown by [createChat] when set.
  Object? createError;

  /// Optional per-workspace gates used by chat-creation race tests.
  final Map<String, Completer<void>> createCompleters = {};

  /// Thrown by [renameChat] when set.
  Object? renameError;

  /// Thrown by [setChatModel] when set.
  Object? setModelError;

  /// Thrown by [setChatAutoModel] when set.
  Object? setAutoModelError;

  /// Optional gate used by send-ordering regression tests.
  Completer<void>? setAutoModelCompleter;
  final List<String> setAutoModelCalls = [];

  /// External ids of chats created in Auto.
  final List<String> autoModelCreates = [];

  /// Per-model failures used by ordered model-selection regression tests.
  final Map<String?, Object> setModelErrors = {};

  /// Thrown by [archiveChat] when set.
  Object? archiveError;

  /// Thrown by [deleteChat] when set.
  Object? deleteError;

  /// Optional gate for a delete request that is already in flight.
  Completer<void>? deleteCompleter;

  /// Thrown by [continueChat] when set.
  Object? continueError;

  /// Thrown by [postMessage] when set; thrown once, then cleared.
  Object? postError;

  /// When set, v1 [postMessage] waits on this before answering, holding the
  /// send in flight.
  Completer<void>? postCompleter;

  /// Bootstrap served by [getMessages], keyed by chat id; idle when absent.
  final Map<String, CloudChatBootstrap> bootstraps = {};

  /// Thrown by [getMessages] for the given chat id when set.
  final Map<String, Object> bootstrapErrors = {};

  /// When set for a chat id, [getMessages] waits on it, holding the
  /// bootstrap in flight.
  final Map<String, Completer<void>> bootstrapCompleters = {};

  final List<String> listCalls = [];
  final List<({String workspaceId, String externalId, String? model})>
  createCalls = [];

  /// `pluginSelections` of every [createChat], in call order.
  final List<Map<String, Object?>?> createPluginSelections = [];

  /// Rows every invocables request answers with.
  List<ComposerCommand> invocableRows = const [];

  /// When set, the workspace inventory answers with its rows for the
  /// request's `pluginSelections`, as the server does, instead of
  /// [invocableRows].
  List<ComposerCommand> Function(Map<String, Object?>? pluginSelections)?
  workspaceInvocableRows;

  /// Project defaults the workspace inventory reports.
  Map<String, Object?>? defaultPluginSelections;

  /// Thrown by the invocables requests when set.
  Object? invocablesError;

  /// When set, the invocables requests wait on it before answering.
  Completer<void>? invocablesGate;

  final List<
    ({
      String scope,
      String id,
      String? model,
      Map<String, Object?>? pluginSelections,
    })
  >
  invocableCalls = [];

  /// Thrown by [setChatCapabilities] when set.
  Object? capabilitiesError;

  /// When set, answers [setChatCapabilities] instead of echoing the request.
  CloudCapabilityWriteResult Function(Map<String, Object?> selections)?
  capabilitiesAnswer;

  /// The capability catalog; [capabilityCatalogError] fails it instead.
  ComposerPluginCatalog capabilityCatalogValue = const ComposerPluginCatalog(
    items: [],
  );
  Object? capabilityCatalogError;
  final List<String> capabilityCatalogCalls = [];

  /// When set, [setChatCapabilities] waits on it before answering.
  Completer<void>? capabilitiesGate;

  final List<({String chatId, Map<String, Object?> selections})>
  capabilityCalls = [];
  final List<({String chatId, String? title})> renameCalls = [];
  final List<String> archiveCalls = [];
  final List<String> deleteCalls = [];
  final List<
    ({
      String chatId,
      String id,
      String text,
      String? model,
      String? thinking,
      bool? fast,
      bool replay,
      List<ChatAttachmentRef> attachments,
    })
  >
  postCalls = [];

  final List<({String chatId, String filename, String mediaType, int size})>
  uploadCalls = [];
  final List<({String chatId, String attachmentId})> deleteAttachmentCalls = [];

  /// Scripts a slow or refused upload; without it each upload succeeds as
  /// `cloud-att-<n>`.
  Future<ChatAttachmentRef> Function(String chatId, String filename)?
  uploadHandler;
  final List<({String chatId, String turnId})> interruptCalls = [];
  final List<String> continueCalls = [];
  final List<({String chatId, String? model})> setModelCalls = [];
  int modelsCalls = 0;
  int streamAfterContinue = 0;

  bool? _supportsCloudChats;
  @override
  bool? get supportsCloudChats => _supportsCloudChats;

  @override
  Future<List<CloudWorkspaceSummary>> listWorkspaces() async {
    listCalls.add('list');
    final deferred = listCompleter;
    if (deferred != null) return deferred.future;
    final error = listError;
    if (error != null) throw error;
    if (cloudUnavailable) {
      _supportsCloudChats = false;
      return const [];
    }
    _supportsCloudChats = true;
    return List.unmodifiable(_workspaces);
  }

  /// Names passed to [provisionFirstWorkspace], one per request.
  final List<String> provisionCalls = [];

  /// Scripted outcomes for [provisionFirstWorkspace], consumed in order: an
  /// [Object] that is not a workspace is thrown. When empty, the request
  /// creates a workspace named after the request.
  final List<Object?> provisionResults = [];

  /// Optional gate held open by concurrency tests.
  Completer<void>? provisionCompleter;

  @override
  Future<CloudWorkspaceSummary?> provisionFirstWorkspace(String name) async {
    provisionCalls.add(name);
    await provisionCompleter?.future;
    if (provisionResults.isNotEmpty) {
      final result = provisionResults.removeAt(0);
      if (result == null) return null;
      if (result is! CloudWorkspaceSummary) throw result;
      _workspaces = [..._workspaces, result];
      return result;
    }
    final created = sampleWorkspace(id: 'ws-first', name: name, chats: []);
    _workspaces = [..._workspaces, created];
    return created;
  }

  @override
  Future<List<CloudChatSummary>> listChats(String workspaceId) async =>
      _workspace(workspaceId).chats;

  @override
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
    if (autoModel) autoModelCreates.add(externalId);
    createCalls.add((
      workspaceId: workspaceId,
      externalId: externalId,
      model: modelDefinitionId,
    ));
    createPluginSelections.add(pluginSelections);
    await createCompleters[workspaceId]?.future;
    final error = createError;
    if (error != null) throw error;
    final chat = CloudChatSummary(
      externalId: externalId,
      title: title,
      taskChatExternalId: null,
      modelDefinitionId: modelDefinitionId,
      modelAuto: autoModel,
      thinkingLevel: thinkingLevel,
      fastMode: fastMode,
      coreAgentSessionId: 'session-$externalId',
      createdAtMs: 1789900000000,
    );
    _replaceWorkspace(
      workspaceId,
      (workspace) =>
          copyWorkspace(workspace, chats: [...workspace.chats, chat]),
    );
    return chat;
  }

  @override
  Future<CloudChatSummary> getChat(String chatId) async => _chat(chatId);

  @override
  Future<CloudChatSummary> renameChat(String chatId, String? title) async {
    renameCalls.add((chatId: chatId, title: title));
    final error = renameError;
    if (error != null) throw error;
    return _replaceChat(chatId, (chat) => copyChat(chat, title: title));
  }

  @override
  Future<CloudChatSummary> setChatModel(
    String chatId,
    String? modelDefinitionId,
  ) async {
    setModelCalls.add((chatId: chatId, model: modelDefinitionId));
    await setModelCompleters[modelDefinitionId]?.future;
    final modelError = setModelErrors[modelDefinitionId];
    if (modelError != null) throw modelError;
    final error = setModelError;
    if (error != null) throw error;
    return _replaceChat(
      chatId,
      (chat) => copyChat(
        chat,
        modelDefinitionId: modelDefinitionId,
        modelAuto: false,
      ),
    );
  }

  @override
  Future<CloudChatSummary> setChatAutoModel(String chatId) async {
    setAutoModelCalls.add(chatId);
    await setAutoModelCompleter?.future;
    final error = setAutoModelError;
    if (error != null) throw error;
    return _replaceChat(chatId, (chat) => copyChat(chat, modelAuto: true));
  }

  @override
  Future<void> archiveChat(String chatId) async {
    archiveCalls.add(chatId);
    final error = archiveError;
    if (error != null) throw error;
    _workspaces = [
      for (final workspace in _workspaces)
        copyWorkspace(
          workspace,
          chats: workspace.chats
              .where((chat) => chat.externalId != chatId)
              .toList(growable: false),
        ),
    ];
  }

  @override
  Future<void> deleteChat(String chatId) async {
    deleteCalls.add(chatId);
    await deleteCompleter?.future;
    final error = deleteError;
    if (error != null) throw error;
    _workspaces = [
      for (final workspace in _workspaces)
        copyWorkspace(
          workspace,
          chats: workspace.chats
              .where((chat) => chat.externalId != chatId)
              .toList(growable: false),
        ),
    ];
  }

  @override
  Future<CloudChatBootstrap> getMessages(String chatId) async {
    await bootstrapCompleters[chatId]?.future;
    final error = bootstrapErrors[chatId];
    if (error != null) throw error;
    return bootstraps[chatId] ??
        const CloudChatBootstrap(messages: [], toolActivity: []);
  }

  @override
  Future<CloudChatStatus> getMessageStatus(String chatId) async =>
      CloudChatStatus(sourceAgentSessionId: _chat(chatId).coreAgentSessionId);

  @override
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
    postCalls.add((
      chatId: chatId,
      id: clientRequestId,
      text: text,
      model: modelDefinitionId,
      thinking: thinkingLevel,
      fast: fastMode,
      replay: replayHint,
      attachments: cloudAttachments,
    ));
    await postCompleter?.future;
    final error = postError;
    if (error != null) {
      postError = null;
      throw error;
    }
    return PostTurnResult(
      message: CloudCoreMessage(
        id: 'message-$clientRequestId',
        clientRequestId: clientRequestId,
        role: 'USER',
        text: text,
        cost: const CloudCoreCost(kind: CloudCoreCostKind.pending),
        costBilledViaLlmProxy: false,
        createdAtMs: 1789900001000,
        artifacts: const [],
        attachments: [for (final ref in cloudAttachments) ref.toJson()],
      ),
      replayed: replayHint,
      streamAfter: '${++streamAfterContinue}',
    );
  }

  @override
  Future<ChatAttachmentRef> uploadChatAttachment(
    String chatId, {
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    uploadCalls.add((
      chatId: chatId,
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
    ));
    final handler = uploadHandler;
    if (handler != null) return handler(chatId, filename);
    return ChatAttachmentRef(
      attachmentId: 'cloud-att-${uploadCalls.length}',
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
      contentSha256: 'a' * 64,
      storageKind: 'blob',
      source: '/cloud/$chatId',
    );
  }

  @override
  Future<void> deleteChatAttachment(String chatId, String attachmentId) async {
    deleteAttachmentCalls.add((chatId: chatId, attachmentId: attachmentId));
  }

  @override
  Future<AgentTurnInterruptResult> interruptTurn(
    String chatId,
    String turnId,
  ) async {
    interruptCalls.add((chatId: chatId, turnId: turnId));
    return AgentTurnInterruptResult(
      outcome: AgentTurnInterruptOutcome.interruptRequested,
      rawOutcome: 'interrupt_requested',
      turnId: turnId,
    );
  }

  @override
  Future<CloudChatSummary> continueChat(
    String chatId, {
    required String sourceAgentSessionId,
    bool? fastMode,
  }) async {
    continueCalls.add(chatId);
    final error = continueError;
    if (error != null) throw error;
    if (conversation != null) {
      conversation = v2Snapshot(
        session: '${_chat(chatId).coreAgentSessionId}-continued',
      );
    }
    return _replaceChat(
      chatId,
      (chat) => copyChat(
        chat,
        coreAgentSessionId: '${chat.coreAgentSessionId}-continued',
      ),
    );
  }

  @override
  Future<CloudInvocableInventory> listChatInvocables(
    String chatId, {
    String? modelDefinitionId,
  }) async {
    invocableCalls.add((
      scope: 'chat',
      id: chatId,
      model: modelDefinitionId,
      pluginSelections: null,
    ));
    await invocablesGate?.future;
    if (invocablesError case final error?) throw error;
    return CloudInvocableInventory(rows: invocableRows);
  }

  @override
  Future<CloudInvocableInventory> listWorkspaceInvocables(
    String workspaceId, {
    String? modelDefinitionId,
    Map<String, Object?>? pluginSelections,
  }) async {
    invocableCalls.add((
      scope: 'workspace',
      id: workspaceId,
      model: modelDefinitionId,
      pluginSelections: pluginSelections,
    ));
    await invocablesGate?.future;
    if (invocablesError case final error?) throw error;
    return CloudInvocableInventory(
      rows: workspaceInvocableRows?.call(pluginSelections) ?? invocableRows,
      defaultPluginSelections: defaultPluginSelections,
    );
  }

  @override
  Future<CloudCapabilityWriteResult> setChatCapabilities(
    String chatId,
    Map<String, Object?> pluginSelections,
  ) async {
    capabilityCalls.add((chatId: chatId, selections: pluginSelections));
    await capabilitiesGate?.future;
    if (capabilitiesError case final error?) throw error;
    return capabilitiesAnswer?.call(pluginSelections) ??
        CloudCapabilityWriteResult(selections: pluginSelections);
  }

  @override
  Future<ComposerPluginCatalog> capabilityCatalog(String workspaceId) async {
    capabilityCatalogCalls.add(workspaceId);
    if (capabilityCatalogError case final error?) throw error;
    return capabilityCatalogValue;
  }

  @override
  Future<CloudModelCatalog> getModels() async {
    modelsCalls++;
    final deferred = modelsCompleter;
    if (deferred != null) return deferred.future;
    final error = modelsError;
    if (error != null) throw error;
    return catalog;
  }

  CloudWorkspaceSummary _workspace(String id) => _workspaces.firstWhere(
    (workspace) => workspace.externalId == id,
    orElse: () => throw const CloudApiException(
      statusCode: 404,
      message: 'workspace not found',
    ),
  );

  CloudChatSummary _chat(String id) {
    for (final workspace in _workspaces) {
      for (final chat in workspace.chats) {
        if (chat.externalId == id) return chat;
      }
    }
    throw const CloudApiException(statusCode: 404, message: 'chat not found');
  }

  void _replaceWorkspace(
    String id,
    CloudWorkspaceSummary Function(CloudWorkspaceSummary) update,
  ) {
    _workspace(id);
    _workspaces = [
      for (final workspace in _workspaces)
        if (workspace.externalId == id) update(workspace) else workspace,
    ];
  }

  CloudChatSummary _replaceChat(
    String id,
    CloudChatSummary Function(CloudChatSummary) update,
  ) {
    final updated = update(_chat(id));
    _workspaces = [
      for (final workspace in _workspaces)
        copyWorkspace(
          workspace,
          chats: [
            for (final chat in workspace.chats)
              if (chat.externalId == id) updated else chat,
          ],
        ),
    ];
    return updated;
  }
}

const Object _absent = Object();

CloudWorkspaceSummary copyWorkspace(
  CloudWorkspaceSummary value, {
  List<CloudChatSummary>? chats,
}) => CloudWorkspaceSummary(
  retainedChatCount: value.retainedChatCount,
  deletionRetentionDays: value.deletionRetentionDays,
  externalId: value.externalId,
  name: value.name,
  description: value.description,
  color: value.color,
  coreSandboxId: value.coreSandboxId,
  createdAtMs: value.createdAtMs,
  chats: chats ?? value.chats,
);

CloudChatSummary copyChat(
  CloudChatSummary value, {
  Object? title = _absent,
  Object? modelDefinitionId = _absent,
  String? coreAgentSessionId,
  bool? modelAuto,
}) => CloudChatSummary(
  externalId: value.externalId,
  title: identical(title, _absent) ? value.title : title as String?,
  taskChatExternalId: value.taskChatExternalId,
  modelDefinitionId: identical(modelDefinitionId, _absent)
      ? value.modelDefinitionId
      : modelDefinitionId as String?,
  thinkingLevel: value.thinkingLevel,
  fastMode: value.fastMode,
  coreAgentSessionId: coreAgentSessionId ?? value.coreAgentSessionId,
  createdAtMs: value.createdAtMs,
  openingClientRequestId: value.openingClientRequestId,
  capabilityBundles: value.capabilityBundles,
  capabilitySelections: value.capabilitySelections,
  capabilityWarnings: value.capabilityWarnings,
  modelAuto: modelAuto ?? value.modelAuto,
);

CloudWorkspaceSummary sampleWorkspace({
  String id = 'ws-1',
  String name = 'Mobile App',
  List<CloudChatSummary>? chats,
}) => CloudWorkspaceSummary(
  retainedChatCount: 0,
  deletionRetentionDays: 30,
  externalId: id,
  name: name,
  description: null,
  color: '#6558D3',
  coreSandboxId: 'sandbox-$id',
  createdAtMs: 1789800000000,
  chats: chats ?? [sampleChat()],
);

CloudChatSummary sampleChat({
  String id = 'chat-1',
  String? title = 'Plan the mobile launch',
  String? taskChatExternalId,
  String? model = 'gpt-5.6-luna',
  String? thinkingLevel = 'medium',
  bool? fastMode,
  String session = 'session-1',
  int createdAtMs = 1789890000000,
}) => CloudChatSummary(
  externalId: id,
  title: title,
  taskChatExternalId: taskChatExternalId,
  modelDefinitionId: model,
  thinkingLevel: thinkingLevel,
  fastMode: fastMode,
  coreAgentSessionId: session,
  createdAtMs: createdAtMs,
);

const CloudModelCatalog sampleCatalog = CloudModelCatalog(
  models: [
    CloudModelOption(
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      provider: 'openai',
      family: 'gpt',
      familyLabel: 'GPT',
      harness: 'codex',
      fastModeSupported: true,
      thinkingLevels: ['off', 'medium', 'high', 'xhigh'],
    ),
    CloudModelOption(
      id: 'claude-opus-5',
      label: 'Opus 5',
      provider: 'anthropic',
      family: 'claude',
      familyLabel: 'Claude',
      harness: 'claude',
      description: 'Deep reasoning',
      fastModeSupported: false,
      thinkingLevels: ['off', 'medium', 'high', 'max'],
    ),
  ],
  modelHarnesses: {'gpt-5.6-luna': 'codex', 'claude-opus-5': 'claude'},
  defaultModelId: 'gpt-5.6-luna',
  defaultModelBlocked: false,
);
