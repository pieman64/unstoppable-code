/// Parsed Portal event batches consumed by the mobile Remote Control feature.
///
/// Both event transports — the SSE stream (`GET .../events/stream`) and the
/// long-poll fallback (`GET .../events`) — deliver byte-identical
/// `PollBrowserPortalEventsResponse` JSON: an array of `PortalEventEnvelope`
/// rows plus the `nextCursor` to resume from and the desktop's derived
/// `connectionStatus`. See `packages/protocol/src/portal/index.ts`.
///
/// Only the envelope types the mobile UI reacts to are given typed shapes;
/// everything else parses to [RemoteUnknownPortalEvent] and is ignored.
library;

import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_provider_usage.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';

/// Desktop connection status derived from heartbeat age
/// (`PortalConnectionStatus`).
enum RemotePortalConnectionStatus {
  pending('pending'),
  active('active'),
  reconnecting('reconnecting'),
  inactive('inactive'),
  ended('ended');

  const RemotePortalConnectionStatus(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values.
  static RemotePortalConnectionStatus? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// One event delivered by the Portal event channel.
sealed class RemotePortalEvent {
  const RemotePortalEvent();
}

/// `portal.chat.event` — a whole-message upsert for one chat thread.
final class RemoteChatMessageEvent extends RemotePortalEvent {
  const RemoteChatMessageEvent({
    required this.chatId,
    required this.message,
    this.cursor,
    this.scope,
    this.workspaceLocalId,
    this.worktreeLocalId,
  });

  final int? cursor;
  final String chatId;
  final RemoteChatMessage message;
  final RemoteChatScope? scope;
  final String? workspaceLocalId;
  final String? worktreeLocalId;
}

/// `portal.state.snapshot` — a scoped snapshot landed in the server cache.
/// When the desktop projected a chat transcript for the scope, the payload
/// carries the full message window in `chatMessages` (live wire shape), and
/// worktree-scoped snapshots carry the chat-tab list as `chat_summary`
/// entities — parsed here so consumers can render tabs straight from the
/// event instead of paying a full state re-fetch on the critical path.
/// The routing `target` echoes which subtree the snapshot answered, letting
/// consumers resolve their pending hydration spinners precisely.
final class RemoteStateSnapshotEvent extends RemotePortalEvent {
  const RemoteStateSnapshotEvent({
    this.eventId,
    this.commandId,
    this.cursor,
    this.scope,
    this.workspaces,
    this.worktrees,
    this.standaloneChats,
    this.chatMessages = const [],
    this.chatMessagesTruncated = false,
    this.selectedChatOnly = false,
    this.chatSummaries = const [],
    this.targetWorkspaceLocalId,
    this.targetWorktreeLocalId,
    this.targetChatId,
    this.targetChatScope,
    this.prProgress,
    this.prStatuses = const {},
    this.providerUsage,
  });

  final String? eventId;

  /// Command whose state request produced this snapshot, when present.
  final String? commandId;

  /// Server-assigned row cursor; older servers omit it.
  final int? cursor;

  /// Wire `PortalStateScope` (`overview`, `worktree`, `chat`, ...).
  final String? scope;

  /// Shell entities carried by the snapshot. Null means the entities field
  /// was absent/malformed; an empty list is an authoritative empty collection
  /// only when the consumer applies the matching snapshot scope.
  final List<RemoteWorkspace>? workspaces;
  final List<RemoteWorktree>? worktrees;

  /// Standalone chats carried by the snapshot, with the same null/empty
  /// meaning as [workspaces].
  final List<RemoteStandaloneChat>? standaloneChats;

  final List<RemoteChatMessage> chatMessages;

  /// True when [chatMessages] is only a bounded tail of the desktop
  /// transcript — consumers must merge instead of replacing cached rows
  /// (`PortalStateSnapshotPayload.chatMessagesTruncated`).
  final bool chatMessagesTruncated;

  /// Negotiated foreground snapshot contains the authoritative worktree tabs.
  final bool selectedChatOnly;

  /// Chat-tab rows from the payload's `chat_summary` entity envelopes.
  final List<RemoteChatSummary> chatSummaries;

  /// `target.workspaceLocalId`, when the request was subtree-scoped.
  final String? targetWorkspaceLocalId;

  /// `target.worktreeLocalId`, when the request was subtree-scoped.
  final String? targetWorktreeLocalId;

  /// The chat the snapshot answered: `target.chatLocalId` (worktree chats)
  /// or `target.standaloneChatLocalId` (standalone chats).
  final String? targetChatId;

  /// Namespace of [targetChatId], derived from which target id field landed.
  final RemoteChatScope? targetChatScope;

  /// Live PR creation/merge feeds from `pr_status` entities, keyed
  /// `'<workspaceLocalId>:<worktreeLocalId>'`. Null when the payload carried
  /// no entity list at all; empty when it carried entities but no progress.
  final Map<String, RemotePrProgressState>? prProgress;

  /// Authoritative PR observations keyed by workspace/worktree, independent
  /// of progress-only patches. Empty lists explicitly clear the PR badges.
  final Map<String, List<RemoteWorktreePr>> prStatuses;

  /// The account-level usage singleton. Only overview snapshots own it, so
  /// other scopes leave it null rather than clearing it.
  final RemoteProviderUsageUpdate? providerUsage;
}

/// Terminal failure of a deferred worktree create
/// (`PortalStateDeltaPayload.worktreeSetupFailure`). The desktop rolls the
/// reserved worktree back when its background git setup fails, so this delta
/// field is the only signal — there is no entity left to inspect and no
/// `portal.command.failed` for the (successfully acknowledged) create.
final class RemoteWorktreeSetupFailure {
  const RemoteWorktreeSetupFailure({
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.error,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final String error;
}

/// `portal.state.delta` — incremental cached-entity update, applied locally
/// without fetching the overview again.
/// [worktreeSetupFailure] is also consumed directly and cannot be recovered
/// from a later state read.
final class RemoteStateDeltaEvent extends RemotePortalEvent {
  const RemoteStateDeltaEvent({
    this.requiresOverviewRefresh = false,
    this.shell = const RemoteShellDelta(),
    this.worktreeSetupFailure,
    this.chatSummaries = const [],
    this.eventId,
    this.cursor,
    this.scope,
    this.workspaces,
    this.worktrees,
    this.prProgress,
    this.prStatuses = const {},
    this.providerUsage,
  });

  final String? eventId;

  /// Server-assigned row cursor; older servers omit it.
  final int? cursor;
  final String? scope;
  final List<RemoteWorkspace>? workspaces;
  final List<RemoteWorktree>? worktrees;

  /// An older server sent shell removals, standalone chats or workspaces
  /// without a per-event cursor. Their order against an overview read is
  /// unknown, so they are not applied and the overview is read instead.
  /// Consumers rate-limit this fallback.
  final bool requiresOverviewRefresh;

  /// Removals and standalone chat upserts, applied before and after the
  /// other rows respectively.
  final RemoteShellDelta shell;

  final RemoteWorktreeSetupFailure? worktreeSetupFailure;
  final List<RemoteChatSummary> chatSummaries;

  /// Live PR creation/merge feeds from `pr_status` entities, keyed
  /// `'<workspaceLocalId>:<worktreeLocalId>'`. Null when the payload carried
  /// no entity list at all; empty when it carried entities but no progress.
  final Map<String, RemotePrProgressState>? prProgress;

  /// Same authoritative PR observations as [RemoteStateSnapshotEvent.prStatuses].
  final Map<String, List<RemoteWorktreePr>> prStatuses;

  /// An upsert or removal of the account-level usage singleton; null when
  /// this delta does not touch it.
  final RemoteProviderUsageUpdate? providerUsage;
}

/// `portal.session.ended` — the desktop ended the Remote Control session.
final class RemoteSessionEndedEvent extends RemotePortalEvent {
  const RemoteSessionEndedEvent();
}

/// `portal.command.failed` — asynchronous failure of a submitted desktop
/// command. The mobile surface keeps the human-readable reason so a delayed
/// rejection is not silently lost after the initiating request returned.
/// `portal.command.completed` — terminal success for a queued command,
/// carrying the desktop's result payload (e.g. the created worktree record
/// for `portal.worktree.create`). This is the authoritative outcome for
/// commands whose submit round trip ended before the desktop finished.
final class RemoteCommandCompletedEvent extends RemotePortalEvent {
  const RemoteCommandCompletedEvent({this.commandId, this.result});

  final String? commandId;
  final Map<String, dynamic>? result;
}

final class RemoteCommandFailedEvent extends RemotePortalEvent {
  const RemoteCommandFailedEvent({
    required this.message,
    this.commandId,
    this.code,
  });

  final String? code;

  final String message;
  final String? commandId;
}

/// `portal.pipeline.event` upsert of a `pipeline_run` entity — the desktop's
/// answer to `portal.pipeline.execution.get` and
/// `portal.pipeline.log_request`, and the live tick for every run the desktop
/// executes, including ones started there.
final class RemotePipelineRunEvent extends RemotePortalEvent {
  const RemotePipelineRunEvent({required this.run, this.commandId});

  final RemotePipelineRun run;

  /// Set when this upsert answers a command this device submitted.
  final String? commandId;
}

/// `portal.pipeline.event` removal of a `pipeline_run` entity.
final class RemotePipelineRunRemovedEvent extends RemotePortalEvent {
  const RemotePipelineRunRemovedEvent({required this.localId});

  final String localId;
}

/// `portal.hook.event` for a `hook_descriptor` entity. The desktop sends an
/// upsert for each hook after a pause or resume. An upsert carries the
/// descriptor row (`PortalHookSummary`), as worktree state reads return it;
/// a removal carries only the hook's key.
final class RemoteHookDescriptorEvent extends RemotePortalEvent {
  const RemoteHookDescriptorEvent({
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    required this.hookKey,
    this.descriptor,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  final String hookKey;

  /// The upserted row, with its worktree and key; null for a removal.
  final Map<String, dynamic>? descriptor;
}

/// `portal.app_advisor.event` — a whole-message upsert for one App Advisor
/// chat. Its own envelope type, so it never mixes with worktree or
/// standalone chat traffic.
final class RemoteAppAdvisorMessageEvent extends RemotePortalEvent {
  const RemoteAppAdvisorMessageEvent({
    required this.chatId,
    required this.message,
  });

  final String chatId;
  final RemoteChatMessage message;
}

/// `portal.state.snapshot` with scope `app_advisor`. Untargeted, [chats] is
/// every Advisor tab and replaces the cached list; targeted at
/// [targetChatId], it replaces only that tab. [chatMessages] seeds the
/// transcripts and is a bounded tail when [chatMessagesTruncated].
final class RemoteAppAdvisorSnapshotEvent extends RemotePortalEvent {
  const RemoteAppAdvisorSnapshotEvent({
    required this.chats,
    this.commandId,
    this.targetChatId,
    this.chatMessages = const [],
    this.chatMessagesTruncated = false,
  });

  final List<RemoteAppAdvisorChat> chats;

  /// Command whose state request produced this snapshot, when present.
  final String? commandId;
  final String? targetChatId;
  final List<RemoteChatMessage> chatMessages;
  final bool chatMessagesTruncated;
}

/// `portal.state.delta` with scope `app_advisor`: tab upserts and removals.
final class RemoteAppAdvisorDeltaEvent extends RemotePortalEvent {
  const RemoteAppAdvisorDeltaEvent({
    required this.chats,
    this.removedChatIds = const [],
  });

  final List<RemoteAppAdvisorChat> chats;
  final List<String> removedChatIds;
}

/// Any envelope type the mobile UI does not consume.
final class RemoteUnknownPortalEvent extends RemotePortalEvent {
  const RemoteUnknownPortalEvent(this.type);

  final String type;
}

/// One `PollBrowserPortalEventsResponse` batch, shared by both transports.
class RemotePortalEventBatch {
  const RemotePortalEventBatch({
    required this.events,
    required this.nextCursor,
    this.connectionStatus,
  });

  final List<RemotePortalEvent> events;

  /// Numeric cursor to resume the channel from (`?after=`).
  final int nextCursor;
  final RemotePortalConnectionStatus? connectionStatus;

  factory RemotePortalEventBatch.fromJson(Map<String, dynamic> json) {
    final rawEvents = json['events'];
    final nextCursor = json['nextCursor'];
    return RemotePortalEventBatch(
      events: rawEvents is List
          ? rawEvents
                .whereType<Map<String, dynamic>>()
                .map(_parseEnvelope)
                .toList(growable: false)
          : const [],
      nextCursor: nextCursor is num ? nextCursor.toInt() : 0,
      connectionStatus: RemotePortalConnectionStatus.fromWire(
        _stringOrNull(json['connectionStatus']),
      ),
    );
  }
}

RemotePortalEvent _parseEnvelope(Map<String, dynamic> envelope) {
  final type = _stringOrNull(envelope['type']) ?? '';
  final rawPayload = envelope['payload'];
  final payload = rawPayload is Map<String, dynamic>
      ? rawPayload
      : const <String, dynamic>{};

  switch (type) {
    case 'portal.chat.event':
      final rawMessage = payload['message'];
      if (rawMessage is! Map<String, dynamic>) {
        return RemoteUnknownPortalEvent(type);
      }
      return RemoteChatMessageEvent(
        cursor: _eventCursor(envelope['cursor']),
        chatId: _stringOrNull(payload['chatId']) ?? '',
        message: RemoteChatMessage.fromWireJson(rawMessage),
        scope: RemoteChatScope.fromWire(_stringOrNull(payload['scope'])),
        workspaceLocalId: _stringOrNull(payload['workspaceLocalId']),
        worktreeLocalId: _stringOrNull(payload['worktreeLocalId']),
      );
    case 'portal.state.snapshot' when payload['scope'] == 'app_advisor':
      final rawTarget = payload['target'];
      return RemoteAppAdvisorSnapshotEvent(
        chats: parseAppAdvisorChatEntities(payload['entities']),
        commandId: _stringOrNull(envelope['commandId']),
        targetChatId: rawTarget is Map<String, dynamic>
            ? _stringOrNull(rawTarget['chatLocalId'])
            : null,
        chatMessages: _parseWireMessages(payload['chatMessages']),
        chatMessagesTruncated: payload['chatMessagesTruncated'] == true,
      );
    case 'portal.state.delta' when payload['scope'] == 'app_advisor':
      final removed = payload['removed'];
      return RemoteAppAdvisorDeltaEvent(
        chats: parseAppAdvisorChatEntities(payload['entities']),
        removedChatIds: [
          if (removed is List)
            for (final row in removed.whereType<Map<String, dynamic>>())
              if (row['entityType'] == 'app_advisor_chat')
                if (row['localId'] case final String id when id.isNotEmpty) id,
        ],
      );
    case 'portal.app_advisor.event':
      final rawMessage = payload['message'];
      final chatId = _stringOrNull(payload['chatId']);
      if (rawMessage is! Map<String, dynamic> ||
          chatId == null ||
          chatId.isEmpty) {
        return RemoteUnknownPortalEvent(type);
      }
      return RemoteAppAdvisorMessageEvent(
        chatId: chatId,
        message: RemoteChatMessage.fromWireJson(rawMessage),
      );
    case 'portal.state.snapshot':
      final rawMessages = payload['chatMessages'];
      final rawTarget = payload['target'];
      final target = rawTarget is Map<String, dynamic>
          ? rawTarget
          : const <String, dynamic>{};
      final standaloneChatId = _stringOrNull(target['standaloneChatLocalId']);
      final worktreeChatId = _stringOrNull(target['chatLocalId']);
      return RemoteStateSnapshotEvent(
        eventId: _stringOrNull(envelope['eventId']),
        commandId: _stringOrNull(envelope['commandId']),
        cursor: _eventCursor(envelope['cursor']),
        scope: _stringOrNull(payload['scope']),
        workspaces: _parseShellEntities(
          payload['entities'],
          'workspace',
        )?.map(RemoteWorkspace.fromJson).toList(growable: false),
        worktrees: _parseShellEntities(
          payload['entities'],
          'worktree',
        )?.map(RemoteWorktree.fromJson).toList(growable: false),
        standaloneChats: parseStandaloneChatEntities(payload['entities']),
        chatMessages: rawMessages is List
            ? rawMessages
                  .whereType<Map<String, dynamic>>()
                  .map(RemoteChatMessage.fromWireJson)
                  .toList(growable: false)
            : const [],
        chatMessagesTruncated: payload['chatMessagesTruncated'] == true,
        selectedChatOnly: payload['selectedChatOnly'] == true,
        chatSummaries: _parseChatSummaryEntities(payload['entities']),
        targetWorkspaceLocalId: _stringOrNull(target['workspaceLocalId']),
        targetWorktreeLocalId: _stringOrNull(target['worktreeLocalId']),
        targetChatId: worktreeChatId ?? standaloneChatId,
        targetChatScope: worktreeChatId != null
            ? RemoteChatScope.worktree
            : standaloneChatId != null
            ? RemoteChatScope.standalone
            : null,
        prProgress: _parsePrProgressEntities(payload['entities']),
        prStatuses: _parsePrStatusEntities(payload),
        providerUsage: payload['scope'] == 'overview'
            ? parseProviderUsageEntities(
                payload['entities'],
                authoritative: true,
              )
            : null,
      );
    case 'portal.state.delta':
      final cursor = _eventCursor(envelope['cursor']);
      final shell = RemoteShellDelta.fromPayload(payload);
      final workspaces = _parseShellEntities(
        payload['entities'],
        'workspace',
      )?.map(RemoteWorkspace.fromJson).toList(growable: false);
      return RemoteStateDeltaEvent(
        requiresOverviewRefresh:
            cursor == null &&
            (!shell.isEmpty ||
                (payload['scope'] != 'overview' &&
                    (workspaces?.isNotEmpty ?? false))),
        shell: shell,
        chatSummaries: _parseChatSummaryEntities(payload['entities']),
        eventId: _stringOrNull(envelope['eventId']),
        cursor: cursor,
        scope: _stringOrNull(payload['scope']),
        workspaces: workspaces,
        worktrees: _parseShellEntities(
          payload['entities'],
          'worktree',
        )?.map(RemoteWorktree.fromJson).toList(growable: false),
        worktreeSetupFailure: _parseWorktreeSetupFailure(
          payload['worktreeSetupFailure'],
        ),
        prProgress: _parsePrProgressEntities(payload['entities']),
        prStatuses: _parsePrStatusEntities(payload),
        providerUsage:
            parseProviderUsageEntities(payload['entities']) ??
            (removesProviderUsage(payload['removed'])
                ? const RemoteProviderUsageUpdate(null)
                : null),
      );
    case 'portal.session.ended':
      return const RemoteSessionEndedEvent();
    case 'portal.command.completed':
      final rawResult = payload['result'];
      return RemoteCommandCompletedEvent(
        commandId:
            _stringOrNull(payload['commandId']) ??
            _stringOrNull(envelope['commandId']),
        result: rawResult is Map<String, dynamic> ? rawResult : null,
      );
    case 'portal.command.failed':
      final rawError = payload['error'];
      final error = rawError is Map<String, dynamic>
          ? _stringOrNull(rawError['message'])
          : _stringOrNull(rawError);
      return RemoteCommandFailedEvent(
        message: error ?? 'The desktop command failed.',
        code: rawError is Map<String, dynamic>
            ? _stringOrNull(rawError['code'])
            : null,
        commandId:
            _stringOrNull(payload['commandId']) ??
            _stringOrNull(envelope['commandId']),
      );
    case 'portal.pipeline.event':
      return _parsePipelineEvent(envelope, payload);
    case 'portal.hook.event':
      return _parseHookDescriptorEvent(payload) ??
          RemoteUnknownPortalEvent(type);
    default:
      return RemoteUnknownPortalEvent(type);
  }
}

/// Extracts `chat_summary` rows from a snapshot payload's entity envelopes
/// (`PortalEntityEnvelope { entityType, localId, payload }`).
List<RemoteChatSummary> _parseChatSummaryEntities(Object? rawEntities) {
  if (rawEntities is! List) return const [];
  final summaries = <RemoteChatSummary>[];
  for (final row in rawEntities.whereType<Map<String, dynamic>>()) {
    if (row['entityType'] != 'chat_summary') continue;
    final entityPayload = row['payload'];
    if (entityPayload is! Map<String, dynamic>) continue;
    final summary = RemoteChatSummary.fromJson(entityPayload);
    if (summary.chatId.isNotEmpty) summaries.add(summary);
  }
  return summaries;
}

List<Map<String, dynamic>>? _parseShellEntities(Object? raw, String type) {
  if (raw is! List) return null;
  final entities = <Map<String, dynamic>>[];
  for (final row in raw.whereType<Map<String, dynamic>>()) {
    if (row['entityType'] != type) continue;
    final payload = row['payload'];
    if (payload is! Map<String, dynamic>) continue;
    final localId = _stringOrNull(row['localId']);
    if (localId == null || localId.isEmpty) continue;
    if (type != 'worktree') {
      entities.add({...payload, 'localId': localId});
      continue;
    }
    final workspaceLocalId =
        _stringOrNull(payload['workspaceLocalId']) ??
        _stringOrNull(row['parentLocalId']);
    if (workspaceLocalId == null || workspaceLocalId.isEmpty) continue;
    entities.add({
      ...payload,
      'localId': localId,
      'workspaceLocalId': workspaceLocalId,
    });
  }
  return entities;
}

/// Extracts `pr_status` progress feeds from a payload's entity envelopes,
/// keyed `'<workspaceLocalId>:<worktreeLocalId>'`. Rows carrying neither feed
/// are omitted so a plain PR-status refresh never clears live progress.
Map<String, RemotePrProgressState>? _parsePrProgressEntities(Object? raw) {
  if (raw is! List) return null;
  final byKey = <String, RemotePrProgressState>{};
  for (final row in raw.whereType<Map<String, dynamic>>()) {
    if (row['entityType'] != 'pr_status') continue;
    final payload = row['payload'];
    if (payload is! Map<String, dynamic>) continue;
    final workspaceLocalId =
        _stringOrNull(payload['workspaceLocalId']) ??
        _stringOrNull(row['parentLocalId']);
    final worktreeLocalId =
        _stringOrNull(payload['worktreeLocalId']) ??
        _stringOrNull(row['localId']);
    if (workspaceLocalId == null || worktreeLocalId == null) continue;
    final hasCreationProgress = payload.containsKey('creationProgress');
    final hasMergeProgress = payload.containsKey('mergeProgress');
    final creation = hasCreationProgress
        ? RemotePrCreationProgress.fromJson(payload['creationProgress'])
        : null;
    final merge = hasMergeProgress
        ? RemoteMergePrProgress.fromJson(payload['mergeProgress'])
        : null;
    final state = RemotePrProgressState(
      creation: creation,
      merge: merge,
      clearCreation: hasCreationProgress && creation == null,
      clearMerge: hasMergeProgress && merge == null,
    );
    if (state.isEmpty) continue;
    byKey['$workspaceLocalId:$worktreeLocalId'] = state;
  }
  return byKey;
}

Map<String, List<RemoteWorktreePr>> _parsePrStatusEntities(
  Map<String, dynamic> payload,
) {
  final entities = payload['entities'];
  if (entities is! List) return const {};
  final target = payload['target'];
  final byKey = <String, List<RemoteWorktreePr>>{};
  for (final row in entities.whereType<Map<String, dynamic>>()) {
    if (row['entityType'] != 'pr_status') continue;
    final data = row['payload'];
    if (data is! Map<String, dynamic>) continue;
    final workspace =
        _stringOrNull(data['workspaceLocalId']) ??
        (target is Map ? _stringOrNull(target['workspaceLocalId']) : null);
    final worktree =
        _stringOrNull(data['worktreeLocalId']) ?? _stringOrNull(row['localId']);
    if (workspace == null ||
        workspace.isEmpty ||
        worktree == null ||
        worktree.isEmpty) {
      continue;
    }
    final repos = data['repos'];
    if (repos is List) {
      final rows = repos.whereType<Map<String, dynamic>>().toList();
      // A failed lookup cannot authoritatively replace remembered PR cards.
      if (rows.every((repo) => repo['prLookupAvailable'] == false) &&
          rows.isNotEmpty) {
        continue;
      }
      if (rows.any(
        (repo) =>
            repo['prLookupAvailable'] == false &&
            _stringOrNull(repo['repoId']) == null,
      )) {
        continue;
      }
      byKey['$workspace:$worktree'] = [
        for (final repo in rows)
          if (repo['prLookupAvailable'] == false)
            RemoteWorktreePr(
              repoId: _stringOrNull(repo['repoId']),
              state: '',
              lookupAvailable: false,
            )
          else if (repo['status'] case final Map<String, dynamic> status)
            RemoteWorktreePr.fromPortal(
              status,
              repoId: _stringOrNull(repo['repoId']),
            ),
      ];
    } else if (!data.containsKey('repos') && data['number'] is num) {
      // Older hosts carry only the primary PR. A null number may accompany
      // progress-only patches, so it cannot clear an existing card.
      byKey['$workspace:$worktree'] = [RemoteWorktreePr.fromPortal(data)];
    }
  }
  return byKey;
}

RemoteWorktreeSetupFailure? _parseWorktreeSetupFailure(Object? raw) {
  if (raw is! Map<String, dynamic>) return null;
  final workspaceLocalId = _stringOrNull(raw['workspaceLocalId']);
  final worktreeLocalId = _stringOrNull(raw['worktreeLocalId']);
  if (workspaceLocalId == null || worktreeLocalId == null) return null;
  return RemoteWorktreeSetupFailure(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    error: _stringOrNull(raw['error']) ?? 'The task setup failed.',
  );
}

/// The portal cache tolerates three shapes here, so mobile does too:
/// `entityType` may be absent (inferred from a `status` string, exactly as
/// `defaultFeatureEntityType` does in the web client), `localId` may arrive
/// as `id`, and the entity's fields may be inline instead of under `payload`.
RemotePortalEvent _parsePipelineEvent(
  Map<String, dynamic> envelope,
  Map<String, dynamic> payload,
) {
  const unknown = RemoteUnknownPortalEvent('portal.pipeline.event');
  if (payload['kind'] == 'remove') {
    final localId = _stringOrNull(payload['localId']);
    if (payload['entityType'] != 'pipeline_run' ||
        localId == null ||
        localId.isEmpty) {
      return unknown;
    }
    return RemotePipelineRunRemovedEvent(localId: localId);
  }
  final entity = payload['entity'];
  if (entity is! Map<String, dynamic>) return unknown;
  final entityPayload = entity['payload'] is Map<String, dynamic>
      ? entity['payload'] as Map<String, dynamic>
      : entity;
  final entityType =
      _stringOrNull(entity['entityType']) ??
      _stringOrNull(entity['type']) ??
      (entityPayload['status'] is String ? 'pipeline_run' : null);
  if (entityType != 'pipeline_run') return unknown;
  final localId =
      _stringOrNull(entity['localId']) ?? _stringOrNull(entity['id']);
  final run = RemotePipelineRun.fromJson({
    ...entityPayload,
    'localId': ?localId,
  });
  if (run == null) return unknown;
  return RemotePipelineRunEvent(
    run: run,
    commandId:
        _stringOrNull(envelope['commandId']) ??
        _stringOrNull(payload['commandId']),
  );
}

/// A `hook_descriptor` upsert or removal; null for hook runs and for rows
/// without a worktree or key. The worktree comes from the row, else from
/// the `'<workspace>:<worktree>'` parent id.
RemoteHookDescriptorEvent? _parseHookDescriptorEvent(
  Map<String, dynamic> payload,
) {
  final removal = payload['kind'] == 'remove';
  final entity = removal ? payload : payload['entity'];
  if (entity is! Map<String, dynamic> ||
      entity['entityType'] != 'hook_descriptor') {
    return null;
  }
  final Map<String, dynamic>? row;
  if (removal) {
    row = null;
  } else if (entity['payload'] case final Map<String, dynamic> upserted) {
    row = upserted;
  } else {
    return null;
  }
  final parent = _stringOrNull(entity['parentLocalId']) ?? '';
  final separator = parent.indexOf(':');
  final workspaceLocalId =
      _stringOrNull(row?['workspaceLocalId']) ??
      (separator > 0 ? parent.substring(0, separator) : null);
  final worktreeLocalId =
      _stringOrNull(row?['worktreeLocalId']) ??
      (separator > 0 ? parent.substring(separator + 1) : null);
  final hookKey =
      _stringOrNull(row?['hookKey']) ?? _stringOrNull(entity['localId']);
  if (workspaceLocalId == null ||
      workspaceLocalId.isEmpty ||
      worktreeLocalId == null ||
      worktreeLocalId.isEmpty ||
      hookKey == null ||
      hookKey.isEmpty) {
    return null;
  }
  return RemoteHookDescriptorEvent(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    hookKey: hookKey,
    descriptor: row == null
        ? null
        : {
            ...row,
            'workspaceLocalId': workspaceLocalId,
            'worktreeLocalId': worktreeLocalId,
            'hookKey': hookKey,
          },
  );
}

List<RemoteChatMessage> _parseWireMessages(Object? raw) => raw is List
    ? raw
          .whereType<Map<String, dynamic>>()
          .map(RemoteChatMessage.fromWireJson)
          .toList(growable: false)
    : const [];

String? _stringOrNull(Object? value) => value is String ? value : null;

int? _eventCursor(Object? value) => value is int && value > 0 ? value : null;
