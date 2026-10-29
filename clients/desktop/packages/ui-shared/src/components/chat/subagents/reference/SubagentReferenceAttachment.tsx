import type { JSX } from 'react';
import { SubagentReferenceChip } from './SubagentReferenceChip';

export interface SubagentReferenceAttachmentProps {
  readonly title: string;
}

/** Right-aligned attachment row that sits above a message bubble. */
export function SubagentReferenceAttachment({
  title,
}: SubagentReferenceAttachmentProps): JSX.Element {
  return (
    <div className="mb-1 flex justify-end">
      <SubagentReferenceChip title={title} />
    </div>
  );
}
