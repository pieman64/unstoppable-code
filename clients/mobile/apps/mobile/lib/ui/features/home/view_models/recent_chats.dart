/// Pure model behind the drawer's Recents list (CAN-2931): cloud chats and
/// Remote Control chats interwoven into one history, newest activity first.
///
/// Remote Control rows carry the desktop's `lastMessageAt`. The cloud
/// workspaces payload carries only creation time, so a cloud row's activity
/// is its creation time raised by the latest user message this device has
/// observed for it ([cloudActivityAt]); a chat touched from another device
/// keeps sorting by creation until the server exposes a message timestamp.
library;

import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_chat_row.dart';

/// Most rows the drawer shows before older history is cut off.
const int recentChatsLimit = 30;

/// Where a chat runs, the only visual distinction between rows.
enum RecentChatLocation { cloud, computer }

/// Why a row carries the attention dot, if it does.
enum RecentChatAttention { none, unread, awaitingAnswer }

/// One row of the Recents list.
sealed class RecentChatEntry {
  const RecentChatEntry();

  /// Stable identity across sources, safe for widget keys.
  String get key;
  String get title;
  RecentChatLocation get location;
  RecentChatAttention get attention;

  /// Sort key; null when neither source knows when the chat was last active.
  DateTime? get activityAt;

  bool get needsAttention => attention != RecentChatAttention.none;
}

/// A cloud chat, resumed through the cloud chat screen.
final class CloudRecentChat extends RecentChatEntry {
  const CloudRecentChat({
    required this.chat,
    required this.workspaceId,
    required this.activityAt,
    required this.attention,
  });

  final CloudChatSummary chat;
  final String workspaceId;

  @override
  final DateTime? activityAt;
  @override
  final RecentChatAttention attention;

  @override
  String get key => 'cloud-${chat.externalId}';
  @override
  String get title => cloudChatDisplayTitle(chat);
  @override
  RecentChatLocation get location => RecentChatLocation.cloud;
}

/// A chat tab inside a worktree on the paired desktop.
final class RemoteWorktreeRecentChat extends RecentChatEntry {
  const RemoteWorktreeRecentChat({
    required this.chat,
    required this.worktree,
    required this.activityAt,
    required this.attention,
  });

  final RemoteChatSummary chat;
  final RemoteWorktree worktree;

  @override
  final DateTime? activityAt;
  @override
  final RecentChatAttention attention;

  @override
  String get key => 'remote-worktree-${worktree.localId}-${chat.chatId}';
  @override
  String get title => chat.displayTitle;
  @override
  RecentChatLocation get location => RecentChatLocation.computer;
}

/// A standalone (cowork) chat on the paired desktop.
final class RemoteStandaloneRecentChat extends RecentChatEntry {
  const RemoteStandaloneRecentChat({
    required this.chat,
    required this.activityAt,
    required this.attention,
  });

  final RemoteStandaloneChat chat;

  @override
  final DateTime? activityAt;
  @override
  final RecentChatAttention attention;

  @override
  String get key => 'remote-standalone-${chat.localId}';
  @override
  String get title => chat.displayTitle;
  @override
  RecentChatLocation get location => RecentChatLocation.computer;
}

/// Flattens both chat inventories into one list ordered by [activityAt]
/// descending, then capped at [limit].
///
/// Rows the user could not open are left out: worktree chats whose worktree
/// is missing or hidden from the sidebar, chats in explicitly hidden
/// workspaces, and archived standalone chats.
/// Rows without any timestamp sort last, keeping their source order.
List<RecentChatEntry> buildRecentChats({
  required List<CloudWorkspaceSummary> cloudWorkspaces,
  DateTime? Function(String chatId)? cloudActivityAt,
  Set<String> cloudChatsAwaitingAnswer = const {},
  List<RemoteWorkspace> remoteWorkspaces = const [],
  List<RemoteWorktree> remoteWorktrees = const [],
  List<RemoteStandaloneChat> remoteStandaloneChats = const [],
  List<RemoteChatSummary> remoteChatSummaries = const [],
  int limit = recentChatsLimit,
}) {
  final entries = <RecentChatEntry>[];

  for (final workspace in cloudWorkspaces) {
    for (final chat in workspace.chats) {
      final created = DateTime.fromMillisecondsSinceEpoch(
        chat.createdAtMs,
        isUtc: true,
      );
      final observed = cloudActivityAt?.call(chat.externalId);
      entries.add(
        CloudRecentChat(
          chat: chat,
          workspaceId: workspace.externalId,
          activityAt: observed != null && observed.isAfter(created)
              ? observed
              : created,
          attention: cloudChatsAwaitingAnswer.contains(chat.externalId)
              ? RecentChatAttention.awaitingAnswer
              : RecentChatAttention.none,
        ),
      );
    }
  }

  final hiddenWorkspaceIds = <String>{
    for (final workspace in remoteWorkspaces)
      if (workspace.hidden) workspace.localId,
  };
  final worktreesById = <String, RemoteWorktree>{
    for (final worktree in remoteWorktrees)
      if (worktree.hidden != true &&
          !hiddenWorkspaceIds.contains(worktree.workspaceLocalId))
        worktree.localId: worktree,
  };
  for (final chat in remoteChatSummaries) {
    if (chat.scope == RemoteChatScope.standalone) continue;
    final worktree = worktreesById[chat.worktreeLocalId];
    if (worktree == null) continue;
    final workspace = chat.workspaceLocalId;
    if (workspace != null &&
        workspace.isNotEmpty &&
        workspace != worktree.workspaceLocalId) {
      continue;
    }
    entries.add(
      RemoteWorktreeRecentChat(
        chat: chat,
        worktree: worktree,
        activityAt: _parse(chat.lastMessageAt) ?? _parse(chat.createdAt),
        attention: _hasOpenQuestion(chat.pendingQuestions)
            ? RecentChatAttention.awaitingAnswer
            : chat.hasUnread == true
            ? RecentChatAttention.unread
            : RecentChatAttention.none,
      ),
    );
  }

  final standaloneSummaries = <String, RemoteChatSummary>{
    for (final chat in remoteChatSummaries)
      if (chat.scope == RemoteChatScope.standalone) chat.chatId: chat,
  };
  for (final chat in remoteStandaloneChats) {
    if (chat.archived == true ||
        hiddenWorkspaceIds.contains(chat.projectLocalId)) {
      continue;
    }
    final summary = standaloneSummaries[chat.localId];
    final rowActivity = _parse(chat.lastMessageAt);
    final summaryActivity = _parse(summary?.lastMessageAt);
    entries.add(
      RemoteStandaloneRecentChat(
        chat: chat,
        activityAt:
            summaryActivity != null &&
                (rowActivity == null || summaryActivity.isAfter(rowActivity))
            ? summaryActivity
            : rowActivity,
        attention: _hasOpenQuestion(summary?.pendingQuestions)
            ? RecentChatAttention.awaitingAnswer
            : chat.hasUnread == true || summary?.hasUnread == true
            ? RecentChatAttention.unread
            : RecentChatAttention.none,
      ),
    );
  }

  // Stable: rows sharing a timestamp (or lacking one) keep source order.
  final indexed = entries.indexed.toList()
    ..sort((left, right) {
      final a = left.$2.activityAt;
      final b = right.$2.activityAt;
      if (a == null && b == null) return left.$1.compareTo(right.$1);
      if (a == null) return 1;
      if (b == null) return -1;
      final byActivity = b.compareTo(a);
      return byActivity != 0 ? byActivity : left.$1.compareTo(right.$1);
    });
  return List.unmodifiable([
    for (final (_, entry) in indexed.take(limit)) entry,
  ]);
}

bool _hasOpenQuestion(List<AskUserQuestionState>? questions) =>
    questions != null && questions.any((question) => !question.answered);

DateTime? _parse(String? iso) => iso == null ? null : DateTime.tryParse(iso);
