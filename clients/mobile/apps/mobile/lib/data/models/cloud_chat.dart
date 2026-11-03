/// Hand-written mirrors of the browser-safe `/api/cloud` chat contracts.
///
/// Wire identifiers, decimal money, byte sizes, versions, and cursors remain
/// strings so Dart never rounds values whose range belongs to another system.
library;

String _string(Object? value, [String fallback = '']) =>
    value is String ? value : fallback;
String? _optionalString(Object? value) => value is String ? value : null;
int _int(Object? value) => value is num ? value.toInt() : 0;
int? _optionalInt(Object? value) => value is num ? value.toInt() : null;
Map<String, dynamic> _map(Object? value) =>
    value is Map<String, dynamic> ? value : const {};
List<Map<String, dynamic>> _maps(Object? value) => value is List
    ? value.whereType<Map<String, dynamic>>().toList(growable: false)
    : const [];
String? _wireString(Object? value) => switch (value) {
  String text => text,
  num number => number.toString(),
  _ => null,
};

final class CloudWorkspaceSummary {
  const CloudWorkspaceSummary({
    required this.retainedChatCount,
    required this.deletionRetentionDays,
    required this.externalId,
    required this.name,
    required this.description,
    required this.color,
    required this.coreSandboxId,
    required this.createdAtMs,
    required this.chats,
  });

  final int retainedChatCount;
  final int deletionRetentionDays;
  final String externalId;
  final String name;
  final String? description;
  final String? color;
  final String? coreSandboxId;
  final int createdAtMs;
  final List<CloudChatSummary> chats;

  factory CloudWorkspaceSummary.fromJson(Map<String, dynamic> json) =>
      CloudWorkspaceSummary(
        retainedChatCount: _int(json['retainedChatCount']),
        deletionRetentionDays: _int(json['deletionRetentionDays']),
        externalId: _string(json['externalId']),
        name: _string(json['name']),
        description: _optionalString(json['description']),
        color: _optionalString(json['color']),
        coreSandboxId: _optionalString(json['coreSandboxId']),
        createdAtMs: _int(json['createdAtMs']),
        chats: _maps(
          json['chats'],
        ).map(CloudChatSummary.fromJson).toList(growable: false),
      );
}

final class CloudChatSummary {
  const CloudChatSummary({
    required this.externalId,
    required this.title,
    required this.taskChatExternalId,
    required this.modelDefinitionId,
    required this.thinkingLevel,
    required this.coreAgentSessionId,
    required this.createdAtMs,
    this.fastMode,
    this.openingClientRequestId,
    this.capabilityBundles,
    this.capabilitySelections,
    this.capabilityWarnings = const [],
    this.modelAuto = false,
  });

  final String externalId;
  final String? title;
  final String? taskChatExternalId;
  final String? modelDefinitionId;
  final String? thinkingLevel;
  final bool? fastMode;
  final String coreAgentSessionId;
  final int createdAtMs;
  final String? openingClientRequestId;
  final Map<String, dynamic>? capabilityBundles;
  final Map<String, dynamic>? capabilitySelections;
  final List<String> capabilityWarnings;

  /// The chat is in Auto (`modelSelectionMode: 'auto'`); the server routes
  /// each turn and [modelDefinitionId] stays the concrete fallback.
  final bool modelAuto;

  factory CloudChatSummary.fromJson(
    Map<String, dynamic> json,
  ) => CloudChatSummary(
    externalId: _string(json['externalId']),
    title: _optionalString(json['title']),
    taskChatExternalId: _optionalString(json['taskChatExternalId']),
    modelDefinitionId: _optionalString(json['modelDefinitionId']),
    thinkingLevel: _optionalString(json['thinkingLevel']),
    fastMode: json['fastMode'] is bool ? json['fastMode'] as bool : null,
    coreAgentSessionId: _string(json['coreAgentSessionId']),
    createdAtMs: _int(json['createdAtMs']),
    openingClientRequestId: _optionalString(json['openingClientRequestId']),
    capabilityBundles: json['capabilityBundles'] is Map<String, dynamic>
        ? Map.unmodifiable(json['capabilityBundles'] as Map<String, dynamic>)
        : null,
    capabilitySelections: json['capabilitySelections'] is Map<String, dynamic>
        ? Map.unmodifiable(json['capabilitySelections'] as Map<String, dynamic>)
        : null,
    capabilityWarnings: json['capabilityWarnings'] is List
        ? (json['capabilityWarnings'] as List).whereType<String>().toList(
            growable: false,
          )
        : const [],
    modelAuto: json['modelSelectionMode'] == 'auto',
  );

  /// This chat with another selection mode and model.
  CloudChatSummary withModelSelection({
    required bool modelAuto,
    required String? modelDefinitionId,
  }) => CloudChatSummary(
    externalId: externalId,
    title: title,
    taskChatExternalId: taskChatExternalId,
    modelDefinitionId: modelDefinitionId,
    thinkingLevel: thinkingLevel,
    fastMode: fastMode,
    coreAgentSessionId: coreAgentSessionId,
    createdAtMs: createdAtMs,
    openingClientRequestId: openingClientRequestId,
    capabilityBundles: capabilityBundles,
    capabilitySelections: capabilitySelections,
    capabilityWarnings: capabilityWarnings,
    modelAuto: modelAuto,
  );
}

enum CloudCoreCostKind { billable, zero, pending, invalid, unknown }

final class CloudCoreCost {
  const CloudCoreCost({required this.kind, this.amountUsd, this.raw});

  final CloudCoreCostKind kind;
  final String? amountUsd;
  final Object? raw;

  factory CloudCoreCost.fromJson(Object? value) {
    final json = _map(value);
    return switch (json['kind']) {
      'billable' => CloudCoreCost(
        kind: CloudCoreCostKind.billable,
        amountUsd: _wireString(json['costUsd']),
      ),
      'zero' => const CloudCoreCost(kind: CloudCoreCostKind.zero),
      'pending' => const CloudCoreCost(kind: CloudCoreCostKind.pending),
      'invalid' => CloudCoreCost(
        kind: CloudCoreCostKind.invalid,
        raw: json['raw'],
      ),
      _ => CloudCoreCost(kind: CloudCoreCostKind.unknown, raw: value),
    };
  }
}

final class CloudCoreArtifact {
  const CloudCoreArtifact({
    this.id,
    required this.toolCallId,
    required this.artifactIndex,
    required this.kind,
    required this.label,
    required this.storageKind,
    this.sizeBytes,
    required this.fileName,
    this.fileContent,
    this.metadata,
  });

  final String? id;
  final String toolCallId;
  final int artifactIndex;
  final String kind;
  final String label;
  final String storageKind;
  final String? sizeBytes;
  final String fileName;
  final String? fileContent;
  final Map<String, dynamic>? metadata;

  factory CloudCoreArtifact.fromJson(Map<String, dynamic> json) {
    final file = _map(json['file']);
    return CloudCoreArtifact(
      id: _optionalString(json['id']),
      toolCallId: _string(json['toolCallId']),
      artifactIndex: _int(json['artifactIndex']),
      kind: _string(json['kind']),
      label: _string(json['label']),
      storageKind: _string(json['storageKind']),
      sizeBytes: _wireString(json['sizeBytes']),
      fileName: _string(file['name']),
      fileContent: _optionalString(file['content']),
      metadata: json['metadata'] is Map<String, dynamic>
          ? Map.unmodifiable(json['metadata'] as Map<String, dynamic>)
          : null,
    );
  }
}

final class CloudCoreMessage {
  const CloudCoreMessage({
    required this.id,
    required this.role,
    required this.text,
    required this.cost,
    required this.costBilledViaLlmProxy,
    required this.createdAtMs,
    required this.artifacts,
    this.clientRequestId,
    this.sequence,
    this.contentBlocks = const [],
    this.model,
    this.usage,
    this.attachments = const [],
    this.sourceKey,
    this.reasoningText,
    this.taskId,
  });

  final String id;
  final String? clientRequestId;
  final int? sequence;
  final String role;
  final String text;
  final List<Map<String, dynamic>> contentBlocks;
  final CloudCoreCost cost;
  final Map<String, dynamic>? model;
  final Map<String, dynamic>? usage;
  final bool costBilledViaLlmProxy;
  final int createdAtMs;
  final List<CloudCoreArtifact> artifacts;
  final List<Map<String, dynamic>> attachments;
  final String? sourceKey;
  final String? reasoningText;

  /// Set on an agent task (subagent) reply, which is not a root message.
  final String? taskId;

  factory CloudCoreMessage.fromJson(Map<String, dynamic> json) =>
      CloudCoreMessage(
        id: _string(json['id']),
        clientRequestId: _optionalString(json['clientRequestId']),
        sequence: _optionalInt(json['sequence']),
        role: _string(json['role'], 'UNKNOWN'),
        text: _string(json['text']),
        contentBlocks: _maps(json['contentBlocks']),
        cost: CloudCoreCost.fromJson(json['cost']),
        model: json['model'] is Map<String, dynamic>
            ? Map.unmodifiable(json['model'] as Map<String, dynamic>)
            : null,
        usage: json['usage'] is Map<String, dynamic>
            ? Map.unmodifiable(json['usage'] as Map<String, dynamic>)
            : null,
        costBilledViaLlmProxy: json['costBilledViaLlmProxy'] == true,
        createdAtMs: _int(json['createdAtMs']),
        artifacts: _maps(
          json['artifacts'],
        ).map(CloudCoreArtifact.fromJson).toList(growable: false),
        attachments: _maps(json['attachments']),
        sourceKey: _optionalString(json['sourceKey']),
        reasoningText: _optionalString(json['reasoningText']),
        taskId: _taskId(json),
      );
}

String? _taskId(Map<String, dynamic> json) {
  final id = json['taskId'];
  return id is String && id.isNotEmpty ? id : null;
}

enum CloudToolActivityKind { call, result, unknown }

final class CloudChatToolActivity {
  const CloudChatToolActivity({
    required this.kind,
    required this.rawKind,
    this.sourceKey,
    this.toolCallId,
    this.toolName,
    this.input,
    this.output,
    this.isError,
    required this.raw,
  });

  final CloudToolActivityKind kind;
  final String rawKind;
  final String? sourceKey;
  final String? toolCallId;
  final String? toolName;
  final String? input;
  final String? output;
  final bool? isError;
  final Map<String, dynamic> raw;

  /// Set on an agent task's own tool call or result.
  String? get taskId => switch (raw[rawKind]) {
    final Map<String, dynamic> payload => _taskId(payload) ?? _taskId(raw),
    _ => _taskId(raw),
  };

  factory CloudChatToolActivity.fromJson(Map<String, dynamic> json) {
    final rawKind = _string(json['kind']);
    final payload = _map(
      rawKind == 'call'
          ? json['call']
          : rawKind == 'result'
          ? json['result']
          : null,
    );
    return CloudChatToolActivity(
      kind: switch (rawKind) {
        'call' => CloudToolActivityKind.call,
        'result' => CloudToolActivityKind.result,
        _ => CloudToolActivityKind.unknown,
      },
      rawKind: rawKind,
      sourceKey:
          _optionalString(payload['sourceKey']) ??
          _optionalString(json['sourceKey']),
      toolCallId: _optionalString(payload['toolCallId']),
      toolName: _optionalString(payload['toolName']),
      input: _optionalString(payload['input']),
      output: _optionalString(payload['output']),
      isError: payload['isError'] is bool ? payload['isError'] as bool : null,
      raw: Map.unmodifiable(json),
    );
  }
}

final class CloudTerminalSession {
  const CloudTerminalSession({
    required this.status,
    required this.sourceAgentSessionId,
  });
  final String status;
  final String sourceAgentSessionId;

  factory CloudTerminalSession.fromJson(Map<String, dynamic> json) =>
      CloudTerminalSession(
        status: _string(json['status']),
        sourceAgentSessionId: _string(json['sourceAgentSessionId']),
      );
}

final class CloudChatStatus {
  const CloudChatStatus({
    this.sourceAgentSessionId,
    this.livenessUnknown = false,
    this.terminalSession,
  });
  final String? sourceAgentSessionId;
  final bool livenessUnknown;
  final CloudTerminalSession? terminalSession;

  factory CloudChatStatus.fromJson(Map<String, dynamic> json) {
    final terminal = json['terminalSession'];
    return CloudChatStatus(
      sourceAgentSessionId: _optionalString(json['sourceAgentSessionId']),
      livenessUnknown: json['livenessUnknown'] == true,
      terminalSession: terminal is Map<String, dynamic>
          ? CloudTerminalSession.fromJson(terminal)
          : null,
    );
  }
}

final class CloudChatBootstrap {
  const CloudChatBootstrap({
    required this.messages,
    required this.toolActivity,
    this.activeTurnId,
    this.activeUserMessageId,
    this.executionHarness,
    this.activeStreamAfter,
    this.livenessUnknown = false,
    this.terminalSession,
    this.harnessWarnings = const [],
    this.compactions = const [],
  });

  final List<CloudCoreMessage> messages;
  final List<CloudChatToolActivity> toolActivity;
  final String? activeTurnId;
  final String? activeUserMessageId;
  final String? executionHarness;
  final String? activeStreamAfter;
  final bool livenessUnknown;
  final CloudTerminalSession? terminalSession;
  final List<Map<String, dynamic>> harnessWarnings;
  final List<Map<String, dynamic>> compactions;

  factory CloudChatBootstrap.fromJson(Map<String, dynamic> json) {
    final terminal = json['terminalSession'];
    return CloudChatBootstrap(
      messages: _maps(
        json['messages'],
      ).map(CloudCoreMessage.fromJson).toList(growable: false),
      toolActivity: _maps(
        json['toolActivity'],
      ).map(CloudChatToolActivity.fromJson).toList(growable: false),
      activeTurnId: _optionalString(json['activeTurnId']),
      activeUserMessageId: _optionalString(json['activeUserMessageId']),
      executionHarness: _optionalString(json['executionHarness']),
      activeStreamAfter: _wireString(_map(json['activeStream'])['after']),
      livenessUnknown: json['livenessUnknown'] == true,
      terminalSession: terminal is Map<String, dynamic>
          ? CloudTerminalSession.fromJson(terminal)
          : null,
      harnessWarnings: _maps(json['harnessWarnings']),
      compactions: _maps(json['compactions']),
    );
  }
}

final class PostTurnResult {
  const PostTurnResult({
    required this.message,
    required this.replayed,
    this.streamAfter,
    this.capabilityBundles,
    this.capabilityBundleStateVersion,
    this.title,
    this.modelSelectionMode,
    this.modelDefinitionId,
  });
  final CloudCoreMessage message;
  final bool replayed;
  final String? streamAfter;
  final Object? capabilityBundles;
  final String? capabilityBundleStateVersion;
  final String? title;

  /// The selection mode (`auto` or `manual`) and model the server saved with
  /// this turn; null when it did not say.
  final String? modelSelectionMode;
  final String? modelDefinitionId;

  factory PostTurnResult.fromJson(Map<String, dynamic> json) {
    final message = json['message'];
    final cost = message is Map<String, dynamic> ? message['cost'] : null;
    final role = message is Map<String, dynamic> ? message['role'] : null;
    final createdAtMs = message is Map<String, dynamic>
        ? message['createdAtMs']
        : null;
    if (message is! Map<String, dynamic> ||
        message['id'] is! String ||
        !const {'USER', 'ASSISTANT', 'SYSTEM', 'TOOL'}.contains(role) ||
        message['text'] is! String ||
        cost is! Map<String, dynamic> ||
        !const {
          'billable',
          'zero',
          'pending',
          'invalid',
        }.contains(cost['kind']) ||
        message['costBilledViaLlmProxy'] is! bool ||
        createdAtMs is! num ||
        !createdAtMs.isFinite ||
        message['artifacts'] is! List) {
      throw const FormatException('Invalid cloud turn message');
    }
    final replayed = json['replayed'];
    if (replayed is! bool) {
      throw const FormatException('Invalid cloud turn replay status');
    }
    return PostTurnResult(
      message: CloudCoreMessage.fromJson(message),
      replayed: replayed,
      streamAfter: _wireString(json['streamAfter']),
      capabilityBundles: json['capabilityBundles'],
      capabilityBundleStateVersion: _wireString(
        json['capabilityBundleStateVersion'],
      ),
      title: _optionalString(json['title']),
      modelSelectionMode: _optionalString(json['modelSelectionMode']),
      modelDefinitionId: _optionalString(json['modelDefinitionId']),
    );
  }
}

enum AgentTurnInterruptOutcome {
  interruptRequested,
  alreadyTerminal,
  superseded,
  unknown,
}

final class AgentTurnInterruptResult {
  const AgentTurnInterruptResult({
    required this.outcome,
    required this.rawOutcome,
    required this.turnId,
    this.activeTurnId,
  });
  final AgentTurnInterruptOutcome outcome;
  final String rawOutcome;
  final String turnId;
  final String? activeTurnId;

  factory AgentTurnInterruptResult.fromJson(Map<String, dynamic> json) {
    final raw = _string(json['outcome']);
    return AgentTurnInterruptResult(
      outcome: switch (raw) {
        'interrupt_requested' => AgentTurnInterruptOutcome.interruptRequested,
        'already_terminal' => AgentTurnInterruptOutcome.alreadyTerminal,
        'superseded' => AgentTurnInterruptOutcome.superseded,
        _ => AgentTurnInterruptOutcome.unknown,
      },
      rawOutcome: raw,
      turnId: _string(json['turnId']),
      activeTurnId: _optionalString(json['activeTurnId']),
    );
  }
}

final class CloudModelOption {
  const CloudModelOption({
    required this.id,
    required this.label,
    required this.provider,
    required this.family,
    required this.familyLabel,
    this.contextWindow,
    this.description,
    this.showMoreOnly = false,
    this.harness,
    this.fastGatewayId,
    this.fastModeSupported,
    this.thinkingLevels,
    this.libraryLocked = false,
  });
  final String id;
  final String label;
  final int? contextWindow;
  final String? description;
  final bool showMoreOnly;
  final String? provider;
  final String? harness;
  final String? fastGatewayId;
  final bool? fastModeSupported;
  final List<String>? thinkingLevels;
  final String? family;
  final String? familyLabel;

  /// The server's `libraryEligibility: 'locked'`: the account's model library
  /// access ([CloudModelCatalog.modelLibrary]) does not cover this model.
  final bool libraryLocked;

  factory CloudModelOption.fromJson(Map<String, dynamic> json) =>
      CloudModelOption(
        id: _string(json['id']),
        label: _string(json['label']),
        contextWindow: _optionalInt(json['contextWindow']),
        description: _optionalString(json['description']),
        showMoreOnly: json['showMoreOnly'] == true,
        provider: _optionalString(json['provider']),
        harness: _optionalString(json['harness']),
        fastGatewayId: _optionalString(json['fastGatewayId']),
        fastModeSupported: json['fastModeSupported'] is bool
            ? json['fastModeSupported'] as bool
            : null,
        thinkingLevels: json.containsKey('thinkingLevels')
            ? (json['thinkingLevels'] is List
                  ? (json['thinkingLevels'] as List).whereType<String>().toList(
                      growable: false,
                    )
                  : const [])
            : null,
        family: _optionalString(json['family']),
        familyLabel: _optionalString(json['familyLabel']),
        libraryLocked: json['libraryEligibility'] == 'locked',
      );
}

final class CloudModelCatalog {
  const CloudModelCatalog({
    required this.models,
    required this.modelHarnesses,
    required this.defaultModelId,
    required this.defaultModelBlocked,
    this.defaultModelUnavailable = false,
    this.defaultModelFallbackId,
    this.modelLibrary,
  });
  final List<CloudModelOption> models;
  final Map<String, String> modelHarnesses;
  final String? defaultModelId;
  final bool defaultModelBlocked;
  final bool defaultModelUnavailable;
  final String? defaultModelFallbackId;

  /// The account's model library access (`unlocked`, `needs_sign_in`,
  /// `needs_sign_in_then_purchase` or `needs_purchase`); null from a server
  /// that predates it.
  final String? modelLibrary;

  factory CloudModelCatalog.fromJson(Map<String, dynamic> json) =>
      CloudModelCatalog(
        models: _maps(
          json['models'],
        ).map(CloudModelOption.fromJson).toList(growable: false),
        modelHarnesses: {
          for (final entry in _map(json['modelHarnesses']).entries)
            if (entry.value is String) entry.key: entry.value as String,
        },
        defaultModelId: _optionalString(json['defaultModelId']),
        defaultModelBlocked: json['defaultModelBlocked'] == true,
        defaultModelUnavailable: json['defaultModelUnavailable'] == true,
        defaultModelFallbackId: _optionalString(json['defaultModelFallbackId']),
        modelLibrary: _optionalString(json['modelLibrary']),
      );
}
