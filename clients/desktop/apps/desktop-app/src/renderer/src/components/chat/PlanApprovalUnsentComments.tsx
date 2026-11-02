import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { usePlanComments } from '@/components/plan-explore/usePlanComments';
import { usePlanPanelCommentSubmit } from '@/components/plan-explore/usePlanPanelCommentSubmit';
import {
  usePlanViewData,
  useSharedPlanCommentPull,
} from '@/components/plan-explore/usePlanViewData';
import { planViewKey, usePlanViewStore } from '@/stores/planViewStore';
import {
  PlanApprovalPrompt,
  type PlanApprovalUnsentComments,
} from './PlanApprovalPrompt';

/** The waiting plan and the chat waiting on it, all in one worktree. */
export interface PlanApprovalCommentsTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly chatId: string;
}

/**
 * The plan's unsent comments for the approval prompt, or `null` when there
 * are none. Counts and sends exactly as the Plan panel's tray does: the same
 * shared plan view entry, eligibility, and submit (one in flight per plan, from
 * any view, and only the sent snapshot is marked sent). The send goes to
 * `chatId`, the chat waiting on the plan, where it reads as plan feedback.
 */
function usePlanApprovalUnsentComments(
  plan: TrackedPlanData,
  chatId: string,
): PlanApprovalUnsentComments | null {
  useSharedPlanCommentPull(plan);
  const comments = usePlanComments(plan);
  // The composer reviews the latest revision, never an older one on screen.
  const onSend = usePlanPanelCommentSubmit(plan, comments.submit, null, chatId);
  const key = planViewKey(plan.projectId, plan.worktreeId, plan.id);
  const sending = usePlanViewStore(
    (state) => state.entries[key]?.submitting === true,
  );
  const count = comments.stagedCount;
  return useMemo(
    () => (count > 0 ? { count, onSend, sending } : null),
    [count, onSend, sending],
  );
}

type PlanApprovalPromptProps = ComponentProps<typeof PlanApprovalPrompt>;

interface ReportedNotice {
  readonly targetKey: string;
  readonly notice: PlanApprovalUnsentComments | null;
}

type ReportNotice = Dispatch<SetStateAction<ReportedNotice | null>>;

function targetKeyOf(target: PlanApprovalCommentsTarget): string {
  return `${planViewKey(target.projectId, target.worktreeId, target.planId)}/${target.chatId}`;
}

/** Reports a loaded plan's notice up to the prompt; renders nothing. */
function UnsentCommentsReporter({
  plan,
  chatId,
  targetKey,
  onReport,
}: {
  readonly plan: TrackedPlanData;
  readonly chatId: string;
  readonly targetKey: string;
  readonly onReport: ReportNotice;
}): null {
  const notice = usePlanApprovalUnsentComments(plan, chatId);
  useEffect(() => {
    onReport({ targetKey, notice });
  }, [targetKey, notice, onReport]);
  useEffect(
    () => (): void => {
      onReport((current) =>
        current?.targetKey === targetKey ? null : current,
      );
    },
    [targetKey, onReport],
  );
  return null;
}

/** Resolves the plan by its exact identity; reports nothing until it loads. */
function UnsentCommentsSource({
  target,
  targetKey,
  onReport,
}: {
  readonly target: PlanApprovalCommentsTarget;
  readonly targetKey: string;
  readonly onReport: ReportNotice;
}): JSX.Element | null {
  const data = usePlanViewData(target, target.planId);
  return data.status === 'ready' ? (
    <UnsentCommentsReporter
      plan={data.plan}
      chatId={target.chatId}
      targetKey={targetKey}
      onReport={onReport}
    />
  ) : null;
}

/**
 * The plan-approval prompt, warning about the waiting plan's unsent comments
 * when `target` names it. Without a target, or until its plan loads, it is
 * the plain prompt.
 *
 * The prompt stays mounted at one position while the plan loads, changes, or
 * goes away, so the text row's editor is never remounted under the user. The
 * comments are read by a sibling keyed to the target, so switching plans or
 * chats drops the previous plan's state; a notice is shown only for the
 * target that reported it.
 */
export function PlanApprovalPromptWithComments({
  target,
  ...promptProps
}: Omit<PlanApprovalPromptProps, 'unsentComments'> & {
  readonly target: PlanApprovalCommentsTarget | null;
}): JSX.Element {
  const [reported, setReported] = useState<ReportedNotice | null>(null);
  const targetKey = target ? targetKeyOf(target) : null;
  const notice =
    reported !== null && reported.targetKey === targetKey
      ? reported.notice
      : null;
  return (
    <>
      <PlanApprovalPrompt
        {...promptProps}
        {...(notice ? { unsentComments: notice } : {})}
      />
      {target && targetKey && (
        <UnsentCommentsSource
          key={targetKey}
          target={target}
          targetKey={targetKey}
          onReport={setReported}
        />
      )}
    </>
  );
}
