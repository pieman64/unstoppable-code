// Modal that lists every watcher matching a surface (pipeline card,
// pipeline detail, chat panel, or the Automations Watchers tab) and exposes
// the per-watcher actions the user can take: jump to the subscribing chat
// and delete (with an optional "notify subscribing chat" checkbox).
//
// The modal does not hydrate the watcher store itself — the caller owns
// subscription and passes a fresh snapshot in via `watchers`. When a delete
// succeeds, the App Advisor watcher broadcast removes the row from the next
// snapshot the caller passes in; the modal therefore only needs to maintain
// per-row confirmation state.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherSummary,
  AppAdvisorWatcherTarget,
  AppAdvisorWatcherTriggerType,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  useAppAdvisorWatchersStore,
  type AppAdvisorWatchersStore,
} from '@/stores/appAdvisorWatchersStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import {
  formatGitHubRunSampleLabel,
  formatRelativeTime,
  githubRunSampleOverflow,
  githubWatcherTargetDisplay,
  liveWatcherDestinationTitle,
  triggerTitle,
  watcherDestinationDisplay,
  watcherOwnerDelegateDisplay,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
  localWatcherProgressLabel,
  watcherTitleReplayClass,
} from './watcherDisplay';
import { jumpToWatcherSubscriberChat } from './jumpToWatcherSubscriberChat';
import {
  WatcherRecipientPicker,
  type WatcherRecipientGroup,
} from './WatcherRecipientPicker';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * Opt-in configuration enabling the modal's "Add a watcher" section. When
 * present the modal renders a recipient picker plus an optional follow-up
 * instruction field that creates a watcher with the supplied trigger/target and
 * the chosen recipient as destination.
 */
export interface WatcherManagementModalAddConfig {
  trigger: AppAdvisorWatcherTriggerType;
  target: AppAdvisorWatcherTarget;
  recipientGroups: WatcherRecipientGroup[];
  /** Heading for the add section. Defaults to "Add a watcher". */
  heading?: string;
  /** Helper text under the heading. */
  description?: string;
}

export interface WatcherManagementModalProps {
  title: string;
  emptyMessage: string;
  watchers: AppAdvisorWatcherSummary[];
  onClose: () => void;
  /**
   * Optional override for the jump-to-chat action. The default behavior is
   * {@link jumpToWatcherSubscriberChat}; the Automations Watchers tab passes
   * its own implementation so it can keep the page open while emitting an
   * inline row-level error.
   */
  onJumpToChat?: (
    watcher: AppAdvisorWatcherSummary,
  ) => { ok: true } | { ok: false; error: string };
  /** When provided, renders the "Add a watcher" section. */
  add?: WatcherManagementModalAddConfig;
  /** When true, each row exposes an inline edit-follow-up affordance. */
  allowEditFollowUp?: boolean;
  /** Document that owns the invoking surface, including auxiliary windows. */
  ownerDocument?: Document;
}

interface RowJumpError {
  watcherId: string;
  message: string;
}

export function WatcherManagementModal({
  title,
  emptyMessage,
  watchers,
  onClose,
  onJumpToChat,
  add,
  allowEditFollowUp = false,
  ownerDocument,
}: WatcherManagementModalProps): JSX.Element {
  const modalDocument = ownerDocument ?? document;
  const deleteErrors = useAppAdvisorWatchersStore((s) => s.deleteErrors);
  const deleteWatcher = useAppAdvisorWatchersStore(
    (s): AppAdvisorWatchersStore['deleteWatcher'] => s.deleteWatcher,
  );
  const createWatcher = useAppAdvisorWatchersStore(
    (s): AppAdvisorWatchersStore['createWatcher'] => s.createWatcher,
  );
  const updateWatcherFollowUp = useAppAdvisorWatchersStore(
    (s): AppAdvisorWatchersStore['updateWatcherFollowUp'] =>
      s.updateWatcherFollowUp,
  );
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const confirmingDeleteRef = useRef(confirmingDeleteId);
  confirmingDeleteRef.current = confirmingDeleteId;
  const [notifySubscriber, setNotifySubscriber] = useState(false);
  const [jumpError, setJumpError] = useState<RowJumpError | null>(null);
  // Row-aligned current titles, so a renamed subscribing chat shows its name.
  const liveDestinationTitles = useChatSidebarStore(
    useShallow((s) =>
      watchers.map((watcher) =>
        liveWatcherDestinationTitle(s.worktrees, watcher.destination),
      ),
    ),
  );

  // Add-section state.
  const [addRecipient, setAddRecipient] =
    useState<AppAdvisorWatcherDestination | null>(null);
  const [addFollowUp, setAddFollowUp] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  // Per-row follow-up edit state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const handleAdd = useCallback(async (): Promise<void> => {
    if (!add) return;
    if (!addRecipient) {
      setAddError('Select a chat to notify.');
      return;
    }
    setAddBusy(true);
    setAddError(null);
    const trimmed = addFollowUp.trim();
    const result = await createWatcher({
      destination: addRecipient,
      watcher: {
        trigger: add.trigger,
        target: add.target,
        followUpInstruction: trimmed.length > 0 ? trimmed : undefined,
      },
    });
    setAddBusy(false);
    if (result.ok) {
      // Reset the picker: the just-added destination is removed from the
      // available recipients, so clear the selection back to the placeholder.
      setAddRecipient(null);
      setAddFollowUp('');
      setAddError(null);
    } else {
      setAddError(result.error);
    }
  }, [add, addRecipient, addFollowUp, createWatcher]);

  const handleStartEdit = useCallback(
    (watcher: AppAdvisorWatcherSummary): void => {
      setEditingId(watcher.id);
      setEditText(watcher.followUpInstruction ?? '');
      setEditError(null);
    },
    [],
  );

  const handleSaveEdit = useCallback(async (): Promise<void> => {
    if (!editingId) return;
    setEditBusy(true);
    setEditError(null);
    const result = await updateWatcherFollowUp(editingId, editText);
    setEditBusy(false);
    if (result.ok) {
      setEditingId(null);
      setEditText('');
    } else {
      setEditError(result.error);
    }
  }, [editingId, editText, updateWatcherFollowUp]);
  const modalChatId = useMemo(() => {
    const chatIds = new Set(
      watchers
        .map((watcher) => watcher.destination.chatId)
        .filter((chatId): chatId is string => typeof chatId === 'string'),
    );
    return chatIds.size === 1 ? Array.from(chatIds)[0] : undefined;
  }, [watchers]);

  useCurrentUiStateReporter('appAdvisor.watchersModal', {
    open: true,
    watcherCount: watchers.length,
    confirmingDelete: confirmingDeleteId !== null,
    ...(modalChatId ? { chatId: modalChatId } : {}),
  });

  // Close on Escape — mirrors the existing App Advisor watcher modal.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    modalDocument.addEventListener('keydown', handleKeyDown);
    return (): void => {
      modalDocument.removeEventListener('keydown', handleKeyDown);
    };
  }, [modalDocument, onClose]);

  // If the row currently in confirmation state disappears (delete broadcast
  // or filter change), reset the local UI state so we never confirm-delete
  // against a stale id.
  useEffect(() => {
    if (
      confirmingDeleteId &&
      !watchers.some((watcher) => watcher.id === confirmingDeleteId)
    ) {
      setConfirmingDeleteId(null);
      setNotifySubscriber(false);
    }
    if (jumpError && !watchers.some((w) => w.id === jumpError.watcherId)) {
      setJumpError(null);
    }
    if (editingId && !watchers.some((w) => w.id === editingId)) {
      setEditingId(null);
      setEditText('');
      setEditError(null);
    }
  }, [watchers, confirmingDeleteId, jumpError, editingId]);

  const handleDeleteClick = useCallback(
    (watcherId: string): void => {
      if (confirmingDeleteId !== watcherId) {
        setConfirmingDeleteId(watcherId);
        setNotifySubscriber(false);
        return;
      }
      // Second click — actually perform the delete with the current notify
      // selection. Success is acknowledged by the next watcher snapshot
      // (which drops the row); failures surface in `deleteErrors`.
      const requestedNotify = notifySubscriber;
      void deleteWatcher(watcherId, {
        notifySubscriber: requestedNotify,
      }).then((result) => {
        // Another row may have been armed while this delete was settling.
        if (result.ok && confirmingDeleteRef.current === watcherId) {
          setConfirmingDeleteId(null);
          setNotifySubscriber(false);
        }
      });
    },
    [confirmingDeleteId, deleteWatcher, notifySubscriber],
  );

  const handleCancelDelete = useCallback((): void => {
    setConfirmingDeleteId(null);
    setNotifySubscriber(false);
  }, []);

  const handleJumpClick = useCallback(
    (watcher: AppAdvisorWatcherSummary): void => {
      const result = onJumpToChat
        ? onJumpToChat(watcher)
        : jumpToWatcherSubscriberChat(watcher);
      if (result.ok) {
        setJumpError(null);
        // For the App Advisor / management button case we close the modal so
        // the user can see the destination chat they just jumped to. The
        // Automations page passes its own onJumpToChat that returns ok and
        // also closes the page-level modal it owns.
        onClose();
      } else {
        setJumpError({ watcherId: watcher.id, message: result.error });
      }
    },
    [onClose, onJumpToChat],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-overlay-scrim px-4 pt-[15vh]"
      data-testid="watcher-management-modal-backdrop"
      onClick={onClose}
    >
      {/* Command watcher titles and follow-up instructions are blocked. */}
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="watcher-management-modal"
        className="electron-no-drag flex max-h-[70vh] w-full max-w-144 flex-col overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(event): void => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-s font-semibold fg-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring rounded-md p-1 fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
          >
            <AppCatalogCloseIcon width="14" height="14" aria-hidden="true" />
          </button>
        </header>
        {add && (
          <div
            className="border-b px-4 py-3"
            data-testid="watcher-management-add-section"
          >
            <div className="text-xs font-semibold fg-secondary">
              {add.heading ?? 'Add a watcher'}
            </div>
            {add.description && (
              <p className="mt-1 text-2xs fg-secondary">{add.description}</p>
            )}
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-2xs fg-secondary">
                  Notify
                </span>
                <WatcherRecipientPicker
                  groups={add.recipientGroups}
                  value={addRecipient}
                  onChange={(destination): void => {
                    setAddRecipient(destination);
                    setAddError(null);
                  }}
                  dataTestId="watcher-management-add-recipient"
                />
              </div>
              <textarea
                value={addFollowUp}
                onChange={(event): void => setAddFollowUp(event.target.value)}
                placeholder="Optional follow-up instruction for the notified chat…"
                rows={2}
                data-testid="watcher-management-add-followup"
                className="focus-ring w-full resize-none rounded-md border bg-popover px-2 py-1.5 text-xs fg-primary placeholder:fg-secondary"
              />
              <div className="flex items-center justify-between gap-2">
                {addError ? (
                  <span
                    role="alert"
                    data-testid="watcher-management-add-error"
                    className="text-2xs fg-destructive"
                  >
                    {addError}
                  </span>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  disabled={addBusy || !addRecipient}
                  onClick={(): void => {
                    void handleAdd();
                  }}
                  data-testid="watcher-management-add-submit"
                  className="focus-ring rounded-md border border-fg-info/30 bg-info-subtle px-3 py-1 text-xs font-medium fg-info transition hover:bg-info-subtle/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {addBusy ? 'Adding…' : 'Add watcher'}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
          {watchers.length === 0 ? (
            <p
              className="text-s fg-secondary"
              data-testid="watcher-management-empty"
            >
              {emptyMessage}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {watchers.map((watcher, index) => {
                const target = watcherTargetDisplay(watcher.target);
                const github = githubWatcherTargetDisplay(watcher.target);
                const destinationLabel = watcherDestinationDisplay(
                  watcher.destination,
                  liveDestinationTitles[index],
                );
                const owner = watcher.ownerDelegate
                  ? watcherOwnerDelegateDisplay(watcher.ownerDelegate)
                  : null;
                const isConfirming = confirmingDeleteId === watcher.id;
                const deleteError = deleteErrors[watcher.id];
                const rowJumpError =
                  jumpError?.watcherId === watcher.id
                    ? jumpError.message
                    : null;
                return (
                  <li
                    key={watcher.id}
                    data-testid={`watcher-management-row-${watcher.id}`}
                    className="rounded-lg border bg-fg-primary/[0.02] p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div
                          className={`${watcherTitleReplayClass(watcher.target)} truncate text-s font-medium fg-primary`}
                        >
                          {watcher.label || target.title}
                        </div>
                        <div className="mt-0.5 truncate text-xs fg-secondary">
                          {triggerTitle(watcher.trigger)}
                        </div>
                        {watcher.localProgress && (
                          <div
                            className="mt-1 text-xs fg-secondary"
                            data-testid={`local-watcher-progress-${watcher.id}`}
                          >
                            {localWatcherProgressLabel(watcher)}
                          </div>
                        )}
                        <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                          <div className="contents">
                            <dt className="fg-secondary">Watching</dt>
                            <dd className="min-w-0 break-words fg-primary">
                              <span
                                className={`${watcherTitleReplayClass(watcher.target)} font-medium`}
                              >
                                {target.title}
                              </span>
                              {target.subtitle && (
                                <span className="ml-1 fg-secondary">
                                  · {target.subtitle}
                                </span>
                              )}
                            </dd>
                          </div>
                          <div className="contents">
                            <dt className="fg-secondary">Subscribed chat</dt>
                            <dd
                              className="min-w-0 break-words fg-primary"
                              data-testid={`watcher-management-destination-${watcher.id}`}
                            >
                              {destinationLabel}
                            </dd>
                          </div>
                          {owner && (
                            <div className="contents">
                              <dt className="fg-secondary">Delegate</dt>
                              <dd
                                className="min-w-0 break-words fg-primary"
                                data-testid={`watcher-management-owner-${watcher.id}`}
                              >
                                {owner.name}
                                {owner.detail && (
                                  <span className="fg-secondary">
                                    {` · ${owner.detail}`}
                                  </span>
                                )}
                              </dd>
                            </div>
                          )}
                          <div className="contents">
                            <dt className="fg-secondary">Created</dt>
                            <dd className="min-w-0 break-words fg-primary">
                              {formatRelativeTime(watcher.createdAt)}
                            </dd>
                          </div>
                          <div className="contents">
                            <dt className="fg-secondary">Status</dt>
                            <dd
                              className="min-w-0 break-words fg-primary"
                              data-testid={`watcher-management-status-${watcher.id}`}
                            >
                              {watcherStatusLabelWithFailure(
                                watcher.status,
                                watcher.failureKind,
                              )}
                            </dd>
                          </div>
                          {watcher.status === 'delivery_failed' &&
                            watcher.deliveryError && (
                              <div className="contents">
                                <dt className="fg-secondary">Delivery error</dt>
                                <dd
                                  className="min-w-0 break-words fg-destructive"
                                  data-testid={`watcher-management-delivery-error-${watcher.id}`}
                                >
                                  {watcher.deliveryError}
                                </dd>
                              </div>
                            )}
                        </dl>
                        {github &&
                          (github.filters.length > 0 ||
                            github.sample.length > 0) && (
                            <div
                              className="mt-2 flex flex-col gap-1"
                              data-testid={`watcher-management-github-${watcher.id}`}
                            >
                              {github.filters.length > 0 && (
                                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
                                  {github.filters.map((filter) => (
                                    <span key={filter.label}>
                                      <span className="fg-secondary">
                                        {filter.label}:
                                      </span>{' '}
                                      <span className="fg-primary">
                                        {filter.value}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}
                              {github.sample.length > 0 && (
                                <ul className="flex flex-col gap-0.5">
                                  {github.sample.map((run) => (
                                    <li
                                      key={`${run.repository}#${run.runId}`}
                                      className="truncate text-2xs fg-secondary"
                                    >
                                      {formatGitHubRunSampleLabel(run)}
                                    </li>
                                  ))}
                                  {githubRunSampleOverflow(
                                    github,
                                    github.sample.length,
                                  ) > 0 && (
                                    <li className="text-2xs fg-secondary/80">
                                      +
                                      {githubRunSampleOverflow(
                                        github,
                                        github.sample.length,
                                      )}{' '}
                                      more
                                    </li>
                                  )}
                                </ul>
                              )}
                            </div>
                          )}
                        {(watcher.followUpInstruction || allowEditFollowUp) && (
                          <div className="mt-2 text-xs">
                            {editingId === watcher.id ? (
                              <div className="flex flex-col gap-1">
                                <span className="fg-secondary">
                                  Follow-up instruction
                                </span>
                                <textarea
                                  value={editText}
                                  onChange={(event): void =>
                                    setEditText(event.target.value)
                                  }
                                  rows={2}
                                  placeholder="Instruction for the notified chat…"
                                  data-testid={`watcher-management-edit-followup-${watcher.id}`}
                                  className="focus-ring w-full resize-none rounded-md border bg-popover px-2 py-1.5 text-xs fg-primary placeholder:fg-secondary"
                                />
                                {editError && (
                                  <span
                                    role="alert"
                                    data-testid={`watcher-management-edit-error-${watcher.id}`}
                                    className="text-2xs fg-destructive"
                                  >
                                    {editError}
                                  </span>
                                )}
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={editBusy}
                                    onClick={(): void => {
                                      void handleSaveEdit();
                                    }}
                                    data-testid={`watcher-management-edit-save-${watcher.id}`}
                                    className="focus-ring rounded-md border border-fg-info/30 bg-info-subtle px-2 py-1 text-2xs font-medium fg-info transition hover:bg-info-subtle/80 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    {editBusy ? 'Saving…' : 'Save'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(): void => {
                                      setEditingId(null);
                                      setEditText('');
                                      setEditError(null);
                                    }}
                                    className="text-2xs fg-secondary underline hover:fg-primary"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <span className="fg-secondary">
                                    Follow-up
                                  </span>{' '}
                                  <span
                                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} break-words fg-primary`}
                                  >
                                    {watcher.followUpInstruction || 'None'}
                                  </span>
                                </div>
                                {allowEditFollowUp && (
                                  <button
                                    type="button"
                                    onClick={(): void =>
                                      handleStartEdit(watcher)
                                    }
                                    data-testid={`watcher-management-edit-followup-button-${watcher.id}`}
                                    className="focus-ring shrink-0 rounded-md border bg-popover px-2 py-0.5 text-2xs fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary"
                                  >
                                    Edit
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(): void => handleJumpClick(watcher)}
                            data-testid={`watcher-management-jump-${watcher.id}`}
                            className="focus-ring rounded-md border bg-popover px-2 py-1 text-xs fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary"
                          >
                            Jump to chat
                          </button>
                          {isConfirming ? (
                            <button
                              type="button"
                              onClick={(): void =>
                                handleDeleteClick(watcher.id)
                              }
                              data-testid={`watcher-management-confirm-delete-${watcher.id}`}
                              className="focus-ring rounded-md border border-line-destructive/40 bg-destructive-subtle px-2 py-1 text-xs font-medium fg-destructive transition hover:bg-destructive-subtle/80"
                            >
                              Confirm delete
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(): void =>
                                handleDeleteClick(watcher.id)
                              }
                              data-testid={`watcher-management-delete-${watcher.id}`}
                              className="focus-ring rounded-md border bg-popover px-2 py-1 text-xs fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                        {isConfirming && (
                          <div className="flex flex-col items-end gap-0.5">
                            <label className="inline-flex items-center gap-1.5 text-2xs fg-secondary">
                              <input
                                type="checkbox"
                                checked={notifySubscriber}
                                data-testid={`watcher-management-notify-${watcher.id}`}
                                onChange={(event): void =>
                                  setNotifySubscriber(event.target.checked)
                                }
                                className="h-3 w-3 rounded border bg-popover fg-accent focus-ring"
                              />
                              Notify subscribing chat
                            </label>
                            <span className="max-w-64 text-right text-3xs fg-secondary">
                              Sends a final watcher-deleted message to the chat
                              that subscribed to this watcher.
                            </span>
                            <button
                              type="button"
                              onClick={handleCancelDelete}
                              className="text-3xs fg-secondary underline hover:fg-primary"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        {deleteError && (
                          <span
                            role="alert"
                            data-testid={`watcher-management-delete-error-${watcher.id}`}
                            className="text-2xs fg-destructive"
                          >
                            Could not delete watcher.
                          </span>
                        )}
                        {rowJumpError && (
                          <span
                            role="alert"
                            data-testid={`watcher-management-jump-error-${watcher.id}`}
                            className="text-2xs fg-destructive"
                          >
                            {rowJumpError}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>,
    modalDocument.body,
  );
}
