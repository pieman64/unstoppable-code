/// Durable cloud sends the server has not accepted (CAN-3556).
library;

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_session.dart';

const String kCloudUnsentSurface = 'cloud';

String cloudUnsentRecordId(String clientRequestId) =>
    '$kCloudUnsentSurface:$clientRequestId';

final class CloudUnsentRecord {
  const CloudUnsentRecord({
    required this.clientRequestId,
    required this.payload,
    required this.createdAt,
    required this.status,
    this.chatId,
    this.workspaceId,
    this.externalId,
    this.attempts = 0,
    this.error,
    this.pluginSelections,
  });

  /// A first message whose chat create has not been confirmed. Its
  /// [externalId] is reused on every create attempt so the server returns the
  /// same chat (`cloud-service.ts` `createChat`).
  factory CloudUnsentRecord.pendingCreate({
    required String workspaceId,
    required String externalId,
    required String clientRequestId,
    required CloudSendPayload payload,
    required DateTime createdAt,
    Map<String, Object?>? pluginSelections,
  }) => CloudUnsentRecord(
    clientRequestId: clientRequestId,
    payload: payload,
    createdAt: createdAt,
    status: UnsentStatus.sending,
    workspaceId: workspaceId,
    externalId: externalId,
    pluginSelections: pluginSelections,
  );

  factory CloudUnsentRecord.fromEntry(
    CloudOutboxEntry entry, {
    required String chatId,
    required UnsentStatus status,
  }) => CloudUnsentRecord(
    clientRequestId: entry.clientRequestId,
    payload: entry.payload,
    createdAt: entry.enqueuedAt,
    status: status,
    chatId: chatId,
    attempts: entry.attempts,
    error: status == UnsentStatus.sending ? null : entry.lastError?.message,
  );

  final String clientRequestId;
  final CloudSendPayload payload;
  final DateTime createdAt;
  final UnsentStatus status;
  final String? chatId;
  final String? workspaceId;
  final String? externalId;
  final int attempts;
  final String? error;

  /// The draft's own capability selection, sent with every create attempt
  /// (pending creates only). Null keeps the project defaults.
  final Map<String, Object?>? pluginSelections;

  bool get isPendingCreate => chatId == null;

  CloudUnsentRecord copyWith({
    UnsentStatus? status,
    String? error,
    bool clearError = false,
    String? chatId,
  }) => CloudUnsentRecord(
    clientRequestId: clientRequestId,
    payload: payload,
    createdAt: createdAt,
    status: status ?? this.status,
    chatId: chatId ?? this.chatId,
    workspaceId: workspaceId,
    externalId: externalId,
    attempts: attempts,
    error: clearError ? null : (error ?? this.error),
    pluginSelections: pluginSelections,
  );

  bool sameAs(CloudUnsentRecord other) =>
      other.status == status &&
      other.attempts == attempts &&
      other.error == error &&
      other.chatId == chatId &&
      other.payload.text == payload.text;

  UnsentRecord toUnsentRecord() => UnsentRecord(
    id: cloudUnsentRecordId(clientRequestId),
    surface: kCloudUnsentSurface,
    targetKey: switch (chatId) {
      final chatId? => CloudChatDraftTarget(chatId).key,
      null => CloudNewChatDraftTarget(workspaceId ?? '').key,
    },
    text: payload.text,
    createdAt: createdAt,
    status: status,
    error: error,
    extra: {
      'clientRequestId': clientRequestId,
      'chatId': ?chatId,
      'workspaceId': ?workspaceId,
      'externalId': ?externalId,
      'attempts': attempts,
      'modelDefinitionId': ?payload.modelDefinitionId,
      'thinkingLevel': ?payload.thinkingLevel,
      'resetThinkingLevel': payload.resetThinkingLevel,
      'fastMode': ?payload.fastMode,
      if (payload.autoModel) 'autoModel': true,
      'pluginSelections': ?pluginSelections,
      if (payload.attachments.isNotEmpty)
        'attachments': [for (final ref in payload.attachments) ref.toJson()],
    },
  );

  static CloudUnsentRecord? fromRecord(UnsentRecord record) {
    if (record.surface != kCloudUnsentSurface) return null;
    final extra = record.extra;
    final id = extra['clientRequestId'];
    if (id is! String) return null;
    String? text(String key) => switch (extra[key]) {
      final String value => value,
      _ => null,
    };
    final attempts = extra['attempts'];
    final reset = extra['resetThinkingLevel'];
    final fast = extra['fastMode'];
    final selections = extra['pluginSelections'];
    final attachments = extra['attachments'];
    final chatId = text('chatId');
    final workspaceId = text('workspaceId');
    if (chatId == null && workspaceId == null) return null;
    return CloudUnsentRecord(
      clientRequestId: id,
      payload: CloudSendPayload(
        text: record.text,
        modelDefinitionId: text('modelDefinitionId'),
        thinkingLevel: text('thinkingLevel'),
        resetThinkingLevel: reset is bool && reset,
        fastMode: fast is bool ? fast : null,
        autoModel: extra['autoModel'] == true,
        attachments: [
          if (attachments is List)
            for (final ref in attachments)
              if (ref is Map)
                ChatAttachmentRef.fromJson({
                  for (final MapEntry(:key, :value) in ref.entries)
                    if (key is String) key: value,
                }),
        ],
      ),
      createdAt: record.createdAt,
      status: record.status,
      chatId: chatId,
      workspaceId: workspaceId,
      externalId: text('externalId'),
      attempts: attempts is int ? attempts : 0,
      error: record.error,
      pluginSelections: selections is Map
          ? {
              for (final MapEntry(:key, :value) in selections.entries)
                if (key is String) key: value,
            }
          : null,
    );
  }

  /// The `failedSends` entry for a restored record. Nothing posts until the
  /// user taps Resend; an interrupted send replays under its original id.
  CloudOutboxEntry toFailedEntry() {
    final interrupted = status != UnsentStatus.notSent;
    return CloudOutboxEntry(
      clientRequestId: clientRequestId,
      payload: payload,
      enqueuedAt: createdAt,
      attempts: interrupted && attempts == 0 ? 1 : attempts,
      lastError: CloudSendError(
        kind: CloudSendErrorKind.definitive,
        status: 0,
        message: error ?? '',
        uncertain: interrupted,
      ),
    );
  }
}

List<CloudUnsentRecord> cloudRecordsForChat(
  UnsentRecordPort store,
  String chatId,
) => [
  for (final record in store.unsentFor(kCloudUnsentSurface))
    if (CloudUnsentRecord.fromRecord(record) case final typed?
        when typed.chatId == chatId)
      typed,
];

List<CloudUnsentRecord> cloudPendingCreates(
  UnsentRecordPort store,
  String workspaceId,
) => [
  for (final record in store.unsentFor(kCloudUnsentSurface))
    if (CloudUnsentRecord.fromRecord(record) case final typed?
        when typed.isPendingCreate && typed.workspaceId == workspaceId)
      typed,
]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
