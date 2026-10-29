import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

interface InlinePipelineYamlPreviewProps {
  rawPipeline: string;
  testId: string;
  maxHeightClassName?: 'max-h-56' | 'max-h-80';
}

/** Shared read-only YAML treatment for automation install and review flows. */
export function InlinePipelineYamlPreview({
  rawPipeline,
  testId,
  maxHeightClassName = 'max-h-56',
}: InlinePipelineYamlPreviewProps): JSX.Element {
  return (
    <pre
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} ${maxHeightClassName} overflow-auto rounded-md bg-fg-primary/[0.03] px-3 py-2 text-xs fg-primary`}
      data-testid={testId}
    >
      {rawPipeline}
    </pre>
  );
}
