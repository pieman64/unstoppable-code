import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { externalProjectCandidateIdFor } from './seedExternalProjectImportFixture.mjs';

/** Real Git repositories; no provider stores or mocked discover responses. */
export function seedPickedParentFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'can5487-'));
  const parent = path.join(root, 'AndroidStudioProjects');
  const names = ['compose-playground', 'pantry-android', 'wear-timer'];
  try {
    for (const name of [...names, 'scripts', '.idea']) {
      const directory = path.join(parent, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'README.md'), `# ${name}\n`);
      if (!names.includes(name)) continue;
      const git = (args) =>
        execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
      git(['init', '-q', '--initial-branch=main']);
      git(['add', 'README.md']);
      git([
        '-c',
        'user.name=Import fixture',
        '-c',
        'user.email=import@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'Initial fixture',
      ]);
    }
    return {
      parent,
      parentId: externalProjectCandidateIdFor(parent),
      repositories: names.map((name) => ({
        name,
        id: externalProjectCandidateIdFor(path.join(parent, name)),
      })),
      env: { CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1' },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function overridePickedFolder(electronApp, folder) {
  await electronApp.evaluate(({ dialog }, selected) => {
    globalThis.__can5487OriginalFolderDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, folder);
  return async () => {
    await electronApp.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__can5487OriginalFolderDialog;
      delete globalThis.__can5487OriginalFolderDialog;
    });
  };
}
