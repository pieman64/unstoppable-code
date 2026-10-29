'use client';

import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type {
  InstalledSkillInfo,
  SkillContentResponse,
} from '@canopy/protocol';
import {
  DetailHeader,
  DetailMoreMenu,
  DetailPageActions,
  ExecutionActionButton,
  MarketplaceShareButton,
  SkillFilePreview,
  SkillFileTabBar,
  SkillFileTree,
  SkillMarkdownBody,
  SkillUpdateNotice,
  SkillUpdateStatus,
  hasSkillUpdateStatus,
  skillUpdateMenuItem,
  visibleFrontmatterEntries,
  type DetailMoreMenuItem,
  type MarkdownOptions,
} from '@canopy/ui-shared/components';
import {
  TrashIcon,
  SparkleIcon,
  DocumentPencilIcon as AppCatalogDocumentPencilIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SKILL_MAIN_FILE,
  marketplaceTitleCase,
  skillFileLabel,
  type MarketplaceShareAction,
  type SkillUpdateAction,
} from '@canopy/ui-shared/lib';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';
import { MarkdownFrontmatterContent } from '../code/file/MarkdownFrontmatterContent';
import {
  EDIT_WITH_AI_LABEL,
  SkillEditWithAIButton,
  type SkillEditWithAIState,
} from './SkillEditWithAIButton';

export { SKILL_MAIN_FILE } from '@canopy/ui-shared/lib';

export interface SkillReadFileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * The page header an installed skill detail shows (CAN-4264): title, the
 * one-line description, and quiet facts. With it the detail owns its actions
 * and notice; without it (dialogs, shared copies) the legacy layout stays.
 */
export interface SkillReadDetailHeader {
  title: string;
  /** The heading's id, for a page shell's `aria-labelledby`. */
  titleId?: string;
  /** From SKILL.md: shown under session replay's block. */
  description?: string;
  /** From SKILL.md: the first meta fact, under session replay's block. */
  version?: string;
  meta?: readonly ReactNode[];
}

const UPDATED_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * The installed skill page's header on every host (CAN-4264): the list's
 * title, the frontmatter description, then where it came from, its version
 * and when it last changed. Facts the host does not know are left out.
 */
export function installedSkillDetailHeader(
  name: string,
  content: SkillContentResponse | null,
  installed:
    | Pick<
        InstalledSkillInfo,
        'source' | 'updatedAt' | 'builtIn' | 'custom' | 'description'
      >
    | undefined,
  titleId?: string,
  /** The list's display name, so title, list row and breadcrumb match. */
  displayName?: string,
): SkillReadDetailHeader {
  const frontmatterDescription = content?.frontmatter.description;
  const description =
    typeof frontmatterDescription === 'string' && frontmatterDescription
      ? frontmatterDescription
      : installed?.description || undefined;
  const version = content?.frontmatter.version;
  const updated = installed ? new Date(installed.updatedAt) : null;
  const source = installed?.builtIn
    ? 'Built-in'
    : installed?.custom
      ? 'Custom'
      : installed?.source;
  return {
    title: displayName?.trim() || marketplaceTitleCase(name),
    ...(titleId ? { titleId } : {}),
    ...(description ? { description } : {}),
    ...(typeof version === 'string' || typeof version === 'number'
      ? { version: `v${String(version).replace(/^v/i, '')}` }
      : {}),
    meta: [
      source,
      updated && Number.isFinite(updated.getTime())
        ? `Updated ${UPDATED_DATE_FORMAT.format(updated)}`
        : undefined,
    ].filter((fact): fact is string => typeof fact === 'string' && fact !== ''),
  };
}

export interface SkillReadDetailProps {
  skill: Pick<InstalledSkillInfo, 'sourceId' | 'name'>;
  header?: SkillReadDetailHeader;
  /**
   * The host page already shows this title and description above the body
   * (a share page's own header). The body drops what repeats them, as under
   * `header`, without rendering a second header.
   */
  hostHeader?: Pick<SkillReadDetailHeader, 'title' | 'description'>;
  /**
   * The host's own failure for the page (a removal or Edit with AI error).
   * It takes the header's one notice slot, ahead of any update notice.
   */
  notice?: ReactNode;
  content: SkillContentResponse | null;
  /**
   * Host-supplied notice shown above the content when the host's transport
   * truncated the main document (e.g. the portal transfer limit). Hosts with
   * untruncated reads simply omit it.
   */
  contentTruncatedNotice?: string;
  files: string[];
  filesTruncated?: boolean;
  loading: boolean;
  error: string;
  readFile: (path: string) => Promise<SkillReadFileContent>;
  initialFilePath?: string;
  onEdit?: () => void;
  /**
   * "Edit with AI" (CAN-1259): opens a chat to change the skill. Omit when the
   * host cannot start one (the portal) or the skill's record is unresolved.
   */
  editWithAI?: SkillEditWithAIState;
  onAdd?: () => void;
  /**
   * Host-owned primary action, such as the shared Try it / Install CTA. When
   * present it replaces the internal Add primary so the header keeps exactly
   * one accent action.
   */
  primaryAction?: ReactNode;
  /**
   * Share, first in the top-right actions row beside the leading Back: the
   * host's share flow, or the reason sharing is unavailable. Omit when the
   * host has no sharing capability or places Share in its own page chrome.
   */
  shareAction?: MarketplaceShareAction;
  /** Opens the host's delete/remove confirmation; omit when not removable. */
  onRemove?: () => void;
  /**
   * `delete` for skills the user authored (permanent), `remove` for installed
   * skills that can be reinstalled. Defaults to `remove`.
   */
  removeKind?: 'delete' | 'remove';
  /** Disables the remove action while the host's removal is in flight. */
  removePending?: boolean;
  /**
   * Check for and apply updates (CAN-4264): the host's runnable callbacks,
   * or cached availability with the reason the host cannot act. Omit when
   * the skill is not updatable.
   */
  updateAction?: SkillUpdateAction;
  /** Leading chrome, such as Back, sharing one row with the actions. */
  leadingContent?: ReactNode;
  relatedContent?: ReactNode;
  onViewStateChange?: (state: SkillReadDetailViewState) => void;
}

export interface SkillReadDetailViewState {
  treeOpen: boolean;
  openTabs: string[];
  activeFile: string;
}

interface FileState {
  loading: boolean;
  error: string;
  data: SkillReadFileContent | null;
}

const HEADER_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'version',
]);

// Under a page header the skill body's headings rank below the page title:
// an H1 becomes an H2, and none is larger than body-size text, so the
// header's title stays the page's dominant heading.
const BODY_HEADING_CLASS = 'text-m font-semibold';
const BODY_SUBHEADING_CLASS = 'text-s font-semibold';
export const HEADER_BODY_MARKDOWN_OPTIONS: MarkdownOptions = {
  overrides: {
    h1: { component: 'h2', props: { className: BODY_HEADING_CLASS } },
    h2: { props: { className: BODY_HEADING_CLASS } },
    h3: { props: { className: BODY_SUBHEADING_CLASS } },
    h4: { props: { className: BODY_SUBHEADING_CLASS } },
    h5: { props: { className: BODY_SUBHEADING_CLASS } },
    h6: { props: { className: BODY_SUBHEADING_CLASS } },
  },
};

function headingKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The body without a leading `# Title` that repeats the page title or the
 * skill's name (ignoring case, punctuation and spacing): the header already
 * shows it.
 */
function withoutRepeatedTitle(body: string, names: readonly string[]): string {
  const match = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match) return body;
  const keys = new Set(names.map(headingKey));
  return keys.has(headingKey(match[1])) ? body.slice(match[0].length) : body;
}

/**
 * The body without a leading paragraph that repeats the header's description
 * (ignoring case, punctuation and spacing), after any repeated title: the
 * header already shows it. Same rule as `withoutRepeatedTitle`.
 */
function withoutRepeatedDescription(
  body: string,
  description: string | undefined,
): string {
  if (!description) return body;
  const match =
    /^\s*([^\n#>*\-`|][^\n]*(?:\r?\n(?!\s*\r?\n)[^\n]+)*)(?:\r?\n|$)/.exec(
      body,
    );
  if (!match) return body;
  return headingKey(match[1]) === headingKey(description)
    ? body.slice(match[0].length)
    : body;
}

/**
 * A skill's SKILL.md under a page header that already shows its title and
 * description (CAN-4261): without the name, description and version
 * frontmatter (the outlined Name/Description card), a leading `# Title` that
 * repeats the name, or a leading paragraph that repeats the description.
 * Render the body with `HEADER_BODY_MARKDOWN_OPTIONS` so its headings rank
 * below the page title.
 */
export function skillContentUnderHeader<
  T extends { frontmatter: Record<string, unknown>; body: string },
>(
  content: T,
  header: { title: string; description?: string },
  names: readonly string[] = [],
): T {
  return {
    ...content,
    frontmatter: Object.fromEntries(
      Object.entries(content.frontmatter).filter(
        ([key]) => !HEADER_FRONTMATTER_KEYS.has(key),
      ),
    ),
    body: withoutRepeatedDescription(
      withoutRepeatedTitle(content.body, [header.title, ...names]),
      header.description,
    ),
  };
}

/** Edit with AI as a ⋯ menu item, keeping its unavailable reason. */
function editWithAIMenuItem(state: SkillEditWithAIState): DetailMoreMenuItem {
  return state.available
    ? {
        id: 'edit-with-ai',
        label: EDIT_WITH_AI_LABEL,
        icon: <SparkleIcon />,
        testId: 'skill-read-detail-edit-with-ai',
        onSelect: state.onSelect,
        ...(state.pending ? { disabled: true } : {}),
      }
    : {
        id: 'edit-with-ai',
        label: EDIT_WITH_AI_LABEL,
        icon: <SparkleIcon />,
        testId: 'skill-read-detail-edit-with-ai',
        onSelect: (): void => {},
        disabled: true,
        reason: state.reason,
      };
}

const LOADING_FILE_STATE: FileState = { loading: true, error: '', data: null };

export function SkillReadDetail({
  skill,
  header,
  hostHeader,
  notice,
  content,
  contentTruncatedNotice,
  files,
  filesTruncated = false,
  loading,
  error,
  readFile,
  initialFilePath,
  onEdit,
  editWithAI,
  onAdd,
  primaryAction,
  shareAction,
  onRemove,
  removeKind = 'remove',
  removePending = false,
  updateAction,
  leadingContent,
  relatedContent,
  onViewStateChange,
}: SkillReadDetailProps): JSX.Element {
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(false);
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const requestVersion = useRef(0);

  useEffect(() => {
    onViewStateChange?.({
      treeOpen: showTree,
      openTabs,
      activeFile: activeFile ?? SKILL_MAIN_FILE,
    });
  }, [activeFile, onViewStateChange, openTabs, showTree]);

  useEffect(() => {
    requestVersion.current += 1;
    setOpenTabs([]);
    setActiveFile(null);
    setShowTree(false);
    setFileStates({});
    setCollapsed(new Set());
  }, [skill.sourceId, skill.name]);

  const openFile = (path: string): void => {
    if (path === SKILL_MAIN_FILE) {
      setActiveFile(null);
      return;
    }
    setOpenTabs((previous) =>
      previous.includes(path) ? previous : [...previous, path],
    );
    setActiveFile(path);
    if (Object.prototype.hasOwnProperty.call(fileStates, path)) return;
    const version = requestVersion.current;
    setFileStates((previous) => ({ ...previous, [path]: LOADING_FILE_STATE }));
    void readFile(path).then(
      (data): void => {
        if (requestVersion.current !== version) return;
        setFileStates((previous) => ({
          ...previous,
          [path]: { loading: false, error: '', data },
        }));
      },
      (reason: unknown): void => {
        if (requestVersion.current !== version) return;
        setFileStates((previous) => ({
          ...previous,
          [path]: {
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
            data: null,
          },
        }));
      },
    );
  };

  useEffect(() => {
    if (!initialFilePath || !files.includes(initialFilePath)) return;
    openFile(initialFilePath);
    // Preview state changes must not restart a deep-link request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, initialFilePath, skill.sourceId, skill.name]);

  const isMultiFile = files.length > 1;
  const secondaryActionClass = `${SECONDARY_ACTION_BUTTON_CLASS} gap-1.5`;
  const removeLabel = removeKind === 'delete' ? 'Delete' : 'Remove';
  const editWithAIButton = editWithAI ? (
    <SkillEditWithAIButton
      state={editWithAI}
      dataTestId="skill-read-detail-edit-with-ai"
    />
  ) : null;
  const editButton = onEdit ? (
    <button
      type="button"
      onClick={onEdit}
      data-testid="skill-read-detail-edit"
      className={secondaryActionClass}
    >
      <AppCatalogDocumentPencilIcon width="12" height="12" aria-hidden />
      Edit
    </button>
  ) : null;
  const shareButton = shareAction ? (
    <MarketplaceShareButton
      action={shareAction}
      name={skill.name}
      placement="detail"
      dataTestId="skill-read-detail-share"
    />
  ) : undefined;
  const primary =
    primaryAction !== undefined ? (
      primaryAction
    ) : onAdd ? (
      <ExecutionActionButton
        label="Add"
        ariaLabel="Add"
        variant="primary"
        placement="detail"
        onClick={onAdd}
        dataTestId="skill-read-detail-add"
        stopKeyDownPropagation={false}
      />
    ) : undefined;
  const checkItem = skillUpdateMenuItem(updateAction);
  const menuName = header?.title ?? skill.name;
  const menu = (items: DetailMoreMenuItem[]): JSX.Element | null =>
    items.length > 0 ? (
      <DetailMoreMenu
        name={menuName}
        items={items}
        triggerTestId="skill-read-detail-more"
        menuTestId="skill-read-detail-menu"
      />
    ) : null;

  let topRow: ReactNode;
  if (header) {
    // The page header (CAN-4264, CAN-4261): [⋯ More] [Edit] [Share]
    // [Primary] beside the title, at most three visible actions. Edit with
    // AI and the rarer actions sit in the menu with the destructive one
    // last, and one notice sits under it where the host's own failure wins
    // over the update state.
    const menuItems: DetailMoreMenuItem[] = [
      ...(checkItem ? [checkItem] : []),
      ...(editWithAI ? [editWithAIMenuItem(editWithAI)] : []),
      ...(onRemove
        ? [
            {
              id: 'remove',
              label: removeLabel,
              icon: <TrashIcon />,
              testId: 'skill-read-detail-remove',
              onSelect: onRemove,
              disabled: removePending,
              destructive: true,
            },
          ]
        : []),
    ];
    const headerActions =
      menuItems.length > 0 || editButton || shareButton || primary ? (
        <>
          {menu(menuItems)}
          {editButton}
          {shareButton}
          {primary}
        </>
      ) : undefined;
    topRow = (
      <>
        {leadingContent}
        <div className="mb-6">
          <DetailHeader
            dataTestId="skill-read-detail-header"
            title={header.title}
            titleId={header.titleId}
            // SKILL.md frontmatter is file content: session replay keeps a
            // placeholder for it, as it does for the body (CAN-3119).
            description={
              header.description ? (
                <span className={REPLAY_BLOCK_CLASS}>{header.description}</span>
              ) : undefined
            }
            meta={[
              ...(header.version
                ? [
                    <span key="version" className={REPLAY_BLOCK_CLASS}>
                      {header.version}
                    </span>,
                  ]
                : []),
              ...(header.meta ?? []),
              ...(hasSkillUpdateStatus(updateAction)
                ? [<SkillUpdateStatus key="update" action={updateAction} />]
                : []),
            ]}
            actions={headerActions}
            notice={
              notice ?? (
                <SkillUpdateNotice action={updateAction} onRemove={onRemove} />
              )
            }
          />
        </div>
      </>
    );
  } else {
    // The standard action bar: [⋯ Check for updates] [Delete or Remove]
    // [Edit with AI] [Edit] [Share] [Add]. Inside a page shell or dialog
    // that opens action slots they render in its top right; elsewhere they
    // share the Back row below.
    const actions = (onEdit ||
      editWithAI ||
      onAdd ||
      shareAction ||
      onRemove ||
      checkItem) && (
      <DetailPageActions
        secondary={
          checkItem || onRemove || editWithAI || onEdit ? (
            <>
              {menu(checkItem ? [checkItem] : [])}
              {onRemove && (
                <button
                  type="button"
                  onClick={onRemove}
                  disabled={removePending}
                  data-testid="skill-read-detail-remove"
                  className={`${secondaryActionClass} hover:fg-destructive disabled:opacity-50`}
                >
                  <TrashIcon width={12} height={12} aria-hidden />
                  {removeLabel}
                </button>
              )}
              {editWithAIButton}
              {editButton}
            </>
          ) : undefined
        }
        share={shareButton}
        primary={primary}
      />
    );
    const updateNotice = updateAction ? (
      <div className="mb-4 empty:hidden">
        <SkillUpdateNotice action={updateAction} onRemove={onRemove} />
      </div>
    ) : null;
    // Back and the actions share one row when no shell hosts the action bar.
    topRow = (
      <>
        {leadingContent || actions ? (
          <div className="mb-2 flex shrink-0 flex-wrap items-start justify-between gap-2 empty:hidden">
            {leadingContent}
            {actions}
          </div>
        ) : null}
        {updateNotice}
      </>
    );
  }

  // The header (ours or the host's) already shows the name, description and
  // version, and its title is the page heading.
  const pageHeader = header ?? hostHeader;
  const shownContent =
    pageHeader && content
      ? skillContentUnderHeader(content, pageHeader, [skill.name])
      : content;
  const bodyMarkdownOptions = pageHeader
    ? HEADER_BODY_MARKDOWN_OPTIONS
    : undefined;
  // A body that only repeated the header's title and description has
  // nothing left to show: the header says it all, so no "no content" note.
  const bodyRepeatsHeader =
    pageHeader !== undefined &&
    content !== null &&
    content.body.trim() !== '' &&
    shownContent?.body.trim() === '' &&
    visibleFrontmatterEntries(shownContent.frontmatter).length === 0;

  const truncationNotice =
    contentTruncatedNotice !== undefined && contentTruncatedNotice !== '' ? (
      <p
        className="mb-4 rounded-lg border bg-secondary/50 px-4 py-3 text-s fg-secondary"
        role="note"
        data-testid="skill-read-detail-truncated"
      >
        {contentTruncatedNotice}
      </p>
    ) : null;

  if (!isMultiFile) {
    return (
      <div
        data-testid="skill-read-detail"
        className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5"
      >
        {topRow}
        {truncationNotice}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {/* SKILL.md is file content: session replay keeps a placeholder.
              MarkdownFrontmatterContent renders a fragment, so an unstyled
              block-level wrapper carries the block; related content after
              it stays recorded. */}
          {bodyRepeatsHeader && !loading && !error ? null : (
            <div className={REPLAY_BLOCK_CLASS}>
              <MarkdownFrontmatterContent
                markdownOptions={bodyMarkdownOptions}
                loading={loading}
                error={error}
                content={shownContent}
                emptyText="This skill has no content."
              />
            </div>
          )}
          {relatedContent}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="skill-read-detail"
      className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5"
    >
      {topRow}
      {truncationNotice}
      {/* Under a header the name, description and version move up; an
          otherwise empty block would leave a blank band above the tabs. */}
      {loading ||
      error ||
      !shownContent ||
      visibleFrontmatterEntries(shownContent.frontmatter).length > 0 ? (
        <div
          className={`${REPLAY_BLOCK_CLASS} shrink-0 max-h-64 overflow-y-auto`}
        >
          <MarkdownFrontmatterContent
            loading={loading}
            error={error}
            content={
              shownContent
                ? { frontmatter: shownContent.frontmatter, body: '' }
                : null
            }
            emptyText=""
          />
        </div>
      ) : null}
      {filesTruncated && (
        <p className="pb-2 text-xs fg-secondary italic">
          The file list is incomplete because the skill contains many files.
        </p>
      )}
      <SkillFileTabBar
        tabs={openTabs.map((path) => ({
          key: path,
          label: skillFileLabel(path),
          title: path,
        }))}
        activeKey={activeFile}
        onSelectMain={() => setActiveFile(null)}
        onSelectTab={openFile}
        onCloseTab={(path) => {
          setOpenTabs((tabs) => tabs.filter((tab) => tab !== path));
          setActiveFile((active) => (active === path ? null : active));
        }}
        treeToggle={{
          open: showTree,
          onToggle: () => setShowTree((open) => !open),
          className:
            'focus-ring mr-1 shrink-0 rounded-md border p-1.5 fg-secondary',
        }}
      />
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        {showTree && (
          <div className="w-56 shrink-0 overflow-y-auto rounded-lg border">
            <SkillFileTree
              files={files}
              activePath={activeFile}
              onSelectFile={openFile}
              collapsed={collapsed}
              onToggleDirectory={(path) =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
            />
          </div>
        )}
        {/* Skill files are file content: session replay keeps a placeholder
            for the open file and for the SKILL.md body. Related content after
            the body stays recorded. */}
        <div
          className={`${activeFile === null ? '' : `${REPLAY_BLOCK_CLASS} `}min-w-0 flex-1 overflow-y-auto`}
        >
          {activeFile === null ? (
            <>
              {shownContent?.body.trim() ? (
                <div className={REPLAY_BLOCK_CLASS}>
                  <SkillMarkdownBody
                    markdown={shownContent.body}
                    options={bodyMarkdownOptions}
                  />
                </div>
              ) : bodyRepeatsHeader ? null : (
                <p className="text-s fg-secondary text-center py-8">
                  This skill has no content.
                </p>
              )}
              {relatedContent}
            </>
          ) : (
            <SkillFilePreview
              filePath={activeFile}
              state={fileStates[activeFile] ?? LOADING_FILE_STATE}
            />
          )}
        </div>
      </div>
    </div>
  );
}
