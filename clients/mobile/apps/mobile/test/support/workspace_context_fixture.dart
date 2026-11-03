/// Synthetic Portal shell state for CAN-4429 workspace-context scoping.
///
/// One paired desktop holds Personal and organization projects:
///  * P (`ws-personal`) sends no owner, like a desktop that predates owners.
///  * P2 (`ws-personal-notes`) is a flat project with an explicit Personal
///    owner.
///  * Q (`ws-org-a`) is an organization A project.
///  * QC (`ws-org-a-cloud`) is a cloud workspace owned by organization A.
/// Organization B owns nothing. Standalone chats cover a projectless chat,
/// one attached to Q and one whose project is missing from the snapshot.
///
/// All names and ids are synthetic test data.
library;

import 'package:mobile/data/protocol/generated/organization.dart';

const workspaceContextOrgA = 'org-a';
const workspaceContextOrgB = 'org-b';

OrganizationSummary workspaceContextOrganization(String id, String name) =>
    OrganizationSummary(
      id: id,
      name: name,
      role: OrganizationRole.member,
      memberCount: 3,
      subTeamCount: 0,
    );

/// Organizations A and B, as `/api/account/organizations` lists them.
List<OrganizationSummary> workspaceContextOrganizations() => [
  workspaceContextOrganization(workspaceContextOrgA, 'Acme'),
  workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
];

/// The shell state JSON. Pass [withOwners] false for a desktop that sends no
/// `owner` fields at all.
Map<String, dynamic> workspaceContextShellState({bool withOwners = true}) => {
  'workspaces': [
    {
      'localId': 'ws-personal',
      'name': 'Personal app',
      'type': 'single-repo',
      'order': 0,
    },
    {
      'localId': 'ws-personal-notes',
      'name': 'Personal notes',
      'type': 'cowork',
      'layout': 'flat',
      'order': 1,
      if (withOwners) 'owner': {'type': 'personal'},
    },
    {
      'localId': 'ws-org-a',
      'name': 'Acme API',
      'type': 'single-repo',
      'order': 2,
      if (withOwners)
        'owner': {
          'type': 'organization',
          'organizationId': workspaceContextOrgA,
          'projectId': 'project-acme-api',
        },
    },
    {
      'localId': 'ws-org-a-cloud',
      'name': 'Acme cloud',
      'type': 'cowork',
      'layout': 'flat',
      'order': 3,
      if (withOwners)
        'owner': {
          'type': 'cloud-organization',
          'organizationId': workspaceContextOrgA,
        },
    },
  ],
  'worktrees': [
    {
      'localId': 'wt-personal',
      'workspaceLocalId': 'ws-personal',
      'branch': 'personal-task',
      'label': 'Personal task',
      'hasUnread': true,
      'lastActivityAt': '2026-10-18T10:00:00Z',
    },
    {
      'localId': 'wt-acme',
      'workspaceLocalId': 'ws-org-a',
      'branch': 'acme-task',
      'label': 'Acme task',
      'hasUnread': true,
      'lastActivityAt': '2026-10-18T11:00:00Z',
    },
  ],
  'standaloneChats': [
    {
      'localId': 'chat-loose',
      'projectLocalId': '',
      'title': 'Loose chat',
      'lastMessageAt': '2026-10-18T09:00:00Z',
    },
    {
      'localId': 'chat-notes',
      'projectLocalId': 'ws-personal-notes',
      'title': 'Notes chat',
      'lastMessageAt': '2026-10-18T09:30:00Z',
    },
    {
      'localId': 'chat-acme',
      'projectLocalId': 'ws-org-a',
      'title': 'Acme chat',
      'lastMessageAt': '2026-10-18T11:30:00Z',
    },
    {
      'localId': 'chat-acme-cloud',
      'projectLocalId': 'ws-org-a-cloud',
      'title': 'Acme cloud chat',
      'lastMessageAt': '2026-10-18T11:45:00Z',
    },
    {
      'localId': 'chat-orphan',
      'projectLocalId': 'ws-missing',
      'title': 'Orphan chat',
      'lastMessageAt': '2026-10-18T08:00:00Z',
    },
  ],
  'chatSummaries': [
    {
      'chatId': 'tab-personal',
      'scope': 'worktree',
      'worktreeLocalId': 'wt-personal',
      'title': 'Personal task chat',
      'lastMessageAt': '2026-10-18T10:00:00Z',
    },
    {
      'chatId': 'tab-acme',
      'scope': 'worktree',
      'worktreeLocalId': 'wt-acme',
      'title': 'Acme task chat',
      'lastMessageAt': '2026-10-18T11:00:00Z',
    },
  ],
};

/// Personal project ids.
const workspaceContextPersonalIds = ['ws-personal', 'ws-personal-notes'];

/// Organization A project ids.
const workspaceContextOrgAIds = ['ws-org-a', 'ws-org-a-cloud'];
