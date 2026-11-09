import type {
  CoreCoworkProject,
  CoreCoworkTask,
} from '@canopy/app-state/core-cowork';
import { cloudProjectsForContext } from '../useCloudCoworkSidebar';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const project = (
  workspaceId: string,
  ownerOrganizationId: string | null,
): CoreCoworkProject => ({
  key: `web-core:${workspaceId}`,
  workspaceId,
  name: workspaceId,
  ownerOrganizationId,
});

const PROJECTS: CoreCoworkProject[] = [
  project('personal', null),
  project('ours', ORG),
  project('theirs', OTHER_ORG),
];
const TASKS: Record<string, readonly CoreCoworkTask[]> = {
  'web-core:ours': [
    {
      key: 'web-core:ours:task-1',
      workspaceId: 'ours',
      worktreeId: 'task-1',
      title: 'Plan',
      state: 'running',
      updatedAt: '2026-11-07T10:00:00Z',
    },
  ],
};

describe('cloud cowork sidebar rows', () => {
  it('projects of another organization are hidden', () => {
    const inOrg = cloudProjectsForContext(PROJECTS, TASKS, {
      kind: 'organization',
      organizationId: ORG,
    });
    expect(inOrg.map((row) => row.workspaceId)).toEqual(['ours']);
    expect(inOrg[0]).toMatchObject({
      cloud: true,
      entries: [{ key: 'web-core:ours:task-1', title: 'Plan', working: true }],
    });

    const personal = cloudProjectsForContext(PROJECTS, TASKS, {
      kind: 'personal',
    });
    expect(personal.map((row) => row.workspaceId)).toEqual(['personal']);
  });

  it('an archived task leaves the sidebar', () => {
    const archived: CoreCoworkTask = {
      key: 'web-core:ours:task-2',
      workspaceId: 'ours',
      worktreeId: 'task-2',
      title: 'Done and archived',
      state: 'archived',
      updatedAt: '2026-11-07T11:00:00Z',
    };
    const [row] = cloudProjectsForContext(
      PROJECTS,
      { 'web-core:ours': [archived, ...(TASKS['web-core:ours'] ?? [])] },
      { kind: 'organization', organizationId: ORG },
    );
    expect(row?.entries.map((entry) => entry.title)).toEqual(['Plan']);
  });
});
