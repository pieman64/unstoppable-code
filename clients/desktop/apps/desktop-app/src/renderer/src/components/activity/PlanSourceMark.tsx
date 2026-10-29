import type { JSX } from 'react';
import { PlanSourceIcon } from '@/lib/providerUi';
import { PlanSourceMark as SharedPlanSourceMark } from '@canopy/ui-shared/components';

export type PlanSource =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'copilot'
  | 'opencode'
  | 'pipeline'
  | 'imported'
  | 'detected';

export function PlanSourceMark({
  source,
  size,
  className,
}: {
  source: PlanSource;
  size: number;
  className?: string;
}): JSX.Element {
  return (
    <SharedPlanSourceMark
      source={source}
      size={size}
      className={className}
      icon={<PlanSourceIcon source={source} width={size} height={size} />}
    />
  );
}
