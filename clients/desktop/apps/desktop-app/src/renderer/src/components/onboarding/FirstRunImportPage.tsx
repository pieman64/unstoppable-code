import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type ReactNode,
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
import { CheckIcon, FolderIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatCompactAge } from '@canopy/ui-shared/lib';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { BrandLogo } from '@/components/BrandLogo';
import { ProviderAuthPanel } from '@/components/auth/ProviderAuthPanel';
import {
  SettingsGroup,
  SettingsLoading,
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
import { offerCursorRulesReview } from '@/lib/cursorRulesOffer';
import { agentConnectionsIntro } from '@/lib/onboarding/agent-connections-copy';
import {
  dailyCreditsRowState,
  FIRST_RUN_DAILY_CREDITS_ENABLED,
  FIRST_RUN_DAILY_CREDITS_LABEL,
  firstRunDailyCreditsGranted,
  firstRunDailyCreditsOffer,
} from '@/lib/onboarding/first-run-daily-credits-copy';
import {
  captureProjectImportSubmission,
  openImportedProject,
  type ProjectImportSubmission,
} from '@/lib/importedProjectNavigation';
import {
  createFirstRunImportVisit,
  providerConnection,
  startProjectImportSubmission,
  UNKNOWN_IMPORT_SCAN,
  type ImportScanState,
  type ProjectImportResultCounts,
  type ProviderConnections,
} from '@/lib/projectImportTelemetry';
import type { HomeWorkspaceSelectionReason } from '@/stores/homeComposerStore';
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
    <span className="flex min-w-0 gap-1.5 max-sm:flex-wrap">
      {/* The folder name tells projects apart, so the parents truncate and
          the name stays whole. */}
      <span
        className={`flex min-w-0 font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}
        title={candidate.rootPath}
      >
        <span className="min-w-0 truncate">{parent}</span>
        <span className="max-w-full shrink-0">{name}</span>
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

const PROVIDER_ORDER: readonly ExternalProjectProvider[] = ['claude', 'codex'];
// `formatCompactAge` buckets, spelled out as singular and plural words.
const AGE_UNIT_WORDS = new Map<string, readonly [string, string]>([
  ['m', ['minute', 'minutes']],
  ['h', ['hour', 'hours']],
  ['d', ['day', 'days']],
  ['w', ['week', 'weeks']],
  ['mo', ['month', 'months']],
  ['y', ['year', 'years']],
]);

interface WordedAge {
  readonly value: number;
  readonly unit: readonly [string, string];
}

function wordedAge(timestamp: number, now: number): WordedAge | null {
  const match = /^(\d+)(mo|m|h|d|w|y)$/.exec(formatCompactAge(timestamp, now));
  const unit = AGE_UNIT_WORDS.get(match?.[2] ?? '');
  if (!match || !unit) return null;
  return { value: Number(match[1]), unit };
}

function ageWords({ value, unit }: WordedAge): string {
  return `${value} ${value === 1 ? unit[0] : unit[1]}`;
}

// Newest to oldest, sharing the unit only when both ends use it:
// `3–5 months`, `3 months`, or `11 months–1 year`.
function ageRange(newest: WordedAge, oldest: WordedAge): string {
  if (newest.unit !== oldest.unit)
    return `${ageWords(newest)}–${ageWords(oldest)}`;
  if (newest.value === oldest.value) return ageWords(oldest);
  return `${newest.value}–${oldest.value} ${oldest.unit[1]}`;
}

/**
 * Says what was found when every project is older, such as `Found 3 Claude
 * projects · last used 3–5 months ago`. A provider is named only when every
 * project has one, and the age covers only parseable activity.
 */
function foundProjectsDescription(
  importable: ExternalProjectCandidate[],
  now: number,
): string {
  const count = importable.length;
  const harnesses = importable.every(
    (c) =>
      c.providers.length > 0 &&
      c.providers.every((provider) => PROVIDER_ORDER.includes(provider)),
  )
    ? PROVIDER_ORDER.filter((provider) =>
        importable.some((c) => c.providers.includes(provider)),
      )
        .map((provider) => HARNESS_NAMES[provider])
        .join(' and ')
    : '';
  const found = `Found ${count} ${harnesses ? `${harnesses} ` : ''}${count === 1 ? 'project' : 'projects'}`;
  const known = importable
    .filter((c) => c.lastActivityAt)
    .map((c) => activityMs(c.lastActivityAt))
    .filter((ms) => Number.isFinite(ms));
  if (known.length === 0) return found;
  const newest = wordedAge(Math.max(...known), now);
  const oldest = wordedAge(Math.min(...known), now);
  if (!newest || !oldest) return found;
  const lead = known.length === count ? 'last used' : 'known activity';
  return `${found} · ${lead} ${ageRange(newest, oldest)} ago`;
}

/**
 * The account's daily free AI Credits, offered as an opt-in to a user with
 * no Claude or Codex subscription. Off until the user turns it on; either
 * answer is saved as their decision, which also clears Home's "Claim…" step.
 *
 * The description is one region whose height never changes between the
 * offer and the confirmations: every variant sits in the same grid cell and
 * only the current one is visible, so the page (and Continue) never moves
 * at any width or text size.
 */
function AccountCreditsRow({
  drip,
}: {
  drip: DailyCreditDripOptInState;
}): JSX.Element {
  const { live, busy, error, outcome, turnOn, notNow } = drip;
  // Only the hook's current save may show an optimistic choice. Its busy
  // state also clears on account changes, before an old request settles.
  const [pending, setPending] = useState(false);
  const canSave = live.state === 'undecided' || live.state === 'decided';
  const capCredits = live.capCredits ?? DEFAULT_DAILY_DRIP_CAP_CREDITS;
  const onChange = (next: boolean): void => {
    if (busy) return;
    setPending(next);
    void (next ? turnOn() : notNow());
  };
  const id = useId();
  const switchId = `${id}-switch`;
  const offerId = `${id}-offer`;
  const confirmationId = `${id}-confirmation`;
  // A save in flight keeps the offer: success is announced once it settles.
  const state = busy
    ? 'offer'
    : dailyCreditsRowState(outcome, live.enabled === true);
  const offer = firstRunDailyCreditsOffer(capCredits);
  const confirmation =
    state === 'granted' && outcome
      ? firstRunDailyCreditsGranted(outcome.granted)
      : state === 'enabled'
        ? FIRST_RUN_DAILY_CREDITS_ENABLED
        : null;
  const cell = 'col-start-1 row-start-1';
  return (
    <SettingsRow
      dataTestId="first-run-daily-credits"
      htmlFor={switchId}
      label={
        <span className="inline-flex items-center gap-2">
          <BrandLogo size={16} aria-hidden />
          {FIRST_RUN_DAILY_CREDITS_LABEL}
        </span>
      }
      description={
        <span
          className="grid"
          data-testid="first-run-daily-credits-description"
          data-state={state}
        >
          {/* Invisible sizers: the longest variants reserve their height. */}
          <span
            aria-hidden="true"
            className={`${cell} invisible flex items-start gap-1`}
          >
            <CheckIcon size={12} className="mt-0.5 shrink-0" />
            <span>{firstRunDailyCreditsGranted(capCredits)}</span>
          </span>
          <span aria-hidden="true" className={`${cell} invisible`}>
            {FIRST_RUN_DAILY_CREDITS_ENABLED}
          </span>
          <span
            id={offerId}
            className={`${cell} ${confirmation === null ? '' : 'invisible'}`}
            aria-hidden={confirmation === null ? undefined : true}
          >
            {offer}
          </span>
          {/* Always mounted, so screen readers hear each settled outcome. */}
          <span
            role="status"
            id={confirmationId}
            className={`${cell} flex items-start gap-1`}
          >
            {confirmation !== null && (
              <>
                {state === 'granted' && (
                  <CheckIcon
                    aria-hidden
                    size={12}
                    className="mt-0.5 shrink-0 fg-success"
                  />
                )}
                <span data-testid="first-run-daily-credits-confirmation">
                  {confirmation}
                </span>
              </>
            )}
          </span>
        </span>
      }
      control={
        <ToggleSwitch
          id={switchId}
          label={FIRST_RUN_DAILY_CREDITS_LABEL}
          describedBy={confirmation === null ? offerId : confirmationId}
          dataTestId="first-run-daily-credits-toggle"
          checked={busy ? pending : live.enabled === true}
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

/**
 * What the Projects box holds: the scan running, the scan failed (its error
 * shows by the actions), what it found, or nothing to import.
 */
type ProjectsBody =
  | { readonly kind: 'scanning' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'candidates';
      readonly importable: ExternalProjectCandidate[];
    }
  | { readonly kind: 'empty' };

function CandidateRows({
  importable,
  allOlder,
  selected,
  setSelected,
  expanded,
  setExpanded,
  now,
}: {
  importable: ExternalProjectCandidate[];
  allOlder: boolean;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  now: number;
}): JSX.Element {
  // Recent projects start checked and always show, so nothing checked is
  // hidden; older ones start unchecked behind the toggle. When none is
  // recent, every project shows unchecked and there is no toggle (CAN-4712).
  const visible =
    expanded || allOlder
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
    <>
      {visible.length > 1 && (
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
      {!allOlder && (expanded || hiddenCount > 0) && (
        <Button
          data-testid="first-run-import-older"
          size="compact"
          variant="ghost"
          className="self-start"
          onClick={(): void => setExpanded(!expanded)}
        >
          {expanded
            ? 'Hide older projects'
            : `Show ${hiddenCount} older ${hiddenCount === 1 ? 'project' : 'projects'}`}
        </Button>
      )}
    </>
  );
}

/**
 * The Projects box, from the first render: it is as tall as its rows, up to
 * the page under the providers, past which its rows scroll inside it, and
 * the page's actions sit at its bottom, so finishing the scan or showing
 * older projects never pushes them out of view (CAN-4679).
 */
function ProjectsSection({
  body,
  selected,
  setSelected,
  chooseFolder,
  actions,
}: {
  body: ProjectsBody;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  chooseFolder: () => void;
  actions: ReactNode;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const now = Date.now();
  const allOlder =
    body.kind === 'candidates' && !body.importable.some(isRecent);
  return (
    <SettingsSection
      fill
      title="Projects"
      description={
        allOlder
          ? foundProjectsDescription(body.importable, now)
          : PROJECTS_DESCRIPTION
      }
      dataTestId="first-run-import-projects"
    >
      <SettingsGroup fill>
        {/* The box pads its direct children. Only the inner rows own the
            list's vertical padding, so its last control stays scrollable.
            The list grows up to its rows' height and scrolls past it, so
            the box never holds blank space. */}
        <div
          data-testid="first-run-import-list"
          className="settings-fill-list -mx-4 px-4 scroll-py-1 list-scroll-gutter"
          style={{ paddingBlock: 0 }}
        >
          <SettingsGroup surface="plain">
            {body.kind === 'scanning' && (
              <SettingsLoading
                rows={2}
                dataTestId="first-run-import-projects-loading"
              />
            )}
            {body.kind === 'candidates' && (
              <CandidateRows
                importable={body.importable}
                allOlder={allOlder}
                selected={selected}
                setSelected={setSelected}
                expanded={expanded}
                setExpanded={setExpanded}
                now={now}
              />
            )}
            {body.kind === 'empty' && (
              <SettingsRow
                dataTestId="first-run-import-empty"
                label={
                  <span className="inline-flex items-center gap-2">
                    <FolderIcon className="h-4 w-4 shrink-0" aria-hidden />
                    Add a project
                  </span>
                }
                description="Add the folder you want to work in"
                control={
                  <Button
                    data-testid="first-run-import-choose-folder"
                    size="compact"
                    variant="primary"
                    onClick={chooseFolder}
                  >
                    Choose a folder
                  </Button>
                }
              />
            )}
          </SettingsGroup>
        </div>
        <div
          data-testid="first-run-import-actions"
          className="flex shrink-0 flex-col gap-3"
        >
          {actions}
        </div>
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
  const [scan, setScan] = useState<ExternalProjectDiscoverResponse | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const importing = useRef(false);
  const mounted = useRef(false);

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
        if (cancelled) return;
        setScanFailed(true);
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

  // Telemetry only (CAN-4635): one visit per mount, so effect replay keeps
  // it and a real remount starts a new one.
  const [visit] = useState(createFirstRunImportVisit);
  const connections: ProviderConnections = {
    claude: providerConnection(claude),
    codex: providerConnection(codex),
  };
  // A failed folder rescan keeps the earlier scan on screen, so it stays
  // the scan reported.
  const scanState: ImportScanState = scan
    ? { kind: 'completed', scan, found: importable }
    : scanFailed
      ? { kind: 'failed' }
      : UNKNOWN_IMPORT_SCAN;
  const latest = useRef({ connections, scanState });
  useEffect(() => {
    latest.current = { connections, scanState };
  });
  useEffect(() => {
    mounted.current = true;
    visit.begin(latest.current.connections);
    return (): void => {
      mounted.current = false;
    };
  }, [visit]);

  const finish = async (imported?: {
    submission: ProjectImportSubmission;
    workspaceId: string;
    reason?: HomeWorkspaceSelectionReason;
  }): Promise<void> => {
    if (mounted.current)
      visit.complete(latest.current.scanState, latest.current.connections);
    await markFirstRunDone().catch((): void => {});
    onDone();
    if (imported)
      await openImportedProject(
        imported.submission,
        imported.workspaceId,
        imported.reason,
      );
  };

  const runImport = async (): Promise<void> => {
    if (!scan || selected.size === 0 || importing.current) return;
    importing.current = true;
    const submission = captureProjectImportSubmission();
    const selectedIds = Array.from(selected);
    const tracking =
      selectedIds.length > 0
        ? startProjectImportSubmission({
            surface: { source: 'first_run', connections },
            scan: scanState,
            selectedIds,
            pickedFolder: visit.pickedFolder,
          })
        : null;
    let recorded: ProjectImportResultCounts | null = null;
    setBusy(true);
    setError(null);
    try {
      const response = await window.api.externalProjects.importProjects({
        scanId: scan.scanId,
        selections: selectedIds.map((candidateId) => ({
          candidateId,
          // shortcut: projects only until import keeps each chat's worktree
          // and uncommitted changes; chats now would land on the default branch.
          importChats: false,
        })),
      });
      if (tracking) {
        recorded = tracking.settle(response);
        visit.recordSubmission(recorded);
      }
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
      // Land in the most recently active imported project, and say so when
      // it was chosen over other successful imports (CAN-4674).
      const reason: HomeWorkspaceSelectionReason | undefined =
        new Set(workspaceIds).size > 1 ? 'most-recent-import' : undefined;
      await finish({
        submission,
        workspaceId: first,
        ...(reason ? { reason } : {}),
      });
    } catch {
      // A failure after the response was recorded is not a request failure.
      if (tracking && recorded === null)
        visit.recordSubmission(tracking.fail());
      setError("Couldn't import projects. Try again.");
      setBusy(false);
    } finally {
      importing.current = false;
    }
  };

  const chooseFolder = (): void => {
    void window.api.externalProjects
      .pickFolder()
      .then(async (folder) => {
        if (!folder) return;
        visit.markPickedFolder();
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
  useEffect(() => {
    if (showCredits) visit.markCreditsOffered();
  }, [showCredits, visit]);

  const foundAny = importable.length > 0;
  const nothingToImport = scan !== null && !foundAny;
  // Only a failed scan leaves an error with no scan to show.
  const body: ProjectsBody =
    scan === null
      ? error === null
        ? { kind: 'scanning' }
        : { kind: 'failed' }
      : foundAny
        ? { kind: 'candidates', importable }
        : { kind: 'empty' };
  return (
    <div
      className="first-run-import-page page-scroll-gutter settings-content-scroll-mask h-full w-full overflow-y-auto pt-10 wrap-anywhere"
      data-testid="first-run-import-page"
    >
      <SettingsPage
        fill
        title="Let's get started"
        description={pageDescription(scan, foundAny)}
      >
        <SettingsSection
          description={agentConnectionsIntro({ offersCredits: showCredits })}
        >
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

        <ProjectsSection
          body={body}
          selected={selected}
          setSelected={setSelected}
          chooseFolder={chooseFolder}
          actions={
            <>
              {/* A project name can be one long word; it wraps in the box. */}
              {error && (
                <Notice intent="destructive">
                  <span className="wrap-anywhere">{error}</span>
                </Notice>
              )}
              {/* An import primary comes last, at the trailing edge. With
                  nothing to import, the primary is Choose a folder in the
                  Projects box. */}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  data-testid="first-run-import-skip"
                  size="compact"
                  variant="ghost"
                  disabled={busy}
                  onClick={(): void => {
                    void finish();
                  }}
                >
                  {nothingToImport
                    ? 'Continue without a project'
                    : 'Skip for now'}
                </Button>
                {foundAny && (
                  <Button
                    data-testid="first-run-import-submit"
                    size="compact"
                    variant="primary"
                    disabled={busy || selected.size === 0}
                    onClick={(): void => {
                      void runImport();
                    }}
                  >
                    {busy
                      ? 'Importing…'
                      : selected.size === 0
                        ? 'Select a project to import'
                        : `Import ${selected.size} ${selected.size === 1 ? 'project' : 'projects'}`}
                  </Button>
                )}
              </div>
            </>
          }
        />
      </SettingsPage>
    </div>
  );
}
