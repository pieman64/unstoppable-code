/** @jest-environment node */
import {
  DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
  FileSaveOperationalError,
} from '@canopy/protocol/file-image-save';
import type {
  SaveFileContentRequest,
  SaveFileContentResponse,
} from '@canopy/desktop-shared/types';
import { desktopDiagramSaveDestination } from '../diagramSaveDestination';

function saveMock(): jest.Mock<
  Promise<SaveFileContentResponse>,
  [SaveFileContentRequest]
> {
  return jest.fn<Promise<SaveFileContentResponse>, [SaveFileContentRequest]>();
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
]);

function target(
  overrides: Partial<Parameters<typeof desktopDiagramSaveDestination>[0]> = {},
): Parameters<typeof desktopDiagramSaveDestination>[0] {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    filePath: '/repo/docs/plan.md',
    support: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
    readOnly: false,
    saveFileContent: jest.fn(),
    openFile: jest.fn(),
    ...overrides,
  };
}

describe('desktop diagram save destination', () => {
  it('creates PNG bytes beside the document and opens the saved name', async () => {
    const saveFileContent = saveMock().mockResolvedValue({
      filename: 'plan-flow.png',
      sizeBytes: PNG_BYTES.length,
      modifiedAtMs: 1,
    });
    const openFile = jest.fn();
    const destination = desktopDiagramSaveDestination(
      target({ saveFileContent, openFile }),
    );
    if (destination.kind !== 'sibling') throw new Error('expected sibling');
    expect(destination.documentName).toBe('plan.md');
    const result = await destination.save({
      filename: 'plan-flow.png',
      format: 'png',
      body: new Blob([PNG_BYTES], { type: 'image/png' }),
    });
    expect(saveFileContent).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      absolutePath: '/repo/docs/plan-flow.png',
      content: Buffer.from(PNG_BYTES).toString('base64'),
      encoding: 'base64',
      createOnly: true,
    });
    expect(saveFileContent.mock.calls[0]?.[0]).not.toHaveProperty(
      'expectedModifiedAtMs',
    );
    if (result.status !== 'saved') throw new Error('expected saved');
    result.open();
    expect(openFile).toHaveBeenCalledWith({
      absolutePath: '/repo/docs/plan-flow.png',
      filename: 'plan-flow.png',
    });
  });

  it('writes SVG as UTF-8 beside a Windows document', async () => {
    const saveFileContent = saveMock().mockResolvedValue({
      filename: 'plan-é.svg',
      sizeBytes: 10,
      modifiedAtMs: 1,
    });
    const destination = desktopDiagramSaveDestination(
      target({ filePath: 'C:\\repo\\plan.md', saveFileContent }),
    );
    if (destination.kind !== 'sibling') throw new Error('expected sibling');
    await destination.save({
      filename: 'plan-é.svg',
      format: 'svg',
      body: new Blob(['<svg>é</svg>'], { type: 'image/svg+xml' }),
    });
    expect(saveFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: 'C:\\repo\\plan-é.svg',
        content: '<svg>é</svg>',
        encoding: 'utf8',
        createOnly: true,
      }),
    );
  });

  it('retries only the channel’s named conflict', async () => {
    const conflict = new Error(
      "Error invoking remote method 'file:save-content': FileNameConflictError: A file with this name already exists.",
    );
    const saveFileContent = jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(
        Object.assign(new Error('exists'), { code: 'EEXIST' }),
      )
      .mockRejectedValueOnce(new FileSaveOperationalError('disk full'));
    const destination = desktopDiagramSaveDestination(
      target({ saveFileContent }),
    );
    if (destination.kind !== 'sibling') throw new Error('expected sibling');
    const request = {
      filename: 'plan.svg',
      format: 'svg' as const,
      body: new Blob(['<svg/>']),
    };
    await expect(destination.save(request)).resolves.toEqual({
      status: 'conflict',
    });
    // An arbitrary error shape is not a conflict.
    await expect(destination.save(request)).rejects.toThrow('exists');
    await expect(destination.save(request)).rejects.toBeInstanceOf(
      FileSaveOperationalError,
    );
  });

  it('downloads when the scope or host cannot create the format', () => {
    expect(
      desktopDiagramSaveDestination(target({ support: undefined })),
    ).toMatchObject({ kind: 'download', documentName: 'plan.md' });
    expect(
      desktopDiagramSaveDestination(target({ readOnly: true })),
    ).toMatchObject({
      kind: 'download',
      documentName: 'plan.md',
    });
    const pngOnly = desktopDiagramSaveDestination(
      target({
        support: {
          ...DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
          formats: { png: DESKTOP_FILE_IMAGE_SAVE_SUPPORT.formats.png },
        },
      }),
    );
    expect(pngOnly.kind === 'sibling' && pngOnly.formats).toEqual({
      png: true,
      svg: false,
    });
  });

  it('keeps sibling saving available for a document at a filesystem root', () => {
    const destination = desktopDiagramSaveDestination(
      target({ filePath: '/plan.md' }),
    );
    expect(destination.kind).toBe('sibling');
    expect(destination.documentName).toBe('plan.md');
  });

  it('distinguishes documents with the same basename in different directories', () => {
    const first = desktopDiagramSaveDestination(
      target({ filePath: '/repo/one/plan.md' }),
    );
    const second = desktopDiagramSaveDestination(
      target({ filePath: '/repo/two/plan.md' }),
    );
    expect(first.documentId).toBeDefined();
    expect(second.documentId).toBeDefined();
    expect(first.documentId).not.toBe(second.documentId);
  });

  it('rejects a picture over the advertised limit before writing', async () => {
    const saveFileContent = jest.fn();
    const destination = desktopDiagramSaveDestination(
      target({
        saveFileContent,
        support: { ...DESKTOP_FILE_IMAGE_SAVE_SUPPORT, maxDecodedBytes: 4 },
      }),
    );
    if (destination.kind !== 'sibling') throw new Error('expected sibling');
    await expect(
      destination.save({
        filename: 'plan.png',
        format: 'png',
        body: new Blob([PNG_BYTES]),
      }),
    ).rejects.toThrow('larger than the save limit');
    expect(saveFileContent).not.toHaveBeenCalled();
  });
});
