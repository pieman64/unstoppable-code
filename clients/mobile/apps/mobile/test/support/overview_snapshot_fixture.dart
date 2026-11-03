import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';

Map<String, dynamic> overviewWorkspace({
  String name = 'Repository',
  bool includeLocalId = true,
}) => {
  if (includeLocalId) 'localId': 'ws-1',
  'name': name,
  'type': 'single-repo',
};

Map<String, dynamic> overviewWorktree({
  String state = 'open',
  bool includeLocalId = true,
}) => {
  if (includeLocalId) 'localId': 'wt-1',
  'workspaceLocalId': 'ws-1',
  'branch': 'feature/live-pr',
  'label': 'koala',
  'status': state == 'merged' ? 'done' : 'active',
  'lastKnownPrStatus': {
    'repos': [
      {
        'repoId': '__workspace_root__',
        'status': {'prNumber': 3061, 'state': state},
      },
    ],
  },
};

RemoteSessionSnapshot initialOverview() => RemoteSessionSnapshot.fromJson({
  'workspaces': [overviewWorkspace()],
  'worktrees': [overviewWorktree()],
  'standaloneChats': <Object>[],
});

RemotePortalEventBatch overviewBatch({
  String scope = 'overview',
  String eventId = 'overview-1',
  String type = 'portal.state.snapshot',
  List<Map<String, dynamic>>? entities,
}) => RemotePortalEventBatch.fromJson({
  'events': [
    {
      'eventId': eventId,
      'type': type,
      'payload': {
        'scope': scope,
        'generatedAt': '2026-09-05T13:00:00Z',
        'entities':
            entities ??
            [
              {
                'entityType': 'workspace',
                'localId': 'ws-1',
                'payload': overviewWorkspace(
                  name: 'Renamed repository',
                  includeLocalId: false,
                ),
              },
              {
                'entityType': 'worktree',
                'localId': 'wt-1',
                'parentLocalId': 'ws-1',
                'payload': overviewWorktree(
                  state: 'merged',
                  includeLocalId: false,
                ),
              },
            ],
      },
    },
  ],
  'nextCursor': 2,
});
