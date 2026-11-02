import { DOCUMENT_PREVIEW_MAX_BYTES } from '@canopy/protocol/document-preview';
import type { FileDocumentBytesResponse } from '@canopy/desktop-shared/types';
import type { FileDocumentBytesResult } from '@canopy/ui-app';

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('Document preview was aborted.', 'AbortError');
}

export async function resolveDesktopDocumentBytes(
  read: () => Promise<FileDocumentBytesResponse>,
  signal: AbortSignal,
  maxBytes: number = DOCUMENT_PREVIEW_MAX_BYTES,
): Promise<FileDocumentBytesResult> {
  assertNotAborted(signal);
  try {
    const result = await read();
    assertNotAborted(signal);
    if (result.status === 'too-large')
      return { status: 'too-large', maxBytes: result.maxBytes };
    if (result.status === 'missing') return { status: 'failed' };
    if (result.bytes.byteLength > maxBytes) {
      return { status: 'too-large', maxBytes };
    }
    // Copy the view, not its possibly larger backing store. IPC itself is
    // structured-cloned and cannot be cancelled by this renderer signal.
    return { status: 'ready', bytes: new Uint8Array(result.bytes).buffer };
  } catch {
    assertNotAborted(signal);
    return { status: 'failed' };
  }
}
