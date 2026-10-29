import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  getWorktreePanelLayoutFilePath,
  getWorktreeShareFileScopePath,
} from '../lib/paths';
import {
  pinSharedContainerPreferredLayout,
  pinSharedContainerPreferredLayoutIfMissing,
  readSharedContainerFileScope,
  readSharedContainerPreferredLayoutSnapshot,
  removeSharedContainerScopeItemId,
  replaceSharedContainerScopeItemId,
  writeSharedContainerFileScope,
} from '../shared-containers/file-scope-store';
import type { SharedContainerFileScope } from '@canopy/desktop-shared/types';

const mockLogMainProcessWarn = jest.fn();
let mockBrowsers: Array<{ id: string; url: string }> = [];

jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<Record<string, unknown>>('../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): void => {
    mockLogMainProcessWarn(...args);
  },
}));

jest.mock('../browser/browser-persistence', () => ({
  loadWorktreeBrowserState: (): { state: { browsers: unknown[] } } => ({
    state: { browsers: mockBrowsers },
  }),
}));

function panelLayout(panelId: string): Record<string, unknown> {
  return {
    version: 1,
    grid: {
      orientation: 0,
      root: {
        type: 'leaf',
        groupId: 'group-1',
        panels: [{ panelId, kind: 'chat', instance: { chatTabId: 'chat-1' } }],
        activePanelId: panelId,
        size: 1,
      },
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-1',
    mostRecentActiveGroupIds: ['group-1'],
  };
}

function writePanelLayout(panelId: string): void {
  const filePath = getWorktreePanelLayoutFilePath('project-1', 'worktree-1');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(panelLayout(panelId)), 'utf8');
}

function pinnedPanelId(
  snapshot: { layout: { grid: { root: unknown } } } | null,
): unknown {
  const root = snapshot?.layout.grid.root as
    | { panels?: Array<{ panelId: string }> }
    | undefined;
  return root?.panels?.[0]?.panelId;
}

describe('shared-container file-scope store', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'shared-container-scope-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    mockLogMainProcessWarn.mockClear();
    mockBrowsers = [];
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns only the public scope shape when no persisted file exists', async () => {
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toStrictEqual({
      includedPaths: [],
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
  });

  it('creates the parent directory and normalizes included paths', async () => {
    const write = writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [
        'src/z.ts',
        ' src/a.ts ',
        'src/z.ts',
        '',
        '../escape',
        'C:\\secrets\\windows.txt',
      ],
      includedNoteIds: ['note-z', ' note-a ', 'note-z'],
      includedPromptIds: ['prompt-1'],
    });
    expect(write).toBeInstanceOf(Promise);
    await write;
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      includedPaths: ['src/a.ts', 'src/z.ts'],
      includedNoteIds: ['note-a', 'note-z'],
      includedPromptIds: ['prompt-1'],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toEqual({
      includedPaths: ['src/a.ts', 'src/z.ts'],
      includedNoteIds: ['note-a', 'note-z'],
      includedPromptIds: ['prompt-1'],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
  });

  it('normalizes opt-out item and run-script fields', async () => {
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedNoteIds: [' note-z ', 'note-a', 'note-z', '../invalid'],
      excludedPromptIds: [' prompt-1 '],
      runSharingDisabled: true,
      excludedRunScripts: [
        ' launch ',
        'Launch UD Mobile (Android Device)',
        'has\nnewline',
      ],
    });

    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toMatchObject({
      excludedNoteIds: ['note-a', 'note-z'],
      excludedPromptIds: ['prompt-1'],
      runSharingDisabled: true,
      excludedRunScripts: ['Launch UD Mobile (Android Device)', 'launch'],
    });
  });

  it('deletes the scope file when default inclusion has no exclusions', async () => {
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedPaths: [],
      excludedNoteIds: [],
      excludedPromptIds: [],
      runSharingDisabled: false,
      excludedRunScripts: [],
    });

    expect(existsSync(filePath)).toBe(false);
  });

  it('keeps exclusion ids in sync across rename and delete', async () => {
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedNoteIds: ['note-old'],
      excludedPromptIds: ['prompt-old'],
    });

    await replaceSharedContainerScopeItemId(
      'project-1',
      'note',
      'note-old',
      'note-new',
    );
    await removeSharedContainerScopeItemId('project-1', 'prompt', 'prompt-old');

    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toMatchObject({
      excludedNoteIds: ['note-new'],
    });
    expect(
      await readSharedContainerFileScope('project-1', 'worktree-1'),
    ).not.toHaveProperty('excludedPromptIds');
  });

  it('normalizes exclusions while preserving an absent legacy exclusion field', async () => {
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, includedPaths: ['legacy-only.txt'] }),
    );
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toMatchObject({ includedPaths: ['legacy-only.txt'] });
    expect(
      await readSharedContainerFileScope('project-1', 'worktree-1'),
    ).not.toHaveProperty('excludedPaths');

    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedPaths: [' z.txt ', 'folder\\a.txt', 'z.txt', '../escape'],
    });

    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toMatchObject({
      includedPaths: [],
      excludedPaths: ['folder/a.txt', 'z.txt'],
    });
  });

  it('persists an explicit empty legacy Cowork allowlist', async () => {
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');

    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      legacyAllowlist: true,
    } as SharedContainerFileScope & { legacyAllowlist: true });

    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({
      version: 1,
      includedPaths: [],
      legacyAllowlist: true,
    });
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toMatchObject({ includedPaths: [], legacyAllowlist: true });
  });

  it('fails closed on malformed or unsupported persisted scope data', async () => {
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 99, includedPaths: ['secret.txt'] }),
    );
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).rejects.toThrow('Unsupported shared-container file scope');

    writeFileSync(filePath, '{not json');
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).rejects.toBeInstanceOf(SyntaxError);

    await rm(filePath);
    mkdirSync(filePath);
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).rejects.toBeDefined();
  });

  it('deletes the scope file when legacy inclusion fields are empty', async () => {
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');

    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: ['src/a.ts'],
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
    expect(existsSync(filePath)).toBe(false);
  });

  it('bounds the persisted approved-file scope', async () => {
    const includedPaths = Array.from(
      { length: 205 },
      (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`,
    );

    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths,
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
    });

    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toEqual({
      includedPaths: includedPaths.slice(0, 200),
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
  });

  it('drops an individually oversized path', async () => {
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [`src/${'a'.repeat(4096)}.ts`, 'src/kept.ts'],
      includedNoteIds: [],
      includedPromptIds: [],
    });

    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toEqual({
      includedPaths: ['src/kept.ts'],
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
  });

  it('drops legacy note-only and prompt-only selections on write', async () => {
    const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      includedNoteIds: ['note-1'],
      includedPromptIds: ['prompt-1'],
      runSharingEnabled: false,
      includedRunScripts: [],
    });
    expect(existsSync(filePath)).toBe(false);
  });

  // Any script the publisher can see in their own Scripts panel is publishable,
  // so real `canopy.json` keys with spaces, parentheses, and dots survive.
  it('persists custom excluded run script names alongside lifecycle ones', async () => {
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedRunScripts: [
        'launch',
        'teardown',
        'setup',
        'Launch UD Mobile (Android Device)',
        'update-binaries',
      ],
    });

    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toEqual({
      includedPaths: [],
      includedNoteIds: [],
      includedPromptIds: [],
      runSharingEnabled: false,
      includedRunScripts: [],
      excludedRunScripts: [
        'Launch UD Mobile (Android Device)',
        'launch',
        'setup',
        'teardown',
        'update-binaries',
      ],
    });
  });

  it('rejects excluded run script names the wire contract could not carry', async () => {
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedRunScripts: [
        'setup',
        'has\nnewline',
        '../escape',
        ' leading-space-only ',
        '',
        'x'.repeat(65),
      ],
    });

    // ` leading-space-only ` survives as its trimmed form; the rest cannot
    // reach a revision, so persisting them would only defer the failure.
    await expect(
      readSharedContainerFileScope('project-1', 'worktree-1'),
    ).resolves.toMatchObject({
      excludedRunScripts: ['leading-space-only', 'setup'],
    });
  });

  it('does not cap exclusions at the eight-command publication limit', async () => {
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      excludedRunScripts: Array.from(
        { length: 12 },
        (_unused, index) => `script-${index}`,
      ),
    });

    const scope = await readSharedContainerFileScope('project-1', 'worktree-1');
    expect(scope.excludedRunScripts).toHaveLength(12);
  });

  describe('preferred layout', () => {
    const defaultScope: SharedContainerFileScope = { includedPaths: [] };

    it('reads an absent field as on and not pinned', async () => {
      await writeSharedContainerFileScope('project-1', 'worktree-1', {
        includedPaths: [],
        excludedNoteIds: ['note-1'],
      });

      expect(
        await readSharedContainerFileScope('project-1', 'worktree-1'),
      ).not.toHaveProperty('preferredLayout');
      await expect(
        readSharedContainerPreferredLayoutSnapshot('project-1', 'worktree-1'),
      ).resolves.toBeNull();
    });

    it('pins the current layout once and keeps that pin', async () => {
      writePanelLayout('panel-first');
      mockBrowsers = [
        { id: 'local', url: 'file:///repo/index.html' },
        { id: 'web', url: 'https://example.com' },
        { id: 'dev-server', url: 'http://localhost:3000/' },
        { id: 'blank', url: 'about:blank' },
      ];

      await expect(
        pinSharedContainerPreferredLayoutIfMissing('project-1', 'worktree-1'),
      ).resolves.toBe(true);
      writePanelLayout('panel-second');
      await expect(
        pinSharedContainerPreferredLayoutIfMissing('project-1', 'worktree-1'),
      ).resolves.toBe(false);

      const snapshot = await readSharedContainerPreferredLayoutSnapshot(
        'project-1',
        'worktree-1',
      );
      expect(pinnedPanelId(snapshot)).toBe('panel-first');
      expect(snapshot?.browsers).toEqual([
        { id: 'local', url: 'file:///repo/index.html' },
        { id: 'web', url: 'https://example.com' },
        { id: 'dev-server', url: 'http://localhost:3000/' },
      ]);
      const scope = await readSharedContainerFileScope(
        'project-1',
        'worktree-1',
      );
      expect(scope.preferredLayout).toEqual({
        enabled: true,
        pinnedAt: snapshot?.pinnedAt,
      });
      expect(scope.preferredLayout).not.toHaveProperty('snapshot');
    });

    it('does not pin when no layout file exists', async () => {
      await expect(
        pinSharedContainerPreferredLayoutIfMissing('project-1', 'worktree-1'),
      ).resolves.toBe(false);

      expect(
        existsSync(getWorktreeShareFileScopePath('project-1', 'worktree-1')),
      ).toBe(false);
    });

    it('replaces the pin on an explicit pin', async () => {
      writePanelLayout('panel-first');
      await pinSharedContainerPreferredLayoutIfMissing(
        'project-1',
        'worktree-1',
      );
      writePanelLayout('panel-second');

      await expect(
        pinSharedContainerPreferredLayout('project-1', 'worktree-1'),
      ).resolves.toBe(true);

      expect(
        pinnedPanelId(
          await readSharedContainerPreferredLayoutSnapshot(
            'project-1',
            'worktree-1',
          ),
        ),
      ).toBe('panel-second');
    });

    it('keeps the existing pin on an explicit pin with no layout to capture', async () => {
      writePanelLayout('panel-first');
      await pinSharedContainerPreferredLayoutIfMissing(
        'project-1',
        'worktree-1',
      );
      await rm(getWorktreePanelLayoutFilePath('project-1', 'worktree-1'));

      await expect(
        pinSharedContainerPreferredLayout('project-1', 'worktree-1'),
      ).resolves.toBe(false);

      expect(
        pinnedPanelId(
          await readSharedContainerPreferredLayoutSnapshot(
            'project-1',
            'worktree-1',
          ),
        ),
      ).toBe('panel-first');
    });

    it('turns an off scope back on, not pinned, on an explicit pin with no layout', async () => {
      await writeSharedContainerFileScope('project-1', 'worktree-1', {
        ...defaultScope,
        excludedNoteIds: ['note-1'],
        preferredLayout: { enabled: false },
      });

      await expect(
        pinSharedContainerPreferredLayout('project-1', 'worktree-1'),
      ).resolves.toBe(false);

      expect(
        await readSharedContainerFileScope('project-1', 'worktree-1'),
      ).not.toHaveProperty('preferredLayout');
    });

    it('replaces a malformed scope file on a save, with a warning', async () => {
      const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, '{not json');

      await writeSharedContainerFileScope('project-1', 'worktree-1', {
        includedPaths: [],
        excludedNoteIds: ['note-1'],
      });

      await expect(
        readSharedContainerFileScope('project-1', 'worktree-1'),
      ).resolves.toMatchObject({ excludedNoteIds: ['note-1'] });
      expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
        '[shared-containers] replaced a malformed share file scope',
        expect.any(SyntaxError),
      );
    });

    it('fails a save rather than replace a scope file it could not read', async () => {
      const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
      mkdirSync(filePath, { recursive: true });

      await expect(
        writeSharedContainerFileScope('project-1', 'worktree-1', {
          includedPaths: [],
          excludedNoteIds: ['note-1'],
        }),
      ).rejects.toMatchObject({ code: 'EISDIR' });
      expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
    });

    it('writes the scope file by rename and leaves no temporary file behind', async () => {
      writePanelLayout('panel-first');
      await pinSharedContainerPreferredLayoutIfMissing(
        'project-1',
        'worktree-1',
      );

      const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
      expect(readdirSync(dirname(filePath))).toContain(basename(filePath));
      expect(
        readdirSync(dirname(filePath)).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
    });

    it('persists off, drops the pin, and is not pinned again', async () => {
      writePanelLayout('panel-first');
      await pinSharedContainerPreferredLayoutIfMissing(
        'project-1',
        'worktree-1',
      );

      await writeSharedContainerFileScope('project-1', 'worktree-1', {
        ...defaultScope,
        preferredLayout: { enabled: false },
      });
      // A later scope save that does not mention the layout keeps it off.
      await writeSharedContainerFileScope(
        'project-1',
        'worktree-1',
        defaultScope,
      );

      await expect(
        pinSharedContainerPreferredLayoutIfMissing('project-1', 'worktree-1'),
      ).resolves.toBe(false);
      expect(
        (await readSharedContainerFileScope('project-1', 'worktree-1'))
          .preferredLayout,
      ).toEqual({ enabled: false });
      await expect(
        readSharedContainerPreferredLayoutSnapshot('project-1', 'worktree-1'),
      ).resolves.toBeNull();
    });

    it('keeps the scope file while a pin exists and every other field is default', async () => {
      writePanelLayout('panel-first');
      await pinSharedContainerPreferredLayoutIfMissing(
        'project-1',
        'worktree-1',
      );

      await writeSharedContainerFileScope(
        'project-1',
        'worktree-1',
        defaultScope,
      );

      expect(
        existsSync(getWorktreeShareFileScopePath('project-1', 'worktree-1')),
      ).toBe(true);
      expect(
        pinnedPanelId(
          await readSharedContainerPreferredLayoutSnapshot(
            'project-1',
            'worktree-1',
          ),
        ),
      ).toBe('panel-first');
    });

    it('drops a malformed snapshot with a warning', async () => {
      const filePath = getWorktreeShareFileScopePath('project-1', 'worktree-1');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          includedPaths: [],
          preferredLayout: {
            enabled: true,
            snapshot: { pinnedAt: 'yesterday', layout: panelLayout('panel') },
          },
        }),
        'utf8',
      );

      expect(
        await readSharedContainerFileScope('project-1', 'worktree-1'),
      ).not.toHaveProperty('preferredLayout');
      expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
        '[shared-containers] dropped an invalid preferred layout snapshot',
      );
    });

    it('carries the pin through an item-id rename without rewriting it', async () => {
      writePanelLayout('panel-first');
      await writeSharedContainerFileScope('project-1', 'worktree-1', {
        includedPaths: [],
        excludedNoteIds: ['note-old'],
      });
      await pinSharedContainerPreferredLayoutIfMissing(
        'project-1',
        'worktree-1',
      );
      const before = await readSharedContainerPreferredLayoutSnapshot(
        'project-1',
        'worktree-1',
      );

      await replaceSharedContainerScopeItemId(
        'project-1',
        'note',
        'note-old',
        'note-new',
      );

      await expect(
        readSharedContainerFileScope('project-1', 'worktree-1'),
      ).resolves.toMatchObject({ excludedNoteIds: ['note-new'] });
      await expect(
        readSharedContainerPreferredLayoutSnapshot('project-1', 'worktree-1'),
      ).resolves.toEqual(before);
    });

    it('does not lose an off written while a pin is in flight', async () => {
      writePanelLayout('panel-first');

      await Promise.all([
        pinSharedContainerPreferredLayoutIfMissing('project-1', 'worktree-1'),
        writeSharedContainerFileScope('project-1', 'worktree-1', {
          ...defaultScope,
          preferredLayout: { enabled: false },
        }),
      ]);

      await expect(
        readSharedContainerPreferredLayoutSnapshot('project-1', 'worktree-1'),
      ).resolves.toBeNull();
    });
  });
});
