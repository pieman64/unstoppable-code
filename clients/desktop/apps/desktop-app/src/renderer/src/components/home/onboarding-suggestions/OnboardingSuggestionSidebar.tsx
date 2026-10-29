import type { JSX } from 'react';
import type { OnboardingChecklistView } from './queue';
import { GettingStartedSidebarTile } from '@canopy/ui-shared/components';

/** The sidebar card's copy for one step: title, one sentence, and action. */
interface SidebarStepCopy {
  /** A complete verb-led label of at most 30 characters. */
  title: string;
  description: string;
  /** The pill's label, sized to its content. */
  action: string;
}

const PLAN_DESCRIPTION = 'Have the agent draft a plan before it starts.';

/** Sidebar-only copy: one complete action label, kept concise where possible. */
function onboardingSuggestionCopy(
  view: OnboardingChecklistView,
): SidebarStepCopy {
  if (view.status === 'deferred') {
    return {
      title: 'Add a project first',
      description: 'This step needs a project to work in.',
      action: 'Add project',
    };
  }
  const { step } = view;
  // Items tailored to the active project template (CAN-3032) name the
  // plugin to add or the template a prompt comes from.
  if (view.blueprint) {
    if (step.kind === 'plugin-add') {
      return {
        title: `Add ${step.displayName}`,
        description: `Recommended for ${view.blueprint.name}.`,
        action: 'Add',
      };
    }
    if (step.kind === 'prompt') {
      return {
        title: `Try a ${view.blueprint.name} prompt`,
        description: 'Start a task from your project template.',
        action: 'Try it',
      };
    }
  }
  switch (step.kind) {
    case 'enable-daily-credits':
      return {
        title: 'Claim free AI Credits',
        description: `Get ${step.capCredits} free AI Credits every day.`,
        action: 'Turn on',
      };
    case 'import-projects-cta':
      return {
        title: 'Import projects',
        description: 'Bring your chats and projects from Claude and Codex.',
        action: 'Import',
      };
    case 'import-editor-setup-cta':
      return {
        title: 'Use your Cursor rules',
        description: "Bring a project's Cursor rules into new chats.",
        action: 'Review',
      };
    case 'get-mobile-app':
      return {
        title: 'Get the mobile app',
        description: 'Follow and steer your tasks from your phone.',
        action: 'Get app',
      };
    case 'add-repo-cta':
      return {
        title: 'Add a project',
        description: 'Choose a folder or repository to work in.',
        action: 'Add project',
      };
    case 'prompt':
      return view.entryId === 'plan-mode'
        ? {
            title: 'Plan your first project',
            description: PLAN_DESCRIPTION,
            action: 'Start',
          }
        : {
            title: 'Try your next task',
            description: 'Run a suggested task in your project.',
            action: 'Start',
          };
    case 'connect-github':
      return {
        title: 'Connect GitHub',
        description: 'Let agents read issues and open pull requests.',
        action: 'Connect',
      };
    case 'github-try':
      return {
        title: 'Try the GitHub plugin',
        description: 'Run a task that uses your GitHub account.',
        action: 'Try it',
      };
    case 'connect-tools':
      return {
        title: 'Connect your tools',
        description: 'Give agents access to the apps you work in.',
        action: 'Browse',
      };
    case 'plugin-examples-preview':
      return {
        title: 'Try your connected tools',
        description: 'Run an example that uses them.',
        action: 'Try it',
      };
    case 'connect-agents':
      return {
        title: 'Connect AI providers',
        description: 'Use Claude, Codex, or Ollama with your own account.',
        action: 'Connect',
      };
    case 'create-plan':
      return {
        title: 'Try plan mode',
        description: PLAN_DESCRIPTION,
        action: 'Try it',
      };
    case 'connect-linear':
      return {
        title: 'Connect Linear',
        description: 'Plan and work on the issues assigned to you.',
        action: 'Connect',
      };
    case 'linear-try-prompt':
      return {
        title: 'Try the Linear plugin',
        description: 'Plan an issue that is assigned to you.',
        action: 'Try it',
      };
    case 'plugin-add':
      return {
        title: 'Connect your tools',
        description: `Add ${step.displayName} so agents can use it.`,
        action: 'Add',
      };
    case 'plugin-try':
      return {
        title: 'Try a connected plugin',
        description: `Run a task with ${step.displayName}.`,
        action: 'Try it',
      };
    case 'advanced-prompt':
      return {
        title: 'Explore examples',
        description: 'Try an advanced example with your tools.',
        action: 'Try it',
      };
    case 'advanced-readiness':
      return {
        title: 'Set up your project',
        description: 'Fix what the project needs before agents run.',
        action: 'Fix',
      };
    case 'enable-focus-shortcut':
      return {
        title: 'Set up quick access',
        description: 'Open the app from anywhere with a keyboard shortcut.',
        action: 'Turn on',
      };
    case 'focus-shortcut-blocked':
      return {
        title: 'Set up quick access',
        description: 'Another app uses this shortcut. Pick a different one.',
        action: 'Change',
      };
    case 'enable-launch-at-login':
      return {
        title: 'Open when you sign in',
        description: 'Start the app when you sign in to your computer.',
        action: 'Turn on',
      };
    case 'launch-at-login-needs-approval':
      return {
        title: 'Allow in System Settings',
        description: 'Approve opening the app when you sign in.',
        action: 'Open Settings',
      };
  }
}

interface BusyFlags {
  focusShortcutBusy: boolean;
  dailyCreditsBusy: boolean;
  launchAtLoginBusy: boolean;
}

/**
 * Label while the visible step's OWN round trip is in flight; null otherwise.
 * Keyed per feature so a focus-shortcut round trip never relabels or disables
 * the launch at sign-in row, and vice versa.
 */
function busyLabelFor(
  step: OnboardingChecklistView['step'],
  flags: BusyFlags,
): string | null {
  switch (step.kind) {
    case 'enable-focus-shortcut':
      return flags.focusShortcutBusy ? 'Enabling shortcut' : null;
    case 'enable-launch-at-login':
      return flags.launchAtLoginBusy ? 'Turning on' : null;
    case 'enable-daily-credits':
      return flags.dailyCreditsBusy ? 'Turning on' : null;
    default:
      return null;
  }
}

interface OnboardingSuggestionSidebarProps {
  view?: OnboardingChecklistView;
  nontechnical: boolean;
  onActivate: () => void;
  /** Skips the step (or moves on from one being revisited), as on Home. */
  onSkip?: () => void;
  /** The ×'s accessible name when it skips more than the card shows. */
  skipLabel?: string;
  /** Steps still waiting after this one; they peek out behind the card. */
  upcoming?: number;
  /** True while the OS focus shortcut update is in flight. */
  focusShortcutBusy: boolean;
  /** True while the daily free AI Credits save is in flight. */
  dailyCreditsBusy?: boolean;
  /** True while a launch at sign-in change is in flight. */
  launchAtLoginBusy: boolean;
}

/**
 * Home's suggestion queue as the shared sidebar deck: the current step in
 * front with its action and Skip, the steps after it peeking out behind.
 */
export function OnboardingSuggestionSidebar({
  view,
  onActivate,
  onSkip,
  skipLabel,
  upcoming = 0,
  focusShortcutBusy,
  dailyCreditsBusy = false,
  launchAtLoginBusy,
}: OnboardingSuggestionSidebarProps): JSX.Element {
  const copy = view ? onboardingSuggestionCopy(view) : undefined;
  const busyLabel = view
    ? busyLabelFor(view.step, {
        focusShortcutBusy,
        dailyCreditsBusy,
        launchAtLoginBusy,
      })
    : null;
  return (
    <GettingStartedSidebarTile
      entryId={view?.entryId}
      title={copy?.title}
      description={copy?.description}
      actionLabel={busyLabel ?? copy?.action}
      disabled={busyLabel !== null}
      onActivate={onActivate}
      onSkip={onSkip}
      skipLabel={skipLabel}
      upcoming={upcoming}
    />
  );
}
