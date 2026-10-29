import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type JSX,
  type SetStateAction,
} from 'react';
import type {
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportResponse,
  ExternalProjectProvider,
} from '@canopy/desktop-shared/types';
import { DEFAULT_DAILY_DRIP_CAP_CREDITS } from '@canopy/protocol/billing';
import {
  Button,
  Checkbox,
  Notice,
  ToggleSwitch,
  Tooltip,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import { FolderIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatCompactAge } from '@canopy/ui-shared/lib';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { BrandLogo } from '@/components/BrandLogo';
import { ProviderAuthPanel } from '@/components/auth/ProviderAuthPanel';
import { completeOnboardingSuggestionDurably } from '@/components/home/onboarding-suggestions/completionWriter';
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import {
  useDailyCreditDripOptIn,
  type DailyCreditDripOptInState,
} from '@/hooks/useDailyCreditDripOptIn';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';
import { brandText } from '@/lib/brand';
import { offerCursorRulesReview } from '@/lib/cursorRulesOffer';
import { agentConnectionsIntro } from '@/lib/onboarding/agent-connections-copy';
import {
  captureProjectImportSubmission,
  openImportedProject,
  type ProjectImportSubmission,
} from '@/lib/importedProjectNavigation';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * Prototype first-run page (v0): import Claude and Codex projects, confirm
 * the signed-in providers, and land in a chat. Replaces the old wizard once
 * the UX settles.
 */

export const FIRST_RUN_IMPORT_MARKER = 'first-run-import-v0';

const OLD_PROJECT_MS = 90 * 24 * 60 * 60 * 1000;
const HARNESS_NAMES: Record<ExternalProjectProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

function activityMs(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function isRecent(candidate: ExternalProjectCandidate): boolean {
  return Date.now() - activityMs(candidate.lastActivityAt) < OLD_PROJECT_MS;
}

// shortcut: detects Claude Desktop folder-less Cowork sessions by path, since
// the scan DTO does not flag them; add a field to the candidate when hardening.
function isScratchSession(candidate: ExternalProjectCandidate): boolean {
  return candidate.rootPath.includes('local-agent-mode-sessions');
}

// Display only: shows the home folder as `~` on macOS, Linux, and Windows.
function displayPath(rootPath: string): string {
  return rootPath.replace(
    /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/,
    '~',
  );
}

function RowDetail({
  candidate,
  now,
}: {
  candidate: ExternalProjectCandidate;
  now: number;
}): JSX.Element {
  const shown = displayPath(candidate.rootPath);
  const split = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1;
  const parent = shown.slice(0, split);
  const name = shown.slice(split);
  return (
    <span className="flex min-w-0 gap-1.5">
      {/* The folder name tells projects apart, so the parents truncate and
          the name stays whole. */}
      <span
        className={`flex min-w-0 font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}
        title={candidate.rootPath}
      >
        <span className="min-w-0 truncate">{parent}</span>
        <span className="shrink-0">{name}</span>
      </span>
      <span className="shrink-0">
        ·{' '}
        {candidate.lastActivityAt
          ? formatCompactAge(candidate.lastActivityAt, now)
          : 'No chat history'}
      </span>
    </span>
  );
}

async function markFirstRunDone(): Promise<void> {
  const prefs = await window.api.loadPreferences();
  const prior = Array.isArray(prefs.onboardingCompleted)
    ? prefs.onboardingCompleted
    : [];
  if (!prior.includes(FIRST_RUN_IMPORT_MARKER)) {
    await window.api.savePreferences({
      onboardingCompleted: [...prior, FIRST_RUN_IMPORT_MARKER],
    });
  }
}

/** The harnesses a project was used with, as their logos. */
function HarnessTags({
  providers,
}: {
  providers: ExternalProjectProvider[];
}): JSX.Element | null {
  // A picked folder has no harness of its own.
  if (providers.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 fg-secondary"
      aria-label={`Used with ${providers.map((p) => HARNESS_NAMES[p]).join(' and ')}`}
    >
      {providers.map((provider) => (
        <Tooltip key={provider} label={HARNESS_NAMES[provider]}>
          {provider === 'claude' ? (
            <ClaudeLogo className="size-3.5" aria-hidden />
          ) : (
            <CodexLogo className="size-3.5" aria-hidden />
          )}
        </Tooltip>
      ))}
    </span>
  );
}

function emptyStateTitle(scan: ExternalProjectDiscoverResponse): string {
  if (!scan.providersDetected.claude && !scan.providersDetected.codex)
    return 'No Claude or Codex data found on this computer';
  // Hidden scratch sessions don't count as something already imported.
  return scan.candidates.some(
    (c) => c.status !== 'unavailable' && !isScratchSession(c),
  )
    ? `Everything found is already in ${brandText.appName}`
    : 'No Claude or Codex projects found on this computer';
}

function initialSelection(
  response: ExternalProjectDiscoverResponse,
  include: (candidate: ExternalProjectCandidate) => boolean,
): Set<string> {
  return new Set(
    response.candidates
      .filter((c) => c.status === 'available' && include(c))
      .map((c) => c.id),
  );
}

// Names the projects that didn't import, for the page's error.
function failedImportMessage(response: ExternalProjectImportResponse): string {
  const failed = response.results.filter(
    (result) => result.status !== 'imported',
  );
  if (failed.length === 0 || failed.length > 2)
    return "Couldn't import those projects. Try again.";
  const names = failed.map((result) => result.displayName).join(' and ');
  return `Couldn't import ${names}. Try again.`;
}

function importedWorkspaceIds(
  response: ExternalProjectImportResponse,
  order: string[],
): string[] {
  // Results follow selection order, which is not recency; sort by `order`.
  return response.results
    .filter((result) => result.status === 'imported' && result.workspaceId)
    .sort((a, b) => order.indexOf(a.candidateId) - order.indexOf(b.candidateId))
    .flatMap((result) => (result.workspaceId ? [result.workspaceId] : []));
}

// New projects have no worktrees yet; collapsed, they don't each show a
// "No worktrees" row in the sidebar.
async function collapseInSidebar(workspaceIds: string[]): Promise<void> {
  const projects = useProjectsStore.getState();
  await projects.loadProjects({ silent: true });
  const imported = new Set(workspaceIds);
  for (const item of useProjectsStore.getState().projects) {
    if (imported.has(item.id) && !item.collapsed)
      await projects.toggleCollapsed(item.id);
  }
}

const PROJECTS_DESCRIPTION =
  'A project is a folder you work in. Its chats, settings, and instructions stay together.';

/**
 * The account's daily free AI Credits, offered as an opt-in to a user with
 * no Claude or Codex subscription. Off until the user turns it on; either
 * answer is saved as their decision, which also clears Home's "Claim…" step.
 */
function AccountCreditsRow({
  drip,
}: {
  drip: DailyCreditDripOptInState;
}): JSX.Element {
  const { live, busy, error, turnOn, notNow } = drip;
  // The switch shows the requested answer while it saves, then the saved
  // one; a failed save falls back to the saved answer.
  const [pending, setPending] = useState<boolean | null>(null);
  const canSave = live.state === 'undecided' || live.state === 'decided';
  const capCredits = live.capCredits ?? DEFAULT_DAILY_DRIP_CAP_CREDITS;
  const onChange = (next: boolean): void => {
    setPending(next);
    void (next ? turnOn() : notNow()).finally(() => setPending(null));
  };
  return (
    <SettingsRow
      dataTestId="first-run-daily-credits"
      label={
        <span className="inline-flex items-center gap-2">
          <BrandLogo size={16} aria-hidden />
          {brandText.appName}
        </span>
      }
      description={`Get ${capCredits} free AI Credits every day.`}
      control={
        <ToggleSwitch
          label="Daily free AI Credits"
          dataTestId="first-run-daily-credits-toggle"
          checked={pending ?? live.enabled === true}
          disabled={busy || !canSave}
          onChange={onChange}
        />
      }
    >
      {error && (
        <Notice intent="attention" data-testid="first-run-daily-credits-error">
          {error}
        </Notice>
      )}
    </SettingsRow>
  );
}

function ProjectsSection({
  importable,
  selected,
  setSelected,
}: {
  importable: ExternalProjectCandidate[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const buttonSize = useSettingsButtonSize();
  const now = Date.now();
  // Recent projects start checked and always show, so nothing checked is
  // hidden; older ones start unchecked behind the toggle.
  const visible = expanded
    ? importable
    : importable.filter((c) => isRecent(c) || selected.has(c.id));
  const hiddenCount = importable.length - visible.length;
  const allOn = importable.every((c) => selected.has(c.id));
  const toggle = (id: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <SettingsSection title="Projects" description={PROJECTS_DESCRIPTION}>
      <SettingsGroup>
        {importable.length > 1 && (
          <SettingsRow
            dataTestId="first-run-import-select-all"
            label="Select all"
            htmlFor="first-run-select-all"
            control={
              <Checkbox
                id="first-run-select-all"
                checked={allOn}
                onChange={(): void =>
                  setSelected(
                    allOn ? new Set() : new Set(importable.map((c) => c.id)),
                  )
                }
              />
            }
          />
        )}
        {visible.map((candidate) => (
          <SettingsRow
            key={candidate.id}
            dataTestId={`first-run-import-row-${candidate.id}`}
            label={
              <span className="flex min-w-0 items-center gap-2">
                <span className={`truncate ${POSTHOG_REPLAY_MASK_CLASS}`}>
                  {candidate.displayName}
                </span>
                <HarnessTags providers={candidate.providers} />
              </span>
            }
            description={<RowDetail candidate={candidate} now={now} />}
            htmlFor={`first-run-${candidate.id}`}
            control={
              <Checkbox
                id={`first-run-${candidate.id}`}
                checked={selected.has(candidate.id)}
                onChange={(): void => toggle(candidate.id)}
              />
            }
          />
        ))}
        {(expanded || hiddenCount > 0) && (
          <Button
            data-testid="first-run-import-older"
            size={buttonSize}
            variant="ghost"
            className="self-start"
            onClick={(): void => setExpanded(!expanded)}
          >
            {expanded
              ? 'Hide older projects'
              : `Show ${hiddenCount} older ${hiddenCount === 1 ? 'project' : 'projects'}`}
          </Button>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

function pageDescription(
  scan: ExternalProjectDiscoverResponse | null,
  foundAny: boolean,
): string | undefined {
  if (scan === null) return 'Finding your recent work…';
  return foundAny
    ? 'Import your work. Source folders stay where they are, and nothing runs until you start it.'
    : undefined;
}

export function FirstRunImportPage({
  onDone,
}: {
  onDone: () => void;
}): JSX.Element {
  const claude = useClaudeAuthStatus();
  const codex = useCodexAuthStatus();
  const drip = useDailyCreditDripOptIn();
  const buttonSize = useSettingsButtonSize();
  const [scan, setScan] = useState<ExternalProjectDiscoverResponse | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.externalProjects
      .discover({})
      .then((response) => {
        if (cancelled) return;
        setScan(response);
        setSelected(
          initialSelection(
            response,
            (c) => !isScratchSession(c) && isRecent(c),
          ),
        );
      })
      .catch(() => {
        if (!cancelled)
          setError("Couldn't look for Claude and Codex projects. Try again.");
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const importable = useMemo(
    () =>
      (scan?.candidates ?? [])
        .filter(
          (candidate) =>
            candidate.status === 'available' && !isScratchSession(candidate),
        )
        .sort(
          (a, b) => activityMs(b.lastActivityAt) - activityMs(a.lastActivityAt),
        ),
    [scan],
  );

  const finish = async (imported?: {
    submission: ProjectImportSubmission;
    workspaceId: string;
  }): Promise<void> => {
    // Home's Getting started list would otherwise offer import again.
    completeOnboardingSuggestionDurably(
      'import-projects',
      imported ? 'imported' : 'skipped',
    );
    await markFirstRunDone().catch((): void => {});
    onDone();
    if (imported)
      await openImportedProject(imported.submission, imported.workspaceId);
  };

  const runImport = async (): Promise<void> => {
    if (!scan) return;
    const submission = captureProjectImportSubmission();
    setBusy(true);
    setError(null);
    try {
      const response = await window.api.externalProjects.importProjects({
        scanId: scan.scanId,
        selections: Array.from(selected).map((candidateId) => ({
          candidateId,
          // shortcut: projects only until import keeps each chat's worktree
          // and uncommitted changes; chats now would land on the default branch.
          importChats: false,
        })),
      });
      const workspaceIds = importedWorkspaceIds(
        response,
        importable.map((candidate) => candidate.id),
      );
      const [first] = workspaceIds;
      if (first === undefined) {
        // Nothing imported: stay here so the member can retry or skip.
        setError(failedImportMessage(response));
        setBusy(false);
        return;
      }
      // Cosmetic: the projects are imported even if the sidebar can't fold.
      await collapseInSidebar(workspaceIds).catch((): void => {});
      // Imported repositories with Cursor rules get the review offered as
      // soon as the member lands in the app (CAN-2053).
      void offerCursorRulesReview(
        response.results.flatMap((item) =>
          item.status === 'imported' && item.workspaceId
            ? [{ workspaceId: item.workspaceId, displayName: item.displayName }]
            : [],
        ),
        'first-run-import',
      );
      // Land in the most recently active imported project.
      await finish({ submission, workspaceId: first });
    } catch {
      setError("Couldn't import projects. Try again.");
      setBusy(false);
    }
  };

  const chooseFolder = (): void => {
    void window.api.externalProjects
      .pickFolder()
      .then(async (folder) => {
        if (!folder) return;
        const response = await window.api.externalProjects.discover({
          customRoots: [folder],
        });
        setScan(response);
        // Only the picked folder: the rescan also returns the default finds,
        // including hidden scratch sessions and older projects. Its root is
        // canonicalized, so match the custom-folder surface, not the path.
        setSelected(
          initialSelection(response, (c) =>
            c.surfaces.includes('custom-folder'),
          ),
        );
      })
      .catch(() => setError("Couldn't add that folder. Try again."));
  };

  // Offered only once both checks have finished and neither provider is
  // connected; a failed check counts as not connected.
  const noSubscription =
    claude !== null &&
    claude.authenticated !== true &&
    codex !== null &&
    codex.authenticated !== true;
  const creditsOfferable =
    noSubscription &&
    (drip.live.state === 'undecided' || drip.live.state === 'decided');
  // Once shown, the row stays, so connecting a provider or a re-read does
  // not pull it out from under the user. Losing the cloud account hides it,
  // since the choice can no longer be saved.
  const [creditsShown, setCreditsShown] = useState(false);
  useEffect(() => {
    if (creditsOfferable) setCreditsShown(true);
  }, [creditsOfferable]);
  const showCredits =
    drip.live.state !== 'unavailable' && (creditsShown || creditsOfferable);

  const foundAny = importable.length > 0;
  const nothingToImport = scan !== null && !foundAny;
  return (
    <div
      className="page-scroll-gutter settings-content-scroll-mask h-full w-full overflow-y-auto pt-10"
      data-testid="first-run-import-page"
    >
      <SettingsPage
        title="Let's get started"
        description={pageDescription(scan, foundAny)}
      >
        <SettingsSection description={agentConnectionsIntro()}>
          <SettingsGroup>
            {showCredits && <AccountCreditsRow drip={drip} />}
            <ProviderAuthPanel
              provider="claude"
              layout="row"
              unauthenticatedTone="neutral"
            />
            <ProviderAuthPanel
              provider="codex"
              layout="row"
              unauthenticatedTone="neutral"
            />
          </SettingsGroup>
        </SettingsSection>

        {foundAny && (
          <ProjectsSection
            importable={importable}
            selected={selected}
            setSelected={setSelected}
          />
        )}

        {nothingToImport && (
          <SettingsSection title="Projects" description={PROJECTS_DESCRIPTION}>
            <SettingsGroup>
              <SettingsRow
                dataTestId="first-run-import-empty"
                label={
                  <span className="inline-flex items-center gap-2">
                    <FolderIcon className="h-4 w-4 shrink-0" aria-hidden />
                    {emptyStateTitle(scan)}
                  </span>
                }
                description="Add any folder on this computer as a project."
                control={
                  <Button
                    data-testid="first-run-import-choose-folder"
                    size={buttonSize}
                    variant="secondary"
                    onClick={chooseFolder}
                  >
                    Choose a folder
                  </Button>
                }
              />
            </SettingsGroup>
          </SettingsSection>
        )}

        {error && <Notice intent="destructive">{error}</Notice>}

        <div className="flex items-center gap-2">
          {foundAny && (
            <Button
              data-testid="first-run-import-submit"
              size={buttonSize}
              variant="primary"
              disabled={busy || selected.size === 0}
              onClick={(): void => {
                void runImport();
              }}
            >
              {busy
                ? 'Importing…'
                : `Import ${selected.size} ${selected.size === 1 ? 'project' : 'projects'}`}
            </Button>
          )}
          <Button
            data-testid="first-run-import-skip"
            size={buttonSize}
            variant={nothingToImport ? 'primary' : 'ghost'}
            disabled={busy}
            onClick={(): void => {
              void finish();
            }}
          >
            {nothingToImport ? 'Continue' : 'Skip for now'}
          </Button>
        </div>
      </SettingsPage>
    </div>
  );
}
