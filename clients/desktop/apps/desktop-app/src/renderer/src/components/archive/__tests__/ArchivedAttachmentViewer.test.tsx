/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import type { WorkspaceAttachmentItem } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ArchivedAttachmentViewer } from '../ArchivedAttachmentViewer';
import { rootClassList } from '@/test-utils/replay';

jest.mock('@canopy/ui-app', () => ({
  FileViewer: (): JSX.Element => <div data-testid="mock-file-viewer" />,
}));
jest.mock('@canopy/app-state', () => ({
  fileViewerKey: (): string => 'file-key',
  useFileViewerStore: <T,>(
    selector: (state: { closeFile: () => void }) => T,
  ): T => selector({ closeFile: () => {} }),
}));
jest.mock('@/client/ipc-canopy-client', () => ({
  registerLocalFileRootOverride: (): (() => void) => (): void => {},
}));
jest.mock('@/components/shared', () => ({
  LoadingPlaceholder: (): null => null,
}));

const attachment: WorkspaceAttachmentItem = {
  filename: 'secret-notes.md',
  absolutePath: '/archive/attachments/secret-notes.md',
  sizeBytes: 12,
  createdAt: '2026-10-01T00:00:00.000Z',
};

describe('ArchivedAttachmentViewer', () => {
  it('records the attachment viewer header and leaves content blocks to FileViewer', (): void => {
    const markup = renderToStaticMarkup(
      <ArchivedAttachmentViewer
        workspaceId="workspace-1"
        containerId="container-1"
        attachment={attachment}
        attachments={[attachment]}
        onSelectAttachment={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    // The header (back, file name, reveal) is recorded; FileViewer blocks
    // the file content itself.
    expect(markup).not.toContain(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(rootClassList(markup)).toEqual([
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col',
    ]);
    expect(markup).toContain('data-testid="archived-attachment-viewer"');
  });
});
