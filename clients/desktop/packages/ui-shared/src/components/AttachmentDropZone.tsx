import type { JSX } from 'react';
import { DownloadIcon } from '../icons/AppIcons';
import { Stack } from './Stack';
import { Surface } from './Surface';

export interface AttachmentDropZoneProps {
  readonly active?: boolean;
  readonly emptyMessage?: string;
  readonly testId: string;
}

function AttachmentDropZoneContent({
  active = false,
  emptyMessage = 'Drop files here or click + to add attachments',
}: Omit<AttachmentDropZoneProps, 'testId'>): JSX.Element {
  return active ? (
    <Stack gap="inline" align="center">
      <DownloadIcon size="xl" />
      <p className="text-xs font-medium">Drop files to attach</p>
    </Stack>
  ) : (
    <p className="text-xs fg-secondary/60">{emptyMessage}</p>
  );
}

/** Attachment presentation shared by local and hosted upload adapters. */
export function AttachmentDropZone({
  active = false,
  emptyMessage,
  testId,
}: AttachmentDropZoneProps): JSX.Element {
  return (
    <div className="flex h-full min-h-28">
      <Surface
        variant="dashed"
        size="small"
        selected={active}
        className="flex flex-1 items-center justify-center text-center"
        data-testid={testId}
      >
        <div className={active ? 'py-8 fg-accent' : 'py-8'}>
          <AttachmentDropZoneContent
            active={active}
            emptyMessage={emptyMessage}
          />
        </div>
      </Surface>
    </div>
  );
}
