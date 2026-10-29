'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  DialogModal,
  FloatingPickerMenu,
  LoadingButton,
  Notice,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuSection,
  PickerMenuSectionLabel,
  PrivateMemoryAdvancedOption,
  RailIconButton,
  SettingsListSkeleton,
  StatusPill,
  buttonClassName,
} from '@canopy/ui-shared/components';
import { SIDEBAR_INDICATOR_BLUE } from '@canopy/ui-shared/lib';
import { FilterIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  ORG_PROJECT_LIMITS,
  organizationIntegrationsPath,
  type CreateOrgProjectOutcome,
  type OrgProjectDetail,
  type OrgProjectGrant,
} from '@canopy/protocol/org-projects';
import { GITHUB_REPOSITORY_QUERY_MAX_LENGTH } from '@canopy/protocol/settings/organization-repositories';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { SettingsLink, useSettingsClient, useSettingsPrivacy } from '../host';
import { settingsErrorFacts, useSettingsErrorCopy } from '../errors';
import { GITHUB_PICKER_KNOWN_ERRORS } from '../github/github-organization-error-copy';
import {
  createOrganizationProjects,
  listOrganizationGitHubRepositories,
} from './team-api';
import { TeamProjectsGrantsEditor } from './team-projects-grants-editor';

type RepositoryPage = Awaited<
  ReturnType<typeof listOrganizationGitHubRepositories>
>;
type Repository = RepositoryPage['repositories'][number];
const FIELD_CLASS =
  'w-full rounded-md border bg-card px-3 py-2 text-s fg-primary';

/** Class tokens joined without stray whitespace when one is empty. */
function joinClasses(...classes: string[]): string {
  return classes.filter(Boolean).join(' ');
}

interface GitHubConnectionLinkProps {
  orgId: string;
  variant?: 'primary' | 'secondary';
}
/**
 * Opens the organization's Integrations tab through the host's link, so the
 * desktop settings overlay routes it in place instead of leaving the page.
 */
export function GitHubConnectionLink({
  orgId,
  variant = 'primary',
}: GitHubConnectionLinkProps): JSX.Element {
  return (
    <SettingsLink
      href={organizationIntegrationsPath(orgId)}
      className={buttonClassName({ variant })}
      data-testid="team-projects-connect-github"
    >
      Connect GitHub
    </SettingsLink>
  );
}

/** Route codes that the organization's GitHub connection page can fix. */
const NEEDS_CONNECTION_CODES: ReadonlySet<string> = new Set([
  'github-not-connected',
  'github-installation-suspended',
]);

/**
 * Logs scope for the Projects tab's GitHub and project requests, shared by
 * the create dialog, the repository picker and the Repositories dialog.
 */
export const PROJECTS_ERROR_SCOPE = 'settings.organization.projects';

/** A failed projects request as its notice shows it. Never server text. */
export interface RequestFailure {
  /** Friendly copy from `settings/errors`. */
  readonly copy: string;
  /** The organization's GitHub connection needs fixing first. */
  readonly needsConnection: boolean;
}

/** The notice for a failed request, with `copy` already chosen. */
export function requestFailure(error: unknown, copy: string): RequestFailure {
  const { serverCode } = settingsErrorFacts(error);
  return {
    copy,
    needsConnection:
      serverCode !== undefined && NEEDS_CONNECTION_CODES.has(serverCode),
  };
}

interface RequestNoticeProps {
  failure: RequestFailure;
  orgId: string;
}
export function RequestNotice({
  failure,
  orgId,
}: RequestNoticeProps): JSX.Element {
  return (
    <Notice
      intent="attention"
      actions={
        failure.needsConnection ? (
          <GitHubConnectionLink orgId={orgId} variant="secondary" />
        ) : undefined
      }
    >
      {failure.copy}
    </Notice>
  );
}

interface TeamProjectsCreateDialogProps {
  detail: OrganizationDetail;
  growthDisabled: boolean;
  onClose: () => void;
  onCreated: (projects: OrgProjectDetail[]) => void;
}
export function TeamProjectsCreateDialog({
  detail,
  growthDisabled,
  onClose,
  onCreated,
}: TeamProjectsCreateDialogProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const [step, setStep] = useState<'repositories' | 'definition' | 'outcomes'>(
    'repositories',
  );
  const [selected, setSelected] = useState<Repository[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [grants, setGrants] = useState<OrgProjectGrant[]>([]);
  // Off unless the admin chooses it; members inherit the definition's value.
  const [privateMemory, setPrivateMemory] = useState(false);
  const [results, setResults] = useState<CreateOrgProjectOutcome[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestFailure | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  const submit = async (): Promise<void> => {
    if (submitting.current || growthDisabled || selected.length === 0) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await createOrganizationProjects(client, detail.id, {
        repositories: selected.map((repository) => {
          const displayName = names[repository.id]?.trim();
          return {
            providerRepoId: String(repository.id),
            owner: repository.owner,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
            ...(displayName && displayName !== repository.name
              ? { displayName }
              : {}),
          };
        }),
        grants,
        ...(privateMemory ? { privateMemory: true } : {}),
      });
      if (!alive.current) return;
      setResults(response.results);
      onCreated(
        response.results.flatMap((result) =>
          result.outcome === 'created' && result.project
            ? [result.project]
            : [],
        ),
      );
      setStep('outcomes');
    } catch (err) {
      if (alive.current)
        setError(
          requestFailure(
            err,
            errorCopy.actionCopy(err, {
              action: 'create projects',
              known: GITHUB_PICKER_KNOWN_ERRORS,
            }),
          ),
        );
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <DialogModal
      title="Create project"
      dataTestId="team-projects-create-dialog"
      maxWidth="2xl"
      trapFocus
      onClose={(): void => {
        if (!submitting.current) onClose();
      }}
    >
      <div className="flex flex-col gap-5 p-5">
        {error && <RequestNotice failure={error} orgId={detail.id} />}
        <div hidden={step !== 'repositories'}>
          <RepositoryPicker
            orgId={detail.id}
            selected={selected}
            onSelectionChange={setSelected}
            disabled={busy || growthDisabled}
          />
        </div>
        {step === 'repositories' && (
          <Button
            disabled={selected.length === 0 || growthDisabled}
            onClick={(): void => setStep('definition')}
          >
            Next
          </Button>
        )}
        {step === 'definition' && (
          <>
            <h3 className="text-m fg-primary">Definition</h3>
            {selected.map((repository) => (
              <label
                key={repository.id}
                className={joinClasses(
                  'flex flex-col gap-2 text-s',
                  blockClassName,
                )}
              >
                {repository.fullName}
                <input
                  className={FIELD_CLASS}
                  data-testid={`team-projects-name-${repository.id}`}
                  aria-label={`Name for ${repository.fullName}`}
                  placeholder={repository.name}
                  maxLength={ORG_PROJECT_LIMITS.nameLength}
                  disabled={busy}
                  value={names[repository.id] ?? ''}
                  onChange={(event): void =>
                    setNames((current) => ({
                      ...current,
                      [repository.id]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
            <PrivateMemoryAdvancedOption
              checked={privateMemory}
              onChange={setPrivateMemory}
              disabled={busy}
              dataTestId="team-projects-create-private-memory"
              disclosureTestId="team-projects-create-advanced"
            />
            <h3 className="text-m fg-primary">Grants</h3>
            <TeamProjectsGrantsEditor
              detail={detail}
              grants={grants}
              setGrants={setGrants}
              disabled={busy}
              growthDisabled={growthDisabled}
            />
            <div className="flex gap-3">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={(): void => {
                  setError(null);
                  setStep('repositories');
                }}
              >
                Back
              </Button>
              <LoadingButton
                data-testid="team-projects-create-submit"
                loading={busy}
                disabled={growthDisabled}
                onClick={(): void => {
                  void submit();
                }}
              >
                Create {selected.length} projects
              </LoadingButton>
            </div>
          </>
        )}
        {step === 'outcomes' && (
          <>
            <ul className="flex flex-col gap-3 text-s">
              {results.map((result) => (
                <li
                  key={result.providerRepoId}
                  data-testid={`team-projects-create-outcome-${result.providerRepoId}`}
                >
                  <span className={blockClassName || undefined}>
                    {selected.find(
                      (repository) =>
                        String(repository.id) === result.providerRepoId,
                    )?.fullName ?? result.providerRepoId}
                  </span>
                  <span className="ml-3">
                    {result.outcome === 'created'
                      ? 'Created'
                      : result.outcome === 'exists'
                        ? 'Already exists'
                        : result.error === 'repository-not-in-installation'
                          ? 'Not in your GitHub installation'
                          : // Any other per-repository reason is server
                            // text, which settings never render.
                            "Couldn't create this project."}
                  </span>
                </li>
              ))}
            </ul>
            <p role="status">
              {results.filter((result) => result.outcome === 'created').length}{' '}
              created,{' '}
              {results.filter((result) => result.outcome === 'exists').length}{' '}
              already existed,{' '}
              {results.filter((result) => result.outcome === 'error').length}{' '}
              failed
            </p>
            <Button onClick={onClose}>Done</Button>
          </>
        )}
      </div>
    </DialogModal>
  );
}

type VisibilityFilter = 'all' | 'public' | 'private';
type StatusFilter = 'all' | 'active' | 'archived';
interface RepositoryFilters {
  visibility: VisibilityFilter;
  status: StatusFilter;
}
const NO_FILTERS: RepositoryFilters = { visibility: 'all', status: 'all' };

function matchesFilters(
  repository: Repository,
  filters: RepositoryFilters,
): boolean {
  if (filters.visibility === 'public' && repository.private) return false;
  if (filters.visibility === 'private' && !repository.private) return false;
  if (filters.status === 'active' && repository.archived) return false;
  if (filters.status === 'archived' && !repository.archived) return false;
  return true;
}

interface FilterOption<Value extends string> {
  value: Value;
  label: string;
  testId: string;
}
const VISIBILITY_OPTIONS: ReadonlyArray<FilterOption<VisibilityFilter>> = [
  { value: 'all', label: 'All', testId: 'any-visibility' },
  { value: 'public', label: 'Public', testId: 'public' },
  { value: 'private', label: 'Private', testId: 'private' },
];
const STATUS_OPTIONS: ReadonlyArray<FilterOption<StatusFilter>> = [
  { value: 'all', label: 'All', testId: 'any-status' },
  { value: 'active', label: 'Active', testId: 'active' },
  { value: 'archived', label: 'Archived', testId: 'archived' },
];

interface RepositoryFilterMenuProps {
  filters: RepositoryFilters;
  onChange: (filters: RepositoryFilters) => void;
  disabled: boolean;
}

/**
 * Private and Archived filters for the picker (CAN-3466), following the
 * shared filter-menu pattern: a filter icon with an active dot and a checked
 * menu that stays open while choosing.
 */
function RepositoryFilterMenu({
  filters,
  onChange,
  disabled,
}: RepositoryFilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const active =
    filters.visibility !== NO_FILTERS.visibility ||
    filters.status !== NO_FILTERS.status;
  const title = 'Filter repositories';
  const section = <Value extends string>(
    heading: string,
    options: ReadonlyArray<FilterOption<Value>>,
    current: Value,
    choose: (value: Value) => void,
  ): JSX.Element => (
    <div role="group" aria-label={heading}>
      <PickerMenuSectionLabel>{heading}</PickerMenuSectionLabel>
      {options.map((option) => {
        const checked = option.value === current;
        return (
          <PickerMenuOption
            key={option.value}
            role="menuitemradio"
            aria-checked={checked}
            selected={checked}
            data-testid={`team-projects-repo-filter-${option.testId}`}
            onClick={(): void => choose(option.value)}
          >
            <PickerMenuOptionCheck selected={checked} reserveSpace />
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>{option.label}</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
          </PickerMenuOption>
        );
      })}
    </div>
  );
  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        iconSize={16}
        size="row"
        hoverSurface
        disabled={disabled}
        aria-label={title}
        aria-haspopup="true"
        aria-expanded={open}
        title={title}
        data-testid="team-projects-repo-filter-trigger"
        data-active={active ? 'true' : 'false'}
        onClick={(): void => setOpen((current) => !current)}
      />
      {active && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${SIDEBAR_INDICATOR_BLUE.background}`}
        />
      )}
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        interaction="menu"
        closeOnSelect={false}
        aria-label={title}
        data-testid="team-projects-repo-filter-menu"
      >
        {section(
          'Visibility',
          VISIBILITY_OPTIONS,
          filters.visibility,
          (visibility) => onChange({ ...filters, visibility }),
        )}
        <PickerMenuSection>
          {section('Status', STATUS_OPTIONS, filters.status, (status) =>
            onChange({ ...filters, status }),
          )}
        </PickerMenuSection>
      </FloatingPickerMenu>
    </div>
  );
}

interface RepositoryPickerProps {
  orgId: string;
  selected: Repository[];
  onSelectionChange: (repositories: Repository[]) => void;
  disabled: boolean;
}
function RepositoryPicker({
  orgId,
  selected,
  onSelectionChange,
  disabled,
}: RepositoryPickerProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(PROJECTS_ERROR_SCOPE);
  const { blockClassName } = useSettingsPrivacy();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<RepositoryPage>({
    repositories: [],
    nextCursor: null,
    repositorySelection: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<RequestFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const [filters, setFilters] = useState<RepositoryFilters>(NO_FILTERS);
  const requestVersion = useRef(0);
  const pending = useRef(false);
  const searchEdited = useRef(false);

  useEffect(() => {
    const version = ++requestVersion.current;
    pending.current = true;
    const load = async (): Promise<void> => {
      try {
        const response = await listOrganizationGitHubRepositories(
          client,
          orgId,
          {
            query,
          },
        );
        if (requestVersion.current === version) setPage(response);
      } catch (err) {
        if (requestVersion.current === version)
          setError(
            requestFailure(
              err,
              errorCopy.loadCopy(err, GITHUB_PICKER_KNOWN_ERRORS),
            ),
          );
      } finally {
        if (requestVersion.current === version) {
          pending.current = false;
          setLoading(false);
        }
      }
    };
    // The first page opens immediately; edits to the query wait for typing to settle.
    const timer = searchEdited.current
      ? setTimeout((): void => {
          void load();
        }, 300)
      : undefined;
    if (!searchEdited.current) void load();
    return (): void => {
      clearTimeout(timer);
      requestVersion.current = version + 1;
    };
  }, [client, errorCopy, orgId, query, retry]);

  const resetSearch = (): void => {
    ++requestVersion.current;
    pending.current = true;
    setLoading(true);
    setError(null);
    setPage({ repositories: [], nextCursor: null, repositorySelection: null });
  };

  const loadMore = async (): Promise<void> => {
    if (!page.nextCursor || pending.current || disabled) return;
    const version = requestVersion.current;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await listOrganizationGitHubRepositories(client, orgId, {
        query,
        cursor: page.nextCursor,
      });
      if (version === requestVersion.current)
        setPage((current) => ({
          ...response,
          repositories: [
            ...current.repositories,
            ...response.repositories.filter(
              (repository) =>
                !current.repositories.some(
                  (existing) => existing.id === repository.id,
                ),
            ),
          ],
        }));
    } catch (err) {
      if (version === requestVersion.current)
        setError(
          requestFailure(
            err,
            errorCopy.loadCopy(err, GITHUB_PICKER_KNOWN_ERRORS),
          ),
        );
    } finally {
      if (version === requestVersion.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  };
  const capped = selected.length >= ORG_PROJECT_LIMITS.repositoriesPerCreate;
  // Filters narrow what is shown, never the selection.
  const filtered = page.repositories.filter((repository) =>
    matchesFilters(repository, filters),
  );
  return (
    <section
      data-testid="team-projects-repo-picker"
      className="flex flex-col gap-4"
    >
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-s">
          Search repositories
          <input
            className={FIELD_CLASS}
            aria-label="Search repositories"
            placeholder="Search repositories"
            maxLength={GITHUB_REPOSITORY_QUERY_MAX_LENGTH}
            value={query}
            disabled={disabled}
            onChange={(event): void => {
              const nextQuery = event.target.value.slice(
                0,
                GITHUB_REPOSITORY_QUERY_MAX_LENGTH,
              );
              if (nextQuery !== query) {
                resetSearch();
                searchEdited.current = true;
                setQuery(nextQuery);
              }
            }}
          />
        </label>
        <RepositoryFilterMenu
          filters={filters}
          onChange={setFilters}
          disabled={disabled}
        />
      </div>
      {page.repositorySelection === 'selected' && (
        <Notice>
          Only repositories the installation was granted show here. Manage
          access on GitHub to add more.
        </Notice>
      )}
      {error && <RequestNotice failure={error} orgId={orgId} />}
      {error && !page.nextCursor && (
        <Button
          variant="ghost"
          disabled={loading || disabled}
          onClick={(): void => {
            resetSearch();
            setRetry((current) => current + 1);
          }}
        >
          Try again
        </Button>
      )}
      {loading && page.repositories.length === 0 && (
        <DelayedLoadingPlaceholder>
          <SettingsListSkeleton avatarShape="square" />
        </DelayedLoadingPlaceholder>
      )}
      {!loading && !error && page.repositories.length === 0 && (
        <Notice>
          No repositories found. Try another search or manage access on GitHub.
        </Notice>
      )}
      {page.repositories.length > 0 && filtered.length === 0 && (
        <p className="text-s fg-secondary">
          No repositories match these filters.
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {filtered.map((repository) => {
          const checked = selected.some((entry) => entry.id === repository.id);
          return (
            <li key={repository.id}>
              <label className="flex items-center gap-3 text-s">
                <input
                  type="checkbox"
                  data-testid={`team-projects-repo-${repository.id}`}
                  checked={checked}
                  disabled={disabled || (!checked && capped)}
                  onChange={(): void => {
                    if (checked)
                      onSelectionChange(
                        selected.filter((entry) => entry.id !== repository.id),
                      );
                    else if (!capped)
                      onSelectionChange([...selected, repository]);
                  }}
                />
                <span
                  className={joinClasses(
                    'min-w-0 flex-1 break-words',
                    blockClassName,
                  )}
                >
                  {repository.fullName}
                  <span className="block fg-secondary">
                    Default branch: {repository.defaultBranch ?? 'Not set'}
                  </span>
                </span>
                {repository.private && <StatusPill>Private</StatusPill>}
                {repository.archived && <StatusPill>Archived</StatusPill>}
              </label>
            </li>
          );
        })}
      </ul>
      <p aria-live="polite">{selected.length} selected</p>
      {capped && (
        <Notice>
          Select up to {ORG_PROJECT_LIMITS.repositoriesPerCreate} repositories.
        </Notice>
      )}
      {page.nextCursor && (
        <LoadingButton
          data-testid="team-projects-repo-load-more"
          loading={loading}
          disabled={disabled}
          onClick={(): void => {
            void loadMore();
          }}
        >
          Load more
        </LoadingButton>
      )}
    </section>
  );
}
