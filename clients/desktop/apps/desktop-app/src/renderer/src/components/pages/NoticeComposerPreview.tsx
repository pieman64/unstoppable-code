import { useEffect, useRef, useState, type JSX } from 'react';
import type { ActiveComposerView } from '@/components/chat/types';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  NOTICE_GALLERY_SECTIONS,
  type NoticeGalleryEntry,
} from './noticeStateGalleryData';
import { Heading } from '@canopy/ui-shared/components';

/**
 * The composer preview at the top of the Notice States gallery: the real
 * `ChatInput` on the real chat ground, so a notice is reviewed at the width
 * and against the surface it actually ships on rather than in an isolated
 * row. The selected notice rides in `beforeComposer`, the slot just under
 * the live notice stack, and carries that stack's own bottom margin so it
 * sits exactly where a raised notice does.
 *
 * The composer is the shipping component, not a mock, so it is pointed at a
 * chat that cannot exist. That matters: several of its controls fall back to
 * the SELECTED worktree's active tab when no `targetOverride` is given
 * (`getWorktreeChatContext` and `togglePlanMode` both read `selectedWorktree`
 * plus `activeTabId`), so an unpointed preview would edit whichever real chat
 * the developer had open. With the synthetic target every one of those
 * lookups misses its `worktreeChats` key and bails.
 *
 * The inert `onSendMessage` is load-bearing too, not decoration: passing it
 * without `nativeSessionComposer` is what nulls `bannerTarget` and
 * `sessionChatTarget` inside `ChatInput`, which stands down the live banner
 * stack, the tool-approval dock, scheduled send, and usage-limit resume. It
 * also swallows every send. Paste and drop are swallowed here, because those
 * two handlers copy files into a workspace before any target check.
 *
 * One residual: the composer's own attach item still opens a file dialog,
 * and picking a file writes under the synthetic workspace id rather than a
 * real one. Nothing reads that directory and no shipping prop hides the
 * affordance, so it is left alone rather than bent around a dev page.
 */

/**
 * Ids that no real project, worktree, or chat can hold, so every target-keyed
 * store lookup inside the composer misses.
 */
const PREVIEW_TARGET = {
  projectId: 'notice-states-preview',
  worktreeId: 'notice-states-preview',
  chatId: 'notice-states-preview',
} as const;

/** A chat that exists only for layout. */
const PREVIEW_TAB: ActiveComposerView = {
  id: 'notice-states-preview',
  title: 'Notice preview',
  status: 'idle',
  error: null,
  hasStartedSession: false,
  shareSessionBusy: false,
  planMode: false,
  proposalMode: 'optional',
  thinkingLevel: 'high',
  modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
  providerType: 'claude',
};

const COMPOSER_ENTRIES: readonly NoticeGalleryEntry[] =
  NOTICE_GALLERY_SECTIONS.find((section) => section.id === 'composer')
    ?.entries ?? [];

/** Matches the picker chips on the sibling Activity States gallery. */
function chipClass(selected: boolean): string {
  return `focus-ring min-h-7 rounded-md px-2 text-2xs pointer-coarse:min-h-11 ${
    selected
      ? 'bg-accent-subtle fg-accent'
      : 'fg-secondary hover:bg-secondary hover:fg-primary'
  }`;
}

export function NoticeComposerPreview({
  renderNotice,
}: {
  /** Renders one gallery entry through the shared `Notice`. */
  renderNotice: (entry: NoticeGalleryEntry) => JSX.Element;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(
    COMPOSER_ENTRIES[0]?.id ?? null,
  );
  const selected =
    COMPOSER_ENTRIES.find((entry) => entry.id === selectedId) ?? null;
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Paste and drop reach `importWorktreeAttachments` before any target
  // check, so they would copy a pasted screenshot into a real workspace.
  // This takes plain-text paste with it, which is the accepted cost: the
  // handler cannot tell the two apart before it has already resolved a
  // destination.
  // `ChatInput` takes drops on its chat area, or on its own root when no
  // ancestor is marked as one (as here), so this ancestor capture listener
  // still wins.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return undefined;
    const swallow = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    el.addEventListener('drop', swallow, true);
    el.addEventListener('paste', swallow, true);
    return (): void => {
      el.removeEventListener('drop', swallow, true);
      el.removeEventListener('paste', swallow, true);
    };
  }, []);

  return (
    <section
      className="mb-12"
      data-testid="notice-gallery-section-composer-preview"
    >
      <Heading level={2} variant="title" className="mb-1">
        In the composer
      </Heading>
      <p className="mb-3 max-w-3xl text-xs fg-secondary">
        The shipping composer at its real width, on the chat surface. Pick a
        notice to raise it where the live stack sits, directly above the input.
        Typing and sending do nothing.
      </p>

      <div
        className="mb-3 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Composer notices"
        data-testid="notice-preview-picker"
      >
        <button
          type="button"
          onClick={(): void => setSelectedId(null)}
          className={chipClass(selectedId === null)}
          data-testid="notice-preview-pick-none"
          aria-pressed={selectedId === null}
        >
          No notice
        </button>
        {COMPOSER_ENTRIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={(): void => setSelectedId(entry.id)}
            className={chipClass(entry.id === selectedId)}
            data-testid={`notice-preview-pick-${entry.id}`}
            aria-pressed={entry.id === selectedId}
          >
            {entry.title}
          </button>
        ))}
      </div>

      {/* The composer centers itself at `--chat-composer-shell-width`, so the
          frame stays full width and lets it find its own measure, exactly as
          the chat panel does. */}
      <div
        ref={surfaceRef}
        className="flex min-h-155 flex-col justify-end rounded-xl bg-base ring-[length:var(--border-hairline)] ring-line-secondary"
        data-testid="notice-preview-surface"
      >
        <ChatInput
          tab={PREVIEW_TAB}
          targetOverride={PREVIEW_TARGET}
          composerShortcutsEnabled={false}
          // A plan-mode toggle with no session behind it can only mislead.
          hidePlanMode
          hideDirectoryPicker
          disableFileTypeahead
          disableTerminalMode
          onSendMessage={(): Promise<void> => Promise.resolve()}
          {...(selected
            ? {
                // `mb-1.5` mirrors the live stack's own bottom margin
                // (`chat-input-notices` in `ChatInput`); keep the two in
                // step so this page shows the real gap.
                beforeComposer: (
                  <div className="mb-1.5">{renderNotice(selected)}</div>
                ),
              }
            : {})}
        />
      </div>
    </section>
  );
}
