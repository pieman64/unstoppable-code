import type { JSX } from 'react';
import type { McpRowHealthModel } from '../lib/mcp-row-health';
import { Dot } from './Badge';
import { Tooltip } from './Tooltip';
import type { DotTone } from '../lib/badge';

const DOT_TONE: Readonly<Record<McpRowHealthModel['tone'], DotTone>> = {
  positive: 'success',
  attention: 'attention',
  destructive: 'danger',
  neutral: 'filter',
};

const TONE_CLASS: Readonly<Record<McpRowHealthModel['tone'], string>> = {
  positive: 'fg-success',
  attention: 'fg-warning',
  destructive: 'fg-destructive',
  neutral: 'fg-secondary',
};

export interface McpRowHealthProps {
  readonly model: McpRowHealthModel;
  readonly testId: string;
  /** The check time, already formatted for this host. */
  readonly checkedLabel?: string;
}

/** Non-interactive health for the row's subtitle; the check time is its tooltip. */
export function McpRowHealth({
  model,
  testId,
  checkedLabel,
}: McpRowHealthProps): JSX.Element {
  return (
    <Tooltip
      label={checkedLabel}
      disabled={checkedLabel === undefined}
      allowShrink
    >
      <span
        role="status"
        data-testid={testId}
        className={`inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs ${TONE_CLASS[model.tone]}`}
      >
        <Dot tone={DOT_TONE[model.tone]} data-testid={`${testId}-dot`} />
        <span className="truncate">{model.text}</span>
      </span>
    </Tooltip>
  );
}
