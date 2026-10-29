// Integration-style coverage for the workspace-items storage engine and IPC
// adapter, using real fs under a temp CANOPY_DATA_DIR (same posture as
// worktree-attachments.test.ts). Covers the code-workspace notes/prompts
// index round-trip, self-healing directory reconciliation, branch-origin
// capture + lazy snapshot refresh across a rename, the snapshot fallback
// after worktree deletion, and prompt read-by-path validation.

const showOpenDialogMock = jest.fn(() =>
  Promise.resolve({ canceled: true, filePaths: [] }),
);
const fromWebContentsMock = jest.fn<unknown, [unknown]>();
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]): unknown =>
      showOpenDialogMock(...args),
  },
  BrowserWindow: {
    fromWebContents: (contents: unknown): unknown =>
      fromWebContentsMock(contents),
  },
}));

jest.mock('node:fs/promises', () => {
  const actual: typeof fsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    rename: jest.fn(actual.rename),
  };
});

const registeredHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(
    (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      registeredHandlers.set(channel, handler);
    },
  ),
}));

const mockScheduleSharedContainerWorkspace = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): {
    scheduleWorkspace: typeof mockScheduleSharedContainerWorkspace;
  } => ({ scheduleWorkspace: mockScheduleSharedContainerWorkspace }),
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  type WorkspaceAttachmentItem,
  type WorkspaceAttachmentsImportResponse,
  type WorkspaceNoteItem,
  type WorkspacePromptItem,
  type WorkspacePromptReadByPathResponse,
  type WorktreesFile,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  listWorkspaceNotes,
  listWorkspacePrompts,
  readWorkspaceNote,
  readWorkspacePrompt,
  saveWorkspaceNote,
  saveWorkspacePrompt,
  deleteWorkspaceNote,
} from '../lib/workspace-items';
import { registerWorkspaceItemHandlers } from '../ipc/workspace-items';
import { getAppAdvisorHomeDir, getWorkspaceHomeDir } from '../lib/paths';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import {
  readSharedContainerFileScope,
  writeSharedContainerFileScope,
} from '../shared-containers/file-scope-store';
import { isRecord } from '../lib/type-guards';

const WORKSPACE_ID = 'ws-1';
const WORKTREE_ID = 'wt-1';
const DEFAULT_BRANCH = `${WORKTREE_ID}-1700000000000`;

function writeWorktreesFile(branchName: string | null): void {
  const dir = join(
    process.env.CANOPY_DATA_DIR ?? '',
    'workspaces',
    WORKSPACE_ID,
  );
  mkdirSync(dir, { recursive: true });
  const file: WorktreesFile = {
    version: 1,
    worktrees:
      branchName === null
        ? []
        : [
            {
              id: WORKTREE_ID,
              branchName,
              createdAt: '2026-07-14T00:00:00.000Z',
            },
          ],
  };
  writeFileSync(join(dir, 'worktrees.json'), JSON.stringify(file));
}

interface TestIndexItem {
  originBranchName?: string;
  title: string;
}

interface TestIndexFile {
  version: number;
  items: Record<string, TestIndexItem>;
}

function readIndexFile(kind: 'notes' | 'prompts'): TestIndexFile {
  const raw = readFileSync(
    join(
      process.env.CANOPY_DATA_DIR ?? '',
      'workspaces',
      WORKSPACE_ID,
      kind,
      'index.json',
    ),
    'utf8',
  );
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.version !== 'number' ||
    !isRecord(parsed.items)
  ) {
    throw new Error('Invalid workspace-items test index');
  }
  const items: Record<string, TestIndexItem> = {};
  for (const [id, item] of Object.entries(parsed.items)) {
    if (
      !isRecord(item) ||
      typeof item.title !== 'string' ||
      (item.originBranchName !== undefined &&
        typeof item.originBranchName !== 'string')
    ) {
      throw new Error(`Invalid workspace-items test index item: ${id}`);
    }
    items[id] = {
      title: item.title,
      ...(item.originBranchName !== undefined
        ? { originBranchName: item.originBranchName }
        : {}),
    };
  }
  return { version: parsed.version, items };
}

describe('workspace-items storage engine (code projects)', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-workspace-items-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('round-trips a note through save/list/read with a versioned index', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const saved = await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Release checklist',
      content: '# Release checklist\n- ship it',
    });
    expect(saved.id).toBe('release-checklist');
    expect(existsSync(saved.absolutePath)).toBe(true);

    const index = readIndexFile('notes');
    expect(index.version).toBe(1);
    expect(index.items['release-checklist']?.title).toBe('Release checklist');

    const listed = await listWorkspaceNotes(WORKSPACE_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe('Release checklist');
    expect(listed[0].origin).toBeUndefined();

    const { content } = await readWorkspaceNote(
      WORKSPACE_ID,
      'release-checklist',
    );
    expect(content).toContain('ship it');
  });

  it('captures branch origin at save and resolves it live while the worktree exists', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Scoped note',
      content: 'body',
      originWorktreeId: WORKTREE_ID,
    });

    const listed = await listWorkspaceNotes(WORKSPACE_ID);
    expect(listed[0].origin).toEqual({
      worktreeId: WORKTREE_ID,
      branchName: DEFAULT_BRANCH,
      worktreeExists: true,
    });
  });

  it('shows the renamed branch live and lazily rewrites the index snapshot', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Renamed origin',
      content: 'body',
      originWorktreeId: WORKTREE_ID,
    });

    // Simulate branch-namer renaming the canopy-generated default branch.
    writeWorktreesFile('feat/real-branch-name');

    const listed = await listWorkspaceNotes(WORKSPACE_ID);
    expect(listed[0].origin?.branchName).toBe('feat/real-branch-name');
    expect(listed[0].origin?.worktreeExists).toBe(true);

    // Lazy write-behind: the snapshot in the index was refreshed by list.
    const index = readIndexFile('notes');
    expect(index.items['renamed-origin']?.originBranchName).toBe(
      'feat/real-branch-name',
    );
  });

  it('falls back to the stored snapshot after the origin worktree is deleted', async () => {
    writeWorktreesFile('feat/final-name');
    await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Orphaned origin',
      content: 'body',
      originWorktreeId: WORKTREE_ID,
    });

    writeWorktreesFile(null);

    const listed = await listWorkspaceNotes(WORKSPACE_ID);
    expect(listed[0].origin).toEqual({
      worktreeId: WORKTREE_ID,
      branchName: 'feat/final-name',
      worktreeExists: false,
    });
  });

  it('self-heals: adopts hand-dropped markdown and drops entries whose file vanished', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const saved = await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Indexed note',
      content: 'body',
    });

    const notesDir = join(tempDataDir, 'workspaces', WORKSPACE_ID, 'notes');
    writeFileSync(join(notesDir, 'hand-dropped.md'), '# Dropped by hand');
    rmSync(saved.absolutePath);

    const listed = await listWorkspaceNotes(WORKSPACE_ID);
    expect(listed.map((note: WorkspaceNoteItem) => note.id)).toEqual([
      'hand-dropped',
    ]);
    expect(listed[0].title).toBe('Dropped by hand');

    const index = readIndexFile('notes');
    expect(index.items['hand-dropped']).toBeDefined();
    expect(index.items['indexed-note']).toBeUndefined();
  });

  it('deletes the file and its index entry', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const saved = await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Doomed',
      content: 'body',
    });
    await deleteWorkspaceNote(WORKSPACE_ID, saved.id);
    expect(existsSync(saved.absolutePath)).toBe(false);
    expect(await listWorkspaceNotes(WORKSPACE_ID)).toHaveLength(0);
  });

  it('keeps the original item when an atomic rename write fails', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const original = await saveWorkspaceNote({
      workspaceId: WORKSPACE_ID,
      title: 'Original title',
      content: 'original body',
    });
    jest
      .mocked(fsPromises.rename)
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      saveWorkspaceNote({
        workspaceId: WORKSPACE_ID,
        noteId: original.id,
        title: 'Replacement title',
        content: 'replacement body',
      }),
    ).rejects.toThrow('disk full');

    expect(readFileSync(original.absolutePath, 'utf8')).toBe('original body');
    expect(
      existsSync(join(dirname(original.absolutePath), 'replacement-title.md')),
    ).toBe(false);
    expect(readIndexFile('notes').items[original.id]?.title).toBe(
      'Original title',
    );
  });

  it('stores prompts with frontmatter and reads back the body only', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const saved = await saveWorkspacePrompt({
      workspaceId: WORKSPACE_ID,
      title: 'Review prompt',
      content: 'Review this code carefully.',
    });
    const raw = readFileSync(saved.absolutePath, 'utf8');
    expect(raw).toContain('title: "Review prompt"');

    const { content } = await readWorkspacePrompt(WORKSPACE_ID, saved.id);
    expect(content).toBe('Review this code carefully.');

    const listed = await listWorkspacePrompts(WORKSPACE_ID);
    expect(listed[0].title).toBe('Review prompt');
  });
});

describe('workspace-items IPC adapter', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';

  beforeEach(() => {
    registeredHandlers.clear();
    mockScheduleSharedContainerWorkspace.mockClear();
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-workspace-items-ipc-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
    registerWorkspaceItemHandlers();
  });

  afterEach(() => {
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  function getHandler(
    channel: typeof IPC_CHANNELS.workspaceNotesSave,
  ): (event: unknown, ...args: unknown[]) => Promise<WorkspaceNoteItem>;
  function getHandler(
    channel: typeof IPC_CHANNELS.workspacePromptsReadByPath,
  ): (
    event: unknown,
    ...args: unknown[]
  ) => Promise<WorkspacePromptReadByPathResponse>;
  function getHandler(
    channel: typeof IPC_CHANNELS.workspaceAttachmentsImport,
  ): (
    event: unknown,
    ...args: unknown[]
  ) => Promise<WorkspaceAttachmentsImportResponse>;
  function getHandler(
    channel: typeof IPC_CHANNELS.workspaceAttachmentsList,
  ): (event: unknown, ...args: unknown[]) => Promise<WorkspaceAttachmentItem[]>;
  function getHandler(
    channel: string,
  ): (event: unknown, ...args: unknown[]) => unknown {
    const handler = registeredHandlers.get(channel);
    if (typeof handler !== 'function') {
      throw new Error(`${channel} handler was not registered`);
    }
    return handler;
  }

  it('reads a prompt body by path when inside the project prompts dir', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const saved = await saveWorkspacePrompt({
      workspaceId: WORKSPACE_ID,
      title: 'Expandable',
      content: 'Expanded body text.',
    });

    const handler = getHandler(IPC_CHANNELS.workspacePromptsReadByPath);
    const response = await handler(undefined, {
      projectId: WORKSPACE_ID,
      absolutePath: saved.absolutePath,
    });
    expect(response.content).toBe('Expanded body text.');
  });

  it('rejects a prompt read-by-path outside the project prompts dir', async () => {
    const outside = join(tempDataDir, 'secrets.md');
    writeFileSync(outside, 'not a prompt');

    const handler = getHandler(IPC_CHANNELS.workspacePromptsReadByPath);
    await expect(
      handler(undefined, {
        projectId: WORKSPACE_ID,
        absolutePath: outside,
      }),
    ).rejects.toThrow(/outside the project prompts directory/);
  });

  it('rejects a prompt symlink whose canonical target is outside the prompts dir', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const promptsDir = join(tempDataDir, 'workspaces', WORKSPACE_ID, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    const outside = join(tempDataDir, 'secrets.md');
    const linkedPrompt = join(promptsDir, 'linked-prompt.md');
    writeFileSync(outside, 'not a prompt');
    symlinkSync(outside, linkedPrompt);

    const handler = getHandler(IPC_CHANNELS.workspacePromptsReadByPath);
    await expect(
      handler(undefined, {
        projectId: WORKSPACE_ID,
        absolutePath: linkedPrompt,
      }),
    ).rejects.toThrow(/outside the project prompts directory/);
  });

  it('rejects a cowork prompts root symlink whose canonical target is outside the project', async () => {
    const coworkRoot = getWorkspaceHomeDir(STANDALONE_CHAT_PROJECT_ID);
    const promptsDir = getCoworkManagedSubdir(coworkRoot, 'prompts');
    const outsidePromptsDir = join(tempDataDir, 'outside-prompts');
    const outsidePrompt = join(outsidePromptsDir, 'linked-prompt.md');
    mkdirSync(coworkRoot, { recursive: true });
    mkdirSync(dirname(promptsDir), { recursive: true });
    mkdirSync(outsidePromptsDir, { recursive: true });
    writeFileSync(outsidePrompt, 'not a project prompt');
    symlinkSync(outsidePromptsDir, promptsDir, 'dir');

    const handler = getHandler(IPC_CHANNELS.workspacePromptsReadByPath);
    await expect(
      handler(undefined, {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        absolutePath: join(promptsDir, 'linked-prompt.md'),
      }),
    ).rejects.toThrow(/prompts directory is outside the project/);
  });

  it('rejects a non-Markdown file in the prompts directory', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const promptsDir = join(tempDataDir, 'workspaces', WORKSPACE_ID, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    const textFile = join(promptsDir, 'not-a-prompt.txt');
    writeFileSync(textFile, 'plain text');

    const handler = getHandler(IPC_CHANNELS.workspacePromptsReadByPath);
    await expect(
      handler(undefined, {
        projectId: WORKSPACE_ID,
        absolutePath: textFile,
      }),
    ).rejects.toThrow(/must reference a Markdown file/);
  });

  it('validates note, prompt, and origin worktree ids at the IPC boundary', async () => {
    await expect(
      getHandler(IPC_CHANNELS.workspaceNotesRead)(undefined, {
        projectId: WORKSPACE_ID,
        noteId: '../note',
      }),
    ).rejects.toThrow('Invalid noteId');
    await expect(
      getHandler(IPC_CHANNELS.workspacePromptsDelete)(undefined, {
        projectId: WORKSPACE_ID,
        promptId: '../prompt',
      }),
    ).rejects.toThrow('Invalid promptId');
    await expect(
      getHandler(IPC_CHANNELS.workspaceNotesSave)(undefined, {
        projectId: WORKSPACE_ID,
        title: 'Unsafe',
        content: '',
        originWorktreeId: '../worktree',
      }),
    ).rejects.toThrow('Invalid originWorktreeId');
  });

  it('schedules shared-container publication after code note and prompt mutations', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);

    const note = await getHandler(IPC_CHANNELS.workspaceNotesSave)(undefined, {
      projectId: WORKSPACE_ID,
      title: 'Shared note',
      content: 'First note revision.',
      originWorktreeId: WORKTREE_ID,
    });
    expect(mockScheduleSharedContainerWorkspace).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
    );

    mockScheduleSharedContainerWorkspace.mockClear();
    await getHandler(IPC_CHANNELS.workspaceNotesDelete)(undefined, {
      projectId: WORKSPACE_ID,
      noteId: note.id,
    });
    expect(mockScheduleSharedContainerWorkspace).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
    );

    mockScheduleSharedContainerWorkspace.mockClear();
    const prompt = (await getHandler(IPC_CHANNELS.workspacePromptsSave)(
      undefined,
      {
        projectId: WORKSPACE_ID,
        title: 'Shared prompt',
        content: 'First prompt revision.',
        originWorktreeId: WORKTREE_ID,
      },
    )) as WorkspacePromptItem;
    expect(mockScheduleSharedContainerWorkspace).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
    );

    mockScheduleSharedContainerWorkspace.mockClear();
    await getHandler(IPC_CHANNELS.workspacePromptsDelete)(undefined, {
      projectId: WORKSPACE_ID,
      promptId: prompt.id,
    });
    expect(mockScheduleSharedContainerWorkspace).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
    );
  });

  it('keeps excluded note and prompt scopes current across renames and deletes', async () => {
    writeWorktreesFile(DEFAULT_BRANCH);
    const note = await getHandler(IPC_CHANNELS.workspaceNotesSave)(undefined, {
      projectId: WORKSPACE_ID,
      title: 'Shared note',
      content: 'First note revision.',
      originWorktreeId: WORKTREE_ID,
    });
    const prompt = (await getHandler(IPC_CHANNELS.workspacePromptsSave)(
      undefined,
      {
        projectId: WORKSPACE_ID,
        title: 'Shared prompt',
        content: 'First prompt revision.',
        originWorktreeId: WORKTREE_ID,
      },
    )) as WorkspacePromptItem;
    const scopedWorktrees = [WORKTREE_ID, 'wt-2'];
    for (const worktreeId of scopedWorktrees) {
      await writeSharedContainerFileScope(WORKSPACE_ID, worktreeId, {
        includedPaths: [],
        excludedNoteIds: [note.id],
        excludedPromptIds: [prompt.id],
      });
    }

    const renamedNote = await getHandler(IPC_CHANNELS.workspaceNotesSave)(
      undefined,
      {
        projectId: WORKSPACE_ID,
        noteId: note.id,
        title: 'Renamed note',
        content: 'Second note revision.',
      },
    );
    const renamedPrompt = (await getHandler(IPC_CHANNELS.workspacePromptsSave)(
      undefined,
      {
        projectId: WORKSPACE_ID,
        promptId: prompt.id,
        title: 'Renamed prompt',
        content: 'Second prompt revision.',
      },
    )) as WorkspacePromptItem;

    expect(renamedNote.id).not.toBe(note.id);
    expect(renamedPrompt.id).not.toBe(prompt.id);
    for (const worktreeId of scopedWorktrees) {
      await expect(
        readSharedContainerFileScope(WORKSPACE_ID, worktreeId),
      ).resolves.toMatchObject({
        excludedNoteIds: [renamedNote.id],
        excludedPromptIds: [renamedPrompt.id],
      });
    }

    await getHandler(IPC_CHANNELS.workspaceNotesDelete)(undefined, {
      projectId: WORKSPACE_ID,
      noteId: renamedNote.id,
    });
    await getHandler(IPC_CHANNELS.workspacePromptsDelete)(undefined, {
      projectId: WORKSPACE_ID,
      promptId: renamedPrompt.id,
    });
    for (const worktreeId of scopedWorktrees) {
      const scope = await readSharedContainerFileScope(
        WORKSPACE_ID,
        worktreeId,
      );
      expect(scope.excludedNoteIds ?? []).toEqual([]);
      expect(scope.excludedPromptIds ?? []).toEqual([]);
    }
  });

  it('imports and lists attachments for a code worktree without altering storage layout', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'canopy-wsitems-src-'));
    const sourcePath = join(sourceDir, 'design.png');
    writeFileSync(sourcePath, 'binary-ish');

    try {
      const importHandler = getHandler(IPC_CHANNELS.workspaceAttachmentsImport);
      const imported = await importHandler(undefined, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        filePaths: [sourcePath],
      });

      expect(imported.attachments).toHaveLength(1);
      // Same location the legacy worktreeImportAttachments handler uses for
      // single-repo workspaces: workspaces/{projectId}/attachments/{worktreeId}.
      expect(imported.attachments[0].absolutePath).toContain(
        join('workspaces', WORKSPACE_ID, 'attachments', WORKTREE_ID),
      );

      const listHandler = getHandler(IPC_CHANNELS.workspaceAttachmentsList);
      const listed = await listHandler(undefined, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
      });
      expect(listed.map((item) => item.filename)).toEqual(['design.png']);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  // CAN-2706: the attachment open panel is raised from the `+` menu, and an
  // unparented panel floats free of the app instead of being presented as a
  // window-modal sheet centered on it.
  it('presents the attachment open panel over the window that requested it', async () => {
    showOpenDialogMock.mockClear();
    const senderWindow = { isDestroyed: (): boolean => false };
    fromWebContentsMock.mockReturnValue(senderWindow);
    const sender = { id: 3 };

    await getHandler(IPC_CHANNELS.workspaceAttachmentsImport)(
      { sender },
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        filePaths: [],
      },
    );

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender);
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      senderWindow,
      expect.objectContaining({
        title: 'Import attachments',
        properties: ['openFile', 'multiSelections'],
      }),
    );
  });

  it('roots App Advisor project items and attachments in its shared home', async () => {
    const noteHandler = getHandler(IPC_CHANNELS.workspaceNotesSave);
    const saved = await noteHandler(undefined, {
      projectId: APP_ADVISOR_PROJECT_ID,
      title: 'Advisor note',
      content: 'Remember this.',
    });
    expect(saved.absolutePath).toContain(
      getCoworkManagedSubdir(getAppAdvisorHomeDir(), 'notes'),
    );

    const sourceDir = mkdtempSync(join(tmpdir(), 'canopy-advisor-attachment-'));
    const sourcePath = join(sourceDir, 'advisor.txt');
    writeFileSync(sourcePath, 'context');
    try {
      const imported = await getHandler(
        IPC_CHANNELS.workspaceAttachmentsImport,
      )(undefined, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        filePaths: [sourcePath],
      });
      expect(imported.attachments[0]?.absolutePath).toContain(
        getCoworkManagedSubdir(getAppAdvisorHomeDir(), 'attachments'),
      );
      expect(
        resolveAgentAttachmentsDir(APP_ADVISOR_PROJECT_ID, 'another-entry'),
      ).toBe(getCoworkManagedSubdir(getAppAdvisorHomeDir(), 'attachments'));

      const deleteHandler = getHandler(IPC_CHANNELS.workspaceAttachmentsDelete);
      const attachmentsDir = getCoworkManagedSubdir(
        getAppAdvisorHomeDir(),
        'attachments',
      );
      await expect(
        deleteHandler(undefined, {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          filename: '.',
        }),
      ).rejects.toThrow('Invalid attachment filename');
      await expect(
        deleteHandler(undefined, {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          filename: '',
        }),
      ).rejects.toThrow('Invalid attachment filename');
      expect(existsSync(attachmentsDir)).toBe(true);
      expect(existsSync(imported.attachments[0].absolutePath)).toBe(true);

      await deleteHandler(undefined, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-one',
        filename: imported.attachments[0].filename,
      });
      expect(existsSync(imported.attachments[0].absolutePath)).toBe(false);
      expect(existsSync(attachmentsDir)).toBe(true);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('preserves duplicate attachment names during a batch import', async () => {
    const firstSourceDir = mkdtempSync(join(tmpdir(), 'canopy-wsitems-src-a-'));
    const secondSourceDir = mkdtempSync(
      join(tmpdir(), 'canopy-wsitems-src-b-'),
    );
    const firstSourcePath = join(firstSourceDir, 'design.png');
    const secondSourcePath = join(secondSourceDir, 'design.png');
    writeFileSync(firstSourcePath, 'first');
    writeFileSync(secondSourcePath, 'second');

    try {
      const importHandler = getHandler(IPC_CHANNELS.workspaceAttachmentsImport);
      const imported = await importHandler(undefined, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        filePaths: [firstSourcePath, secondSourcePath],
      });

      expect(imported.attachments.map((item) => item.filename)).toEqual([
        'design.png',
        'design-2.png',
      ]);
      expect(
        imported.attachments.map((item) =>
          readFileSync(item.absolutePath, 'utf8'),
        ),
      ).toEqual(['first', 'second']);
    } finally {
      rmSync(firstSourceDir, { recursive: true, force: true });
      rmSync(secondSourceDir, { recursive: true, force: true });
    }
  });
});
