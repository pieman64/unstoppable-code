/// Chat and worktree identities shared by `RemoteControlViewModel` and its
/// collaborators. Pure Dart, so engine collaborators can key their state on
/// these without depending on Flutter.
library;

import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';

/// A chat's identity across the worktree and standalone namespaces.
typedef RemoteChatKey = ({RemoteChatScope scope, String chatId});

/// One worktree's identity: the key of every per-worktree map.
typedef RemoteWorktreeKey = ({String workspaceLocalId, String worktreeLocalId});

/// Starts a one-shot timer. Injected into collaborators so their schedules
/// can run under a fake clock and outside Flutter.
typedef RemoteTimerFactory =
    Timer Function(Duration delay, void Function() callback);

RemoteChatKey? remoteChatKeyForTarget(RemoteChatTarget target) {
  final chatId = target.chatId;
  if (chatId == null || chatId.isEmpty) return null;
  return (scope: target.scope, chatId: chatId);
}

RemoteWorktreeKey remoteWorktreeKey(
  String workspaceLocalId,
  String worktreeLocalId,
) => (workspaceLocalId: workspaceLocalId, worktreeLocalId: worktreeLocalId);

RemoteWorktreeKey remoteWorktreeKeyOf(RemoteWorktree worktree) =>
    remoteWorktreeKey(worktree.workspaceLocalId, worktree.localId);

/// Parses the `'<workspaceLocalId>:<worktreeLocalId>'` keys of the PR maps
/// carried by portal events. Local ids never contain a colon.
RemoteWorktreeKey? remoteWorktreeKeyFromEvent(String key) {
  final separator = key.indexOf(':');
  if (separator < 0) return null;
  return remoteWorktreeKey(
    key.substring(0, separator),
    key.substring(separator + 1),
  );
}
