import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initializePanelLayoutModeFile,
  readPanelLayoutModeFile,
  readWorkspaceDefaultLayoutMode,
  savePanelLayoutModeFile,
  type PanelLayoutModeFileTarget,
} from '../panel-layout-mode';

describe('panel layout mode file', () => {
  let tempDir: string;
  let target: PanelLayoutModeFileTarget;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-layout-mode-'));
    target = {
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      filePath: path.join(
        tempDir,
        'worktree-data',
        'worktree-1',
        'panel-layout-mode.json',
      ),
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('reads a valid v1 file and treats absent or malformed files as absent', async () => {
    await expect(readPanelLayoutModeFile(target)).resolves.toBeNull();

    fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
    for (const payload of [
      '{',
      JSON.stringify({ version: 1, mode: 'unsupported' }),
      JSON.stringify({ version: 2, mode: 'minimal' }),
    ]) {
      fs.writeFileSync(target.filePath, payload, 'utf8');
      await expect(readPanelLayoutModeFile(target)).resolves.toBeNull();
    }

    fs.writeFileSync(
      target.filePath,
      JSON.stringify({ version: 1, mode: 'minimal' }),
      'utf8',
    );
    await expect(readPanelLayoutModeFile(target)).resolves.toBe('minimal');
  });

  it('initializes create-only and returns an existing valid value', async () => {
    await expect(
      initializePanelLayoutModeFile(target, 'minimal'),
    ).resolves.toBe('minimal');
    expect(JSON.parse(fs.readFileSync(target.filePath, 'utf8'))).toEqual({
      version: 1,
      mode: 'minimal',
    });

    await expect(
      initializePanelLayoutModeFile(target, 'advanced'),
    ).resolves.toBe('minimal');
    expect(JSON.parse(fs.readFileSync(target.filePath, 'utf8'))).toEqual({
      version: 1,
      mode: 'minimal',
    });
  });

  it('atomically replaces an explicit value', async () => {
    await initializePanelLayoutModeFile(target, 'minimal');
    await savePanelLayoutModeFile(target, 'advanced');

    await expect(readPanelLayoutModeFile(target)).resolves.toBe('advanced');
  });

  it('rejects a failed explicit save and preserves the prior durable value', async () => {
    await initializePanelLayoutModeFile(target, 'minimal');
    const parent = path.dirname(target.filePath);
    fs.chmodSync(parent, 0o500);
    try {
      await expect(
        savePanelLayoutModeFile(target, 'advanced'),
      ).rejects.toThrow();
      await expect(readPanelLayoutModeFile(target)).resolves.toBe('minimal');
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });

  it.each([
    { workspaceId: '../unsafe' },
    { worktreeId: 'unsafe/id' },
    { filePath: 'relative/panel-layout-mode.json' },
    { filePath: path.join(os.tmpdir(), 'wrong-name.json') },
  ])('rejects unsafe targets before file access: %p', async (patch) => {
    await expect(
      readPanelLayoutModeFile({ ...target, ...patch }),
    ).rejects.toThrow('Invalid');
  });

  it('reads and normalizes the global preference from preferences.json', async () => {
    const preferencesPath = path.join(tempDir, 'preferences.json');
    fs.writeFileSync(
      preferencesPath,
      JSON.stringify({
        version: 1,
        preferences: { workspaceDefaultLayoutMode: 'minimal' },
      }),
      'utf8',
    );
    await expect(readWorkspaceDefaultLayoutMode(tempDir)).resolves.toBe(
      'minimal',
    );

    for (const value of [undefined, 'unsupported', 42]) {
      fs.writeFileSync(
        preferencesPath,
        JSON.stringify({
          version: 1,
          preferences: { workspaceDefaultLayoutMode: value },
        }),
        'utf8',
      );
      await expect(readWorkspaceDefaultLayoutMode(tempDir)).resolves.toBe(
        'advanced',
      );
    }
  });
});
