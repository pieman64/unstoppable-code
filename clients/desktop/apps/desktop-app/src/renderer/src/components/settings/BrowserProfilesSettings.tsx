import { BrowserProfileDataSettings } from './BrowserProfileDataSettings';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  BrowserProfileBadge,
  BrowserProfilePermissions,
  Button,
  ColorSwatchPicker,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared';
import type {
  BrowserProfileRecord,
  BrowserProfilePatch,
  BrowserProfileDeletePreview,
} from '@canopy/protocol/browser-profiles';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  SettingsGroup,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';
import {
  collidingProfileNames,
  profileNameQualifier,
} from '@/lib/browserProfileNames';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

/**
 * Readable trailing label for a profile row.
 *
 * Every Task profile is stored with the display name `Task`, so the list needs
 * a second fact to tell two of them apart. Prefer the names the user already
 * knows: the workspace and branch this profile belongs to. Fall back to a
 * short monospaced id only when the owning task is not in the sidebar (an
 * archived worktree, a cowork entry this view cannot resolve); an id is a
 * technical identifier of last resort here, never the primary label.
 *
 * The whole task must resolve for the friendly label to be used. A workspace
 * name on its own is not a label — every archived worktree under one workspace
 * would render the same words, which is exactly the collision this trailing
 * column exists to break. A partial answer falls through to the id.
 *
 * A named profile needs nothing: its name is already unique to the user, and a
 * second column repeating "Named profile" on every row would only compete with
 * it. The detail panel still states the kind for the selected profile.
 */
function taskScopeLabel(
  profile: BrowserProfileRecord,
  projects: SidebarItem[],
): { text: string; mono: boolean } {
  if (profile.kind !== 'task' || profile.owner.kind !== 'task')
    return { text: '', mono: false };
  const scope = profile.owner.taskScope;
  if (scope.kind === 'worktree') {
    const project = projects.find((item) => item.id === scope.projectId);
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find((entry) => entry.id === scope.worktreeId)
        : undefined;
    if (project && worktree)
      return { text: `${project.name} · ${worktree.branchName}`, mono: false };
  }
  return { text: profile.profileId.slice(0, 6), mono: true };
}

/**
 * The trailing label for one row: the task's scope, or — for the named profile
 * whose name another profile is also using — the short id that tells them
 * apart. Nothing enforces unique names, so two rows can otherwise be identical
 * and there is no way to pick the intended one.
 */
function rowLabel(
  profile: BrowserProfileRecord,
  projects: SidebarItem[],
  colliding: ReadonlySet<string>,
): { text: string; mono: boolean } {
  const qualifier = profileNameQualifier(profile, colliding);
  return qualifier
    ? { text: qualifier, mono: true }
    : taskScopeLabel(profile, projects);
}

export function BrowserProfilesSettings(): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const projects = useProjectsStore((state) => state.projects);
  const [cleanup, setCleanup] = useState<
    Awaited<
      ReturnType<typeof window.api.browser.profiles.cleanupStatus>
    >['jobs']
  >([]);
  const refreshCleanup = useCallback(async (): Promise<void> => {
    setCleanup((await window.api.browser.profiles.cleanupStatus()).jobs);
  }, []);
  const [profiles, setProfiles] = useState<BrowserProfileRecord[]>([]);
  const [nextOffset, setNextOffset] = useState<number>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectionEpoch = useRef(0);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<
    BrowserProfileDeletePreview & {
      selectionEpoch: number;
      displayName: string;
    }
  >();
  // The confirmation replaces the button that opened it, so focus has to be
  // carried across by hand: into the dialog when it appears, back to the
  // trigger when it closes. Without it a keyboard or screen-reader user is
  // dropped at the top of the page with a destructive prompt open somewhere
  // below them.
  const deleteDialog = useRef<HTMLDivElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const restoreDeleteFocus = useRef(false);
  const select = (profileId?: string): void => {
    if (selectedIdRef.current !== profileId) selectionEpoch.current++;
    selectedIdRef.current = profileId;
    setSelectedId(profileId);
    setPreview(undefined);
  };
  useEffect(
    () => (): void => {
      selectionEpoch.current++;
    },
    [],
  );
  const selected = profiles.find((profile) => profile.profileId === selectedId);
  const colliding = collidingProfileNames(profiles);
  const activePreview =
    preview &&
    preview.profileId === selected?.profileId &&
    preview.metadataRevision === selected.metadataRevision &&
    preview.selectionEpoch === selectionEpoch.current
      ? preview
      : undefined;
  // Both moves wait for the commit that swapped the two surfaces: the trigger
  // is unmounted while the prompt is open, so the restore has to land on the
  // button React has just mounted again, not the detached node that opened it.
  //
  // Restoring is keyed on an explicit dismissal rather than on the prompt
  // closing, because selecting another profile closes it too. Treating that as
  // a dismissal would pull focus off the row the user just clicked and onto a
  // *different* profile's delete button — a destructive control they never
  // aimed at. Only Cancel and Escape arm the flag.
  const deletePromptOpen = activePreview !== undefined;
  useEffect(() => {
    if (deletePromptOpen) {
      deleteDialog.current?.focus();
      return;
    }
    if (!restoreDeleteFocus.current) return;
    restoreDeleteFocus.current = false;
    deleteTrigger.current?.focus();
  }, [deletePromptOpen]);
  /** Dismiss the confirmation and hand focus back to the button that opened it. */
  const dismissDeletePrompt = (): void => {
    restoreDeleteFocus.current = true;
    setPreview(undefined);
  };
  const refreshSelected = useCallback(async (): Promise<void> => {
    if (selectedId) {
      const updated = await window.api.browser.profiles.get({
        profileId: selectedId,
      });
      setProfiles((current) =>
        current.map((profile) =>
          profile.profileId === updated.profileId ? updated : profile,
        ),
      );
    }
    await refreshCleanup();
  }, [selectedId, refreshCleanup]);
  useEffect(() => {
    void refreshCleanup().catch(() => undefined);
  }, [refreshCleanup]);

  const load = useCallback(async (offset = 0): Promise<void> => {
    setLoading(true);
    try {
      const page = await window.api.browser.profiles.list({ offset });
      setProfiles((current) =>
        Array.from(
          new Map(
            (offset ? [...current, ...page.profiles] : page.profiles).map(
              (profile) => [profile.profileId, profile],
            ),
          ).values(),
        ),
      );
      setNextOffset(page.nextOffset);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load().catch((cause) => setError(String(cause)));
  }, [load]);
  useEffect(() => {
    setRename(selected?.displayName ?? '');
    setPreview(undefined);
  }, [selected?.profileId, selected?.displayName]);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: BrowserProfilePatch): void => {
    if (!selected) return;
    void run(async () => {
      const updated = await window.api.browser.profiles.update({
        operationId: crypto.randomUUID(),
        profileId: selected.profileId,
        expectedMetadataRevision: selected.metadataRevision,
        patch,
      });
      setProfiles((current) =>
        current.map((profile) =>
          profile.profileId === updated.profileId ? updated : profile,
        ),
      );
    });
  };
  // The list, the selected profile's settings, and its browser data are
  // sections of the page; the page's spacing separates them.
  return (
    <>
      <SettingsSection
        title="Profiles"
        description="Keep logins separate, or reuse a named profile across tasks."
        ariaLabel="Browser profiles"
        dataTestId="browser-profiles-settings"
      >
        {error && (
          <Notice
            intent="destructive"
            actions={
              <NoticeButton
                onClick={() =>
                  void load().catch((cause) => setError(String(cause)))
                }
              >
                Refresh profiles
              </NoticeButton>
            }
          >
            {error}
          </Notice>
        )}
        {notice && <Notice intent="neutral">{notice}</Notice>}
        {cleanup.length > 0 && (
          <Notice
            intent="attention"
            data-testid="browser-profile-cleanup-jobs"
            title={`${cleanup.length} retired ${cleanup.length === 1 ? 'store' : 'stores'} pending cleanup`}
            detail={summarizeCleanup(cleanup)}
            actions={
              <NoticeButton
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await window.api.browser.profiles.retryCleanup();
                    await refreshCleanup();
                  })
                }
              >
                Retry cleanup
              </NoticeButton>
            }
          >
            Browser data from deleted or reset profiles is still on disk.
          </Notice>
        )}
        <SettingsGroup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const profile = await window.api.browser.profiles.create({
                  operationId: crypto.randomUUID(),
                  input: { displayName: name },
                });
                setProfiles((current) => [...current, profile]);
                select(profile.profileId);
                setName('');
              });
            }}
          >
            <SettingsRow
              label="New profile"
              htmlFor="browser-profile-new-name"
              control={
                <>
                  <SettingsTextField
                    id="browser-profile-new-name"
                    width="md"
                    aria-label="New profile name"
                    data-testid="browser-profile-new-name"
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Personal or Work"
                  />
                  <Button
                    size={settingsButtonSize}
                    type="submit"
                    variant="primary"
                    data-testid="browser-profile-create"
                    disabled={busy || !name.trim()}
                  >
                    Create profile
                  </Button>
                </>
              }
            />
          </form>
          {profiles.map((profile) => (
            // The row keeps the group's padding and hairline; the button
            // bleeds into that padding so the selected ring sits clear of
            // the text, which stays on the rows' shared edge.
            <div key={profile.profileId} className="flex min-h-7 items-center">
              <button
                type="button"
                data-testid={`browser-profile-row-${profile.profileId}`}
                aria-pressed={selectedId === profile.profileId}
                onClick={() => select(profile.profileId)}
                className={`focus-ring -mx-2 -my-1.5 flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-s fg-primary transition-colors ${
                  selectedId === profile.profileId
                    ? 'bg-accent-subtle ring-1 ring-line-accent'
                    : 'hover:bg-subtle'
                }`}
              >
                <BrowserProfileBadge
                  name={profile.displayName}
                  color={profile.color}
                />
                <ScopeLabel {...rowLabel(profile, projects, colliding)} />
              </button>
            </div>
          ))}
          {/* First load only: loading more keeps the listed profiles and
              holds the button until the next page arrives. */}
          {loading && profiles.length === 0 && (
            <SettingsLoading rows={2} dataTestId="browser-profiles-loading" />
          )}
          {!loading && !error && profiles.length === 0 && (
            <p className="text-s fg-secondary">
              No profiles yet. Opening a browser creates its Task profile.
            </p>
          )}
          {nextOffset !== undefined && (
            <div>
              <Button
                size={settingsButtonSize}
                variant="ghost"
                disabled={loading}
                onClick={() => void run(() => load(nextOffset))}
              >
                Load more profiles
              </Button>
            </div>
          )}
        </SettingsGroup>
      </SettingsSection>
      {selected && (
        // Automation scopes the profile's settings and its browser data
        // together; `contents` keeps both sections direct items of the page.
        <div className="contents" data-testid="browser-profile-details">
          <SettingsSection
            title={
              <BrowserProfileBadge
                name={selected.displayName}
                color={selected.color}
                className="max-w-full"
              />
            }
            headingId="browser-profile-details-heading"
            description={
              selected.kind === 'task'
                ? 'Task profile. It belongs to one worktree or work entry.'
                : 'Named profile. Reuse it across tasks.'
            }
          >
            <SettingsGroup>
              {selected.kind === 'named' && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    update({ displayName: rename });
                  }}
                >
                  <SettingsRow
                    label="Name"
                    htmlFor="browser-profile-rename"
                    control={
                      <>
                        <SettingsTextField
                          id="browser-profile-rename"
                          width="md"
                          aria-label="Profile name"
                          value={rename}
                          maxLength={100}
                          onChange={(event) => setRename(event.target.value)}
                        />
                        <Button
                          size={settingsButtonSize}
                          type="submit"
                          variant="secondary"
                          disabled={busy || !rename.trim()}
                        >
                          Rename
                        </Button>
                      </>
                    }
                  />
                </form>
              )}
              {selected.kind === 'named' && (
                <SettingsRow
                  label="Color"
                  control={
                    <ColorSwatchPicker
                      value={selected.color}
                      disabled={busy}
                      testId="browser-profile-color-swatches"
                      onChange={(color) => update({ color })}
                    />
                  }
                />
              )}
              {/* The shared permissions control lays out both agent
                  permissions itself, so together they are one row here. */}
              <BrowserProfilePermissions
                task={selected.kind === 'task'}
                allowEnable={selected.agentPermissions.allowEnable}
                allowClear={selected.agentPermissions.allowClear}
                disabled={busy}
                onEnableChange={(allowEnable) => update({ allowEnable })}
                onClearChange={(allowClear) => update({ allowClear })}
              />
              {selected.kind === 'named' && !activePreview && (
                <SettingsRow
                  label="Delete profile"
                  description="Removes this profile and its browser data."
                  control={
                    <Button
                      size={settingsButtonSize}
                      ref={deleteTrigger}
                      variant="destructive"
                      data-testid="browser-profile-delete"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const epoch = selectionEpoch.current;
                          const result =
                            await window.api.browser.profiles.previewDelete({
                              profileId: selected.profileId,
                              expectedMetadataRevision:
                                selected.metadataRevision,
                            });
                          if (
                            epoch === selectionEpoch.current &&
                            selectedIdRef.current === selected.profileId &&
                            result.profileId === selected.profileId
                          )
                            setPreview({
                              ...result,
                              selectionEpoch: epoch,
                              displayName: selected.displayName,
                            });
                        })
                      }
                    >
                      Delete profile
                    </Button>
                  }
                />
              )}
              {activePreview && (
                <div
                  ref={deleteDialog}
                  tabIndex={-1}
                  role="alertdialog"
                  aria-label="Delete browser profile"
                  className="flex items-start justify-between gap-6 focus:outline-none"
                  data-testid="browser-profile-delete-preview"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && !busy) {
                      event.preventDefault();
                      event.stopPropagation();
                      dismissDeletePrompt();
                    }
                  }}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-s font-medium fg-primary">
                      Delete “{activePreview.displayName}” and its browser data?
                    </p>
                    <p className="text-xs text-pretty fg-secondary">
                      Open pages will close and unsaved changes will be lost.
                      {activePreview.tabs.length > 0
                        ? ` ${activePreview.tabs.length} saved ${activePreview.tabs.length === 1 ? 'tab becomes' : 'tabs become'} unavailable.`
                        : ''}
                      {activePreview.defaults.length > 0
                        ? ` ${activePreview.defaults.length} task ${activePreview.defaults.length === 1 ? 'default needs' : 'defaults need'} another profile.`
                        : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size={settingsButtonSize}
                      variant="ghost"
                      disabled={busy}
                      onClick={dismissDeletePrompt}
                    >
                      Cancel
                    </Button>
                    <Button
                      size={settingsButtonSize}
                      variant="destructive"
                      data-testid="browser-profile-confirm-delete"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (
                            activePreview.selectionEpoch !==
                              selectionEpoch.current ||
                            activePreview.profileId !== selectedIdRef.current
                          )
                            return;
                          const result =
                            await window.api.browser.profiles.delete({
                              operationId: crypto.randomUUID(),
                              token: activePreview.token,
                            });
                          select(undefined);
                          setPreview(undefined);
                          await load();
                          await refreshCleanup();
                          setNotice(
                            result.cleanupPending
                              ? 'Profile deleted. Storage cleanup is still running.'
                              : 'Profile deleted.',
                          );
                        })
                      }
                    >
                      Delete profile
                    </Button>
                  </div>
                </div>
              )}
            </SettingsGroup>
          </SettingsSection>
          <BrowserProfileDataSettings
            key={`${selected.profileId}:${selected.storageGeneration}`}
            profile={selected}
            api={window.api.browser.profiles}
            onChanged={refreshSelected}
          />
        </div>
      )}
    </>
  );
}

/** Trailing identity for a profile row: a name, or a monospaced id fallback. */
function ScopeLabel({
  text,
  mono,
}: {
  text: string;
  mono: boolean;
}): JSX.Element | null {
  if (!text) return null;
  return (
    <span
      className={`max-w-48 shrink-0 truncate text-s fg-tertiary ${mono ? 'font-mono' : ''}`}
    >
      {text}
    </span>
  );
}

/**
 * One readable line for the pending retired-storage jobs.
 *
 * A failure carries a diagnostic message, and it is the only thing that tells
 * the user why Retry might not work either — a locked file, a missing
 * directory. Counting the failures without saying what went wrong leaves them
 * pressing the same button. One message is enough: the failures in a batch are
 * near-always the same cause, and the notice is a summary line, not a log.
 */
function summarizeCleanup(
  jobs: Awaited<
    ReturnType<typeof window.api.browser.profiles.cleanupStatus>
  >['jobs'],
): string {
  const waiting = jobs.filter((job) => job.status === 'pending_restart').length;
  const failures = jobs.filter((job) => job.status === 'failed');
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} waiting for an app restart`);
  if (failures.length) parts.push(`${failures.length} needing attention`);
  if (!parts.length) return 'Cleanup is queued.';
  const reason = failures.find((job) => job.message)?.message;
  return reason ? `${parts.join(', ')}. ${reason}` : parts.join(', ');
}
