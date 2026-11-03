/// Hand-written Dart mirror of the paired desktop's App Advisor chat row
/// (`PortalAppAdvisorChatSummary` in `packages/protocol/src/portal/index.ts`).
library;

import 'package:mobile/data/models/remote_chat.dart';

/// One App Advisor chat tab, carried as an `app_advisor_chat` entity.
///
/// The desktop groups tabs into Work Entries (its Advisor nav rows); [summary]
/// is the tab itself in the shared chat-summary shape, so `active` marks the
/// Work Entry's selected tab and `pendingQuestions` keeps its omitted-versus-
/// empty contract.
class RemoteAppAdvisorChat {
  const RemoteAppAdvisorChat({
    required this.summary,
    this.workEntryId,
    this.workEntryTitle,
    this.workEntryCreatedAt,
    this.workEntryOrder,
    this.desktopCurrent = false,
  });

  final RemoteChatSummary summary;

  /// Owning Work Entry; older desktops omit it, making each tab its own row.
  final String? workEntryId;

  /// Desktop-derived Work Entry title shown in the Advisor nav.
  final String? workEntryTitle;

  /// ISO-8601 Work Entry creation time, the ordering fallback.
  final String? workEntryCreatedAt;

  /// The desktop's persisted manual Work Entry order.
  final int? workEntryOrder;

  /// True only for the chat selected in the desktop's current Work Entry.
  final bool desktopCurrent;

  String get chatId => summary.chatId;

  /// Groups tabs into rows: the Work Entry, or the tab alone without one.
  String get entryKey => workEntryId ?? chatId;

  factory RemoteAppAdvisorChat.fromJson(Map<String, dynamic> json) {
    final order = json['workEntryOrder'];
    return RemoteAppAdvisorChat(
      summary: RemoteChatSummary.fromJson(json),
      workEntryId: _nonEmptyString(json['workEntryId']),
      workEntryTitle: _nonEmptyString(json['workEntryTitle']),
      workEntryCreatedAt: _nonEmptyString(json['workEntryCreatedAt']),
      workEntryOrder: order is num ? order.toInt() : null,
      desktopCurrent: json['desktopCurrent'] == true,
    );
  }

  /// Applies a newer projection of the same tab. Pending questions the
  /// update omits keep their cached value, as the wire contract requires.
  RemoteAppAdvisorChat merge(RemoteAppAdvisorChat update) {
    final merged = update.summary.inheritPendingQuestions(summary);
    if (identical(merged, update.summary)) return update;
    return RemoteAppAdvisorChat(
      summary: merged,
      workEntryId: update.workEntryId,
      workEntryTitle: update.workEntryTitle,
      workEntryCreatedAt: update.workEntryCreatedAt,
      workEntryOrder: update.workEntryOrder,
      desktopCurrent: update.desktopCurrent,
    );
  }
}

/// The model choices of the desktop's App Advisor settings
/// (`PortalAppAdvisorSettings`): the default new chats run on, and the
/// catalog the desktop's own Advisor picker offers.
class RemoteAppAdvisorSettings {
  const RemoteAppAdvisorSettings({
    this.model,
    this.availableModels = const [],
    this.providerAvailability,
  });

  final String? model;
  final List<ModelOption> availableModels;
  final ProviderAvailability? providerAvailability;

  factory RemoteAppAdvisorSettings.fromJson(Map<String, dynamic> json) =>
      RemoteAppAdvisorSettings(
        model: _nonEmptyString(json['model']),
        availableModels: ModelOption.listFromJson(json['availableModels']),
        providerAvailability: ProviderAvailability.maybeFromJson(
          json['providerAvailability'],
        ),
      );
}

/// Extracts `app_advisor_chat` rows from a payload's entity envelopes.
List<RemoteAppAdvisorChat> parseAppAdvisorChatEntities(Object? rawEntities) {
  if (rawEntities is! List) return const [];
  final chats = <RemoteAppAdvisorChat>[];
  for (final row in rawEntities.whereType<Map<String, dynamic>>()) {
    if (row['entityType'] != 'app_advisor_chat') continue;
    final payload = row['payload'];
    if (payload is! Map<String, dynamic>) continue;
    final chat = RemoteAppAdvisorChat.fromJson(payload);
    if (chat.chatId.isNotEmpty) chats.add(chat);
  }
  return chats;
}

String? _nonEmptyString(Object? value) =>
    value is String && value.isNotEmpty ? value : null;
