import type { JSX } from 'react';
import { ModelProviderIcon } from '../../../ModelProviderIcon';

export interface SubagentHarnessMarkProps {
  /** The harness that runs the subagent, such as `claude` or `codex`. */
  readonly harnessId: string | undefined;
  /** Glyph size in pixels. Defaults to 12. */
  readonly size?: number;
}

/** The provider glyph beside a model name; nothing when the harness is unknown. */
export function SubagentHarnessMark({
  harnessId,
  size = 12,
}: SubagentHarnessMarkProps): JSX.Element | null {
  if (!harnessId) return null;
  return (
    <span className="inline-flex shrink-0 items-center fg-secondary">
      <ModelProviderIcon provider={harnessId} central size={size} aria-hidden />
    </span>
  );
}
