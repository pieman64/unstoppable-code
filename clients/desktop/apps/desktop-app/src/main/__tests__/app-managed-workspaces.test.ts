import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';

const mockGetCanopyDataDir = jest.fn<string, []>();

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
}));

import { migrateAppManagedChatWorkspaces } from '../lib/app-managed-workspaces';
import { isErrnoException } from '../lib/type-guards';

async function writeFixture(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function writeWorkspaceIndex(
  rootDir: string,
  workspaceIds: string[],
): Promise<void> {
  await writeFixture(
    join(rootDir, 'workspaces', 'index.json'),
    `${JSON.stringify(
      {
        version: 1,
        workspaces: workspaceIds.map((id, order) => ({
          id,
          name: id,
          type: 'single-repo',
          color: 'blue',
          collapsed: false,
          order,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

describe('app-managed chat project migration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'canopy-app-workspaces-'));
    mockGetCanopyDataDir.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    mockGetCanopyDataDir.mockReset();
  });

  it('moves legacy app-managed roots out of projects', async () => {
    await writeFixture(
      join(tempDir, 'workspaces', APP_ADVISOR_PROJECT_ID, 'state.txt'),
      'advisor',
    );
    await writeFixture(
      join(
        tempDir,
        'workspaces',
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        'attachments',
        'plan-1',
        'input.txt',
      ),
      'plan',
    );

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(
        join(
          tempDir,
          'app-workspaces',
          APP_ADVISOR_PROJECT_ID,
          'home',
          'state.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('advisor');
    await expect(
      readFile(
        join(
          tempDir,
          'app-workspaces',
          PLAN_EXPLORE_CHAT_PROJECT_ID,
          'attachments',
          'plan-1',
          'input.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('plan');
    await expect(
      exists(join(tempDir, 'workspaces', APP_ADVISOR_PROJECT_ID)),
    ).resolves.toBe(false);
    await expect(
      exists(join(tempDir, 'workspaces', PLAN_EXPLORE_CHAT_PROJECT_ID)),
    ).resolves.toBe(false);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8').then(JSON.parse),
    ).resolves.toEqual({
      version: 1,
      app_workspaces: true,
      app_advisor_home: true,
      code_review_chats_app_workspace: true,
      pipeline_editor_app_workspace: true,
      pipeline_editor_home: true,
    });
  });

  it('separates legacy App Advisor working files from app metadata', async () => {
    const advisorRoot = join(tempDir, 'app-workspaces', APP_ADVISOR_PROJECT_ID);
    await Promise.all([
      writeFixture(join(advisorRoot, 'CLAUDE.md'), 'instructions'),
      writeFixture(join(advisorRoot, 'AGENTS.md'), 'instructions'),
      writeFixture(
        join(advisorRoot, '.canopy', 'notes', 'note.md'),
        'durable note',
      ),
      writeFixture(join(advisorRoot, 'report.md'), 'agent output'),
      writeFixture(
        join(advisorRoot, 'chats', 'entry.json'),
        '{"version":1,"tabs":[],"activeTabId":""}',
      ),
      writeFixture(
        join(advisorRoot, 'worktree-data', 'entry', 'panel-layout.json'),
        '{}',
      ),
      writeFixture(
        join(advisorRoot, 'attachments', 'entry', 'input.txt'),
        'attachment',
      ),
      writeFixture(
        join(advisorRoot, 'work-entries.json'),
        '{"version":1,"entries":[]}',
      ),
      writeFixture(
        join(advisorRoot, 'settings.json'),
        '{"version":1,"archiveRetentionDays":null}',
      ),
      writeFixture(
        join(advisorRoot, 'sidebar-item-groups.json'),
        '{"version":99,"groups":[]}',
      ),
      writeFixture(
        join(advisorRoot, 'sidebar-item-groups.json.corrupt-fixture'),
        'quarantined group data',
      ),
      writeFixture(
        join(advisorRoot, '.sidebar-item-groups.json.1.fixture.tmp'),
        'stale group data',
      ),
      writeFixture(join(advisorRoot, '.settings-stale.tmp'), 'stale settings'),
      writeFixture(
        join(advisorRoot, '.work-entries-stale.tmp'),
        'stale registry',
      ),
    ]);

    await migrateAppManagedChatWorkspaces();

    for (const relativePath of [
      'CLAUDE.md',
      'AGENTS.md',
      '.canopy/notes/note.md',
      'report.md',
    ]) {
      await expect(exists(join(advisorRoot, relativePath))).resolves.toBe(
        false,
      );
      await expect(
        exists(join(advisorRoot, 'home', relativePath)),
      ).resolves.toBe(true);
    }
    for (const relativePath of [
      'chats/entry.json',
      'worktree-data/entry/panel-layout.json',
      'attachments/entry/input.txt',
      'work-entries.json',
      'settings.json',
      'sidebar-item-groups.json',
      'sidebar-item-groups.json.corrupt-fixture',
      '.sidebar-item-groups.json.1.fixture.tmp',
      '.settings-stale.tmp',
      '.work-entries-stale.tmp',
    ]) {
      await expect(exists(join(advisorRoot, relativePath))).resolves.toBe(true);
      await expect(
        exists(join(advisorRoot, 'home', relativePath)),
      ).resolves.toBe(false);
    }
  });

  it('preserves a legacy App Advisor file named home', async () => {
    const advisorRoot = join(tempDir, 'app-workspaces', APP_ADVISOR_PROJECT_ID);
    await writeFixture(join(advisorRoot, 'home'), 'legacy home file');

    await migrateAppManagedChatWorkspaces();

    await expect(
      stat(join(advisorRoot, 'home')).then((value) => value.isDirectory()),
    ).resolves.toBe(true);
    await expect(
      readFile(join(advisorRoot, 'home', 'home'), 'utf8'),
    ).resolves.toBe('legacy home file');
  });

  it('preserves a legacy App Advisor directory named home', async () => {
    const advisorRoot = join(tempDir, 'app-workspaces', APP_ADVISOR_PROJECT_ID);
    await writeFixture(
      join(advisorRoot, 'home', 'report.md'),
      'legacy home report',
    );

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(join(advisorRoot, 'home', 'home', 'report.md'), 'utf8'),
    ).resolves.toBe('legacy home report');
  });

  it('preserves a legacy App Advisor broken symlink named home', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const advisorRoot = join(tempDir, 'app-workspaces', APP_ADVISOR_PROJECT_ID);
    await mkdir(advisorRoot, { recursive: true });
    await symlink('missing-target', join(advisorRoot, 'home'));

    await migrateAppManagedChatWorkspaces();

    await expect(
      lstat(join(advisorRoot, 'home', 'home')).then((value) =>
        value.isSymbolicLink(),
      ),
    ).resolves.toBe(true);
    await expect(readlink(join(advisorRoot, 'home', 'home'))).resolves.toBe(
      'missing-target',
    );
  });

  it('preserves a legacy entry colliding with the migration marker', async () => {
    const advisorRoot = join(tempDir, 'app-workspaces', APP_ADVISOR_PROJECT_ID);
    await writeFixture(
      join(
        advisorRoot,
        '.app-advisor-home-migration-state',
        'user-content.txt',
      ),
      'preserve me',
    );

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(
        join(
          advisorRoot,
          'home',
          '.app-advisor-home-migration-state',
          'user-content.txt',
        ),
        'utf8',
      ),
    ).resolves.toBe('preserve me');
    await expect(
      exists(join(tempDir, '.app-advisor-home-migration-state')),
    ).resolves.toBe(false);
  });

  it('moves legacy top-level code-review chat metadata into app-workspaces', async () => {
    await writeFixture(
      join(tempDir, 'code-review-chats', 'registry.json'),
      '{"version":1,"targets":{}}\n',
    );
    await writeFixture(
      join(tempDir, 'code-review-chats', 'proj--wt.json'),
      '{"version":1,"tabs":[],"activeTabId":""}\n',
    );

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(
        join(
          tempDir,
          'app-workspaces',
          CODE_REVIEW_CHAT_PROJECT_ID,
          'chats',
          'registry.json',
        ),
        'utf8',
      ),
    ).resolves.toBe('{"version":1,"targets":{}}\n');
    await expect(
      readFile(
        join(
          tempDir,
          'app-workspaces',
          CODE_REVIEW_CHAT_PROJECT_ID,
          'chats',
          'proj--wt.json',
        ),
        'utf8',
      ),
    ).resolves.toBe('{"version":1,"tabs":[],"activeTabId":""}\n');
    await expect(exists(join(tempDir, 'code-review-chats'))).resolves.toBe(
      false,
    );
  });

  it('moves missing legacy entries without overwriting destination conflicts', async () => {
    const legacyRoot = join(tempDir, 'workspaces', APP_ADVISOR_PROJECT_ID);
    const destinationRoot = join(
      tempDir,
      'app-workspaces',
      APP_ADVISOR_PROJECT_ID,
    );
    await writeFixture(join(legacyRoot, 'conflict.txt'), 'legacy');
    await writeFixture(join(legacyRoot, 'nested', 'missing.txt'), 'missing');
    await writeFixture(join(destinationRoot, 'conflict.txt'), 'destination');

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(join(destinationRoot, 'home', 'conflict.txt'), 'utf8'),
    ).resolves.toBe('destination');
    await expect(
      readFile(join(destinationRoot, 'home', 'nested', 'missing.txt'), 'utf8'),
    ).resolves.toBe('missing');
    await expect(
      readFile(join(legacyRoot, 'conflict.txt'), 'utf8'),
    ).resolves.toBe('legacy');
    await expect(exists(join(legacyRoot, 'nested'))).resolves.toBe(false);
  });

  it('separates legacy Pipeline Editor working files from app metadata', async () => {
    const editorRoot = join(
      tempDir,
      'app-workspaces',
      PIPELINE_EDITOR_PROJECT_ID,
    );
    await Promise.all([
      writeFixture(join(editorRoot, 'notes.md'), 'legacy notes'),
      writeFixture(join(editorRoot, 'nested', 'output.txt'), 'legacy output'),
      writeFixture(join(editorRoot, 'conflict.txt'), 'legacy conflict'),
      writeFixture(
        join(editorRoot, 'home', 'existing.txt'),
        'legacy home content',
      ),
      writeFixture(
        join(editorRoot, 'chats', 'pipeline-editor.json'),
        '{"version":1,"tabs":[],"activeTabId":""}',
      ),
      writeFixture(
        join(
          editorRoot,
          'worktree-data',
          'pipeline-editor',
          'panel-layout.json',
        ),
        '{}',
      ),
      writeFixture(
        join(editorRoot, 'attachments', 'pipeline-editor', 'input.txt'),
        'attachment',
      ),
    ]);

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(join(editorRoot, 'home', 'notes.md'), 'utf8'),
    ).resolves.toBe('legacy notes');
    await expect(
      readFile(join(editorRoot, 'home', 'nested', 'output.txt'), 'utf8'),
    ).resolves.toBe('legacy output');
    await expect(
      readFile(join(editorRoot, 'home', 'conflict.txt'), 'utf8'),
    ).resolves.toBe('legacy conflict');
    await expect(
      readFile(join(editorRoot, 'home', 'home', 'existing.txt'), 'utf8'),
    ).resolves.toBe('legacy home content');
    await expect(
      readFile(join(editorRoot, 'chats', 'pipeline-editor.json'), 'utf8'),
    ).resolves.toContain('"tabs"');
    await expect(
      readFile(
        join(
          editorRoot,
          'worktree-data',
          'pipeline-editor',
          'panel-layout.json',
        ),
        'utf8',
      ),
    ).resolves.toBe('{}');
    await expect(
      readFile(
        join(editorRoot, 'attachments', 'pipeline-editor', 'input.txt'),
        'utf8',
      ),
    ).resolves.toBe('attachment');
  });

  it('preserves conflicting files while resuming a Pipeline Editor home migration', async () => {
    const editorRoot = join(
      tempDir,
      'app-workspaces',
      PIPELINE_EDITOR_PROJECT_ID,
    );
    await Promise.all([
      writeFixture(join(editorRoot, 'conflict.txt'), 'legacy conflict'),
      writeFixture(
        join(editorRoot, 'home', 'conflict.txt'),
        'current conflict',
      ),
      writeFixture(
        join(tempDir, '.pipeline-editor-home-migration-state', 'started'),
        '',
      ),
    ]);

    await migrateAppManagedChatWorkspaces();

    await expect(
      readFile(join(editorRoot, 'home', 'conflict.txt'), 'utf8'),
    ).resolves.toBe('current conflict');
    await expect(
      readFile(
        join(editorRoot, 'home', 'conflict.txt.legacy-pipeline-editor'),
        'utf8',
      ),
    ).resolves.toBe('legacy conflict');
    await expect(
      exists(join(tempDir, '.pipeline-editor-home-migration-state')),
    ).resolves.toBe(false);
  });

  it.each([APP_ADVISOR_PROJECT_ID, PLAN_EXPLORE_CHAT_PROJECT_ID])(
    'leaves an indexed %s user project under projects',
    async (workspaceId) => {
      const legacyRoot = join(tempDir, 'workspaces', workspaceId);
      await writeFixture(join(legacyRoot, 'state.txt'), 'user-workspace');
      await writeWorkspaceIndex(tempDir, [workspaceId]);

      await migrateAppManagedChatWorkspaces();

      await expect(
        readFile(join(legacyRoot, 'state.txt'), 'utf8'),
      ).resolves.toBe('user-workspace');
      await expect(
        exists(join(tempDir, 'app-workspaces', workspaceId)),
      ).resolves.toBe(false);
      await expect(
        readFile(join(tempDir, 'migrations.json'), 'utf8').then(JSON.parse),
      ).resolves.toEqual({
        version: 1,
        app_workspaces: true,
        app_advisor_home: true,
        code_review_chats_app_workspace: true,
        pipeline_editor_app_workspace: true,
        pipeline_editor_home: true,
      });
    },
  );

  it('skips the migration when migrations.json already has the marker', async () => {
    const legacyRoot = join(tempDir, 'workspaces', APP_ADVISOR_PROJECT_ID);
    await writeFixture(join(legacyRoot, 'state.txt'), 'legacy');
    await writeFixture(
      join(tempDir, 'migrations.json'),
      '{\n  "app_workspaces": true\n}\n',
    );

    await migrateAppManagedChatWorkspaces();

    await expect(readFile(join(legacyRoot, 'state.txt'), 'utf8')).resolves.toBe(
      'legacy',
    );
    await expect(
      exists(join(tempDir, 'app-workspaces', APP_ADVISOR_PROJECT_ID)),
    ).resolves.toBe(false);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8').then(JSON.parse),
    ).resolves.toEqual({
      app_workspaces: true,
      app_advisor_home: true,
      code_review_chats_app_workspace: true,
      pipeline_editor_app_workspace: true,
      pipeline_editor_home: true,
      version: 1,
    });
  });
});
