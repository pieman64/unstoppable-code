import {
  FileNameConflictError,
  restoreFileImageSaveError,
  supportsFileImageSave,
  type FileImageSaveSupport,
} from '@canopy/protocol/file-image-save';
import type {
  SaveFileContentRequest,
  SaveFileContentResponse,
} from '@canopy/desktop-shared/types';
import type {
  MermaidSaveDestination,
  MermaidSiblingSaveResult,
} from '@canopy/ui-shared/components';

export interface DesktopDiagramSaveTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  /** Absolute path of the previewed Markdown document. */
  readonly filePath: string;
  /** Advertised by `getFileTreeRoots`; absent means image saves are unavailable. */
  readonly support: FileImageSaveSupport | undefined;
  /** Read-only scopes never write beside the document. */
  readonly readOnly: boolean;
  readonly saveFileContent: (
    request: SaveFileContentRequest,
  ) => Promise<SaveFileContentResponse>;
  /** Opens a saved file with the preview host's own file opener. */
  readonly openFile: (file: { absolutePath: string; filename: string }) => void;
}

function documentDirectory(filePath: string): string | null {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut >= 0 ? filePath.slice(0, cut + 1) : null;
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(
      ...Array.from(bytes.subarray(index, index + 0x8000)),
    );
  }
  return btoa(binary);
}

/**
 * Where a Markdown preview's diagram pictures go. A writable document whose
 * host advertises create-only image saves gets them beside it, per format;
 * otherwise the picture downloads under the document's name.
 */
export function desktopDiagramSaveDestination({
  projectId,
  worktreeId,
  filePath,
  support,
  readOnly,
  saveFileContent,
  openFile,
}: DesktopDiagramSaveTarget): MermaidSaveDestination {
  const directory = documentDirectory(filePath);
  const documentId = JSON.stringify([projectId, worktreeId, filePath]);
  const documentName = filePath.slice(directory?.length ?? 0);
  const formats = {
    png: !readOnly && supportsFileImageSave(support, 'png'),
    svg: !readOnly && supportsFileImageSave(support, 'svg'),
  };
  if (directory === null || (!formats.png && !formats.svg)) {
    return { kind: 'download', documentId, documentName };
  }
  const maxBytes = support?.maxDecodedBytes ?? 0;
  return {
    kind: 'sibling',
    documentId,
    documentName,
    formats,
    async save({ filename, format, body }): Promise<MermaidSiblingSaveResult> {
      if (body.size > maxBytes) {
        throw new Error('This picture is larger than the save limit.');
      }
      const absolutePath = `${directory}${filename}`;
      const content = format === 'png' ? await base64(body) : await body.text();
      try {
        const saved = await saveFileContent({
          projectId,
          worktreeId,
          absolutePath,
          content,
          encoding: format === 'png' ? 'base64' : 'utf8',
          createOnly: true,
        });
        const savedPath = `${directory}${saved.filename}`;
        return {
          status: 'saved',
          filename: saved.filename,
          open: () =>
            openFile({ absolutePath: savedPath, filename: saved.filename }),
        };
      } catch (error: unknown) {
        // Only the channel's named conflict lets the caller try another
        // name; every other failure, including an unknown outcome, stays one.
        const restored = restoreFileImageSaveError(error);
        if (restored instanceof FileNameConflictError) {
          return { status: 'conflict' };
        }
        throw restored ?? error;
      }
    },
  };
}
