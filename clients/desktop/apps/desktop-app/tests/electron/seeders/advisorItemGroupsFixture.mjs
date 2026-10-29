import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export function seedAdvisorGroups(
  userDataDir,
  { includeThird = false, withMessages = false } = {},
) {
  mkdirSync(path.join(userDataDir, 'app-workspaces', 'app-advisor'), {
    recursive: true,
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        appAdvisorNavCollapsed: false,
      },
    }),
  );
  writeFileSync(
    path.join(
      userDataDir,
      'app-workspaces',
      'app-advisor',
      'work-entries.json',
    ),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'advisor-first',
          title: 'First investigation',
          createdAt: '2026-10-01T00:00:00.000Z',
          chatCount: 1,
          providerType: 'codex',
        },
        {
          id: 'advisor-second',
          title: 'Second investigation',
          createdAt: '2026-10-02T00:00:00.000Z',
          chatCount: 1,
          providerType: 'codex',
        },
        ...(includeThird
          ? [
              {
                id: 'advisor-third',
                title: 'Third investigation',
                createdAt: '2026-10-03T00:00:00.000Z',
              },
            ]
          : []),
      ],
    }),
  );
  if (withMessages) {
    const root = path.join(
      userDataDir,
      'app-workspaces',
      'app-advisor',
      'chats',
    );
    mkdirSync(root, { recursive: true });
    for (const id of [
      'advisor-first',
      'advisor-second',
      ...(includeThird ? ['advisor-third'] : []),
    ]) {
      writeFileSync(
        path.join(root, `${id}.json`),
        JSON.stringify({
          version: 1,
          activeTabId: id,
          tabs: [
            {
              id,
              title: id,
              kind: 'chat',
              createdAt: '2026-10-01T00:00:00.000Z',
              messages: [
                {
                  id: `${id}-message`,
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Seeded investigation' }],
                  timestamp: 1790812800000,
                },
              ],
            },
          ],
        }),
      );
    }
  }
}
