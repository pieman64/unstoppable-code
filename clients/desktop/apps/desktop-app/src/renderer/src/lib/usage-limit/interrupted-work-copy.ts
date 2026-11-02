import type { UsageLimitedSessionItem } from '@canopy/desktop-shared/types';
import { interruptedWorkReasonSummary as reasonSummary } from '@canopy/ui-shared/lib/interrupted-work-copy';
import { brandText } from '@/lib/brand';

// Desktop supplies its brand and listing DTOs; display policy is host-neutral.
export {
  chatResumeEffectLabel,
  countInterruptedWork,
  formatStoppedAt,
  interruptedWorkNouns,
  lastStepLabel,
  resumeConfirmLabel,
  resumeDialogTitle,
  resumeEffectDisclosure,
  shouldShowEveryChatResumeEffect,
  stepLabelSaysStopped,
  type InterruptedWorkCounts,
  type SelectedInterruptedWork,
} from '@canopy/ui-shared/lib/interrupted-work-copy';

export function interruptedWorkReasonSummary(
  sessions: readonly UsageLimitedSessionItem[],
): string {
  return reasonSummary(sessions, brandText.appName);
}
