import { type JSX, useEffect, useMemo, useState } from 'react';
import { Fact, FactList } from '@canopy/ui-shared/components';
import { FeedbackDialog, type FeedbackDialogReportType } from '@canopy/ui-app';
import { Button } from '@canopy/ui-shared';
import {
  type FeedbackArea,
  type FeedbackContextSnapshot,
  type FeedbackPrepareRequest,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { brandText } from '@/lib/brand';
import { ChoiceField } from '@canopy/ui-shared/components';

interface FeedbackModalProps {
  onClose: () => void;
  /**
   * Seeds the form's report type. Omitted opens on `Idea`, the default for the
   * account-menu entry point; a host opening this straight off a failure the
   * user just hit passes `bug`.
   */
  initialReportType?: FeedbackDialogReportType;
}

interface ContextRow {
  label: string;
  value: string;
}

const SAVE_ERROR_FALLBACK = 'Could not save the diagnostics bundle.';

/**
 * Idea leads, and is the default (CAN-2682). A bug-first form framed every
 * submission as a defect report before the user had said anything, so someone
 * arriving with a suggestion or a question had to correct the form's
 * assumption first.
 *
 * No per-option helper line: "Idea" and "Bug" already say what they mean, and
 * a sentence restating a visible control is exactly the copy this cleanup
 * removed.
 */
/**
 * Per-type placeholder. This survived the copy cut where the type helper did
 * not, because it carries information the label does not: the bug variant asks
 * for reproduction steps, which is what triage otherwise has to go back and
 * request.
 */
/**
 * Build the slim, serializable UI-context snapshot attached to a feedback
 * report. Reads the already-sanitized current-UI-state envelope that App
 * Advisor also uses, so no free-form transcript or file content can leak in.
 */
function buildFeedbackContext(): FeedbackContextSnapshot {
  const snapshot = useCurrentUiStateStore.getState().envelope.snapshot;
  const worktree = snapshot.selectedWorktree;
  const chat = snapshot.activeChat;
  const workspaceName = worktree?.workspaceDisplayName ?? worktree?.projectName;
  // The standalone-chat project id is not part of the sanitized UI snapshot, so
  // read it directly from its store. Only meaningful on the standalone chat
  // page, where it lets diagnostics attach that chat project's transcripts.
  const chatProjectId =
    snapshot.activePage === 'chat'
      ? useStandaloneChatStore.getState().activeChatProjectId
      : undefined;
  return {
    ...(snapshot.activePage ? { activePage: snapshot.activePage } : {}),
    ...(worktree?.projectId ? { workspaceId: worktree.projectId } : {}),
    ...(workspaceName ? { workspaceName } : {}),
    ...(worktree?.worktreeId ? { worktreeId: worktree.worktreeId } : {}),
    ...(worktree?.worktreeName ? { worktreeName: worktree.worktreeName } : {}),
    ...(chatProjectId ? { chatProjectId } : {}),
    ...(chat?.chatId ? { chatId: chat.chatId } : {}),
    ...(chat?.providerType ? { provider: chat.providerType } : {}),
    ...(chat?.model ? { model: chat.model } : {}),
    ...(typeof window.platform === 'string'
      ? { platform: window.platform }
      : {}),
  };
}

/** Human-readable summary rows for the read-only auto-captured context block. */
function toContextRows(context: FeedbackContextSnapshot): ContextRow[] {
  const rows: ContextRow[] = [];
  if (context.activePage)
    rows.push({ label: 'Page', value: context.activePage });
  if (context.workspaceName || context.worktreeName) {
    const parts = [context.workspaceName, context.worktreeName].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (parts.length > 0) {
      rows.push({ label: 'Project', value: parts.join(' · ') });
    }
  }
  if (context.provider || context.model) {
    const parts = [context.provider, context.model].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (parts.length > 0) {
      rows.push({ label: 'Chat', value: parts.join(' · ') });
    }
  }
  if (context.appVersion) {
    rows.push({ label: 'Version', value: context.appVersion });
  }
  if (context.platform) {
    rows.push({ label: 'Platform', value: context.platform });
  }
  return rows;
}

/**
 * Best-effort mapping of the captured context onto a `prepareFeedback` request
 * for the offline fallback (save diagnostics to Downloads). Mirrors the
 * backend's context→area mapping; core diagnostics are always included.
 */
function buildFallbackPrepareRequest(
  context: FeedbackContextSnapshot,
  description: string,
): FeedbackPrepareRequest {
  const area = mapContextToArea(context);
  if (area === 'worktrees' && context.workspaceId && context.worktreeId) {
    return {
      description,
      area,
      workspaceSelections: [
        {
          workspaceId: context.workspaceId,
          worktreeIds: [context.worktreeId],
        },
      ],
      includeChatDetails: true,
    };
  }
  if (area === 'chat' && context.chatProjectId) {
    return {
      description,
      area,
      chatProjectIds: [context.chatProjectId],
      includeChatDetails: true,
    };
  }
  return { description, area };
}

function mapContextToArea(context: FeedbackContextSnapshot): FeedbackArea {
  switch (context.activePage) {
    case 'pipelines':
    // The Library is where the Pipelines page went (CAN-3981).
    case 'workflows-library':
      return 'pipelines';
    case 'plugins':
      return 'plugins';
    case 'audit':
    case 'audit-trail':
      return 'audit-trail';
    case 'usage':
      return 'usage';
    case 'settings':
      return 'settings';
    case 'chat':
      return 'chat';
    case 'main':
      return context.worktreeId ? 'worktrees' : 'overview';
    default:
      return 'overview';
  }
}

/** Shared classes for the two free-text controls and their labels. */

/**
 * First-class feedback entry point launched from the sidebar account rail.
 * Lets a user share an idea or file a bug; on submit the report becomes a
 * Linear issue (with diagnostics attached) and the modal confirms receipt. On
 * failure it offers an offline diagnostics fallback.
 *
 * Layout contract (CAN-2682): the card is a two-part column — one scrolling
 * field region and one pinned action footer. `CustomizeSidebarModal` and
 * `AppAdvisorSettingsModal` present the same shape, but reach it differently:
 * both keep `DialogModal`'s default body scroller and simply bound their inner
 * content so it never overflows. The mechanism used here — opting out of that
 * scroller entirely — follows `PluginEntryDetail`, `SkillsTab`, and
 * `ShareInstallModal` instead. The `<form>` IS the column, so the
 * submit button can live in the footer and still drive native form submission.
 * Previously every field, the context block and both buttons shared one
 * `space-y-5` stack, which is what made the form read as loosely stacked rows
 * and let the actions scroll out of reach.
 *
 * `scrollableBody={false}` is load-bearing: `DialogModal` otherwise wraps its
 * children in a second `overflow-y-auto` around the one below, and two nested
 * scrollers chain — the outer starts moving once the inner hits its limit,
 * dragging the "pinned" footer out of view and defeating the point of moving
 * it there. This modal owns its own scrolling entirely.
 */
export function FeedbackModal({
  onClose,
  initialReportType,
}: FeedbackModalProps): JSX.Element {
  // The form (type, description, title, submit/error/success) is the shared
  // FeedbackDialog the web portal renders too; this modal owns what only the
  // desktop can add: the captured UI context, the diagnostics bundle, and the
  // offline diagnostics fallback when submission fails.
  const [description, setDescription] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // Capture the auto-context once when the modal opens so it reflects where the
  // user was when they decided to send feedback, not where they end up after.
  const [context, setContext] = useState<FeedbackContextSnapshot>(() =>
    buildFeedbackContext(),
  );

  useEffect(() => {
    let cancelled = false;
    void window.api.update
      .getAppVersion()
      .then((version) => {
        if (cancelled || typeof version !== 'string' || version.length === 0) {
          return;
        }
        setContext((current) => ({ ...current, appVersion: version }));
      })
      .catch(() => {
        // App version is best-effort; omit it on failure.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const contextRows = useMemo(() => toContextRows(context), [context]);

  async function handleSaveDiagnostics(): Promise<void> {
    setSaving(true);
    setSavedMessage(null);
    try {
      const request = buildFallbackPrepareRequest(
        context,
        description.trim().length > 0
          ? description.trim()
          : 'Feedback diagnostics',
      );
      const prepared = await window.api.prepareFeedback(request);
      await window.api.showInFinder({ absolutePath: prepared.absolutePath });
      setSavedMessage(`Saved ${prepared.filename} to your Downloads folder.`);
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : SAVE_ERROR_FALLBACK;
      setSavedMessage(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <FeedbackDialog
      appName={brandText.appName}
      {...(initialReportType ? { initialReportType } : {})}
      onClose={onClose}
      onDescriptionChange={setDescription}
      onSubmit={async (submission): Promise<void> => {
        await window.api.submitFeedback({
          type: submission.type,
          description: submission.description,
          context,
          includeDiagnostics,
          ...(submission.title ? { title: submission.title } : {}),
        });
      }}
      // One block answers "what gets sent with this?". The captured context
      // rows and the diagnostics opt-out used to sit apart and separately
      // explain the same thing.
      attachments={
        <div
          className="space-y-3 rounded-lg border bg-secondary/30 px-4 py-3"
          data-testid="feedback-modal-attachments"
        >
          {/* The heading asserts something is attached, so it is gated on
              there actually being something. Defensive rather than reachable
              from a running app: `activePage` and `platform` populate on every
              real launch, so `contextRows` is never empty in practice — but
              every field feeding it is optional, and a heading over nothing
              would be a lie about what leaves the user's machine. */}
          {(contextRows.length > 0 || includeDiagnostics) && (
            <span className="block text-xs font-medium fg-secondary">
              Sent with your report
            </span>
          )}
          {contextRows.length > 0 && (
            <FactList
              labelWidth="5rem"
              columnGap="2"
              rowGap="1"
              labelTone="secondary"
              dataTestId="feedback-modal-context"
            >
              {contextRows.map((row) => (
                <Fact key={row.label} label={row.label} fit="truncate">
                  {row.value}
                </Fact>
              ))}
            </FactList>
          )}
          <div className={contextRows.length > 0 ? 'border-t pt-3' : ''}>
            {/* The whole row is the label, so clicking the text toggles it.
                `aria-labelledby` keeps the accessible name to the two words a
                screen reader needs; the helper line is the description. */}
            <ChoiceField
              id="feedback-modal-diagnostics-input"
              data-testid="feedback-modal-include-diagnostics"
              checked={includeDiagnostics}
              aria-labelledby="feedback-modal-diagnostics-label"
              aria-describedby="feedback-modal-diagnostics-description"
              onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                setIncludeDiagnostics(e.target.checked);
              }}
              label={
                <span id="feedback-modal-diagnostics-label">
                  Include diagnostics
                </span>
              }
              description={
                <span id="feedback-modal-diagnostics-description">
                  Logs and app state, shared only with the {brandText.appName}{' '}
                  team
                </span>
              }
            />
          </div>
        </div>
      }
      errorActions={
        <Button
          variant="secondary"
          size="compact"
          onClick={(): void => {
            void handleSaveDiagnostics();
          }}
          disabled={saving}
          data-testid="feedback-modal-save-diagnostics"
        >
          {saving ? 'Saving…' : 'Save diagnostics to Downloads'}
        </Button>
      }
      note={
        savedMessage !== null ? (
          <p
            className="text-xs fg-secondary"
            data-testid="feedback-modal-saved-message"
          >
            {savedMessage}
          </p>
        ) : null
      }
    />
  );
}
