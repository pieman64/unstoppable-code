import {
  getModelCatalogProviderLabel,
  type ModelCatalogProvider,
} from './model-catalog';

/** Minimal display inputs; hosts adapt their own listing contracts. */
export interface InterruptedChatDisplay {
  kind: 'chat';
  provider?: ModelCatalogProvider;
  resumeReason?: string;
  resumePromptKind?: 'continue' | 'resend_user_message';
  worktreeId: string;
  worktreeName?: string;
}

export interface InterruptedPipelineDisplay {
  kind: 'pipeline';
  provider?: ModelCatalogProvider;
  resumeReasons?: readonly string[];
}

export type InterruptedWorkDisplay =
  | InterruptedChatDisplay
  | InterruptedPipelineDisplay;

export interface InterruptedChatStepDisplay {
  toolName: string;
  detail?: string;
  /**
   * Evidence-based status of this invocation: `true` only for a recorded
   * success, `false` only for positive evidence it did not finish. Absent
   * when unknown; never inferred from a missing result.
   */
  finished?: boolean;
}

/**
 * Copy for interrupted chats and workflows in Home and the resume dialog.
 * User-facing text says `chat` and `workflow`, never `session`.
 */
export interface InterruptedWorkCounts {
  chats: number;
  pipelines: number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function countInterruptedWork(
  sessions: readonly InterruptedWorkDisplay[],
): InterruptedWorkCounts {
  const chats = sessions.filter((session) => session.kind === 'chat').length;
  return { chats, pipelines: sessions.length - chats };
}

/** `1 chat`, `3 chats`, `2 workflows`, `1 chat and 2 workflows`. */
export function interruptedWorkNouns(
  counts: InterruptedWorkCounts,
  adjective = '',
): string {
  const prefix = adjective ? `${adjective} ` : '';
  if (counts.pipelines === 0) return plural(counts.chats, `${prefix}chat`);
  if (counts.chats === 0) return plural(counts.pipelines, `${prefix}workflow`);
  return `${plural(counts.chats, `${prefix}chat`)} and ${plural(counts.pipelines, 'workflow')}`;
}

/** `null` while nothing has loaded. */
export function resumeDialogTitle(
  counts: InterruptedWorkCounts | null,
): string {
  if (counts === null || counts.chats + counts.pipelines === 0) {
    return 'Resume interrupted work';
  }
  if (counts.pipelines === 0) {
    return counts.chats === 1
      ? 'Resume interrupted chat'
      : 'Resume interrupted chats';
  }
  if (counts.chats === 0) {
    return counts.pipelines === 1
      ? 'Resume interrupted workflow'
      : 'Resume interrupted workflows';
  }
  return 'Resume interrupted chats and workflows';
}

/** `Resume chat`, `Resume 3 chats`, `Resume 1 chat and 2 workflows`. */
export function resumeConfirmLabel(selected: InterruptedWorkCounts): string {
  const total = selected.chats + selected.pipelines;
  if (total === 0) return 'Resume';
  if (selected.pipelines === 0 && selected.chats === 1) return 'Resume chat';
  if (selected.chats === 0 && selected.pipelines === 1) {
    return 'Resume workflow';
  }
  return `Resume ${interruptedWorkNouns(selected)}`;
}

type StopCause = 'app_shutdown' | 'usage_limit' | 'sign_in';

const STOP_CAUSE: Readonly<Record<string, StopCause | undefined>> = {
  app_shutdown: 'app_shutdown',
  usage_limit: 'usage_limit',
  authentication: 'sign_in',
  provider_sign_in: 'sign_in',
};

/**
 * Normalized causes, or `null` when a pipeline lacks reason metadata. Chats
 * without a reason are legacy usage-limit entries.
 */
function stopCauses(session: InterruptedWorkDisplay): StopCause[] | null {
  const reasons =
    session.kind === 'chat'
      ? [session.resumeReason ?? 'usage_limit']
      : (session.resumeReasons ?? []);
  if (reasons.length === 0) return null;
  const causes: StopCause[] = [];
  for (const reason of reasons) {
    const cause = Object.prototype.hasOwnProperty.call(STOP_CAUSE, reason)
      ? STOP_CAUSE[reason]
      : undefined;
    if (!cause) return null;
    causes.push(cause);
  }
  return causes;
}

function stoppedSubject(counts: InterruptedWorkCounts): string {
  if (counts.pipelines === 0) {
    return counts.chats === 1 ? 'this chat' : 'these chats';
  }
  if (counts.chats === 0) {
    return counts.pipelines === 1 ? 'this workflow' : 'these workflows';
  }
  return 'this work';
}

/**
 * Why the listed work stopped, when one cause explains all of it. Several
 * causes, or a pipeline without reasons, defer to the per-row labels.
 */
export function interruptedWorkReasonSummary(
  sessions: readonly InterruptedWorkDisplay[],
  appDisplayName: string,
): string {
  const causes = new Set<StopCause>();
  for (const session of sessions) {
    const sessionCauses = stopCauses(session);
    if (sessionCauses === null) return 'Review why this work stopped below.';
    sessionCauses.forEach((cause) => causes.add(cause));
  }
  const [cause] = Array.from(causes);
  if (causes.size !== 1 || cause === undefined) {
    return 'Review why this work stopped below.';
  }
  const subject = stoppedSubject(countInterruptedWork(sessions));
  if (cause === 'app_shutdown') {
    return `${appDisplayName} closed before ${subject} finished.`;
  }
  if (cause === 'sign_in') return `A sign-in problem stopped ${subject}.`;
  const providers = new Set(sessions.map((session) => session.provider));
  const [provider] = Array.from(providers);
  return providers.size === 1 && provider && provider !== 'unknown'
    ? `A ${getModelCatalogProviderLabel(provider)} usage limit stopped ${subject}.`
    : `A usage limit stopped ${subject}.`;
}

export interface SelectedInterruptedWork {
  session: InterruptedWorkDisplay;
  /** The listing group's workspace kind; cowork chats have no worktree. */
  workspaceType?: 'single-repo' | 'multi-repo' | 'cowork';
}

function hasKnownWorktree({
  session,
  workspaceType,
}: SelectedInterruptedWork): boolean {
  return (
    session.kind === 'chat' &&
    workspaceType !== undefined &&
    workspaceType !== 'cowork' &&
    session.worktreeId !== '' &&
    Boolean(session.worktreeName?.trim())
  );
}

/**
 * What confirming does for the current selection. Previews the listing; the
 * resume itself re-evaluates the prompt policy at dispatch. `null` when
 * nothing is selected, so no action is promised.
 */
export function resumeEffectDisclosure(
  selected: readonly SelectedInterruptedWork[],
): string | null {
  const chats = selected.filter((entry) => entry.session.kind === 'chat');
  const pipelines = selected.length - chats.length;
  const parts: string[] = [];
  if (chats.length > 0) {
    const one = chats.length === 1;
    const where = one ? 'in this chat' : 'in each selected chat';
    const kinds = new Set(
      chats.map(({ session }) =>
        session.kind === 'chat' ? session.resumePromptKind : undefined,
      ),
    );
    if (kinds.has(undefined)) {
      parts.push(`Resuming asks the agent to continue ${where}.`);
    } else if (kinds.size > 1) {
      parts.push(
        'Resuming sends "Continue" or re-sends your last message, as shown for each selected chat.',
      );
    } else if (kinds.has('continue')) {
      parts.push(
        one
          ? `Resuming sends "Continue" ${where}, so the agent picks up where it stopped without sending your original request again.`
          : `Resuming sends "Continue" ${where}, so each agent picks up where it stopped without sending your original requests again.`,
      );
    } else {
      parts.push(`Resuming re-sends your last message ${where}.`);
    }
    if (chats.every(hasKnownWorktree)) {
      parts.push(
        one
          ? 'The agent continues in the same worktree.'
          : "Each agent continues in its chat's worktree.",
      );
    }
  }
  if (pipelines > 0) {
    parts.push(
      pipelines === 1
        ? 'Resuming continues the selected workflow.'
        : 'Resuming continues the selected workflows.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Whether rows spell out each chat's resume message: always for a resend,
 * and for every chat once the listed chats do not share one known message.
 */
export function shouldShowEveryChatResumeEffect(
  sessions: readonly InterruptedWorkDisplay[],
): boolean {
  const kinds = new Set(
    sessions.flatMap((session) =>
      session.kind === 'chat' ? [session.resumePromptKind] : [],
    ),
  );
  return kinds.size > 1 || kinds.has(undefined);
}

export function chatResumeEffectLabel(
  chat: Pick<InterruptedChatDisplay, 'resumePromptKind'>,
  showEvery: boolean,
): string | null {
  if (chat.resumePromptKind === 'resend_user_message') {
    return 'Re-sends your last message';
  }
  if (!showEvery) return null;
  return chat.resumePromptKind === 'continue'
    ? 'Sends "Continue"'
    : 'Resume message unavailable';
}

function startOfLocalDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/**
 * `Stopped today 6:33 PM`, `Stopped yesterday …`, `Stopped Mon …`, or a date,
 * with the year outside the current one. Calendar days are local, so
 * daylight-saving changes never shift them. Missing, invalid, or future
 * times return `null` rather than a misleading label. `withVerb: false`
 * drops the leading `Stopped` when a `Stopped during …` step precedes it.
 */
export function formatStoppedAt(
  detectedAt: number | undefined,
  now: Date,
  { withVerb = true }: { withVerb?: boolean } = {},
): string | null {
  if (
    detectedAt === undefined ||
    !Number.isFinite(detectedAt) ||
    detectedAt <= 0
  ) {
    return null;
  }
  const when = new Date(detectedAt);
  if (!Number.isFinite(when.getTime()) || detectedAt > now.getTime()) {
    return null;
  }
  const stopped = (label: string): string =>
    withVerb ? `Stopped ${label}` : label;
  const time = when.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const day = startOfLocalDay(when);
  const today = startOfLocalDay(now);
  if (day === today) return stopped(`today ${time}`);
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  ).getTime();
  if (day === yesterday) return stopped(`yesterday ${time}`);
  const weekAgo = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 6,
  ).getTime();
  if (day >= weekAgo) {
    return stopped(
      `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`,
    );
  }
  const date = when.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return stopped(`${date}, ${time}`);
}

/**
 * `Last step: Edit src/api/client.ts`, with ` (finished)` after a recorded
 * success, or `Stopped during Edit … (not finished)` only with positive
 * evidence it did not finish. Unknown status stays neutral.
 */
export function lastStepLabel(
  step: InterruptedChatStepDisplay | undefined,
): string | null {
  if (!step || !step.toolName.trim()) return null;
  const subject = step.detail
    ? `${step.toolName} ${step.detail}`
    : step.toolName;
  if (step.finished === false) {
    return `Stopped during ${subject} (not finished)`;
  }
  if (step.finished === true) return `Last step: ${subject} (finished)`;
  return `Last step: ${subject}`;
}

/** Whether a rendered step label already says the work stopped. */
export function stepLabelSaysStopped(label: string | null): boolean {
  return label?.startsWith('Stopped during ') === true;
}
