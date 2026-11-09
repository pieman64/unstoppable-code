'use client';

import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';

/**
 * What a pipeline's Definition says when `count` workflows use it
 * (CAN-5782): nothing for one, the reach of an edit for two or more.
 */
export function sharedPipelineNoticeText(count: number): string | undefined {
  return count >= 2
    ? `Changes apply to every workflow that uses this pipeline (${String(count)}).`
    : undefined;
}

export interface SharedPipelineNoticeProps {
  /** How many workflows use the pipeline; the host counts them. */
  readonly count: number;
  /** The host's placement among the editor's other notices. */
  readonly className?: string;
}

/**
 * Says that an edit to a pipeline's steps reaches every workflow that uses
 * it, before the edit (CAN-5782). Renders nothing for a pipeline one
 * workflow uses.
 */
export function SharedPipelineNotice({
  count,
  className,
}: SharedPipelineNoticeProps): JSX.Element | null {
  const text = sharedPipelineNoticeText(count);
  if (text === undefined) return null;
  return (
    <Notice
      intent="neutral"
      title="Shared pipeline."
      {...(className !== undefined ? { className } : {})}
      data-testid="pipeline-editor-shared-notice"
    >
      {text}
    </Notice>
  );
}
