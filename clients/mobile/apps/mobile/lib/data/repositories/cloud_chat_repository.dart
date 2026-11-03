import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_conversation_v2.dart';
import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/data/services/cloud_invocables_api_service.dart';

const Object _repositoryFieldAbsent = Object();

abstract interface class CloudChatRepository {
  /// Null until the server-side cloud gate has answered for this account.
  bool? get supportsCloudChats;

  Future<List<CloudWorkspaceSummary>> listWorkspaces();

  /// Creates the account's first workspace, or adopts it when it already
  /// exists. Null when the server declines because the account already had
  /// its first workspace and archived it.
  Future<CloudWorkspaceSummary?> provisionFirstWorkspace(String name);
  Future<List<CloudChatSummary>> listChats(String workspaceId);
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
  });
  Future<CloudChatSummary> getChat(String chatId);
  Future<CloudChatSummary> renameChat(String chatId, String? title);
  Future<CloudChatSummary> setChatModel(
    String chatId,
    String? modelDefinitionId,
  );

  /// Turns on Auto (`modelSelectionMode: 'AUTO'`).
  Future<CloudChatSummary> setChatAutoModel(String chatId);
  Future<void> archiveChat(String chatId);
  Future<void> deleteChat(String chatId);
  Future<CloudChatBootstrap> getMessages(String chatId);
  Future<CloudChatStatus> getMessageStatus(String chatId);
  Future<PostTurnResult> postMessage(
    String chatId, {
    required String text,
    required String clientRequestId,
    String? modelDefinitionId,
    String? thinkingLevel,
    bool resetThinkingLevel = false,
    bool? fastMode,
    bool replayHint,
    List<ChatAttachmentRef> cloudAttachments,
  });

  /// Uploads one file to the chat's attachment store and returns the ready
  /// ref to send as `cloudAttachments`. Throws [CloudApiException] with the
  /// server's reason (too large, unsupported type, too many in flight).
  Future<ChatAttachmentRef> uploadChatAttachment(
    String chatId, {
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  });

  /// Removes a not-yet-sent upload. Best-effort; the server sweep reclaims
  /// orphans.
  Future<void> deleteChatAttachment(String chatId, String attachmentId);
  Future<AgentTurnInterruptResult> interruptTurn(String chatId, String turnId);
  Future<CloudChatSummary> continueChat(
    String chatId, {
    required String sourceAgentSessionId,
    bool? fastMode,
  });
  Future<ConversationDiscoveryMetadata> discoverConversation(String chatId);
  Future<ConversationSnapshot> getConversation(String chatId);
  Future<ConversationHistoryPage> getConversationHistory(
    String chatId,
    String cursor,
  );
  Future<ConversationAcceptedTurn> postConversationTurn(
    String chatId,
    ConversationSendInput input,
  );
  Future<ConversationCommandReceipt> conversationCommand(
    String chatId,
    String turnId,
    ConversationTurnOperation operation,
    ConversationCommandInput input,
  );
  Future<CloudModelCatalog> getModels();

  /// The chat's slash-invocation inventory for [modelDefinitionId].
  Future<CloudInvocableInventory> listChatInvocables(
    String chatId, {
    String? modelDefinitionId,
  });

  /// The project's slash-invocation inventory before a chat exists.
  Future<CloudInvocableInventory> listWorkspaceInvocables(
    String workspaceId, {
    String? modelDefinitionId,
    Map<String, Object?>? pluginSelections,
  });

  /// Saves the chat's complete desired capability selection and answers
  /// what the chat holds afterwards.
  Future<CloudCapabilityWriteResult> setChatCapabilities(
    String chatId,
    Map<String, Object?> pluginSelections,
  );

  /// What the chats of [workspaceId] can select.
  Future<ComposerPluginCatalog> capabilityCatalog(String workspaceId);
}

final class HttpCloudChatRepository implements CloudChatRepository {
  HttpCloudChatRepository({required this.service});

  final CloudApiService service;
  bool? _supportsCloudChats;

  @override
  bool? get supportsCloudChats => _supportsCloudChats;

  @override
  Future<List<CloudWorkspaceSummary>> listWorkspaces() async {
    try {
      final workspaces = await service.listWorkspaces();
      _supportsCloudChats = true;
      return workspaces;
    } on CloudApiException catch (error) {
      if (error.statusCode != 404) rethrow;
      _supportsCloudChats = false;
      return const [];
    }
  }

  @override
  Future<CloudWorkspaceSummary?> provisionFirstWorkspace(String name) =>
      service.provisionFirstWorkspace(name);

  @override
  Future<List<CloudChatSummary>> listChats(String workspaceId) async {
    final workspaces = await listWorkspaces();
    for (final workspace in workspaces) {
      if (workspace.externalId == workspaceId) return workspace.chats;
    }
    return const [];
  }

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
  }) => service.createChat(
    workspaceId,
    externalId: externalId,
    title: title,
    prompt: prompt,
    modelDefinitionId: modelDefinitionId,
    autoModel: autoModel,
    thinkingLevel: thinkingLevel,
    fastMode: fastMode,
    pluginSelections: pluginSelections,
  );

  @override
  Future<CloudChatSummary> getChat(String chatId) => service.getChat(chatId);

  @override
  Future<CloudChatSummary> renameChat(String chatId, String? title) =>
      service.renameChat(chatId, title);

  @override
  Future<CloudChatSummary> setChatModel(
    String chatId,
    String? modelDefinitionId,
  ) => service.setChatModel(chatId, modelDefinitionId);

  @override
  Future<CloudChatSummary> setChatAutoModel(String chatId) =>
      service.setChatAutoModel(chatId);

  @override
  Future<void> archiveChat(String chatId) => service.archiveChat(chatId);

  @override
  Future<void> deleteChat(String chatId) => service.deleteChat(chatId);

  @override
  Future<CloudChatBootstrap> getMessages(String chatId) =>
      service.getMessages(chatId);

  @override
  Future<CloudChatStatus> getMessageStatus(String chatId) =>
      service.getMessageStatus(chatId);

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
  }) => service.postMessage(
    chatId,
    text: text,
    clientRequestId: clientRequestId,
    modelDefinitionId: modelDefinitionId,
    thinkingLevel: thinkingLevel,
    resetThinkingLevel: resetThinkingLevel,
    fastMode: fastMode,
    replayHint: replayHint,
    cloudAttachments: cloudAttachments,
  );

  @override
  Future<ChatAttachmentRef> uploadChatAttachment(
    String chatId, {
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) => service.uploadChatAttachment(
    chatId,
    filename: filename,
    mediaType: mediaType,
    bytes: bytes,
  );

  @override
  Future<void> deleteChatAttachment(String chatId, String attachmentId) =>
      service.deleteChatAttachment(chatId, attachmentId);

  @override
  Future<AgentTurnInterruptResult> interruptTurn(
    String chatId,
    String turnId,
  ) => service.interruptTurn(chatId, turnId);

  @override
  Future<CloudChatSummary> continueChat(
    String chatId, {
    required String sourceAgentSessionId,
    bool? fastMode,
  }) => service.continueChat(
    chatId,
    sourceAgentSessionId: sourceAgentSessionId,
    fastMode: fastMode,
  );

  @override
  Future<ConversationDiscoveryMetadata> discoverConversation(String chatId) =>
      service.discoverConversation(chatId);
  @override
  Future<ConversationSnapshot> getConversation(String chatId) =>
      service.getConversation(chatId);
  @override
  Future<ConversationHistoryPage> getConversationHistory(
    String chatId,
    String cursor,
  ) => service.getConversationHistory(chatId, cursor);
  @override
  Future<ConversationAcceptedTurn> postConversationTurn(
    String chatId,
    ConversationSendInput input,
  ) => service.postConversationTurn(chatId, input);
  @override
  Future<ConversationCommandReceipt> conversationCommand(
    String chatId,
    String turnId,
    ConversationTurnOperation operation,
    ConversationCommandInput input,
  ) => service.conversationCommand(chatId, turnId, operation, input);

  @override
  Future<CloudModelCatalog> getModels() => service.getModels();

  late final _invocables = CloudInvocablesApiService(
    apiClient: service.apiClient,
  );

  @override
  Future<CloudInvocableInventory> listChatInvocables(
    String chatId, {
    String? modelDefinitionId,
  }) =>
      _invocables.chatInvocables(chatId, modelDefinitionId: modelDefinitionId);

  @override
  Future<CloudInvocableInventory> listWorkspaceInvocables(
    String workspaceId, {
    String? modelDefinitionId,
    Map<String, Object?>? pluginSelections,
  }) => _invocables.workspaceInvocables(
    workspaceId,
    modelDefinitionId: modelDefinitionId,
    pluginSelections: pluginSelections,
  );

  @override
  Future<CloudCapabilityWriteResult> setChatCapabilities(
    String chatId,
    Map<String, Object?> pluginSelections,
  ) => _invocables.setChatCapabilities(chatId, pluginSelections);

  @override
  Future<ComposerPluginCatalog> capabilityCatalog(String workspaceId) =>
      _invocables.capabilityCatalog(workspaceId);
}

/// Stateful demo/test twin of [HttpCloudChatRepository].
final class MockCloudChatRepository implements CloudChatRepository {
  MockCloudChatRepository({this.latency = const Duration(milliseconds: 400)})
    : _workspaces = [_sampleWorkspace];

  final Duration latency;
  List<CloudWorkspaceSummary> _workspaces;

  @override
  bool get supportsCloudChats => true;

  Future<void> _wait() => Future<void>.delayed(latency);

  @override
  Future<List<CloudWorkspaceSummary>> listWorkspaces() async {
    await _wait();
    return List.unmodifiable(_workspaces);
  }

  @override
  Future<CloudWorkspaceSummary?> provisionFirstWorkspace(String name) async {
    await _wait();
    if (_workspaces.isNotEmpty) return _workspaces.first;
    final workspace = _copyWorkspace(
      _sampleWorkspace,
      chats: const [],
      externalId: 'mock-first-workspace',
      name: name,
    );
    _workspaces = [workspace];
    return workspace;
  }

  @override
  Future<List<CloudChatSummary>> listChats(String workspaceId) async {
    await _wait();
    return List.unmodifiable(_workspace(workspaceId).chats);
  }

  @override
  Future<CloudChatSummary> createChat(
    String workspaceId, {
    required String externalId,
    String? title,
    String? prompt,
    String? modelDefinitionId,
    bool autoModel = false,
    String? thinkingLevel,
    bool resetThinkingLevel = false,
    bool? fastMode,
    Map<String, Object?>? pluginSelections,
  }) async {
    await _wait();
    final chat = CloudChatSummary(
      externalId: externalId,
      title: title,
      taskChatExternalId: null,
      modelDefinitionId: autoModel ? null : modelDefinitionId,
      modelAuto: autoModel,
      thinkingLevel: thinkingLevel,
      fastMode: fastMode,
      coreAgentSessionId: 'mock-session-$externalId',
      createdAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    _replaceWorkspace(
      workspaceId,
      (workspace) =>
          _copyWorkspace(workspace, chats: [...workspace.chats, chat]),
    );
    return chat;
  }

  @override
  Future<CloudChatSummary> getChat(String chatId) async {
    await _wait();
    return _chat(chatId);
  }

  @override
  Future<CloudChatSummary> renameChat(String chatId, String? title) async {
    await _wait();
    return _replaceChat(chatId, (chat) => _copyChat(chat, title: title));
  }

  @override
  Future<CloudChatSummary> setChatModel(
    String chatId,
    String? modelDefinitionId,
  ) async {
    await _wait();
    return _replaceChat(
      chatId,
      (chat) => _copyChat(
        chat,
        modelDefinitionId: modelDefinitionId,
        modelAuto: false,
      ),
    );
  }

  @override
  Future<CloudChatSummary> setChatAutoModel(String chatId) async {
    await _wait();
    return _replaceChat(chatId, (chat) => _copyChat(chat, modelAuto: true));
  }

  @override
  Future<void> archiveChat(String chatId) => _removeChat(chatId);

  @override
  Future<void> deleteChat(String chatId) => _removeChat(chatId);

  Future<void> _removeChat(String chatId) async {
    await _wait();
    _workspaces = [
      for (final workspace in _workspaces)
        _copyWorkspace(
          workspace,
          chats: workspace.chats
              .where((chat) => chat.externalId != chatId)
              .toList(growable: false),
        ),
    ];
  }

  @override
  Future<CloudChatBootstrap> getMessages(String chatId) async {
    await _wait();
    _chat(chatId);
    return const CloudChatBootstrap(messages: [], toolActivity: []);
  }

  @override
  Future<CloudChatStatus> getMessageStatus(String chatId) async {
    await _wait();
    final chat = _chat(chatId);
    return CloudChatStatus(sourceAgentSessionId: chat.coreAgentSessionId);
  }

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
    await _wait();
    _chat(chatId);
    return PostTurnResult(
      message: CloudCoreMessage(
        id: 'mock-message-$clientRequestId',
        clientRequestId: clientRequestId,
        role: 'USER',
        text: text,
        cost: const CloudCoreCost(kind: CloudCoreCostKind.pending),
        costBilledViaLlmProxy: false,
        createdAtMs: DateTime.now().millisecondsSinceEpoch,
        artifacts: const [],
        attachments: [for (final ref in cloudAttachments) ref.toJson()],
      ),
      replayed: replayHint,
    );
  }

  int _mockAttachmentSeq = 0;

  @override
  Future<ChatAttachmentRef> uploadChatAttachment(
    String chatId, {
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    await _wait();
    _chat(chatId);
    final seq = ++_mockAttachmentSeq;
    return ChatAttachmentRef(
      attachmentId:
          '00000000-0000-4000-9000-${seq.toString().padLeft(12, '0')}',
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
      contentSha256: sha256.convert(bytes).toString(),
      storageKind: 'blob',
      source: '/mock/$chatId/$seq',
    );
  }

  @override
  Future<void> deleteChatAttachment(String chatId, String attachmentId) =>
      _wait();

  @override
  Future<AgentTurnInterruptResult> interruptTurn(
    String chatId,
    String turnId,
  ) async {
    await _wait();
    _chat(chatId);
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
    await _wait();
    final chat = _chat(chatId);
    return _replaceChat(
      chatId,
      (value) => _copyChat(value, fastMode: fastMode ?? chat.fastMode),
    );
  }

  @override
  Future<ConversationDiscoveryMetadata> discoverConversation(
    String chatId,
  ) async => ConversationDiscoveryMetadata(
    sessionId: _chat(chatId).coreAgentSessionId,
    protocolVersion: 1,
  );
  @override
  Future<ConversationSnapshot> getConversation(String chatId) async =>
      throw UnsupportedError('Demo chats use protocol v1');
  @override
  Future<ConversationHistoryPage> getConversationHistory(
    String chatId,
    String cursor,
  ) async => throw UnsupportedError('Demo chats use protocol v1');
  @override
  Future<ConversationAcceptedTurn> postConversationTurn(
    String chatId,
    ConversationSendInput input,
  ) async => throw UnsupportedError('Demo chats use protocol v1');
  @override
  Future<ConversationCommandReceipt> conversationCommand(
    String chatId,
    String turnId,
    ConversationTurnOperation operation,
    ConversationCommandInput input,
  ) async => throw UnsupportedError('Demo chats use protocol v1');

  @override
  Future<CloudModelCatalog> getModels() async {
    await _wait();
    return _sampleCatalog;
  }

  static const _sampleInvocables = [
    ComposerCommand(
      name: 'review',
      description: 'Review the current changes',
      insertText: '/review ',
    ),
    ComposerCommand(
      name: 'release-notes',
      description: 'Draft release notes from merged work',
      insertText: '/release-notes ',
      enableRef: {'sourceId': 'mock-source', 'skillName': 'release-notes'},
    ),
  ];

  @override
  Future<CloudInvocableInventory> listChatInvocables(
    String chatId, {
    String? modelDefinitionId,
  }) async {
    await _wait();
    return const CloudInvocableInventory(rows: _sampleInvocables);
  }

  @override
  Future<CloudInvocableInventory> listWorkspaceInvocables(
    String workspaceId, {
    String? modelDefinitionId,
    Map<String, Object?>? pluginSelections,
  }) async {
    await _wait();
    return const CloudInvocableInventory(rows: _sampleInvocables);
  }

  @override
  Future<CloudCapabilityWriteResult> setChatCapabilities(
    String chatId,
    Map<String, Object?> pluginSelections,
  ) async {
    await _wait();
    return CloudCapabilityWriteResult(selections: pluginSelections);
  }

  @override
  Future<ComposerPluginCatalog> capabilityCatalog(String workspaceId) async {
    await _wait();
    return const ComposerPluginCatalog(
      items: [
        ComposerPluginItem(
          kind: ComposerPluginKind.plugin,
          ref: {'marketplaceId': 'mock-market', 'pluginName': 'github'},
          name: 'GitHub',
          description: 'Pull requests, issues, and checks',
        ),
        ComposerPluginItem(
          kind: ComposerPluginKind.skill,
          ref: {'sourceId': 'mock-source', 'skillName': 'release-notes'},
          name: 'Release notes',
          description: 'Draft release notes from merged work',
        ),
      ],
    );
  }

  CloudWorkspaceSummary _workspace(String id) => _workspaces.firstWhere(
    (workspace) => workspace.externalId == id,
    orElse: () => throw StateError('Unknown cloud workspace $id'),
  );

  CloudChatSummary _chat(String id) {
    for (final workspace in _workspaces) {
      for (final chat in workspace.chats) {
        if (chat.externalId == id) return chat;
      }
    }
    throw StateError('Unknown cloud chat $id');
  }

  void _replaceWorkspace(
    String id,
    CloudWorkspaceSummary Function(CloudWorkspaceSummary) update,
  ) {
    _workspaces = [
      for (final workspace in _workspaces)
        if (workspace.externalId == id) update(workspace) else workspace,
    ];
  }

  CloudChatSummary _replaceChat(
    String id,
    CloudChatSummary Function(CloudChatSummary) update,
  ) {
    CloudChatSummary? result;
    CloudChatSummary replace(CloudChatSummary chat) {
      if (chat.externalId != id) return chat;
      final updated = update(chat);
      result = updated;
      return updated;
    }

    _workspaces = [
      for (final workspace in _workspaces)
        _copyWorkspace(
          workspace,
          chats: [for (final chat in workspace.chats) replace(chat)],
        ),
    ];
    final updated = result;
    if (updated == null) throw StateError('Unknown cloud chat $id');
    return updated;
  }
}

const _sampleChat = CloudChatSummary(
  externalId: 'cloud-chat-1',
  title: 'Plan the mobile launch',
  taskChatExternalId: null,
  modelDefinitionId: 'gpt-5.6-luna',
  thinkingLevel: 'medium',
  fastMode: false,
  coreAgentSessionId: 'mock-session-1',
  createdAtMs: 1789891200000,
);

const _sampleWorkspace = CloudWorkspaceSummary(
  retainedChatCount: 0,
  deletionRetentionDays: 30,
  externalId: 'cloud-workspace-1',
  name: 'Mobile App',
  description: 'Cloud tasks for the mobile team',
  color: '#6558D3',
  coreSandboxId: 'mock-sandbox-1',
  createdAtMs: 1789804800000,
  chats: [_sampleChat],
);

const _sampleCatalog = CloudModelCatalog(
  models: [
    CloudModelOption(
      id: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      provider: 'openai',
      family: 'gpt',
      familyLabel: 'GPT',
      harness: 'codex',
      thinkingLevels: ['off', 'low', 'medium', 'high'],
    ),
  ],
  modelHarnesses: {'gpt-5.6-luna': 'codex'},
  defaultModelId: 'gpt-5.6-luna',
  defaultModelBlocked: false,
);

CloudWorkspaceSummary _copyWorkspace(
  CloudWorkspaceSummary value, {
  List<CloudChatSummary>? chats,
  String? externalId,
  String? name,
}) => CloudWorkspaceSummary(
  retainedChatCount: value.retainedChatCount,
  deletionRetentionDays: value.deletionRetentionDays,
  externalId: externalId ?? value.externalId,
  name: name ?? value.name,
  description: value.description,
  color: value.color,
  coreSandboxId: value.coreSandboxId,
  createdAtMs: value.createdAtMs,
  chats: chats ?? value.chats,
);

CloudChatSummary _copyChat(
  CloudChatSummary value, {
  Object? title = _repositoryFieldAbsent,
  Object? modelDefinitionId = _repositoryFieldAbsent,
  bool? fastMode,
  bool? modelAuto,
}) => CloudChatSummary(
  externalId: value.externalId,
  title: identical(title, _repositoryFieldAbsent)
      ? value.title
      : title as String?,
  taskChatExternalId: value.taskChatExternalId,
  modelDefinitionId: identical(modelDefinitionId, _repositoryFieldAbsent)
      ? value.modelDefinitionId
      : modelDefinitionId as String?,
  thinkingLevel: value.thinkingLevel,
  fastMode: fastMode ?? value.fastMode,
  coreAgentSessionId: value.coreAgentSessionId,
  createdAtMs: value.createdAtMs,
  openingClientRequestId: value.openingClientRequestId,
  capabilityBundles: value.capabilityBundles,
  capabilitySelections: value.capabilitySelections,
  capabilityWarnings: value.capabilityWarnings,
  modelAuto: modelAuto ?? value.modelAuto,
);
