import {
  PORTAL_CATALOG_CONTENT_MAX_BYTES,
  PORTAL_CATALOG_RESULT_MAX_BYTES,
} from '@canopy/protocol/portal';
import { isRecord } from '../validation';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import {
  listNotesForProject,
  readNoteForProject,
  listPromptsForProject,
  readPromptForProject,
} from '../../../services/workspace-items-service';
import { listPortalWorkspaceAttachments } from '../../portal-workspace-reads';
import {
  handlePortalWorkspaceItemsListNotes,
  handlePortalWorkspaceItemsReadNote,
  handlePortalWorkspaceItemsListPrompts,
  handlePortalWorkspaceItemsReadPrompt,
  handlePortalWorkspaceItemsListAttachments,
} from '../workspace-items-adapter';
import { PortalServiceError } from '../../../services/portal-service-error';
import type { PortalAdapterContext } from '../types';

jest.mock('../../../services/workspace-items-service', () => ({
  listNotesForProject: jest.fn(),
  readNoteForProject: jest.fn(),
  listPromptsForProject: jest.fn(),
  readPromptForProject: jest.fn(),
}));
// CAN-4105: the list reaches core.workspace.item.list through this read.
jest.mock('../../portal-workspace-reads', () => ({
  listPortalWorkspaceAttachments: jest.fn(),
}));

function expectNoAbsolutePath(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.keys(value)).not.toContain('absolutePath');
  for (const child of Object.values(value)) expectNoAbsolutePath(child);
}

function legacyFilesystemServiceError(
  code: 'EACCES' | 'ENOENT',
  message: string,
): PortalServiceError {
  const error = new PortalServiceError('execution_failed', message);
  // These cases preserve legacy filesystem codes at the service boundary.
  Reflect.set(error, 'code', code);
  return error;
}

const origin = {
  worktreeId: 'wt-1',
  branchName: 'feature',
  worktreeExists: true,
};
const wireItem = {
  id: 'item-1',
  title: 'Title',
  createdAt: '2026-09-08',
  updatedAt: '2026-09-08',
  origin,
};
const desktopItem = {
  ...wireItem,
  absolutePath: '/private/note.md',
  origin: { ...origin, absolutePath: '/private/worktree' },
};
const wireAttachment = {
  filename: 'image.png',
  sizeBytes: 123,
  createdAt: '2026-09-08',
};
const desktopAttachment = {
  ...wireAttachment,
  absolutePath: '/private/image.png',
};
const complete = jest.fn<void, [PortalCommandEnvelope, unknown?]>();
const fail = jest.fn();
const context: PortalAdapterContext = {
  getWindow: () => null,
  enqueueEvent: jest.fn(),
  complete,
  fail,
};

describe('project items portal adapter', (): void => {
  beforeEach((): void => {
    jest.resetAllMocks();
  });

  describe('list_notes', (): void => {
    const command = {
      id: 'cmd-1',
      sequence: 1,
      type: 'portal.workspace_items.list_notes',
      payload: { projectId: 'project-1' },
      createdAt: '2026-09-08',
      expiresAt: null,
    } satisfies PortalCommandEnvelope;
    it('completes with the mapped result without absolutePath anywhere', async (): Promise<void> => {
      jest.mocked(listNotesForProject).mockResolvedValue([desktopItem]);
      await handlePortalWorkspaceItemsListNotes(command, context);
      expect(listNotesForProject).toHaveBeenCalledWith('project-1');
      expect(complete).toHaveBeenCalledWith(command, {
        ok: true,
        notes: [wireItem],
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expectNoAbsolutePath(complete.mock.calls[0]?.[1]);
      expect(fail).not.toHaveBeenCalled();
    });
    it('keeps the longest fitting deterministic prefix', async (): Promise<void> => {
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        ...wireItem,
        title: `${index}-${'界'.repeat(400)}`,
      }));
      jest
        .mocked(listNotesForProject)
        .mockResolvedValue(rows.map((row) => ({ ...desktopItem, ...row })));
      await handlePortalWorkspaceItemsListNotes(command, context);
      const result = complete.mock.calls[0]?.[1];
      if (!isRecord(result) || !Array.isArray(result.notes)) {
        throw new Error('Expected a list result');
      }
      const count = result.notes.length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(rows.length);
      expect(result).toEqual({
        ok: true,
        notes: rows.slice(0, count),
        truncated: true,
      });
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            ok: true,
            notes: rows.slice(0, count + 1),
            truncated: true,
          }),
          'utf8',
        ),
      ).toBeGreaterThan(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expectNoAbsolutePath(result);
      expect(fail).not.toHaveBeenCalled();
    });
    it.each([null, [], 'invalid'])(
      'rejects invalid payload %p',
      async (payload): Promise<void> => {
        const invalid = Object.assign({}, command);
        Object.defineProperty(invalid, 'payload', { value: payload });
        await handlePortalWorkspaceItemsListNotes(invalid, context);
        expect(fail).toHaveBeenCalledWith(
          invalid,
          'invalid_payload',
          expect.any(String),
        );
        expect(listNotesForProject).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      },
    );
    it('keeps the error code but never echoes the local path', async (): Promise<void> => {
      jest
        .mocked(listNotesForProject)
        .mockRejectedValue(
          legacyFilesystemServiceError(
            'EACCES',
            "EACCES: permission denied, scandir '/Users/someone/.canopy/workspaces/ws/notes'",
          ),
        );
      await handlePortalWorkspaceItemsListNotes(command, context);
      expect(fail).toHaveBeenCalledWith(
        command,
        'EACCES',
        expect.not.stringContaining('/Users/someone'),
        false,
      );
      expect(fail).toHaveBeenCalledWith(
        command,
        'EACCES',
        expect.not.stringContaining('.canopy'),
        false,
      );
      expect(complete).not.toHaveBeenCalled();
    });
  });

  describe('read_note', (): void => {
    const command = {
      id: 'cmd-1',
      sequence: 1,
      type: 'portal.workspace_items.read_note',
      payload: { projectId: 'project-1', noteId: 'item-1' },
      createdAt: '2026-09-08',
      expiresAt: null,
    } satisfies PortalCommandEnvelope;
    it('completes with the mapped result without absolutePath anywhere', async (): Promise<void> => {
      jest
        .mocked(readNoteForProject)
        .mockResolvedValue({ meta: desktopItem, content: 'Body' });
      await handlePortalWorkspaceItemsReadNote(command, context);
      expect(readNoteForProject).toHaveBeenCalledWith('project-1', 'item-1');
      expect(complete).toHaveBeenCalledWith(command, {
        ok: true,
        meta: wireItem,
        content: 'Body',
        truncated: false,
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expectNoAbsolutePath(complete.mock.calls[0]?.[1]);
      expect(fail).not.toHaveBeenCalled();
    });
    it.each(['x', '😀', '界'])(
      'caps oversized %s bodies on a UTF-8 code-point boundary',
      async (character): Promise<void> => {
        const content =
          'a' + character.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES);
        jest
          .mocked(readNoteForProject)
          .mockResolvedValue({ meta: desktopItem, content });
        await handlePortalWorkspaceItemsReadNote(command, context);
        const result = complete.mock.calls[0]?.[1];
        if (!isRecord(result) || typeof result.content !== 'string') {
          throw new Error('Expected a content result');
        }
        expect(result.truncated).toBe(true);
        expect(result.content).toBe(
          'a' +
            character.repeat(
              Math.floor(
                (PORTAL_CATALOG_CONTENT_MAX_BYTES - 1) /
                  Buffer.byteLength(character, 'utf8'),
              ),
            ),
        );
        expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
          PORTAL_CATALOG_CONTENT_MAX_BYTES,
        );
        expect(Buffer.from(result.content, 'utf8').toString('utf8')).toBe(
          result.content,
        );
        expect(result.content).not.toContain('\uFFFD');
        expectNoAbsolutePath(result);
        expect(fail).not.toHaveBeenCalled();
      },
    );
    it.each([null, [], 'invalid'])(
      'rejects invalid payload %p',
      async (payload): Promise<void> => {
        const invalid = Object.assign({}, command);
        Object.defineProperty(invalid, 'payload', { value: payload });
        await handlePortalWorkspaceItemsReadNote(invalid, context);
        expect(fail).toHaveBeenCalledWith(
          invalid,
          'invalid_payload',
          expect.any(String),
        );
        expect(readNoteForProject).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      },
    );
    it('fits the SERIALIZED result, not just the raw body bytes', async (): Promise<void> => {
      // A body at the per-body byte cap can still blow the result cap: JSON
      // escaping expands control characters up to 6 bytes each. Capping raw
      // UTF-8 bytes alone is therefore not enough.
      const content = '\u0001'.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES);
      jest
        .mocked(readNoteForProject)
        .mockResolvedValue({ meta: desktopItem, content });
      await handlePortalWorkspaceItemsReadNote(command, context);
      const result = complete.mock.calls[0]?.[1];
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      if (!isRecord(result)) throw new Error('Expected a result');
      expect(result.truncated).toBe(true);
    });

    it('keeps the error code but never echoes the local path', async (): Promise<void> => {
      // These commands resolve a browser-supplied id onto a local path, so a
      // raw Node filesystem message would put the user's absolute paths on
      // the wire.
      jest
        .mocked(readNoteForProject)
        .mockRejectedValue(
          legacyFilesystemServiceError(
            'ENOENT',
            "ENOENT: no such file or directory, open '/Users/someone/.canopy/workspaces/ws/notes/x.md'",
          ),
        );
      await handlePortalWorkspaceItemsReadNote(command, context);
      expect(fail).toHaveBeenCalledWith(
        command,
        'ENOENT',
        expect.not.stringContaining('/Users/someone'),
        false,
      );
      expect(fail).toHaveBeenCalledWith(
        command,
        'ENOENT',
        expect.not.stringContaining('.canopy'),
        false,
      );
      expect(complete).not.toHaveBeenCalled();
    });
  });

  describe('list_prompts', (): void => {
    const command = {
      id: 'cmd-1',
      sequence: 1,
      type: 'portal.workspace_items.list_prompts',
      payload: { projectId: 'project-1' },
      createdAt: '2026-09-08',
      expiresAt: null,
    } satisfies PortalCommandEnvelope;
    it('completes with the mapped result without absolutePath anywhere', async (): Promise<void> => {
      jest.mocked(listPromptsForProject).mockResolvedValue([desktopItem]);
      await handlePortalWorkspaceItemsListPrompts(command, context);
      expect(listPromptsForProject).toHaveBeenCalledWith('project-1');
      expect(complete).toHaveBeenCalledWith(command, {
        ok: true,
        prompts: [wireItem],
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expectNoAbsolutePath(complete.mock.calls[0]?.[1]);
      expect(fail).not.toHaveBeenCalled();
    });
    it('keeps the longest fitting deterministic prefix', async (): Promise<void> => {
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        ...wireItem,
        title: `${index}-${'界'.repeat(400)}`,
      }));
      jest
        .mocked(listPromptsForProject)
        .mockResolvedValue(rows.map((row) => ({ ...desktopItem, ...row })));
      await handlePortalWorkspaceItemsListPrompts(command, context);
      const result = complete.mock.calls[0]?.[1];
      if (!isRecord(result) || !Array.isArray(result.prompts)) {
        throw new Error('Expected a list result');
      }
      const count = result.prompts.length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(rows.length);
      expect(result).toEqual({
        ok: true,
        prompts: rows.slice(0, count),
        truncated: true,
      });
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            ok: true,
            prompts: rows.slice(0, count + 1),
            truncated: true,
          }),
          'utf8',
        ),
      ).toBeGreaterThan(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expectNoAbsolutePath(result);
      expect(fail).not.toHaveBeenCalled();
    });
    it.each([null, [], 'invalid'])(
      'rejects invalid payload %p',
      async (payload): Promise<void> => {
        const invalid = Object.assign({}, command);
        Object.defineProperty(invalid, 'payload', { value: payload });
        await handlePortalWorkspaceItemsListPrompts(invalid, context);
        expect(fail).toHaveBeenCalledWith(
          invalid,
          'invalid_payload',
          expect.any(String),
        );
        expect(listPromptsForProject).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      },
    );
    it('keeps the error code but never echoes the local path', async (): Promise<void> => {
      jest
        .mocked(listPromptsForProject)
        .mockRejectedValue(
          legacyFilesystemServiceError(
            'EACCES',
            "EACCES: permission denied, scandir '/Users/someone/.canopy/workspaces/ws/notes'",
          ),
        );
      await handlePortalWorkspaceItemsListPrompts(command, context);
      expect(fail).toHaveBeenCalledWith(
        command,
        'EACCES',
        expect.not.stringContaining('/Users/someone'),
        false,
      );
      expect(fail).toHaveBeenCalledWith(
        command,
        'EACCES',
        expect.not.stringContaining('.canopy'),
        false,
      );
      expect(complete).not.toHaveBeenCalled();
    });
  });

  describe('read_prompt', (): void => {
    const command = {
      id: 'cmd-1',
      sequence: 1,
      type: 'portal.workspace_items.read_prompt',
      payload: { projectId: 'project-1', promptId: 'item-1' },
      createdAt: '2026-09-08',
      expiresAt: null,
    } satisfies PortalCommandEnvelope;
    it('completes with the mapped result without absolutePath anywhere', async (): Promise<void> => {
      jest
        .mocked(readPromptForProject)
        .mockResolvedValue({ meta: desktopItem, content: 'Body' });
      await handlePortalWorkspaceItemsReadPrompt(command, context);
      expect(readPromptForProject).toHaveBeenCalledWith('project-1', 'item-1');
      expect(complete).toHaveBeenCalledWith(command, {
        ok: true,
        meta: wireItem,
        content: 'Body',
        truncated: false,
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expectNoAbsolutePath(complete.mock.calls[0]?.[1]);
      expect(fail).not.toHaveBeenCalled();
    });
    it.each(['x', '😀', '界'])(
      'caps oversized %s bodies on a UTF-8 code-point boundary',
      async (character): Promise<void> => {
        const content =
          'a' + character.repeat(PORTAL_CATALOG_CONTENT_MAX_BYTES);
        jest
          .mocked(readPromptForProject)
          .mockResolvedValue({ meta: desktopItem, content });
        await handlePortalWorkspaceItemsReadPrompt(command, context);
        const result = complete.mock.calls[0]?.[1];
        if (!isRecord(result) || typeof result.content !== 'string') {
          throw new Error('Expected a content result');
        }
        expect(result.truncated).toBe(true);
        expect(result.content).toBe(
          'a' +
            character.repeat(
              Math.floor(
                (PORTAL_CATALOG_CONTENT_MAX_BYTES - 1) /
                  Buffer.byteLength(character, 'utf8'),
              ),
            ),
        );
        expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(
          PORTAL_CATALOG_CONTENT_MAX_BYTES,
        );
        expect(Buffer.from(result.content, 'utf8').toString('utf8')).toBe(
          result.content,
        );
        expect(result.content).not.toContain('\uFFFD');
        expectNoAbsolutePath(result);
        expect(fail).not.toHaveBeenCalled();
      },
    );
    it.each([null, [], 'invalid'])(
      'rejects invalid payload %p',
      async (payload): Promise<void> => {
        const invalid = Object.assign({}, command);
        Object.defineProperty(invalid, 'payload', { value: payload });
        await handlePortalWorkspaceItemsReadPrompt(invalid, context);
        expect(fail).toHaveBeenCalledWith(
          invalid,
          'invalid_payload',
          expect.any(String),
        );
        expect(readPromptForProject).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      },
    );
    it('keeps the error code but never echoes the local path', async (): Promise<void> => {
      // These commands resolve a browser-supplied id onto a local path, so a
      // raw Node filesystem message would put the user's absolute paths on
      // the wire.
      jest
        .mocked(readPromptForProject)
        .mockRejectedValue(
          legacyFilesystemServiceError(
            'ENOENT',
            "ENOENT: no such file or directory, open '/Users/someone/.canopy/workspaces/ws/notes/x.md'",
          ),
        );
      await handlePortalWorkspaceItemsReadPrompt(command, context);
      expect(fail).toHaveBeenCalledWith(
        command,
        'ENOENT',
        expect.not.stringContaining('/Users/someone'),
        false,
      );
      expect(fail).toHaveBeenCalledWith(
        command,
        'ENOENT',
        expect.not.stringContaining('.canopy'),
        false,
      );
      expect(complete).not.toHaveBeenCalled();
    });
  });

  describe('list_attachments', (): void => {
    const command = {
      id: 'cmd-1',
      sequence: 1,
      type: 'portal.workspace_items.list_attachments',
      payload: { projectId: 'project-1', worktreeId: 'wt-1' },
      createdAt: '2026-09-08',
      expiresAt: null,
    } satisfies PortalCommandEnvelope;
    it('completes with the mapped result without absolutePath anywhere', async (): Promise<void> => {
      jest
        .mocked(listPortalWorkspaceAttachments)
        .mockResolvedValue([desktopAttachment]);
      await handlePortalWorkspaceItemsListAttachments(command, context);
      expect(listPortalWorkspaceAttachments).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
      );
      expect(complete).toHaveBeenCalledWith(command, {
        ok: true,
        attachments: [wireAttachment],
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expectNoAbsolutePath(complete.mock.calls[0]?.[1]);
      expect(fail).not.toHaveBeenCalled();
    });
    it('keeps the longest fitting deterministic prefix', async (): Promise<void> => {
      const rows = Array.from({ length: 1000 }, (_, index) => ({
        ...wireAttachment,
        filename: `${index}-${'界'.repeat(400)}`,
      }));
      jest
        .mocked(listPortalWorkspaceAttachments)
        .mockResolvedValue(
          rows.map((row) => ({ ...desktopAttachment, ...row })),
        );
      await handlePortalWorkspaceItemsListAttachments(command, context);
      const result = complete.mock.calls[0]?.[1];
      if (!isRecord(result) || !Array.isArray(result.attachments)) {
        throw new Error('Expected a list result');
      }
      const count = result.attachments.length;
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(rows.length);
      expect(result).toEqual({
        ok: true,
        attachments: rows.slice(0, count),
        truncated: true,
      });
      expect(
        Buffer.byteLength(JSON.stringify(result), 'utf8'),
      ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            ok: true,
            attachments: rows.slice(0, count + 1),
            truncated: true,
          }),
          'utf8',
        ),
      ).toBeGreaterThan(PORTAL_CATALOG_RESULT_MAX_BYTES);
      expectNoAbsolutePath(result);
      expect(fail).not.toHaveBeenCalled();
    });
    it.each([null, [], 'invalid'])(
      'rejects invalid payload %p',
      async (payload): Promise<void> => {
        const invalid = Object.assign({}, command);
        Object.defineProperty(invalid, 'payload', { value: payload });
        await handlePortalWorkspaceItemsListAttachments(invalid, context);
        expect(fail).toHaveBeenCalledWith(
          invalid,
          'invalid_payload',
          expect.any(String),
        );
        expect(listPortalWorkspaceAttachments).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
      },
    );
    it('keeps the error code but never echoes the local path', async (): Promise<void> => {
      jest
        .mocked(listPortalWorkspaceAttachments)
        .mockRejectedValue(
          legacyFilesystemServiceError(
            'EACCES',
            "EACCES: permission denied, scandir '/Users/someone/.canopy/workspaces/ws/notes'",
          ),
        );
      await handlePortalWorkspaceItemsListAttachments(command, context);
      expect(fail).toHaveBeenCalledWith(
        command,
        'EACCES',
        expect.not.stringContaining('/Users/someone'),
        false,
      );
      expect(fail).toHaveBeenCalledWith(
        command,
        'EACCES',
        expect.not.stringContaining('.canopy'),
        false,
      );
      expect(complete).not.toHaveBeenCalled();
    });
  });
});
