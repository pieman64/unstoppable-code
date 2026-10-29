import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedCoworkWorkspace, seedStoredPipeline } from './seeders/index.mjs';

/** Real code and Cowork resources; validation must not bless synthetic IDs. */
export function seedAutomationTargetProjects(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const code = JSON.parse(readFileSync(indexPath, 'utf8'));
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: 'seeded-cowork',
    name: 'Research',
  });
  const cowork = JSON.parse(readFileSync(indexPath, 'utf8'));
  writeFileSync(
    indexPath,
    JSON.stringify(
      { ...code, workspaces: [...code.workspaces, ...cowork.workspaces] },
      null,
      2,
    ),
  );
}

/** A stored user pipeline that dispatch-triggered automations can target. */
export function seedAutomationTargetPipeline(userDataDir, id) {
  seedStoredPipeline({
    userDataDir,
    id,
    name: 'Code Review',
    yaml: [
      'pipeline:',
      '  name: Code Review',
      '  on: dispatch',
      '  jobs:',
      '    review:',
      '      steps:',
      '        - id: inspect',
      '          run: echo inspect',
      '',
    ].join('\n'),
  });
}
