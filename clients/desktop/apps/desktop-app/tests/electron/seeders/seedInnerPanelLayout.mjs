import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from './index.mjs';

// Root-H [ A | V[H[B,C],D] | V[E,F,G] | V[H,I] ]. Independent
// vertical boundaries deliberately do not line up. Only B owns a chat;
// C is an idle terminal placeholder; the others are seeded activity sections.
export function seedInnerPanelLayout(
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-inner-panels-')),
) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: 'seed-chat',
        title: 'B — Chat',
        blocks: [
          {
            type: 'text',
            text: 'B and C share a full edge. Collapse either panel to give its sibling more space. This chat remains mounted while collapsed.',
          },
        ],
      },
    ],
  });
  const sections = {
    A: 'notes',
    D: 'todo',
    E: 'changed-files',
    F: 'pipeline-runs',
    G: 'plans',
    H: 'summary',
    I: 'scripts',
  };
  const leaf = (id, size) => ({
    type: 'leaf',
    groupId: `inner-${id}`,
    panels: [
      {
        panelId: id === 'B' ? 'panel-chat-seed-chat' : `inner-panel-${id}`,
        kind: id === 'B' ? 'chat' : id === 'C' ? 'terminal' : 'activity-card',
        title: id,
        ...(id === 'B'
          ? { instance: { chatTabId: 'seed-chat' } }
          : id === 'C'
            ? {}
            : { instance: { sectionId: sections[id] } }),
      },
    ],
    activePanelId: id === 'B' ? 'panel-chat-seed-chat' : `inner-panel-${id}`,
    size,
  });
  const branch = (size, children) => ({ type: 'branch', size, children });
  const dir = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  writeFileSync(
    path.join(dir, 'panel-layout.json'),
    JSON.stringify({
      version: 1,
      grid: {
        orientation: 1,
        width: 1500,
        height: 800,
        root: branch(800, [
          leaf('A', 120),
          branch(700, [
            branch(620, [leaf('B', 350), leaf('C', 350)]),
            leaf('D', 180),
          ]),
          branch(340, [leaf('E', 300), leaf('F', 260), leaf('G', 240)]),
          branch(340, [leaf('H', 420), leaf('I', 380)]),
        ]),
      },
      activeGroupId: 'inner-B',
      mostRecentActiveGroupIds: ['inner-B'],
    }),
  );
  return userDataDir;
}
