import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/** A long, manually ordered list with a readable chat, in the last project by default. */
export function seedSidebarProjectList(
  userDataDir,
  count = 25,
  chatProjectNumber = count,
) {
  const createdAt = '2026-09-01T12:00:00.000Z';
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const projects = Array.from({ length: count }, (_, index) => ({
    id: `project-list-${index + 1}`,
    name: `Project ${String(index + 1).padStart(2, '0')}`,
    type: 'cowork',
    color: '#7C9B6D',
    collapsed: true,
    order: index,
  }));
  writeJson(path.join(workspacesRoot, 'index.json'), {
    version: 1,
    workspaces: projects,
  });
  for (const project of projects) {
    writeJson(path.join(workspacesRoot, project.id, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: { createdAt, archiveRetentionDays: null },
    });
  }
  const lastProjectId = projects.at(-1).id;
  const chatProjectId = projects[chatProjectNumber - 1].id;
  const entryId = 'project-list-entry';
  writeJson(path.join(workspacesRoot, chatProjectId, 'work-entries.json'), {
    version: 1,
    entries: [{ id: entryId, createdAt }],
  });
  writeJson(
    path.join(workspacesRoot, chatProjectId, 'chats', `${entryId}.json`),
    {
      version: 1,
      activeTabId: 'project-list-chat',
      tabs: [
        {
          id: 'project-list-chat',
          title: 'Distant project notes',
          createdAt,
          kind: 'chat',
          messages: [
            {
              id: 'project-list-message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Notes from the last project.' }],
              timestamp: Date.parse(createdAt),
            },
          ],
        },
      ],
    },
  );
  return { lastProjectId, chatProjectId, entryId };
}
