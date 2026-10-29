import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  type JSX,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DetailBackChip } from '../shared/DetailBackChip';
import { useSkillList } from '../../hooks/useSkillList';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useNavigationStore } from '@/stores/navigationStore';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useSharedSkillList } from '../../hooks/useSharedSkillList';
import { useWorkspaceContextReset } from '@/hooks/useWorkspaceContextReset';
import { parseGitHubRepo, formatDate } from '../../lib/format';
import { runCancellableModalLoad } from './entityEditModalUtils';
import { ResourceTable } from './ResourceTable';
import { readSkillContentForDisplay } from './skillContentUtils';
import { parseSkillSource, serializeSkillSource } from '@/lib/skillFrontmatter';
import { useInstalledSkillActions } from '../skills/useInstalledSkillActions';
import { useEditSkillWithAI } from '../skills/useEditSkillWithAI';
import { TryItPrimaryCta } from '../plugins/TryItPrimaryCta';
import { buildTryItPrompt } from '@canopy/protocol/try-it';
import {
  notifySkillsChanged,
  SKILLS_CHANGED_EVENT,
  trackSkillsRefresh,
} from '@/lib/skillsChanged';
import {
  CUSTOM_SKILL_SOURCE_ID,
  findInstalledSharedSkill,
} from '@/lib/sharedSkillImport';
import { sharedResourceInstallLink } from '@/lib/sharedResourceInstallLink';
import type { DeepLinkShareOpenEvent } from '@canopy/desktop-shared/types';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { brandText } from '@/lib/brand';
import { copyTextToClipboard } from '@/lib/clipboard';
import { resolveSharedSkillUrl } from '@/lib/share-links';
import { useClipboardCopy } from '@/hooks/useClipboardCopy';
import {
  isSkillEditorSaveEnabled,
  resolveSupportingFilePaths,
  skillEditorSnapshot,
} from '@/lib/skill-edit-safety';
import {
  getCustomSkillNameValidationError,
  getSkillFilePathValidationError,
} from '@canopy/desktop-shared/skill-name';
import type {
  SkillRiskInfo,
  AvailableSkill,
  FetchAvailableSkillsResponse,
  InstalledSkillInfo,
  SharedSkillDetail,
  SharedSkillSummary,
  SkillContentResponse,
  SkillEditableFile,
} from '@canopy/desktop-shared/types/skills';
import {
  SkillFilePreview,
  SkillFileTabBar,
  SkillFileTree,
  BusyLabel,
} from '@canopy/ui-shared/components';
import {
  skillFileLabel,
  type MarketplaceShareAction,
  type SkillUpdateAction,
} from '@canopy/ui-shared/lib';
import { DialogModal } from '../shared';
import { SECONDARY_ACTION_BUTTON_CLASS } from '@canopy/ui-shared/lib/row-chips';
import {
  MarkdownFrontmatterContent,
  SKILL_MAIN_FILE,
  EDIT_WITH_AI_LABEL,
  SkillEditWithAIButton,
  SkillReadDetail,
  installedSkillDetailHeader,
  type SkillEditWithAIState,
  type SkillReadDetailViewState,
} from '@canopy/ui-app';
import {
  MarketplaceDetailPageShell,
  MarketplaceUnshareAction,
  useMarketplaceUnshare,
  type UseMarketplaceUnshareOptions,
} from '@canopy/ui-app/capability';
import {
  DetailActionBar,
  DetailActionSlotsProvider,
  DetailPageActions,
  MarketplaceShareButton,
  RiskBadge,
  useDetailActionSlots,
  type DetailMoreMenuItem,
  type DetailPageActionsProps,
} from '@canopy/ui-shared/components';
import {
  ErrorBanner,
  LoadingPlaceholder,
  EmptyState,
  DeleteConfirmModal,
} from '../shared';
import { RefreshSpinner } from '../shared/loading/spinners/RefreshSpinner';
import { Tooltip } from '@canopy/ui-shared';
import {
  ShareIcon,
  SparkleIcon,
  TrashIcon as AppCatalogTrashIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
  PlusIcon as AppCatalogPlusIcon,
  DocumentPencilIcon as AppCatalogDocumentPencilIcon,
  CheckIcon as AppCatalogCheckIcon,
  Link as AppCatalogLink,
  Download as AppCatalogDownload,
  ArrowUpRightIcon,
  CopyIcon,
  GlobeIcon,
  RefreshIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';

const SKILL_DELETE_CONFLICT_MESSAGE =
  'This skill is used by one or more collections. Remove it from those collections before deleting it.';
const SHARED_SKILL_DELETE_MESSAGE =
  'Collections that reference this skill must remove it first.';

const SKILL_OPEN_VIEWER_EVENT = 'canopy:skill-open-viewer';

// ---------------------------------------------------------------------------
// AddSkillsModal
// ---------------------------------------------------------------------------

type ModalStep =
  | { step: 'source' }
  | { step: 'loading'; source: string }
  | {
      step: 'select';
      source: string;
      response: FetchAvailableSkillsResponse;
    }
  | { step: 'installing'; source: string; skillNames: string[] };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAddSkillsModalStep(
  operation: () => Promise<void>,
  options: {
    isCancelled: () => boolean;
    setError: (error: string) => void;
    resetToSource: () => void;
  },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (options.isCancelled()) return;
    options.setError(getErrorMessage(error));
    options.resetToSource();
  }
}

/**
 * GitHub skills-install dialog. Exported so the Plugins discovery page's
 * "Add custom…" dropdown can open the same dialog the Skills surface uses
 * (API-2153) instead of forking it.
 */
export function AddSkillsModal({
  isOpen,
  onClose,
  onInstalled,
  onAddMarketplace,
}: {
  isOpen: boolean;
  onClose: () => void;
  onInstalled: () => Promise<void>;
  onAddMarketplace?: (repo: string) => void;
}): JSX.Element | null {
  const [modalStep, setModalStep] = useState<ModalStep>({ step: 'source' });
  const [sourceInput, setSourceInput] = useState('');
  const [error, setError] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) {
      setModalStep({ step: 'source' });
      setSourceInput('');
      setError('');
      setSelectedNames(new Set());
    }
  }, [isOpen]);

  // Fetch available skills when entering loading step
  useEffect(() => {
    if (modalStep.step !== 'loading') return;
    let cancelled = false;

    void runAddSkillsModalStep(
      async (): Promise<void> => {
        const result = await window.skills.fetchAvailable(modalStep.source);
        if (cancelled) return;

        if (result.success && result.data) {
          if (result.data.skills.length === 0) {
            setError('No installable skills found in this repository.');
            setModalStep({ step: 'source' });
          } else {
            setSelectedNames(new Set(result.data.skills.map((s) => s.name)));
            setModalStep({
              step: 'select',
              source: modalStep.source,
              response: result.data,
            });
          }
        } else {
          setError(result.error || 'Failed to fetch skills.');
          setModalStep({ step: 'source' });
        }
      },
      {
        isCancelled: () => cancelled,
        setError,
        resetToSource: () => setModalStep({ step: 'source' }),
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [modalStep]);

  // Store callbacks in refs to avoid re-triggering the install effect
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  // Install skills when entering installing step
  useEffect(() => {
    if (modalStep.step !== 'installing') return;
    let cancelled = false;

    void runAddSkillsModalStep(
      async (): Promise<void> => {
        const result = await window.skills.installSkills(
          modalStep.source,
          modalStep.skillNames,
        );
        if (cancelled) return;

        if (result.success) {
          await onInstalledRef.current();
          onCloseRef.current();
        } else {
          setError(result.error || 'Failed to install skills.');
          setModalStep({ step: 'source' });
        }
      },
      {
        isCancelled: () => cancelled,
        setError,
        resetToSource: () => setModalStep({ step: 'source' }),
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [modalStep]);

  if (!isOpen) return null;

  const handleFindSkills = (): void => {
    setError('');
    const repo = parseGitHubRepo(sourceInput);
    if (!repo) {
      setError(
        'Invalid format. Use owner/repo or a GitHub URL (e.g. https://github.com/owner/repo).',
      );
      return;
    }
    setModalStep({ step: 'loading', source: repo });
  };

  const handleInstall = (): void => {
    if (modalStep.step !== 'select' || selectedNames.size === 0) return;
    setError('');
    setModalStep({
      step: 'installing',
      source: modalStep.source,
      skillNames: Array.from(selectedNames),
    });
  };

  const toggleSkill = (name: string): void => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = (skills: AvailableSkill[]): void => {
    if (selectedNames.size === skills.length) {
      setSelectedNames(new Set());
    } else {
      setSelectedNames(new Set(skills.map((s) => s.name)));
    }
  };

  const parsedRepo = parseGitHubRepo(sourceInput);
  const isSourceValid = parsedRepo !== null;

  return (
    <DialogModal
      onClose={onClose}
      title={modalStep.step === 'select' ? 'Select skills' : 'Add skills'}
      titleId="add-skills-modal-title"
      headerBorder={false}
    >
      <div className="px-5 pb-5 space-y-4">
        {/* Error */}
        <ErrorBanner error={error} />

        {/* Source input step */}
        {modalStep.step === 'source' && (
          <>
            <label className="block text-s">
              <span className="mb-1.5 block fg-secondary">
                GitHub repository
              </span>
              <input
                type="text"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    isSourceValid &&
                    modalStep.step === 'source'
                  )
                    handleFindSkills();
                }}
                placeholder="owner/repo or https://github.com/owner/repo"
                className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s"
                autoFocus
              />
            </label>
            <button
              type="button"
              onClick={handleFindSkills}
              disabled={!isSourceValid}
              className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
            >
              Find skills
            </button>
          </>
        )}

        {/* Loading step */}
        {modalStep.step === 'loading' && (
          <LoadingPlaceholder
            label={`Fetching skills from ${modalStep.source}\u2026`}
            space="section"
          />
        )}

        {/* Select step */}
        {modalStep.step === 'select' && (
          <>
            {modalStep.response.hasMarketplace && (
              <div className="rounded-lg bg-warning-subtle border border-line-attention px-4 py-3">
                <p className="text-s fg-warning">
                  This repository contains a plugin marketplace. It is
                  recommended to install as a marketplace instead of installing
                  skills directly.
                </p>
                {onAddMarketplace && (
                  <button
                    type="button"
                    onClick={() => {
                      onAddMarketplace(modalStep.source);
                      onClose();
                    }}
                    className="mt-2 focus-ring inline-flex items-center rounded-lg bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis hover:bg-accent/90 transition-colors"
                  >
                    Add marketplace
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <p className="text-s fg-secondary">
                {modalStep.response.skills.length} skill
                {modalStep.response.skills.length !== 1 ? 's' : ''} found in{' '}
                <span className="fg-primary font-medium">
                  {modalStep.source}
                </span>
              </p>
              <button
                type="button"
                onClick={() => toggleAll(modalStep.response.skills)}
                className="text-xs fg-accent hover:underline"
              >
                {selectedNames.size === modalStep.response.skills.length
                  ? 'Deselect all'
                  : 'Select all'}
              </button>
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border divide-y">
              {modalStep.response.skills.map((skill) => {
                const risk: SkillRiskInfo | undefined =
                  modalStep.response.riskInfo[skill.name];
                return (
                  <label
                    key={skill.name}
                    className="flex items-start gap-3 px-3 py-2.5 hover:bg-secondary/30 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedNames.has(skill.name)}
                      onChange={() => toggleSkill(skill.name)}
                      className="mt-0.5 rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-s font-medium fg-primary truncate block">
                        {skill.name}
                      </span>
                      {skill.description && (
                        <p className="text-xs fg-secondary mt-0.5 line-clamp-2">
                          {skill.description}
                        </p>
                      )}
                    </div>
                    {risk && <RiskBadge level={risk.level} />}
                  </label>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setModalStep({ step: 'source' });
                }}
                className="focus-ring rounded-lg px-4 py-2 text-s font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleInstall}
                disabled={selectedNames.size === 0}
                className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
              >
                Install {selectedNames.size} skill
                {selectedNames.size !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}

        {/* Installing step */}
        {modalStep.step === 'installing' && (
          <LoadingPlaceholder
            label={`Installing ${modalStep.skillNames.length} skill${modalStep.skillNames.length !== 1 ? 's' : ''}\u2026`}
            space="section"
          />
        )}
      </div>
    </DialogModal>
  );
}

// ---------------------------------------------------------------------------
// SkillDetailModal
// ---------------------------------------------------------------------------

/**
 * Installed-skill viewer. Exported so the Plugins discovery detail wrapper can
 * open the same viewer the Skills section uses (API-2153, design section 4).
 */
export function SkillDetailModal({
  skill,
  onClose,
  onEdit,
  editWithAI,
  notice,
  shareAction,
  onRemove,
  removeKind,
  removePending,
  updateAction,
  loadErrorPrefix,
  installedSkill,
  displayName,
  onNavigateBack,
  relatedContent,
  noEnterAnimation = false,
  presentation = 'modal',
}: {
  skill: { sourceId: string; name: string; filePath?: string } | null;
  /**
   * The installed record, for the page header's source and dates
   * (CAN-4264). The page shows the header without them until it resolves.
   */
  installedSkill?: InstalledSkillInfo;
  onClose: () => void;
  onEdit?: () => void;
  /** "Edit with AI" (CAN-1259); omit to hide it. */
  editWithAI?: SkillEditWithAIState;
  /**
   * A page-level notice for an action's failure: the header's one notice on
   * a page, above the content in a dialog.
   */
  notice?: ReactNode;
  /**
   * Same share flow as the list row, or the Marketplace's reason it cannot
   * be shared; omit when the host offers no Share.
   */
  shareAction?: MarketplaceShareAction;
  /** Same delete/remove confirmation as the list row; omit when ineligible. */
  onRemove?: () => void;
  removeKind?: 'delete' | 'remove';
  removePending?: boolean;
  /** Check for and apply updates (CAN-4264); omit when not updatable. */
  updateAction?: SkillUpdateAction;
  /** Explains a committed mutation when its subsequent content read fails. */
  loadErrorPrefix?: string;
  /** Renders a back chip that restores the previous detail (CAN-2382). */
  /** The list's display name for the page header title. */
  displayName?: string;
  onNavigateBack?: () => void;
  /** Optional related-item sections appended below the skill content. */
  relatedContent?: ReactNode;
  noEnterAnimation?: boolean;
  /** Keep management in a dialog while discovery can host the same viewer inline. */
  presentation?: 'modal' | 'page';
}): JSX.Element | null {
  const [content, setContent] = useState<SkillContentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [viewState, setViewState] = useState<SkillReadDetailViewState>({
    treeOpen: false,
    openTabs: [],
    activeFile: SKILL_MAIN_FILE,
  });
  const selectedSkillSourceId = skill?.sourceId;
  const selectedSkillName = skill?.name;

  useEffect(() => {
    setFiles([]);
    setFilesTruncated(false);
    setViewState({
      treeOpen: false,
      openTabs: [],
      activeFile: SKILL_MAIN_FILE,
    });
    if (
      selectedSkillSourceId === undefined ||
      selectedSkillName === undefined
    ) {
      setContent(null);
      setError('');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    void runCancellableModalLoad(
      async (): Promise<void> => {
        const [result, filesResult] = await Promise.all([
          readSkillContentForDisplay({
            sourceId: selectedSkillSourceId,
            name: selectedSkillName,
          }),
          window.skills.listFiles(selectedSkillSourceId, selectedSkillName),
        ]);
        if (cancelled) return;
        setContent(result);
        if (filesResult.success && filesResult.data) {
          setFiles(filesResult.data.files);
          setFilesTruncated(filesResult.data.truncated);
        }
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [selectedSkillName, selectedSkillSourceId]);

  useCurrentUiStateReporter(
    'plugins.skillDetail',
    skill
      ? {
          open: true,
          sourceId: skill.sourceId,
          skillName: skill.name,
          loading,
          errorVisible: error.length > 0,
          fileCount: files.length,
          filesTruncated,
          treeOpen: viewState.treeOpen,
          openTabs: viewState.openTabs,
          activeFile: viewState.activeFile,
        }
      : { open: false },
  );

  // A dialog shows the skill's actions in its title bar, before close.
  const actionSlots = useDetailActionSlots();

  if (!skill) return null;

  const isMultiFile = files.length > 1;
  const skillDescription = content?.frontmatter.description;
  const detailContent = (
    <SkillReadDetail
      skill={skill}
      // An installed skill is always ready: Try it opens a chat with it
      // selected. The prompt waits for the content, which holds its example.
      primaryAction={
        <TryItPrimaryCta
          capability={{
            kind: 'skill',
            sourceId: skill.sourceId,
            catalogId: skill.name,
            name: skill.name,
          }}
          prompt={buildTryItPrompt({
            kind: 'skill',
            name: skill.name,
            description:
              typeof skillDescription === 'string' ? skillDescription : null,
            frontmatter: content?.frontmatter ?? null,
          })}
          installation={content === null ? 'loading' : 'installed'}
          runtimeSelections={{
            skillRefs: [{ sourceId: skill.sourceId, skillName: skill.name }],
            pluginRefs: [],
          }}
          onInstall={(): void => {}}
        />
      }
      content={content}
      files={files}
      filesTruncated={filesTruncated}
      loading={loading}
      error={error && loadErrorPrefix ? `${loadErrorPrefix} ${error}` : error}
      initialFilePath={skill.filePath}
      onEdit={onEdit}
      editWithAI={editWithAI}
      shareAction={shareAction}
      onRemove={onRemove}
      removeKind={removeKind}
      removePending={removePending}
      updateAction={updateAction}
      // A page shows the skill under its header (CAN-4264); a dialog keeps
      // its title bar and puts the notice above the content.
      header={
        presentation === 'page'
          ? installedSkillDetailHeader(
              skill.name,
              content,
              installedSkill,
              'skill-detail-modal-title',
              displayName,
            )
          : undefined
      }
      notice={presentation === 'page' ? notice : undefined}
      leadingContent={
        onNavigateBack || (notice && presentation !== 'page') ? (
          <>
            {onNavigateBack && (
              <DetailBackChip onNavigateBack={onNavigateBack} />
            )}
            {presentation !== 'page' && notice}
          </>
        ) : undefined
      }
      relatedContent={relatedContent}
      onViewStateChange={setViewState}
      readFile={async (path) => {
        const result = await window.skills.readFile(
          skill.sourceId,
          skill.name,
          path,
        );
        if (!result.success || !result.data) {
          throw new Error(result.error || 'Failed to load file.');
        }
        return result.data;
      }}
    />
  );

  if (presentation === 'page') {
    return (
      <section
        className="mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8"
        data-testid="plugins-entry-detail"
        aria-labelledby="skill-detail-modal-title"
      >
        {/* The header's visible title is the page heading. */}
        {detailContent}
      </section>
    );
  }

  return (
    <DialogModal
      onClose={() => onClose()}
      title={skill.name}
      titleId="skill-detail-modal-title"
      maxWidth={isMultiFile ? '4xl' : '2xl'}
      headerBorder={false}
      noEnterAnimation={noEnterAnimation}
      scrollableBody={false}
      topRightActions={<DetailActionBar slots={actionSlots} />}
    >
      <DetailActionSlotsProvider slots={actionSlots}>
        {detailContent}
      </DetailActionSlotsProvider>
    </DialogModal>
  );
}

// ---------------------------------------------------------------------------
// Skill editor (shared by CreateSkillModal and SharedSkillDetailModal)
// ---------------------------------------------------------------------------

interface MetadataRow {
  id: string;
  key: string;
  value: string;
  original?: {
    key: string;
    value: unknown;
  };
}

let nextMetadataRowId = 0;

function createMetadataRow(
  key: string,
  value: string,
  original?: { key: string; value: unknown },
): MetadataRow {
  nextMetadataRowId += 1;
  return { id: `metadata-row-${nextMetadataRowId}`, key, value, original };
}

interface EditorFileRow {
  id: string;
  path: string;
  content: string;
  /**
   * False for binary/oversized files that cannot be edited here; they are
   * kept as-is on save (path is sent without content).
   */
  editable: boolean;
}

let nextEditorFileId = 0;

function createEditorFileRow(
  path: string,
  content: string,
  editable = true,
): EditorFileRow {
  nextEditorFileId += 1;
  return { id: `editor-file-${nextEditorFileId}`, path, content, editable };
}

/**
 * Collapses parsed YAML values to JSON-safe shapes (a YAML timestamp's Date
 * becomes its ISO string via toJSON). Returns undefined for values JSON
 * cannot represent at all.
 */
function toJsonSafeFrontmatterValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return undefined;
    const parsed: unknown = JSON.parse(serialized);
    return parsed;
  } catch {
    return undefined;
  }
}

function frontmatterValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

interface SkillEditorInitialValues {
  name: string;
  description: string;
  body: string;
  extras: Array<{
    key: string;
    value: string;
    original?: { key: string; value: unknown };
  }>;
  files?: Array<{ path: string; content: string; editable?: boolean }>;
}

interface UseSkillEditorStateResult {
  name: string;
  description: string;
  body: string;
  metadataRows: MetadataRow[];
  showAdvanced: boolean;
  showPreview: boolean;
  skillName: string;
  trimmedDescription: string;
  nameError: string;
  isNameValid: boolean;
  metadataKeyError: string;
  normalizedExtras: Record<string, string>;
  preservedMetadata: Record<string, unknown>;
  previewContent: { frontmatter: Record<string, unknown>; body: string };
  hasContent: boolean;
  files: EditorFileRow[];
  openFileIds: string[];
  activeFileId: string | null;
  showFileTree: boolean;
  filesError: string;
  setName: (next: string) => void;
  setDescription: (next: string) => void;
  setBody: (next: string) => void;
  setShowAdvanced: (next: boolean) => void;
  setShowPreview: (next: boolean) => void;
  addMetadataRow: () => void;
  updateMetadataRow: (id: string, field: 'key' | 'value', next: string) => void;
  removeMetadataRow: (id: string) => void;
  addFile: () => void;
  updateFilePath: (id: string, next: string) => void;
  updateFileContent: (id: string, next: string) => void;
  removeFile: (id: string) => void;
  openFileTab: (id: string) => void;
  closeFileTab: (id: string) => void;
  selectMainFile: () => void;
  setShowFileTree: (next: boolean) => void;
  reset: (values: SkillEditorInitialValues) => void;
}

function useSkillEditorState(): UseSkillEditorStateResult {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [files, setFiles] = useState<EditorFileRow[]>([]);
  const [openFileIds, setOpenFileIds] = useState<string[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [showFileTree, setShowFileTree] = useState(false);

  const reset = (values: SkillEditorInitialValues): void => {
    setName(values.name);
    setDescription(values.description);
    setBody(values.body);
    const rows = values.extras
      .filter(({ key, value }) => key && value)
      .map(({ key, value, original }) =>
        createMetadataRow(key, value, original),
      );
    setMetadataRows(rows);
    setShowAdvanced(rows.length > 0);
    setShowPreview(false);
    setFiles(
      (values.files ?? []).map((file) =>
        createEditorFileRow(file.path, file.content, file.editable ?? true),
      ),
    );
    setOpenFileIds([]);
    setActiveFileId(null);
    setShowFileTree(false);
  };

  const addFile = (): void => {
    const taken = new Set(files.map((f) => f.path.trim().toLowerCase()));
    let candidate = 'new-file.md';
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `new-file-${suffix}.md`;
      suffix += 1;
    }
    const row = createEditorFileRow(candidate, '');
    setFiles((prev) => [...prev, row]);
    setOpenFileIds((prev) => [...prev, row.id]);
    setActiveFileId(row.id);
  };

  const updateFilePath = (id: string, next: string): void => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, path: next } : f)),
    );
  };

  const updateFileContent = (id: string, next: string): void => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, content: next } : f)),
    );
  };

  const removeFile = (id: string): void => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setOpenFileIds((prev) => prev.filter((openId) => openId !== id));
    setActiveFileId((prev) => (prev === id ? null : prev));
  };

  const openFileTab = (id: string): void => {
    setOpenFileIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveFileId(id);
  };

  const closeFileTab = (id: string): void => {
    setOpenFileIds((prev) => prev.filter((openId) => openId !== id));
    setActiveFileId((prev) => (prev === id ? null : prev));
  };

  const selectMainFile = (): void => {
    setActiveFileId(null);
  };

  const addMetadataRow = (): void => {
    setMetadataRows((prev) => [...prev, createMetadataRow('', '')]);
  };

  const updateMetadataRow = (
    id: string,
    field: 'key' | 'value',
    next: string,
  ): void => {
    setMetadataRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: next } : row)),
    );
  };

  const removeMetadataRow = (id: string): void => {
    setMetadataRows((prev) => prev.filter((row) => row.id !== id));
  };

  const normalizedExtras = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of metadataRows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key || /\s/.test(key)) continue;
      if (key === 'name' || key === 'description') continue;
      if (!value) continue;
      out[key] = value;
    }
    return out;
  }, [metadataRows]);

  const preservedMetadata = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const row of metadataRows) {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key || /\s/.test(key)) continue;
      if (key === 'name' || key === 'description') continue;
      if (!value) continue;
      const original = row.original;
      out[key] =
        original &&
        row.key === original.key &&
        row.value === frontmatterValueToString(original.value)
          ? original.value
          : value;
    }
    return out;
  }, [metadataRows]);

  const skillName = name;
  const trimmedDescription = description.trim();
  const nameError = getCustomSkillNameValidationError(skillName) ?? '';
  const isNameValid = !nameError;

  const metadataKeyError = useMemo(() => {
    const seen = new Set<string>();
    for (const row of metadataRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (/\s/.test(key)) {
        return `Metadata key "${row.key}" cannot contain whitespace.`;
      }
      if (key === 'name' || key === 'description') {
        return `Metadata key "${key}" is reserved.`;
      }
      if (seen.has(key)) {
        return `Duplicate metadata key "${key}".`;
      }
      seen.add(key);
    }
    return '';
  }, [metadataRows]);

  const previewContent = useMemo(
    () => ({
      frontmatter: {
        name: skillName,
        description: trimmedDescription,
        // The save payload uses preservedMetadata (typed originals for
        // untouched rows); the preview must render the same values or a
        // boolean like user-invocable: false previews as the string 'false'.
        ...preservedMetadata,
      },
      body,
    }),
    [skillName, trimmedDescription, body, preservedMetadata],
  );

  const filesError = useMemo(() => {
    const seen = new Set<string>();
    for (const file of files) {
      const filePath = file.path.trim();
      const pathError = getSkillFilePathValidationError(filePath);
      if (pathError) {
        return `File "${filePath || '(unnamed)'}": ${pathError}`;
      }
      const lower = filePath.toLowerCase();
      if (seen.has(lower)) {
        return `Duplicate file path "${filePath}".`;
      }
      seen.add(lower);
    }
    const lowerPaths = files.map((file) => file.path.trim().toLowerCase());
    for (const file of files) {
      const prefix = `${file.path.trim().toLowerCase()}/`;
      if (lowerPaths.some((other) => other.startsWith(prefix))) {
        return `File "${file.path.trim()}" conflicts with a folder of the same name.`;
      }
    }
    return '';
  }, [files]);

  const hasContent =
    isNameValid &&
    trimmedDescription.length > 0 &&
    body.trim().length > 0 &&
    !metadataKeyError &&
    !filesError;

  return {
    name,
    description,
    body,
    metadataRows,
    showAdvanced,
    showPreview,
    skillName,
    trimmedDescription,
    nameError,
    isNameValid,
    metadataKeyError,
    normalizedExtras,
    preservedMetadata,
    previewContent,
    hasContent,
    files,
    openFileIds,
    activeFileId,
    showFileTree,
    filesError,
    setName,
    setDescription,
    setBody,
    setShowAdvanced,
    setShowPreview,
    addMetadataRow,
    updateMetadataRow,
    removeMetadataRow,
    addFile,
    updateFilePath,
    updateFileContent,
    removeFile,
    openFileTab,
    closeFileTab,
    selectMainFile,
    setShowFileTree,
    reset,
  };
}

interface SkillEditorBodyProps {
  state: UseSkillEditorStateResult;
  /** Auto-focus the name input on first mount (create flow). */
  nameAutoFocus: boolean;
  /** Header copy shown above the edit/preview toggle. */
  headerHint: JSX.Element | string;
  /**
   * Show the multi-file authoring surface (file tabs, tree, add/delete).
   * Off for the shared-skill editor, which is single-file by contract.
   */
  enableFiles?: boolean;
  /**
   * Escape typed in a text field stays in the field instead of reaching the
   * host page's Escape (Back), so it cannot discard the edits being typed.
   */
  textEntryEscapeBoundary?: boolean;
}

function SkillEditorBody({
  state,
  nameAutoFocus,
  headerHint,
  enableFiles = false,
  textEntryEscapeBoundary = false,
}: SkillEditorBodyProps): JSX.Element {
  const escapeBoundary = textEntryEscapeBoundary ? 'true' : undefined;
  const activeFile = enableFiles
    ? (state.files.find((f) => f.id === state.activeFileId) ?? null)
    : null;

  const filePane = activeFile ? (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <label className="block flex-1 text-s">
          <span className="mb-1.5 block fg-secondary">File path</span>
          <input
            data-canopy-escape-boundary={escapeBoundary}
            type="text"
            value={activeFile.path}
            onChange={(e) =>
              state.updateFilePath(activeFile.id, e.target.value)
            }
            placeholder="references/notes.md"
            spellCheck={false}
            disabled={!activeFile.editable}
            data-testid="skill-file-path-input"
            className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s font-mono disabled:opacity-60"
          />
        </label>
        <Tooltip label="Delete file">
          <button
            type="button"
            onClick={() => state.removeFile(activeFile.id)}
            aria-label="Delete file"
            data-testid="skill-file-delete"
            className="focus-ring mb-0.5 rounded-lg border p-2 fg-secondary hover:fg-destructive hover:bg-secondary transition-colors"
          >
            <AppCatalogTrashIcon width="14" height="14" />
          </button>
        </Tooltip>
      </div>
      {activeFile.editable ? (
        state.showPreview ? (
          <SkillFilePreview
            filePath={activeFile.path.trim() || 'file.txt'}
            state={{
              loading: false,
              error: '',
              data: {
                content: activeFile.content,
                truncated: false,
                binary: false,
              },
            }}
          />
        ) : (
          <textarea
            data-canopy-escape-boundary={escapeBoundary}
            value={activeFile.content}
            onChange={(e) =>
              state.updateFileContent(activeFile.id, e.target.value)
            }
            rows={18}
            placeholder="File contents…"
            spellCheck={false}
            data-testid="skill-file-content-input"
            className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s font-mono resize-y"
          />
        )
      ) : (
        <p className="rounded-lg border bg-secondary/30 px-3 py-2 text-xs fg-secondary">
          This file cannot be edited here. It is kept unchanged when the skill
          is saved.
        </p>
      )}
    </div>
  ) : null;

  const mainPane = state.showPreview ? (
    <MarkdownFrontmatterContent
      loading={false}
      error=""
      content={state.previewContent}
      emptyText="Nothing to preview yet."
    />
  ) : (
    <div className="space-y-4">
      <label className="block text-s">
        <span className="mb-1.5 block fg-secondary">
          Name <span className="fg-destructive">*</span>
        </span>
        <input
          data-canopy-escape-boundary={escapeBoundary}
          type="text"
          value={state.name}
          onChange={(e) => state.setName(e.target.value)}
          placeholder="my-skill-name"
          className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s font-mono"
          spellCheck={false}
          autoFocus={nameAutoFocus}
          aria-invalid={state.name.length > 0 && !!state.nameError}
          aria-describedby="skill-name-help"
        />
        <span
          id="skill-name-help"
          className={`mt-1 block text-xs ${
            state.name.length > 0 && state.nameError
              ? 'fg-destructive'
              : 'fg-secondary'
          }`}
        >
          {state.name.length > 0 && state.nameError
            ? state.nameError
            : 'Lowercase letters, numbers, and hyphens only.'}
        </span>
      </label>

      <label className="block text-s">
        <span className="mb-1.5 block fg-secondary">
          Description <span className="fg-destructive">*</span>
        </span>
        <textarea
          data-canopy-escape-boundary={escapeBoundary}
          value={state.description}
          onChange={(e) => state.setDescription(e.target.value)}
          data-testid="skill-editor-description-input"
          placeholder="One-line summary of when this skill should be used."
          rows={2}
          className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s resize-y"
        />
      </label>

      <div>
        <button
          type="button"
          onClick={() => state.setShowAdvanced(!state.showAdvanced)}
          className="focus-ring inline-flex items-center gap-1.5 text-xs font-medium fg-secondary hover:fg-primary transition-colors"
        >
          <AppCatalogChevronRightMediumIcon
            width="10"
            height="10"
            className={`transition-transform ${state.showAdvanced ? 'rotate-90' : ''}`}
          />
          Advanced metadata
          {state.metadataRows.length > 0 && (
            <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-3xs">
              {state.metadataRows.length}
            </span>
          )}
        </button>

        {state.showAdvanced && (
          <div className="mt-2 rounded-lg border bg-secondary/30 p-3 space-y-2">
            <p className="text-xs fg-secondary">
              Extra YAML frontmatter keys. <code>name</code> and{' '}
              <code>description</code> are reserved.
            </p>
            {state.metadataRows.length === 0 && (
              <p className="text-xs fg-secondary italic">
                No additional fields.
              </p>
            )}
            {state.metadataRows.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <input
                  data-canopy-escape-boundary={escapeBoundary}
                  type="text"
                  value={row.key}
                  onChange={(e) =>
                    state.updateMetadataRow(row.id, 'key', e.target.value)
                  }
                  placeholder="key"
                  spellCheck={false}
                  className="focus-ring w-1/3 rounded border bg-base px-2 py-1 text-xs font-mono"
                />
                <input
                  data-canopy-escape-boundary={escapeBoundary}
                  type="text"
                  value={row.value}
                  onChange={(e) =>
                    state.updateMetadataRow(row.id, 'value', e.target.value)
                  }
                  placeholder="value"
                  className="focus-ring flex-1 rounded border bg-base px-2 py-1 text-xs"
                />
                <Tooltip label="Remove field">
                  <button
                    type="button"
                    onClick={() => state.removeMetadataRow(row.id)}
                    aria-label="Remove field"
                    className="focus-ring rounded p-1 fg-secondary hover:fg-destructive hover:bg-base transition-colors"
                  >
                    <AppCatalogCloseIcon width="12" height="12" />
                  </button>
                </Tooltip>
              </div>
            ))}
            {state.metadataKeyError && (
              <p className="text-xs fg-destructive">{state.metadataKeyError}</p>
            )}
            <button
              type="button"
              onClick={state.addMetadataRow}
              className="focus-ring inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium fg-secondary hover:fg-primary hover:bg-base transition-colors"
            >
              <AppCatalogPlusIcon width="12" height="12" />
              Add field
            </button>
          </div>
        )}
      </div>

      <label className="block text-s">
        <span className="mb-1.5 block fg-secondary">
          Skill content <span className="fg-destructive">*</span>
        </span>
        <textarea
          data-canopy-escape-boundary={escapeBoundary}
          value={state.body}
          onChange={(e) => state.setBody(e.target.value)}
          placeholder={`# My Skill\n\nDescribe how the skill should be used, including examples and constraints.`}
          rows={18}
          className="focus-ring w-full rounded-lg border bg-base px-3 py-2 text-s font-mono resize-y"
          spellCheck={false}
        />
      </label>
    </div>
  );

  const treePaths = [
    SKILL_MAIN_FILE,
    ...state.files.map((f) => f.path.trim()).filter(Boolean),
  ];

  return (
    <div className="px-5">
      <div className="flex items-center justify-between pb-3">
        <p className="text-xs fg-secondary">{headerHint}</p>
        <div className="inline-flex items-center rounded-md border bg-secondary p-0.5 text-xs">
          <button
            type="button"
            onClick={() => state.setShowPreview(false)}
            data-testid="skill-editor-mode-edit"
            className={`px-2.5 py-1 rounded transition-colors ${
              !state.showPreview
                ? 'bg-base fg-primary'
                : 'fg-secondary hover:fg-primary'
            }`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => state.setShowPreview(true)}
            data-testid="skill-editor-mode-preview"
            className={`px-2.5 py-1 rounded transition-colors ${
              state.showPreview
                ? 'bg-base fg-primary'
                : 'fg-secondary hover:fg-primary'
            }`}
          >
            Preview
          </button>
        </div>
      </div>

      {enableFiles && (
        <>
          <SkillFileTabBar
            tabs={state.openFileIds.flatMap((id) => {
              const file = state.files.find((f) => f.id === id);
              if (!file) return [];
              const trimmed = file.path.trim();
              return [
                {
                  key: id,
                  label: skillFileLabel(trimmed) || '(unnamed)',
                  title: trimmed || '(unnamed)',
                },
              ];
            })}
            activeKey={state.activeFileId}
            onSelectMain={state.selectMainFile}
            onSelectTab={state.openFileTab}
            onCloseTab={state.closeFileTab}
            treeToggle={{
              open: state.showFileTree,
              onToggle: () => state.setShowFileTree(!state.showFileTree),
            }}
            trailing={
              <Tooltip label="Add file">
                <button
                  type="button"
                  onClick={state.addFile}
                  aria-label="Add file"
                  data-testid="skill-editor-add-file"
                  className="focus-ring ml-1 shrink-0 rounded-md border border-transparent p-1.5 fg-secondary transition-colors hover:fg-primary hover:bg-secondary/50"
                >
                  <AppCatalogPlusIcon width="12" height="12" />
                </button>
              </Tooltip>
            }
          />
          {state.filesError && (
            <p className="pb-2 text-xs fg-destructive">{state.filesError}</p>
          )}
        </>
      )}

      <div className="flex gap-3">
        {enableFiles && state.showFileTree && (
          <div className="max-h-96 w-48 shrink-0 self-start overflow-y-auto rounded-lg border">
            <SkillFileTree
              files={treePaths}
              activePath={activeFile ? activeFile.path.trim() : null}
              onSelectFile={(selected) => {
                if (selected === SKILL_MAIN_FILE) {
                  state.selectMainFile();
                  return;
                }
                const target = state.files.find(
                  (f) => f.path.trim() === selected,
                );
                if (target) state.openFileTab(target.id);
              }}
            />
          </div>
        )}
        <div
          // Blocks the rendered SKILL.md and file previews; the edit form is
          // recorded with its input values masked. Keyed by mode so the block
          // class mounts with the preview: the recorder ignores a class added
          // to an already-recorded element.
          key={state.showPreview ? 'preview' : 'edit'}
          className={
            state.showPreview
              ? `${POSTHOG_REPLAY_BLOCK_CLASS} min-w-0 flex-1`
              : 'min-w-0 flex-1'
          }
          data-testid="skill-editor-pane"
        >
          {activeFile ? filePane : mainPane}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom skill editor: the create dialog and the installed skill's edit page
// ---------------------------------------------------------------------------

export interface CustomSkillEditorProps {
  /**
   * The custom skill to edit, or null to author a new one. The editor loads
   * the skill (SKILL.md plus supporting files) whenever this changes.
   */
  editingName: string | null;
  /**
   * `modal` is the authoring dialog. `page` is the installed skill's
   * Marketplace edit page (CAN-3485), laid out like the skill's detail page.
   */
  presentation: 'modal' | 'page';
  /** Dialog dismissal (X, backdrop, Escape); the dialog's Cancel too. */
  onClose: () => void;
  /** The page's Cancel and Back. Returns to the skill's details. */
  onCancel?: () => void;
  /**
   * Runs after a successful save with the saved (possibly renamed) name. The
   * dialog closes itself afterwards; the page leaves navigation to its host.
   * `isEditorOpen` reports whether this editor is still mounted, since the
   * user can leave the page while the save runs.
   */
  onSaved: (
    savedName: string,
    isEditorOpen: () => boolean,
  ) => Promise<void> | void;
  /**
   * "Edit with AI" on the edit page (CAN-1259), before Cancel. It waits for
   * Save or Cancel while the form has unsaved changes, which opening the chat
   * would discard.
   */
  editWithAI?: { onSelect: () => void; pending: boolean; error: string };
}

/** Why the edit page's "Edit with AI" waits (CAN-1259). */
const EDIT_WITH_AI_UNSAVED_REASON = 'Save or cancel your changes first.';

const PAGE_SECONDARY_ACTION_CLASS =
  'focus-ring inline-flex items-center gap-1.5 rounded-md border bg-secondary px-2.5 py-1 text-xs font-medium fg-primary hover:bg-accent-subtle transition-colors disabled:opacity-50';

/**
 * Custom skill authoring: name, description, advanced metadata, SKILL.md
 * content, supporting files, preview, validation, and save. One
 * implementation backs both the create dialog and the edit page.
 */
export function CustomSkillEditor({
  editingName,
  presentation,
  onClose,
  onCancel,
  onSaved,
  editWithAI,
}: CustomSkillEditorProps): JSX.Element {
  const editor = useSkillEditorState();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supportingFilesReady, setSupportingFilesReady] = useState(true);
  /** Fingerprint of the fields as loaded; `null` until they load. */
  const [loadedSnapshot, setLoadedSnapshot] = useState<string | null>(null);

  const isEdit = editingName !== null;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const mountedRef = useRef(true);
  useEffect((): (() => void) => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  // Reset the form whenever the editing target changes.
  useEffect(() => {
    setError('');
    if (editingName === null) {
      setSupportingFilesReady(true);
      editorRef.current.reset({
        name: '',
        description: '',
        body: '',
        extras: [],
      });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSupportingFilesReady(false);
    setLoadedSnapshot(null);

    void (async (): Promise<void> => {
      try {
        const [result, filesResult] = await Promise.all([
          window.skills.readContent('custom:app', editingName),
          window.skills.listFiles('custom:app', editingName),
        ]);
        if (cancelled) return;
        if (result.success && result.data) {
          const supportingPaths = resolveSupportingFilePaths(filesResult);
          if (!supportingPaths.success) {
            setError(supportingPaths.error);
            return;
          }
          const fm = result.data.frontmatter;
          const fmName = typeof fm.name === 'string' ? fm.name : editingName;
          const fmDescription =
            typeof fm.description === 'string' ? fm.description : '';
          const extras: Array<{
            key: string;
            value: string;
            original: { key: string; value: unknown };
          }> = [];
          for (const [k, v] of Object.entries(fm)) {
            if (k === 'name' || k === 'description') continue;
            // js-yaml's default schema can yield non-JSON values (e.g. Date
            // for YAML timestamps); preservedMetadata is a JSON-safe contract,
            // so normalize before capturing and derive the display string from
            // the same normalized value.
            const jsonSafeValue = toJsonSafeFrontmatterValue(v);
            if (jsonSafeValue === undefined) continue;
            const stringValue = frontmatterValueToString(jsonSafeValue);
            if (!stringValue) continue;
            extras.push({
              key: k,
              value: stringValue,
              original: { key: k, value: jsonSafeValue },
            });
          }

          // Load supporting files (everything except SKILL.md) so the
          // editor round-trips the full skill directory. Binary/oversized
          // files load as non-editable placeholders that are kept as-is.
          const extraPaths = supportingPaths.paths;
          const fileReads = await Promise.all(
            extraPaths.map((filePath) =>
              window.skills.readFile('custom:app', editingName, filePath),
            ),
          );
          if (cancelled) return;
          const files: Array<{
            path: string;
            content: string;
            editable?: boolean;
          }> = extraPaths.map((filePath, index) => {
            const read = fileReads[index];
            if (read.success && read.data) {
              return read.data.binary || read.data.truncated
                ? { path: filePath, content: '', editable: false }
                : { path: filePath, content: read.data.content };
            }
            return { path: filePath, content: '', editable: false };
          });

          editorRef.current.reset({
            name: fmName,
            description: fmDescription,
            body: result.data.body,
            extras,
            files,
          });
          // Mirrors how `reset` turns these values into editor rows.
          setLoadedSnapshot(
            skillEditorSnapshot({
              name: fmName,
              description: fmDescription,
              body: result.data.body,
              metadata: extras.filter(({ key, value }) => key && value),
              files: files.map((file) => ({
                path: file.path,
                content: file.content,
                editable: file.editable ?? true,
              })),
            }),
          );
          setSupportingFilesReady(true);
        } else {
          setError(result.error || 'Failed to load skill.');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [editingName]);

  const hasUnsavedChanges =
    loadedSnapshot !== null &&
    skillEditorSnapshot({
      name: editor.name,
      description: editor.description,
      body: editor.body,
      metadata: editor.metadataRows,
      files: editor.files,
    }) !== loadedSnapshot;

  const canSave = isSkillEditorSaveEnabled({
    saving,
    loading,
    supportingFilesReady,
    hasContent: editor.hasContent,
  });

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const files: SkillEditableFile[] = editor.files.map((file) =>
        file.editable
          ? { path: file.path.trim(), content: file.content }
          : { path: file.path.trim() },
      );
      const result = await window.skills.saveCustomSkill({
        name: editor.skillName,
        description: editor.trimmedDescription,
        body: editor.body,
        files,
        ...(Object.keys(editor.preservedMetadata).length > 0
          ? { preservedMetadata: editor.preservedMetadata }
          : {}),
        ...(editingName ? { originalName: editingName } : {}),
      });
      if (result.success) {
        await onSaved(
          result.data?.name ?? editor.skillName,
          () => mountedRef.current,
        );
        if (presentation === 'modal') onClose();
      } else {
        setError(result.error || 'Failed to save skill.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit ? `Edit skill: ${editingName}` : 'Create skill';
  const saveLabel = saving
    ? 'Saving…'
    : isEdit
      ? 'Save changes'
      : 'Create skill';
  const fields = loading ? (
    <LoadingPlaceholder label="Loading skill…" />
  ) : (
    <SkillEditorBody
      state={editor}
      nameAutoFocus={!isEdit}
      enableFiles
      textEntryEscapeBoundary={presentation === 'page'}
      headerHint={
        <>
          Custom skills are saved locally and shown as{' '}
          <span className="inline-flex items-center gap-1.5 align-middle">
            <span className="text-3xs bg-accent-subtle fg-accent px-1.5 py-0.5 rounded font-medium">
              custom
            </span>
            <span className="fg-primary font-medium">{brandText.appName}</span>
          </span>{' '}
          in the skills list.
        </>
      }
    />
  );

  if (presentation === 'page') {
    const cancel = onCancel ?? onClose;
    return (
      <section
        className="mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8 pb-5"
        data-testid="skill-editor-page"
        aria-labelledby="skill-editor-page-title"
      >
        <h1 id="skill-editor-page-title" className="sr-only">
          {title}
        </h1>
        <div className="px-5">
          <DetailBackChip onNavigateBack={cancel} />
          <div
            className="mb-2 flex justify-end gap-2"
            data-testid="skill-editor-page-actions"
          >
            {editWithAI && (
              <SkillEditWithAIButton
                state={
                  hasUnsavedChanges
                    ? { available: false, reason: EDIT_WITH_AI_UNSAVED_REASON }
                    : {
                        available: true,
                        onSelect: editWithAI.onSelect,
                        pending: editWithAI.pending || loading || saving,
                      }
                }
                dataTestId="skill-editor-edit-with-ai"
              />
            )}
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              data-testid="skill-editor-cancel"
              className={PAGE_SECONDARY_ACTION_CLASS}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              data-testid="skill-editor-save"
              className="focus-ring inline-flex items-center rounded-md bg-accent px-2.5 py-1 text-xs font-medium fg-emphasis disabled:opacity-60"
            >
              {saveLabel}
            </button>
          </div>
          <ErrorBanner error={error || (editWithAI?.error ?? '')} />
        </div>
        {fields}
      </section>
    );
  }

  return (
    <DialogModal
      onClose={onClose}
      title={title}
      titleId="create-skill-modal-title"
      maxWidth="3xl"
      headerBorder={false}
    >
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto pb-3">
          <div className="px-5">
            <ErrorBanner error={error} />
          </div>
          {fields}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            data-testid="skill-editor-cancel"
            className="focus-ring rounded-lg px-4 py-2 text-s font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            data-testid="skill-editor-save"
            className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </DialogModal>
  );
}

interface CreateSkillModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (savedName: string) => Promise<void>;
}

/**
 * Custom skill authoring dialog. Exported for the same reason as
 * {@link AddSkillsModal}: the Plugins discovery page's "Add custom…" dropdown
 * opens this dialog directly rather than forking it (API-2153). Editing an
 * existing skill opens {@link CustomSkillEditor} as a page instead (CAN-3485).
 */
export function CreateSkillModal({
  isOpen,
  onClose,
  onSaved,
}: CreateSkillModalProps): JSX.Element | null {
  if (!isOpen) return null;
  return (
    <CustomSkillEditor
      editingName={null}
      presentation="modal"
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

// ---------------------------------------------------------------------------
// SkillsTab
// ---------------------------------------------------------------------------

function renderSkillSource(skill: InstalledSkillInfo): JSX.Element {
  if (skill.custom) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-3xs bg-accent-subtle fg-accent px-1.5 py-0.5 rounded font-medium">
          custom
        </span>
        <span>{brandText.appName}</span>
      </span>
    );
  }
  if (skill.builtIn) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-3xs bg-accent-subtle fg-accent px-1.5 py-0.5 rounded font-medium">
          built-in
        </span>
        <span>{brandText.appName}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-3xs bg-secondary px-1.5 py-0.5 rounded font-medium">
        github
      </span>
      <a
        href={`https://github.com/${skill.source}`}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline hover:fg-primary transition-colors"
      >
        {skill.source}
      </a>
    </span>
  );
}

export function SkillsTab({
  onOpenSkill,
  onAddMarketplace,
  onOpenAccountSettings,
}: {
  /**
   * Opens an installed skill's Marketplace detail page. The list no longer
   * owns a skill viewer of its own (CAN-3483). `edit` opens the custom
   * skill's edit page on top of that detail instead (CAN-3485).
   */
  onOpenSkill: (skill: {
    sourceId: string;
    name: string;
    filePath?: string;
    edit?: true;
  }) => void;
  onAddMarketplace?: (repo: string) => void;
  /**
   * Invoked when an empty-account-state CTA is clicked. The parent page
   * opens the cloud account settings, where the cloud account is connected.
   */
  onOpenAccountSettings?: () => void;
}): JSX.Element {
  const { skills, loading, error, refresh, refreshOrThrow } = useSkillList();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const editWithAI = useEditSkillWithAI();

  // Shared-skill state — populated from the configured Canopy Cloud account
  // when it advertises `skills-crud-v1`. The hook automatically skips the
  // list when the capability is missing.
  const sharedSkills = useSharedSkillList();
  const skillActions = useInstalledSkillActions({
    onSkillsChanged: refresh,
    onUpdateInventoryRefresh: () =>
      notifySkillsChanged({ rejectOnFailure: true }),
    onShared: () => void sharedSkills.refreshShared(),
    onPublicLinkRemoved: () => void sharedSkills.refreshShared(),
    onOpenAccountSettings,
    onUpdateCheckComplete: () => void notifySkillsChanged(),
  });
  const [sharedFlash, setSharedFlash] = useState<string | null>(null);
  const [sharedSearch, setSharedSearch] = useState('');
  const [sharedCreatedBy, setSharedCreatedBy] = useState<'me' | 'anyone'>(
    'anyone',
  );
  const [sharedSkillModal, setSharedSkillModal] = useState<{
    mode: 'view' | 'edit';
    summary: SharedSkillSummary;
  } | null>(null);
  const [pendingSharedSkillDelete, setPendingSharedSkillDelete] = useState<{
    summary: SharedSkillSummary;
  } | null>(null);
  const [sharedSkillDeleting, setSharedSkillDeleting] = useState(false);
  const [sharedSkillDeleteError, setSharedSkillDeleteError] = useState<
    string | null
  >(null);
  const [activeView, setActiveView] = useState<'local' | 'shared'>('local');

  useWorkspaceContextReset((): void => {
    setSharedFlash(null);
    setSharedSearch('');
    setSharedCreatedBy('anyone');
    setSharedSkillModal(null);
    setPendingSharedSkillDelete(null);
    setSharedSkillDeleteError(null);
  });

  useCurrentUiStateReporter('plugins.sharedSkills', {
    filters: {
      ...(sharedSearch.trim() ? { query: sharedSearch.trim() } : {}),
      createdBy: sharedCreatedBy,
    },
    shareModalOpen: skillActions.shareDialogOpen,
    detailModal: sharedSkillModal
      ? {
          mode: sharedSkillModal.mode,
          id: sharedSkillModal.summary.id,
          name: sharedSkillModal.summary.name,
        }
      : null,
  });

  // Re-run filters / refresh first page when the user changes them. The hook
  // owns debounce semantics; we just push new filters.
  useEffect(() => {
    sharedSkills.setFilters({
      ...(sharedSearch.trim() ? { q: sharedSearch.trim() } : {}),
      createdBy: sharedCreatedBy,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedSearch, sharedCreatedBy]);

  const cloudSkillsReady =
    isCanopyCloudConnected(sharedSkills.cloudAccount) &&
    sharedSkills.cloudAccount?.capabilities.includes('skills-crud-v1') === true;

  // Lazy-load the first page when the user enters the shared view and the
  // Cloud account is ready.
  useEffect(() => {
    if (activeView !== 'shared') return;
    if (!cloudSkillsReady) return;
    if (sharedSkills.loaded || sharedSkills.loading) return;
    void sharedSkills.refreshShared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, cloudSkillsReady, sharedSkills.loaded, sharedSkills.loading]);

  const skillKey = (sourceId: string, name: string): string =>
    `${sourceId}/${name}`;

  // Skills mutated elsewhere — including from an installed skill's detail
  // page while this list waits hidden behind it (CAN-3483) — refresh both
  // views; the Shared view only once it has loaded.
  const sharedSkillsLoaded = sharedSkills.loaded;
  const refreshSharedSkills = sharedSkills.refreshShared;
  useEffect(() => {
    const handleSkillsChanged = (event: Event): void => {
      trackSkillsRefresh(event, refreshOrThrow());
      if (sharedSkillsLoaded) void refreshSharedSkills();
    };
    window.addEventListener(SKILLS_CHANGED_EVENT, handleSkillsChanged);
    return (): void => {
      window.removeEventListener(SKILLS_CHANGED_EVENT, handleSkillsChanged);
    };
  }, [refreshOrThrow, refreshSharedSkills, sharedSkillsLoaded]);

  useEffect(() => {
    const handleOpenViewer = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ sourceId?: string; skillName?: string }>
      ).detail;
      if (!detail?.sourceId || !detail.skillName) return;
      onOpenSkill({ sourceId: detail.sourceId, name: detail.skillName });
    };

    window.addEventListener(SKILL_OPEN_VIEWER_EVENT, handleOpenViewer);
    return (): void => {
      window.removeEventListener(SKILL_OPEN_VIEWER_EVENT, handleOpenViewer);
    };
  }, [onOpenSkill]);

  // Store-backed shared-skill deep link. Unlike the CustomEvent above — which
  // is dropped if it fires before this tab mounts — the pending payload waits
  // in the navigation store until this effect consumes it. Installed-skill
  // links open the Marketplace detail page and are consumed by the page.
  const pendingSkillViewer = useNavigationStore((s) => s.pendingSkillViewer);
  useEffect(() => {
    if (!pendingSkillViewer) return;
    if ('kind' in pendingSkillViewer && pendingSkillViewer.kind === 'shared') {
      setActiveView('shared');
      let cancelled = false;
      void window.skills
        .getShared(pendingSkillViewer.skillId)
        .then((detail) => {
          if (!cancelled) {
            setSharedSkillModal({ mode: 'view', summary: detail });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setActionError(resolveSharedResourceErrorMessage(error));
        })
        .finally(() => {
          if (!cancelled) useNavigationStore.getState().consumeSkillViewer();
        });
      return (): void => {
        cancelled = true;
      };
    }
    return undefined;
  }, [pendingSkillViewer]);

  // -------------------------------------------------------------------------
  // Shared skill row handlers.
  // -------------------------------------------------------------------------
  const handleSharedDelete = (summary: SharedSkillSummary): Promise<void> => {
    setSharedSkillDeleteError(null);
    setPendingSharedSkillDelete({ summary });
    return Promise.resolve();
  };

  const confirmSharedSkillDelete = async (): Promise<void> => {
    if (!pendingSharedSkillDelete || sharedSkillDeleting) return;
    const { summary } = pendingSharedSkillDelete;
    setSharedSkillDeleting(true);
    setSharedSkillDeleteError(null);
    setSharedFlash(null);
    setActionError(null);
    try {
      await window.skills.deleteShared({ skillId: summary.id });
      sharedSkills.removeSharedRow(summary.id);
      setSharedFlash('Shared skill deleted.');
      await sharedSkills.refreshShared();
      setPendingSharedSkillDelete(null);
    } catch (err) {
      const message = resolveSharedResourceErrorMessage(err, {
        deleteConflictMessage: SKILL_DELETE_CONFLICT_MESSAGE,
      });
      setSharedSkillDeleteError(`Failed to delete shared skill. ${message}`);
    } finally {
      setSharedSkillDeleting(false);
    }
  };

  const handleSharedUpdated = async (
    detail: SharedSkillDetail,
  ): Promise<void> => {
    setSharedFlash(`Shared skill "${detail.name}" updated.`);
    await sharedSkills.refreshShared();
  };

  return (
    <>
      {/* Local / Shared view tabs */}
      <div
        className="canopy-tab-list mb-4 flex gap-1"
        role="tablist"
        data-testid="skills-view-tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'local'}
          onClick={() => setActiveView('local')}
          data-testid="skills-view-tab-local"
          className={`canopy-tab-trigger px-4 py-2 text-s font-medium transition-colors ${
            activeView === 'local'
              ? 'fg-primary'
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          Local
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'shared'}
          onClick={() => setActiveView('shared')}
          data-testid="skills-view-tab-shared"
          className={`canopy-tab-trigger px-4 py-2 text-s font-medium transition-colors ${
            activeView === 'shared'
              ? 'fg-primary'
              : 'fg-secondary hover:fg-primary'
          }`}
        >
          Shared
        </button>
      </div>

      {/* Toolbar \u2014 local view only. */}
      {activeView === 'local' && (
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs fg-secondary">
            {skills.length > 0
              ? `${skills.length} skill${skills.length !== 1 ? 's' : ''} installed`
              : ''}
          </p>
          <div className="flex items-center gap-2">
            {skills.length > 0 && (
              <button
                onClick={skillActions.checkUpdates}
                disabled={skillActions.updatePending !== 'none'}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle transition-colors focus-ring disabled:opacity-50"
              >
                {skillActions.updatePending === 'checking'
                  ? 'Checking\u2026'
                  : 'Check for updates'}
              </button>
            )}
            <button
              onClick={() => setCreateSkillOpen(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle transition-colors focus-ring"
            >
              Create skill
            </button>
            <button
              onClick={() => setAddModalOpen(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent fg-emphasis hover:bg-accent/90 transition-colors focus-ring"
            >
              Add skills
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      <ErrorBanner
        error={
          error ||
          actionError ||
          skillActions.updateErrorFor() ||
          editWithAI.error ||
          null
        }
      />

      {/* Loading */}
      {activeView === 'local' && loading && skills.length === 0 && (
        <LoadingPlaceholder label="Loading skills…" space="page" />
      )}

      {/* Table */}
      {activeView === 'local' && skills.length > 0 && (
        <ResourceTable
          headers={[
            { label: 'Name', align: 'left' },
            { label: 'Source', align: 'left' },
            { label: 'Installed', align: 'left' },
            { label: 'Actions', align: 'right' },
          ]}
        >
          {skills
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((skill) => {
              const key = skillKey(skill.sourceId, skill.name);
              const updateAvailable = skillActions.updateAvailable(skill);
              return (
                <tr
                  key={key}
                  className="border-b last:border-b-0 hover:bg-secondary/30 transition-colors"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() =>
                        onOpenSkill({
                          sourceId: skill.sourceId,
                          name: skill.name,
                        })
                      }
                      className="text-left group"
                    >
                      <span className="fg-primary font-medium group-hover:fg-accent transition-colors">
                        {skill.name}
                      </span>
                      {skill.description && (
                        <p className="text-xs fg-secondary mt-0.5 line-clamp-1">
                          {skill.description}
                        </p>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 fg-secondary">
                    {renderSkillSource(skill)}
                  </td>
                  <td className="px-4 py-3 fg-secondary">
                    {skill.builtIn ? '\u2014' : formatDate(skill.installedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(skillActions.canRemove(skill) ||
                      skillActions.canShare(skill)) && (
                      <span className="inline-flex items-center gap-1">
                        {skillActions.canShare(skill) && (
                          <Tooltip label="Share">
                            <button
                              type="button"
                              onClick={() => skillActions.requestShare(skill)}
                              aria-label="Share skill"
                              data-testid={`skill-share-${skill.sourceId}-${skill.name}`}
                              className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                            >
                              <ShareIcon width={14} height={14} aria-hidden />
                            </button>
                          </Tooltip>
                        )}
                        {skill.custom && (
                          <Tooltip label="Edit skill">
                            <button
                              type="button"
                              onClick={() =>
                                onOpenSkill({
                                  sourceId: skill.sourceId,
                                  name: skill.name,
                                  edit: true,
                                })
                              }
                              aria-label="Edit skill"
                              data-testid={`skill-edit-${skill.sourceId}-${skill.name}`}
                              className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                            >
                              <AppCatalogDocumentPencilIcon
                                width="14"
                                height="14"
                              />
                            </button>
                          </Tooltip>
                        )}
                        {skill.custom && (
                          <Tooltip label={EDIT_WITH_AI_LABEL}>
                            <button
                              type="button"
                              onClick={() =>
                                editWithAI.start({
                                  sourceId: skill.sourceId,
                                  name: skill.name,
                                })
                              }
                              aria-disabled={editWithAI.pending || undefined}
                              aria-busy={editWithAI.pending || undefined}
                              aria-label={EDIT_WITH_AI_LABEL}
                              data-testid={`skill-edit-with-ai-${skill.sourceId}-${skill.name}`}
                              className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors aria-disabled:opacity-50"
                            >
                              <SparkleIcon width={14} height={14} aria-hidden />
                            </button>
                          </Tooltip>
                        )}
                        {skillActions.canUpdate(skill) && updateAvailable && (
                          <Tooltip label="Update available">
                            <button
                              type="button"
                              onClick={() => skillActions.applyUpdate(skill)}
                              disabled={skillActions.updatePending !== 'none'}
                              aria-label="Update available"
                              className="focus-ring rounded p-1 fg-accent hover:bg-secondary transition-colors disabled:opacity-50"
                            >
                              <RefreshSpinner
                                spinning={skillActions.isUpdating(skill)}
                              />
                            </button>
                          </Tooltip>
                        )}
                        {skillActions.canRemove(skill) && (
                          <Tooltip
                            label={
                              skill.custom ? 'Delete skill' : 'Remove skill'
                            }
                          >
                            <button
                              type="button"
                              onClick={() => skillActions.requestRemove(skill)}
                              disabled={skillActions.isRemoving(skill)}
                              aria-label={
                                skill.custom ? 'Delete skill' : 'Remove skill'
                              }
                              className="focus-ring rounded p-1 fg-secondary hover:fg-destructive hover:bg-secondary transition-colors disabled:opacity-50"
                            >
                              <AppCatalogTrashIcon width="14" height="14" />
                            </button>
                          </Tooltip>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
        </ResourceTable>
      )}

      {/* Empty state */}
      {activeView === 'local' && !loading && skills.length === 0 && !error && (
        <EmptyState
          title="No skills installed"
          subtitle="Add a GitHub source to discover and install skills"
        />
      )}

      {/* Shared skills */}
      {activeView === 'shared' && (
        <SharedSkillsSection
          sharedSkills={sharedSkills}
          search={sharedSearch}
          onSearchChange={setSharedSearch}
          createdBy={sharedCreatedBy}
          onCreatedByChange={setSharedCreatedBy}
          flash={sharedFlash}
          onView={(summary) => setSharedSkillModal({ mode: 'view', summary })}
          onEdit={(summary) => setSharedSkillModal({ mode: 'edit', summary })}
          onImport={(link) => {
            // The shared install review (CAN-3710) installs the skill and
            // lands on it.
            useNavigationStore.getState().openShareInstall(link, 'in-app');
          }}
          onDelete={handleSharedDelete}
          onOpenAccountSettings={onOpenAccountSettings}
        />
      )}

      {sharedSkillModal && (
        <SharedSkillDetailModal
          mode={sharedSkillModal.mode}
          summary={sharedSkillModal.summary}
          onClose={() => setSharedSkillModal(null)}
          onUpdated={(detail) => void handleSharedUpdated(detail)}
          onSwitchToEdit={() =>
            setSharedSkillModal({
              mode: 'edit',
              summary: sharedSkillModal.summary,
            })
          }
        />
      )}

      {skillActions.dialogs}

      <AddSkillsModal
        isOpen={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onInstalled={refresh}
        onAddMarketplace={onAddMarketplace}
      />

      <CreateSkillModal
        isOpen={createSkillOpen}
        onClose={() => setCreateSkillOpen(false)}
        onSaved={refresh}
      />

      {pendingSharedSkillDelete && (
        <DeleteConfirmModal
          title={`Delete shared skill "${pendingSharedSkillDelete.summary.name}"?`}
          message={SHARED_SKILL_DELETE_MESSAGE}
          pending={sharedSkillDeleting}
          error={sharedSkillDeleteError}
          onCancel={() => {
            if (sharedSkillDeleting) return;
            setPendingSharedSkillDelete(null);
            setSharedSkillDeleteError(null);
          }}
          onConfirm={() => void confirmSharedSkillDelete()}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// SharedSkillDetailModal
// ---------------------------------------------------------------------------

export function SharedSkillDetailModal({
  mode,
  summary,
  onClose,
  onUpdated,
  onSwitchToEdit,
  presentation = 'modal',
  onNavigateBack,
  onAdd,
  onOpenInstalled,
  shareAction,
  renderUnshare,
  unshareOptions,
}: {
  mode: 'view' | 'edit';
  summary: SharedSkillSummary;
  onClose: () => void;
  onUpdated: (detail: SharedSkillDetail) => void;
  onSwitchToEdit: () => void;
  presentation?: 'modal' | 'page';
  onNavigateBack?: () => void;
  /**
   * Opens the shared install review (CAN-3710), which installs the skill and
   * lands on it. This page never writes the skill itself.
   */
  onAdd?: () => void;
  /** Opens the installed local copy by its custom skill name. */
  onOpenInstalled?: (skillName: string) => void;
  /**
   * Marketplace Share, first in the top-right actions; a team share
   * explains who can share it.
   */
  shareAction?: MarketplaceShareAction;
  /**
   * The owner's Unshare, rendered first among the secondaries once the
   * detail loads. The host gates it on the loaded detail's own verdict, so
   * a stale list summary never decides it.
   */
  renderUnshare?: (detail: SharedSkillDetail) => ReactNode;
  /**
   * The owner's Unshare for the loaded detail, or `null` when its own
   * verdict withholds it. A page lists it last in the header ⋯ menu; a
   * dialog shows it as a bar button.
   */
  unshareOptions?: (
    detail: SharedSkillDetail,
  ) => UseMarketplaceUnshareOptions | null;
}): JSX.Element {
  const [detail, setDetail] = useState<SharedSkillDetail | null>(null);
  const canAdd = onAdd !== undefined && mode === 'view';
  // The installed copy of this share, when the arrival check finds one.
  const [installed, setInstalled] = useState<{ skillName: string } | null>(
    null,
  );
  const [checkingInstalled, setCheckingInstalled] = useState(canAdd);
  const [parsed, setParsed] = useState<{
    frontmatter: Record<string, unknown>;
    body: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publicShareBusy, setPublicShareBusy] = useState(false);
  const [publicShareUrl, setPublicShareUrl] = useState<string | null>(null);
  const [publicShareCopied, setPublicShareCopied] = useState(false);
  const [error, setError] = useState('');

  const editor = useSkillEditorState();
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const isEdit = mode === 'edit' && summary.canUpdate;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    // A share that fails to load must not leave the previous one in place for
    // the installed check to read.
    setDetail(null);
    void (async (): Promise<void> => {
      try {
        const nextDetail = await window.skills.getShared(summary.id);
        if (cancelled) return;
        setDetail(nextDetail);
        const parsedSource = parseSkillSource(nextDetail.rawSkill);
        setParsed(parsedSource);
        const fm = parsedSource.frontmatter;
        const fmName = typeof fm.name === 'string' ? fm.name : summary.name;
        const fmDescription =
          typeof fm.description === 'string'
            ? fm.description
            : summary.description;
        const extras: Array<{ key: string; value: string }> = [];
        for (const [k, v] of Object.entries(fm)) {
          if (k === 'name' || k === 'description') continue;
          const stringValue = frontmatterValueToString(v);
          if (!stringValue) continue;
          extras.push({ key: k, value: stringValue });
        }
        editorRef.current.reset({
          name: fmName,
          description: fmDescription,
          body: parsedSource.body,
          extras,
        });
      } catch (err: unknown) {
        if (!cancelled) {
          setError(resolveSharedResourceErrorMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [summary.id, summary.name, summary.description]);

  // Arrival check, against the loaded share: a skill added earlier opens on
  // its outcome instead of offering Add again. Keyed on what decides the
  // answer, so refreshing the public-link state does not repeat it.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const installCheckKey = detail
    ? [
        detail.id,
        detail.contentHash,
        detail.distributionMode ?? '',
        detail.package?.digest ?? '',
      ].join('\n')
    : null;
  useEffect(() => {
    if (!canAdd) return undefined;
    if (loading) {
      setInstalled(null);
      setCheckingInstalled(true);
      return undefined;
    }
    const loaded = detailRef.current;
    // A share that could not be read has nothing to compare: offer Add.
    if (loaded === null) {
      setCheckingInstalled(false);
      return undefined;
    }
    let cancelled = false;
    setCheckingInstalled(true);
    findInstalledSharedSkill(loaded)
      .then((skillName) => {
        if (!cancelled) setInstalled(skillName === null ? null : { skillName });
      })
      .catch(() => {
        // Best-effort: an unreadable inventory leaves Add available.
      })
      .finally(() => {
        if (!cancelled) setCheckingInstalled(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [canAdd, installCheckKey, loading]);

  useEffect(() => {
    let cancelled = false;
    setPublicShareCopied(false);
    const sharePath = detail?.publicShare?.sharePath;
    if (!sharePath) {
      setPublicShareUrl(null);
      return undefined;
    }
    void resolveSharedSkillUrl(sharePath).then((url) => {
      if (!cancelled) setPublicShareUrl(url);
    });
    return (): void => {
      cancelled = true;
    };
  }, [detail?.publicShare?.sharePath]);

  const refreshDetail = async (): Promise<void> => {
    try {
      const nextDetail = await window.skills.getShared(summary.id);
      setDetail(nextDetail);
      onUpdated(nextDetail);
    } catch {
      // Refresh is non-fatal — the mutation already succeeded; the row stays
      // stale until the modal is reopened.
    }
  };

  // Fall back to the server-minted relative path when the cloud base URL
  // cannot be resolved, so the link stays visible and copyable.
  const publicShareLink =
    publicShareUrl ?? detail?.publicShare?.sharePath ?? null;

  const handlePublishPublicShare = async (): Promise<void> => {
    if (!detail || publicShareBusy) return;
    setPublicShareBusy(true);
    setError('');
    try {
      // The mutation result is the local source of truth; the follow-up
      // refresh is best-effort so a transient getShared failure cannot leave
      // the row contradicting the completed server mutation.
      const publicShare = await window.skills.publishPublicShare(detail.id);
      const nextDetail = { ...detail, publicShare };
      setDetail(nextDetail);
      onUpdated(nextDetail);
      await refreshDetail();
    } catch (err: unknown) {
      setError(
        `Failed to publish public link. ${resolveSharedResourceErrorMessage(err)}`,
      );
    } finally {
      setPublicShareBusy(false);
    }
  };

  const handleRevokePublicShare = async (): Promise<void> => {
    if (!detail || publicShareBusy) return;
    setPublicShareBusy(true);
    setError('');
    try {
      await window.skills.revokePublicShare(detail.id);
      const nextDetail = { ...detail, publicShare: null };
      setDetail(nextDetail);
      onUpdated(nextDetail);
      await refreshDetail();
    } catch (err: unknown) {
      setError(
        `Failed to remove public link. ${resolveSharedResourceErrorMessage(err)}`,
      );
    } finally {
      setPublicShareBusy(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!isEdit || !detail || saving || !editor.hasContent) return;
    setSaving(true);
    setError('');
    try {
      const rawSkill = serializeSkillSource({
        name: editor.skillName,
        description: editor.trimmedDescription,
        body: editor.body,
        ...(Object.keys(editor.normalizedExtras).length > 0
          ? { extraMetadata: editor.normalizedExtras }
          : {}),
      });
      const updated = unwrapShareOperationResult(
        await window.skills.updateShared({
          skillId: detail.id,
          rawSkill,
          expectedContentHash: detail.contentHash,
        }),
      );
      setDetail(updated);
      const parsedSource = parseSkillSource(updated.rawSkill);
      setParsed(parsedSource);
      onUpdated(updated);
      onClose();
    } catch (err: unknown) {
      setError(
        `Failed to update shared skill. ${resolveSharedResourceErrorMessage(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const showInstalled = onAdd !== undefined && installed !== null;
  const showAdd = onAdd !== undefined && !showInstalled && !checkingInstalled;

  const page = presentation === 'page';
  const loadedUnshare =
    !loading && detail ? (unshareOptions?.(detail) ?? null) : null;
  const editButton = summary.canUpdate && (
    <button
      type="button"
      onClick={onSwitchToEdit}
      className={`${SECONDARY_ACTION_BUTTON_CLASS} gap-1.5`}
    >
      <AppCatalogDocumentPencilIcon width="12" height="12" />
      Edit
    </button>
  );
  // A page shows only a Share it can use; a blocked one reads as clutter.
  const visibleShareAction =
    page && shareAction?.status !== 'shareable' ? undefined : shareAction;

  // The standard action bar: [status] [Edit] [Share] [Add or Open skill].
  // A page keeps Edit, Share and the primary visible and moves the rest into
  // the header's ⋯ menu (CAN-4261).
  const pageActions: DetailPageActionsProps | undefined = !isEdit
    ? {
        secondary: page ? (
          editButton
        ) : (
          <>
            {!loading && detail && renderUnshare?.(detail)}
            {!loading && loadedUnshare && (
              <MarketplaceUnshareAction {...loadedUnshare} />
            )}
            {showInstalled && onOpenInstalled && (
              <button
                type="button"
                data-testid="shared-skill-detail-open"
                onClick={() => onOpenInstalled(installed.skillName)}
                className={SECONDARY_ACTION_BUTTON_CLASS}
              >
                Open skill
              </button>
            )}
            {showInstalled && (
              <span
                data-testid="shared-skill-detail-installed-status"
                className="min-w-0 break-words text-xs fg-secondary"
              >
                {`Added as “${installed.skillName}”.`}
              </span>
            )}
            {editButton}
          </>
        ),
        share: visibleShareAction ? (
          <MarketplaceShareButton
            action={visibleShareAction}
            name={summary.name}
            placement="detail"
            dataTestId="plugins-entry-detail-share"
          />
        ) : undefined,
        primary: (
          <TryItPrimaryCta
            capability={{
              kind: 'skill',
              sourceId: 'cloud-shared',
              catalogId: summary.id,
              name: summary.name,
            }}
            prompt={buildTryItPrompt({
              kind: 'skill',
              name: summary.name,
              description: summary.description,
              frontmatter: parsed?.frontmatter,
            })}
            installation={
              loading || checkingInstalled
                ? 'loading'
                : installed
                  ? 'installed'
                  : 'not-installed'
            }
            runtimeSelections={
              installed
                ? {
                    skillRefs: [
                      {
                        sourceId: CUSTOM_SKILL_SOURCE_ID,
                        skillName: installed.skillName,
                      },
                    ],
                    pluginRefs: [],
                  }
                : undefined
            }
            onInstall={() => onAdd?.()}
            installDisabled={!onAdd}
            guestInstallAction={
              showAdd ? (
                <button
                  type="button"
                  data-testid="shared-skill-detail-add"
                  onClick={onAdd}
                  className={SECONDARY_ACTION_BUTTON_CLASS}
                >
                  Install
                </button>
              ) : undefined
            }
          />
        ),
      }
    : undefined;
  const topRightActions = pageActions ? (
    <DetailActionBar {...pageActions} />
  ) : undefined;

  const detailContent = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto pb-3">
        <div className="px-5">
          <ErrorBanner error={error} />
        </div>
        {!page &&
          !loading &&
          detail &&
          (summary.canUpdate || detail.publicShare) && (
            <div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-secondary px-3 py-2 text-xs">
              <span className="font-medium fg-primary">Public link</span>
              {!detail.publicShare ? (
                summary.canUpdate && (
                  <button
                    type="button"
                    data-testid="shared-skill-publish-public-link"
                    disabled={publicShareBusy}
                    onClick={() => void handlePublishPublicShare()}
                    className="focus-ring rounded border bg-base px-2 py-1 font-medium fg-primary hover:bg-accent-subtle disabled:opacity-50"
                  >
                    {publicShareBusy ? 'Publishing…' : 'Publish public link'}
                  </button>
                )
              ) : (
                <>
                  {publicShareLink && (
                    <>
                      <span className="min-w-0 flex-1 truncate fg-secondary">
                        {publicShareLink}
                      </span>
                      <button
                        type="button"
                        data-testid="shared-skill-copy-public-link"
                        onClick={() => {
                          void copyTextToClipboard(publicShareLink).then(
                            (ok) => {
                              if (ok) setPublicShareCopied(true);
                            },
                          );
                        }}
                        className="focus-ring rounded border bg-base px-2 py-1 font-medium fg-primary hover:bg-accent-subtle"
                      >
                        {publicShareCopied ? 'Copied' : 'Copy link'}
                      </button>
                    </>
                  )}
                  {summary.canUpdate && !detail.publicShare.upToDate && (
                    <button
                      type="button"
                      data-testid="shared-skill-update-public-link"
                      disabled={publicShareBusy}
                      onClick={() => void handlePublishPublicShare()}
                      className="focus-ring rounded border bg-base px-2 py-1 font-medium fg-primary hover:bg-accent-subtle disabled:opacity-50"
                    >
                      Update link to latest version
                    </button>
                  )}
                  {summary.canUpdate && (
                    <button
                      type="button"
                      data-testid="shared-skill-remove-public-link"
                      disabled={publicShareBusy}
                      onClick={() => void handleRevokePublicShare()}
                      className="focus-ring rounded px-2 py-1 font-medium fg-destructive hover:bg-destructive-subtle disabled:opacity-50"
                    >
                      Remove public link
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        {!loading && detail?.savedFrom && (
          <p
            data-testid="shared-skill-detail-saved-from"
            className="mx-5 mb-3 text-xs fg-secondary"
          >
            {detail.savedFrom.name
              ? `Saved from ${detail.savedFrom.name}`
              : 'Saved copy'}
            {detail.savedFrom.createdByName
              ? ` by ${detail.savedFrom.createdByName}`
              : ''}
          </p>
        )}
        {loading ? (
          <LoadingPlaceholder label="Loading shared skill…" />
        ) : isEdit ? (
          <SkillEditorBody
            state={editor}
            nameAutoFocus={false}
            headerHint={`Edits are saved to ${brandText.appName} Cloud.`}
          />
        ) : (
          <SkillReadDetail
            skill={{ sourceId: 'cloud-shared', name: summary.name }}
            {...(page
              ? {
                  // The page header shows the name and description; the
                  // body drops its frontmatter card and repeated title.
                  hostHeader: {
                    title: summary.name,
                    description: summary.description,
                  },
                }
              : {})}
            content={parsed}
            files={[]}
            loading={false}
            error=""
            readFile={() =>
              Promise.reject(
                new Error(
                  'Open the installed copy to browse its supporting files.',
                ),
              )
            }
          />
        )}
      </div>
      {/* View mode has no footer: a Close would duplicate the X. */}
      {presentation === 'modal' && isEdit && (
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="focus-ring rounded-lg px-4 py-2 text-s font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={loading || saving || !editor.hasContent}
            className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );

  if (page) {
    // The shared detail header (CAN-4261): title, description and meta,
    // `[⋯] [Edit] [Share] [Primary]`, the rarer actions in ⋯ with the
    // owner's Unshare last.
    const moreItems: DetailMoreMenuItem[] = [];
    if (!isEdit && showInstalled && onOpenInstalled)
      moreItems.push({
        id: 'open-installed',
        label: 'Open installed skill',
        icon: <ArrowUpRightIcon width={14} height={14} aria-hidden />,
        testId: 'shared-skill-detail-open',
        onSelect: () => onOpenInstalled(installed.skillName),
      });
    if (!isEdit && !loading && detail) {
      if (!detail.publicShare && summary.canUpdate)
        moreItems.push({
          id: 'publish-public-link',
          label: publicShareBusy ? 'Publishing…' : 'Publish public link',
          icon: <GlobeIcon width={14} height={14} aria-hidden />,
          testId: 'shared-skill-publish-public-link',
          disabled: publicShareBusy,
          onSelect: () => void handlePublishPublicShare(),
        });
      if (detail.publicShare && publicShareLink)
        moreItems.push({
          id: 'copy-public-link',
          label: publicShareCopied ? 'Copied' : 'Copy public link',
          icon: <CopyIcon width={14} height={14} aria-hidden />,
          testId: 'shared-skill-copy-public-link',
          onSelect: () => {
            void copyTextToClipboard(publicShareLink).then((ok) => {
              if (ok) setPublicShareCopied(true);
            });
          },
        });
      if (
        detail.publicShare &&
        summary.canUpdate &&
        !detail.publicShare.upToDate
      )
        moreItems.push({
          id: 'update-public-link',
          label: 'Update public link',
          icon: <RefreshIcon width={14} height={14} aria-hidden />,
          testId: 'shared-skill-update-public-link',
          disabled: publicShareBusy,
          onSelect: () => void handlePublishPublicShare(),
        });
      if (detail.publicShare && summary.canUpdate)
        moreItems.push({
          id: 'remove-public-link',
          label: 'Remove public link',
          icon: <AppCatalogLink width={14} height={14} aria-hidden />,
          testId: 'shared-skill-remove-public-link',
          disabled: publicShareBusy,
          onSelect: () => void handleRevokePublicShare(),
        });
    }
    const header = {
      description: summary.description,
      meta: [
        showInstalled ? (
          <span data-testid="shared-skill-detail-installed-status">
            {`Added as “${installed.skillName}”`}
          </span>
        ) : null,
        !loading && detail?.publicShare ? 'Public link' : null,
      ],
    };
    const shell = (items: readonly DetailMoreMenuItem[]): JSX.Element => (
      <MarketplaceDetailPageShell
        title={summary.name}
        onNavigateBack={onNavigateBack}
        header={header}
        moreItems={items}
      >
        {pageActions && <DetailPageActions {...pageActions} />}
        {detailContent}
      </MarketplaceDetailPageShell>
    );
    return loadedUnshare ? (
      <SharedSkillUnshareShell options={loadedUnshare} items={moreItems}>
        {shell}
      </SharedSkillUnshareShell>
    ) : (
      shell(moreItems)
    );
  }

  return (
    <DialogModal
      onClose={saving ? (): void => {} : onClose}
      title={isEdit ? `Edit shared skill: ${summary.name}` : summary.name}
      titleId="shared-skill-detail-modal-title"
      maxWidth={isEdit ? '3xl' : '2xl'}
      headerBorder={false}
      closeOnBackdrop={!saving}
      topRightActions={topRightActions}
      scrollableBody={isEdit}
    >
      {detailContent}
    </DialogModal>
  );
}

/** Adds the owner's Unshare, last, to a shared skill page's ⋯ menu. */
function SharedSkillUnshareShell({
  options,
  items,
  children,
}: {
  options: UseMarketplaceUnshareOptions;
  items: readonly DetailMoreMenuItem[];
  children: (items: readonly DetailMoreMenuItem[]) => JSX.Element;
}): JSX.Element {
  const unshare = useMarketplaceUnshare(options);
  return (
    <>
      {children([...items, unshare.item])}
      {unshare.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// SharedSkillsSection
//
// Renders the shared-skill list under the existing local-skills table. Backed
// by the singleton {@link useSharedSkillList} that targets the configured
// Canopy Cloud account. Capability gating happens inside the hook so the
// section short-circuits when `skills-crud-v1` is missing.
// ---------------------------------------------------------------------------

interface SharedSkillsSectionProps {
  sharedSkills: ReturnType<typeof useSharedSkillList>;
  search: string;
  onSearchChange: (next: string) => void;
  createdBy: 'me' | 'anyone';
  onCreatedByChange: (next: 'me' | 'anyone') => void;
  flash: string | null;
  onView: (summary: SharedSkillSummary) => void;
  onEdit: (summary: SharedSkillSummary) => void;
  onImport: (link: DeepLinkShareOpenEvent) => void;
  onDelete: (summary: SharedSkillSummary) => Promise<void>;
  onOpenAccountSettings?: () => void;
}

export function SharedSkillsSection({
  sharedSkills,
  search,
  onSearchChange,
  createdBy,
  onCreatedByChange,
  flash,
  onView,
  onEdit,
  onImport,
  onDelete,
  onOpenAccountSettings,
}: SharedSkillsSectionProps): JSX.Element {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const { copiedKey, copy } = useClipboardCopy();
  const {
    cloudAccount,
    cloudLoading,
    skills,
    loading,
    loadingMore,
    nextCursor,
    error,
    refreshShared,
    loadMoreShared,
  } = sharedSkills;

  if (cloudLoading) {
    return (
      <section>
        <LoadingPlaceholder label="Loading shared skills…" space="section" />
      </section>
    );
  }

  const cloudReady = isCanopyCloudConnected(cloudAccount);
  const hasSkillsCapability =
    cloudAccount?.capabilities.includes('skills-crud-v1') === true;
  const accountUnavailableLabel =
    cloudReady && !hasSkillsCapability
      ? `This ${brandText.appName} Cloud account does not support shared skills.`
      : `No ${brandText.appName} Cloud account configured.`;

  if (!cloudReady || !hasSkillsCapability) {
    return (
      <section>
        <p className="text-s fg-secondary">{accountUnavailableLabel}</p>
        {onOpenAccountSettings && (
          <button
            type="button"
            onClick={onOpenAccountSettings}
            className="mt-2 rounded-lg border bg-base px-3 py-1.5 text-s font-medium fg-primary hover:bg-secondary focus-ring"
          >
            Open account settings
          </button>
        )}
      </section>
    );
  }

  return (
    <section data-testid="shared-skills-section">
      <div className="flex items-center justify-end mb-3">
        <button
          type="button"
          onClick={() => void refreshShared()}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle transition-colors focus-ring disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search shared skills…"
          className="focus-ring flex-1 min-w-50 rounded-md border bg-base px-2.5 py-1.5 text-xs"
        />
        <select
          value={createdBy}
          onChange={(e) => onCreatedByChange(e.target.value as 'me' | 'anyone')}
          className="focus-ring rounded-md border bg-base px-2 py-1.5 text-xs fg-primary"
        >
          <option value="anyone">Created by anyone</option>
          <option value="me">Created by me</option>
        </select>
      </div>

      {flash && <p className="mb-3 text-xs fg-success">{flash}</p>}

      {loading && skills.length === 0 && (
        <LoadingPlaceholder label="Loading shared skills…" space="section" />
      )}

      {error && (
        <div className="space-y-2">
          <ErrorBanner error={error} />
          <button
            type="button"
            onClick={() => void refreshShared()}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle focus-ring"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && skills.length === 0 && (
        <EmptyState
          testId={contextEnabled ? 'shared-skills-empty-state' : undefined}
          title="No shared skills found."
          subtitle=""
        />
      )}

      {skills.length > 0 && (
        <>
          <ResourceTable
            headers={[
              { label: 'Name', align: 'left' },
              { label: 'Owner', align: 'left' },
              { label: 'Updated', align: 'left' },
              { label: 'Actions', align: 'right' },
            ]}
          >
            {skills.map((summary) => {
              const installLink = sharedResourceInstallLink({
                entity: 'skill',
                externalId: summary.id,
                scope: summary.shareScope,
              });
              const description = markdownDescriptionToPlainText(
                summary.description,
              );
              return (
                <tr
                  key={summary.id}
                  data-testid={
                    contextEnabled
                      ? `shared-skill-row-${summary.id}`
                      : undefined
                  }
                  className="border-b last:border-b-0 hover:bg-secondary/30 transition-colors"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onView(summary)}
                      className="text-left group"
                    >
                      <span className="fg-primary font-medium group-hover:fg-accent transition-colors">
                        {summary.name}
                      </span>
                      {description && (
                        <p className="text-xs fg-secondary mt-0.5 line-clamp-1">
                          {description}
                        </p>
                      )}
                      {summary.savedFrom && (
                        <p
                          data-testid={`shared-skill-saved-from-${summary.id}`}
                          className="text-xs fg-secondary mt-0.5 line-clamp-1"
                        >
                          {summary.savedFrom.name
                            ? `Saved from ${summary.savedFrom.name}`
                            : 'Saved copy'}
                          {summary.savedFrom.createdByName
                            ? ` by ${summary.savedFrom.createdByName}`
                            : ''}
                        </p>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 fg-secondary">
                    {('name' in summary.owner ? summary.owner.name : null) ??
                      summary.owner.type}
                  </td>
                  <td className="px-4 py-3 fg-secondary">
                    {formatDate(summary.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-1">
                      {summary.publicShare && (
                        <Tooltip
                          label={
                            copiedKey === summary.id
                              ? 'Copied'
                              : 'Copy share link'
                          }
                        >
                          <button
                            type="button"
                            data-testid={`shared-skill-copy-link-${summary.id}`}
                            onClick={() => {
                              void resolveSharedSkillUrl(
                                summary.publicShare?.sharePath ?? '',
                              ).then((url) =>
                                copy(
                                  url ?? summary.publicShare?.sharePath ?? '',
                                  summary.id,
                                ),
                              );
                            }}
                            aria-label={
                              copiedKey === summary.id
                                ? 'Copied'
                                : 'Copy share link'
                            }
                            className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                          >
                            {copiedKey === summary.id ? (
                              <AppCatalogCheckIcon width="14" height="14" />
                            ) : (
                              <AppCatalogLink width="14" height="14" />
                            )}
                          </button>
                        </Tooltip>
                      )}
                      {summary.canUpdate && (
                        <Tooltip label="Edit shared skill">
                          <button
                            type="button"
                            onClick={() => onEdit(summary)}
                            aria-label="Edit shared skill"
                            className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                          >
                            <AppCatalogDocumentPencilIcon
                              width="14"
                              height="14"
                            />
                          </button>
                        </Tooltip>
                      )}
                      {/* A private skill resolves for its author only,
                          so it has nothing to import from here. */}
                      {installLink !== null && (
                        <Tooltip label="Import skill">
                          <button
                            type="button"
                            onClick={() => onImport(installLink)}
                            aria-label="Import skill"
                            className="focus-ring rounded p-1 fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
                          >
                            <AppCatalogDownload width="14" height="14" />
                          </button>
                        </Tooltip>
                      )}
                      {summary.canDelete && (
                        <Tooltip label="Delete shared skill">
                          <button
                            type="button"
                            onClick={() => void onDelete(summary)}
                            aria-label="Delete shared skill"
                            className="focus-ring rounded p-1 fg-secondary hover:fg-destructive hover:bg-secondary transition-colors"
                          >
                            <AppCatalogTrashIcon width="14" height="14" />
                          </button>
                        </Tooltip>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </ResourceTable>
          {nextCursor && (
            <div className="mt-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMoreShared()}
                disabled={loadingMore}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-secondary fg-primary hover:bg-accent-subtle focus-ring disabled:opacity-50"
              >
                <BusyLabel busy={loadingMore} busyText="Loading…">
                  Load more
                </BusyLabel>
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
