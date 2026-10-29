/**
 * Generic markdown-item activity card shared by Notes and Prompts (they are
 * the same UX with different labels, storage kind, and mention semantics).
 * Workspace-global: the list is keyed by `projectId`; `worktreeId` only
 * tags newly created items with their origin worktree.
 */
import {
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type JSX,
} from 'react';
import type { WorkspaceNoteItem } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  HeaderActionButton,
  Markdown,
  markdownOptions,
} from '@canopy/ui-shared/components';
import {
  PanelSection,
  type CollapsedIconColor,
} from '@/components/shared/panel-section';
import { DialogModal } from '@/components/shared/DialogModal';
import {
  useWorkspaceItemsStore,
  workspaceItemsKey,
} from '@/stores/workspaceItemsStore';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { buildFileReferenceDisplayPath } from '@/lib/fileMentionSearch';
import {
  dispatchWorkspaceItemMention,
  InlineDeleteConfirm,
  ItemMetaInfo,
  MentionIcon,
  PlusIcon,
  RowActionButton,
  RowActionTray,
  TrashIcon,
  useInlineDelete,
} from './workspace-items-shared';

function isSafeMarkdownImageSource(source: string): boolean {
  const value = source.trim();
  if (value.length === 0 || /^[\\/]{2}/.test(value)) return false;

  const protocolMatch = /^([a-z][a-z\d+.-]*):/i.exec(value);
  if (protocolMatch === null) return true;

  const protocol = protocolMatch[1].toLowerCase();
  return protocol === 'blob' || protocol === 'data';
}

function SafeMarkdownImage({
  src,
  alt,
}: ComponentProps<'img'>): JSX.Element | null {
  if (typeof src !== 'string' || !isSafeMarkdownImageSource(src)) {
    return alt ? <span>{alt}</span> : null;
  }
  return <img src={src} alt={alt} />;
}

const WORKSPACE_ITEM_MARKDOWN_OPTIONS = markdownOptions({
  img: SafeMarkdownImage,
});

export interface WorkspaceMarkdownItemsSectionProps {
  projectId: string;
  worktreeId: string;
  kind: 'note' | 'prompt';
  title: string;
  icon: JSX.Element;
  /** Singular noun for copy ("note" / "prompt"). */
  noun: string;
  /** Pseudo-repo group label shown on mention pills ("Notes" / "Prompts"). */
  mentionRepoName: string;
  testIdPrefix: string;
}

interface EditorModalProps {
  heading: string;
  noun: string;
  initialTitle: string;
  initialContent: string;
  onClose: () => void;
  onSave: (item: { title: string; content: string }) => Promise<boolean>;
}

function EditorModal({
  heading,
  noun,
  initialTitle,
  initialContent,
  onClose,
  onSave,
}: EditorModalProps): JSX.Element {
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!title.trim()) return;
    setSaving(true);
    setSaveError(null);
    let saved = false;
    try {
      saved = await onSave({ title: title.trim(), content });
    } catch {
      saved = false;
    }
    if (saved) {
      onClose();
      return;
    }
    setSaveError(`Unable to save this ${noun}. Your draft is still open.`);
    setSaving(false);
  }, [title, content, noun, onSave, onClose]);

  return (
    <DialogModal onClose={onClose} title={heading} maxWidth="md">
      <div className="space-y-3 p-5">
        <div>
          <label className="mb-1 block text-xs font-medium fg-secondary">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e): void => setTitle(e.target.value)}
            placeholder={`${heading} title`}
            autoFocus
            className="w-full rounded-md border bg-base px-3 py-2 text-s fg-primary outline-none placeholder:fg-secondary focus:border-fg-primary/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium fg-secondary">
            Content
          </label>
          <textarea
            value={content}
            onChange={(e): void => setContent(e.target.value)}
            placeholder={`Write your ${noun}... (supports Markdown)`}
            rows={10}
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} w-full resize-y rounded-md border bg-base px-3 py-2 text-s fg-primary outline-none placeholder:fg-secondary focus:border-fg-primary/20`}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-s fg-secondary hover:fg-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={(): void => void handleSave()}
            disabled={!title.trim() || saving}
            className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {saveError !== null && (
          <p role="alert" className="text-xs fg-destructive">
            {saveError}
          </p>
        )}
      </div>
    </DialogModal>
  );
}

interface ViewerModalProps {
  item: WorkspaceNoteItem;
  content: string;
  noun: string;
  onClose: () => void;
  /** Omitted in read-only scopes, which view items but never edit them. */
  onEdit?: () => void;
}

function ViewerModal({
  item,
  content,
  noun,
  onClose,
  onEdit,
}: ViewerModalProps): JSX.Element {
  return (
    <DialogModal
      onClose={onClose}
      title={item.title}
      subtitle={`Updated ${new Date(item.updatedAt).toLocaleDateString()}`}
      maxWidth="lg"
      headerActions={
        onEdit === undefined ? undefined : (
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md px-2 py-1 text-xs fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary"
          >
            Edit
          </button>
        )
      }
    >
      <div className="overflow-y-auto p-5">
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} prose prose-sm max-w-none fg-primary prose-headings:fg-primary prose-p:fg-primary/80 prose-a:fg-accent prose-strong:fg-primary prose-code:fg-primary/80 prose-pre:bg-fg-primary/[0.04]`}
        >
          {content ? (
            <Markdown options={WORKSPACE_ITEM_MARKDOWN_OPTIONS}>
              {content}
            </Markdown>
          ) : (
            <p className="italic fg-secondary">No {noun} content</p>
          )}
        </div>
      </div>
    </DialogModal>
  );
}

interface ItemRowProps {
  item: WorkspaceNoteItem;
  kind: 'note' | 'prompt';
  mentionRepoName: string;
  testIdPrefix: string;
  onView: (item: WorkspaceNoteItem) => void;
  onDelete: (itemId: string) => Promise<void>;
  /** Read-only scopes open items but never mention or delete them. */
  readOnly?: boolean;
}

function ItemRow({
  item,
  kind,
  mentionRepoName,
  testIdPrefix,
  onView,
  onDelete,
  readOnly = false,
}: ItemRowProps): JSX.Element {
  const del = useInlineDelete(
    useCallback(() => onDelete(item.id), [item.id, onDelete]),
  );

  const handleMention = useCallback((): void => {
    // Build the pill's display token exactly like the composer `@` typeahead
    // (`buildFileReferenceDisplayPath`) so both entry points produce identical
    // references: prompts get a `Prompt: {title}` label whose body is inlined
    // at send time (the send-time `expandPromptMentions` matches on this token),
    // while notes keep their absolute path. Passing the raw path here regressed
    // prompts into a raw file-path pill that never expanded.
    dispatchWorkspaceItemMention({
      displayPath: buildFileReferenceDisplayPath(
        {
          kind,
          filename: item.title,
          relativePath: item.title,
          absolutePath: item.absolutePath,
        },
        1,
      ),
      absolutePath: item.absolutePath,
      repoName: mentionRepoName,
      kind,
    });
  }, [item.absolutePath, item.title, kind, mentionRepoName]);

  return (
    <div
      className="group relative rounded border bg-fg-primary/[0.02] transition hover:border-fg-primary/10"
      data-testid={`${testIdPrefix}-item`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
          role="button"
          tabIndex={0}
          onClick={(): void => onView(item)}
          onKeyDown={(e): void => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onView(item);
            }
          }}
        >
          <span className="truncate text-xs font-medium fg-primary">
            {item.title}
          </span>
        </div>
      </div>
      {!readOnly && (
        <RowActionTray>
          {del.confirming ? (
            <InlineDeleteConfirm
              onConfirm={del.confirm}
              onCancel={del.cancel}
              deleting={del.deleting}
            />
          ) : (
            <>
              <ItemMetaInfo createdAt={item.createdAt} origin={item.origin} />
              <RowActionButton label="Mention in chat" onClick={handleMention}>
                <MentionIcon />
              </RowActionButton>
              <RowActionButton
                label={`Delete ${kind}`}
                destructive
                onClick={del.request}
              >
                <TrashIcon />
              </RowActionButton>
            </>
          )}
        </RowActionTray>
      )}
    </div>
  );
}

const EMPTY_ITEMS: readonly WorkspaceNoteItem[] = [];

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspaceMarkdownItemsHeaderChrome({
  projectId,
  worktreeId,
  kind,
  noun,
}: Pick<WorkspaceMarkdownItemsSectionProps, 'projectId' | 'kind' | 'noun'> & {
  worktreeId?: string;
}): {
  subtitle: string | undefined;
  collapsedIconColor: CollapsedIconColor;
} {
  const itemsKey = workspaceItemsKey(projectId, worktreeId);
  const count = useWorkspaceItemsStore((state) =>
    kind === 'note'
      ? (state.notes[itemsKey]?.length ?? 0)
      : (state.prompts[itemsKey]?.length ?? 0),
  );
  return {
    subtitle:
      count > 0 ? `${count} ${noun}${count !== 1 ? 's' : ''}` : undefined,
    collapsedIconColor: count > 0 ? 'amber' : 'muted',
  };
}

export function WorkspaceMarkdownItemsSection({
  projectId,
  worktreeId,
  kind,
  title,
  icon,
  noun,
  mentionRepoName,
  testIdPrefix,
}: WorkspaceMarkdownItemsSectionProps): JSX.Element {
  // Read-only scopes (the shared-container recipient) list and open items
  // from the replica but never add, edit, delete or mention them.
  const readOnly = useWorkspaceIsReadOnly();
  const headerChrome = useWorkspaceMarkdownItemsHeaderChrome({
    projectId,
    worktreeId,
    kind,
    noun,
  });
  const itemsKey = workspaceItemsKey(projectId, worktreeId);
  const items = useWorkspaceItemsStore((s) =>
    kind === 'note'
      ? (s.notes[itemsKey] ?? EMPTY_ITEMS)
      : (s.prompts[itemsKey] ?? EMPTY_ITEMS),
  );
  const store = useWorkspaceItemsStore;

  useEffect(() => {
    const state = store.getState();
    void (kind === 'note'
      ? state.loadNotes(projectId, worktreeId)
      : state.loadPrompts(projectId, worktreeId));
  }, [projectId, worktreeId, kind, store]);

  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<{
    item: WorkspaceNoteItem;
    content: string;
  } | null>(null);
  const [editing, setEditing] = useState<{
    item: WorkspaceNoteItem;
    content: string;
  } | null>(null);

  const handleCreate = useCallback(
    async (draft: { title: string; content: string }): Promise<boolean> => {
      const state = store.getState();
      if (kind === 'note') {
        const saved = await state.saveNote({
          projectId,
          title: draft.title,
          content: draft.content,
          originWorktreeId: worktreeId,
        });
        return saved !== null;
      } else {
        const saved = await state.savePrompt({
          projectId,
          title: draft.title,
          content: draft.content,
          originWorktreeId: worktreeId,
        });
        return saved !== null;
      }
    },
    [kind, projectId, store, worktreeId],
  );

  const handleView = useCallback(
    (item: WorkspaceNoteItem): void => {
      void (async (): Promise<void> => {
        const state = store.getState();
        const result =
          kind === 'note'
            ? await state.readNote(projectId, item.id, worktreeId)
            : await state.readPrompt(projectId, item.id, worktreeId);
        if (result !== null) {
          setViewing({ item: result.meta, content: result.content });
        }
      })();
    },
    [kind, projectId, store, worktreeId],
  );

  const handleDelete = useCallback(
    async (itemId: string): Promise<void> => {
      const state = store.getState();
      await (kind === 'note'
        ? state.deleteNote(projectId, itemId)
        : state.deletePrompt(projectId, itemId));
    },
    [kind, projectId, store],
  );

  const handleEditSave = useCallback(
    async (draft: { title: string; content: string }): Promise<boolean> => {
      if (editing === null) return false;
      const state = store.getState();
      if (kind === 'note') {
        const saved = await state.saveNote({
          projectId,
          noteId: editing.item.id,
          title: draft.title,
          content: draft.content,
        });
        return saved !== null;
      } else {
        const saved = await state.savePrompt({
          projectId,
          promptId: editing.item.id,
          title: draft.title,
          content: draft.content,
        });
        return saved !== null;
      }
    },
    [editing, kind, projectId, store],
  );

  return (
    <PanelSection
      icon={icon}
      title={title}
      subtitle={headerChrome.subtitle}
      collapsedIconColor={headerChrome.collapsedIconColor}
      hasExpandableContent={items.length > 0}
      actionOnlyCard={!readOnly}
      actionOnlyLabel={readOnly ? undefined : `Add ${noun}`}
      headerAction={
        readOnly ? undefined : (
          <HeaderActionButton
            iconOnly
            onClick={(): void => setCreating(true)}
            aria-label={`Add ${noun}`}
            data-testid={`${testIdPrefix}-add`}
          >
            <PlusIcon />
          </HeaderActionButton>
        )
      }
    >
      <div className="max-h-75 overflow-y-auto">
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs fg-secondary/60">
            No {noun}s yet
          </p>
        ) : (
          <div className="space-y-1">
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                kind={kind}
                mentionRepoName={mentionRepoName}
                testIdPrefix={testIdPrefix}
                onView={handleView}
                onDelete={handleDelete}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <EditorModal
          heading={`New ${title.replace(/s$/, '')}`}
          noun={noun}
          initialTitle=""
          initialContent=""
          onClose={(): void => setCreating(false)}
          onSave={handleCreate}
        />
      )}

      {viewing !== null && editing === null && (
        <ViewerModal
          item={viewing.item}
          content={viewing.content}
          noun={noun}
          onClose={(): void => setViewing(null)}
          {...(readOnly
            ? {}
            : {
                onEdit: (): void => {
                  setEditing(viewing);
                  setViewing(null);
                },
              })}
        />
      )}

      {editing !== null && (
        <EditorModal
          heading={`Edit ${title.replace(/s$/, '')}`}
          noun={noun}
          initialTitle={editing.item.title}
          initialContent={editing.content}
          onClose={(): void => setEditing(null)}
          onSave={handleEditSave}
        />
      )}
    </PanelSection>
  );
}
