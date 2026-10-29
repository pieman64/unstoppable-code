import {
  ShareIcon,
  SettingsIcon as AppCatalogSettingsIcon,
  RevertIcon as AppCatalogRevertIcon,
  RedoIcon as AppCatalogRedoIcon,
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { type JSX, type ReactNode, useState } from 'react';
import type { ActivePanel, MainView } from '../../hooks/usePipelineEditor';
import { Tooltip } from '@canopy/ui-shared';

interface PipelineToolbarProps {
  name: string;
  onNameChange: (name: string) => void;
  activePanel: ActivePanel;
  onActivePanelChange: (panel: ActivePanel) => void;
  mainView: MainView;
  onMainViewChange: (view: MainView) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  isDirty: boolean;
  saving: boolean;
  onSave: () => void;
  onBack: () => void;
  onAddJob: () => void;
  readonly?: boolean;
  /** Read-only definition detail owns its own content toggle controls. */
  readDetail?: boolean;
  readDetailView?: 'flowchart' | 'details';
  onReadDetailViewChange?: (view: 'flowchart' | 'details') => void;
  /**
   * When provided the toolbar renders a `Share` button. Only `source: 'user'`
   * pipelines get the entry point — bundled / project / shared pipelines are
   * either read-only or already remote.
   */
  onShare?: () => void;
  headerAction?: ReactNode;
}

const VIEW_MODE_BUTTON_CLASS =
  'px-3 py-1 text-xs font-medium rounded transition-colors';

function viewModeButtonClass(active: boolean): string {
  return `${VIEW_MODE_BUTTON_CLASS} ${
    active ? 'bg-card fg-primary' : 'fg-secondary hover:fg-primary'
  }`;
}

export type PipelineViewModeControlsProps =
  | {
      /** A read-only definition toggles its Flow and Details views. */
      readonly mode: 'read';
      readonly view: 'flowchart' | 'details';
      readonly onViewChange: (view: 'flowchart' | 'details') => void;
    }
  | {
      /** An editable pipeline toggles Flow, List and Raw. */
      readonly mode: 'edit';
      readonly view: MainView;
      readonly onViewChange: (view: MainView) => void;
    };

/** The segmented view switch: Flow/Details when read-only, else Flow/List/Raw. */
export function PipelineViewModeControls(
  props: PipelineViewModeControlsProps,
): JSX.Element {
  if (props.mode === 'read') {
    const { view, onViewChange } = props;
    return (
      <div className="flex items-center bg-secondary rounded-md p-0.5">
        <button
          onClick={() => onViewChange('flowchart')}
          data-testid="pipeline-mode-flow"
          className={viewModeButtonClass(view === 'flowchart')}
        >
          Flow
        </button>
        <button
          onClick={() => onViewChange('details')}
          data-testid="pipeline-mode-details"
          className={viewModeButtonClass(view === 'details')}
        >
          Details
        </button>
      </div>
    );
  }
  const { view, onViewChange } = props;
  return (
    <div className="flex items-center bg-secondary rounded-md p-0.5">
      <button
        onClick={() => onViewChange('flowchart')}
        data-testid="pipeline-mode-flow"
        className={viewModeButtonClass(view === 'flowchart')}
      >
        Flow
      </button>
      <button
        onClick={() => onViewChange('list')}
        data-testid="pipeline-mode-visual"
        className={viewModeButtonClass(view === 'list')}
      >
        List
      </button>
      <button
        onClick={() => onViewChange('raw')}
        data-testid="pipeline-mode-raw"
        className={viewModeButtonClass(view === 'raw')}
      >
        Raw
      </button>
    </div>
  );
}

export interface PipelineAddJobButtonProps {
  readonly onAddJob: () => void;
}

export function PipelineAddJobButton({
  onAddJob,
}: PipelineAddJobButtonProps): JSX.Element {
  return (
    <button
      onClick={onAddJob}
      className="px-3 py-1.5 text-xs font-medium fg-secondary hover:fg-primary
            border rounded-md hover:bg-secondary transition-colors"
    >
      Add job
    </button>
  );
}

export interface PipelineSettingsToggleProps {
  /** The settings panel is open. */
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function PipelineSettingsToggle({
  open,
  onToggle,
}: PipelineSettingsToggleProps): JSX.Element {
  return (
    <button
      onClick={onToggle}
      data-testid="pipeline-editor-settings-toggle"
      className={`p-1.5 rounded-md transition-colors ${
        open
          ? 'bg-accent-subtle fg-accent'
          : 'fg-secondary hover:fg-primary hover:bg-secondary'
      }`}
    >
      <AppCatalogSettingsIcon width="16" height="16" />
    </button>
  );
}

export interface PipelineHistoryControlsProps {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

/** Undo and Redo, labelled with their shortcuts. */
export function PipelineHistoryControls({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: PipelineHistoryControlsProps): JSX.Element {
  const modKey = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  return (
    <>
      <Tooltip label={`Undo (${modKey}+Z)`}>
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="p-1.5 fg-secondary hover:fg-primary transition-colors rounded-md
                    hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Undo"
        >
          <AppCatalogRevertIcon width="16" height="16" />
        </button>
      </Tooltip>
      <Tooltip label={`Redo (${modKey}+Shift+Z)`}>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="p-1.5 fg-secondary hover:fg-primary transition-colors rounded-md
                    hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Redo"
        >
          <AppCatalogRedoIcon width="16" height="16" />
        </button>
      </Tooltip>
    </>
  );
}

export function PipelineToolbar({
  name,
  onNameChange,
  activePanel,
  onActivePanelChange,
  mainView,
  onMainViewChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isDirty,
  saving,
  onSave,
  onBack,
  onAddJob,
  readonly = false,
  readDetail = false,
  readDetailView = 'details',
  onReadDetailViewChange,
  onShare,
  headerAction,
}: PipelineToolbarProps): JSX.Element {
  const [editingName, setEditingName] = useState(false);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b bg-card shrink-0">
      {/* Back button */}
      <button
        onClick={onBack}
        data-testid="pipeline-editor-back"
        className="p-1.5 fg-secondary hover:fg-primary transition-colors rounded-md hover:bg-secondary"
      >
        <AppCatalogChevronLeftMediumIcon width="18" height="18" />
      </button>

      {/* Pipeline name (inline editable, or static label when readonly) */}
      {readonly ? (
        <span className="text-s font-medium fg-primary px-1 py-0.5">
          {name || 'Untitled pipeline'}
        </span>
      ) : editingName ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={() => setEditingName(false)}
          onKeyDown={(e) => e.key === 'Enter' && setEditingName(false)}
          className="text-s font-medium fg-primary bg-transparent border-b border-line-accent outline-none px-1 py-0.5"
        />
      ) : (
        <button
          onClick={() => setEditingName(true)}
          className="text-s font-medium fg-primary hover:fg-accent transition-colors px-1 py-0.5"
        >
          {name || 'Untitled pipeline'}
        </button>
      )}

      <div className="flex-1" />

      {headerAction}

      {/* View toggles */}
      {readDetail ? (
        <PipelineViewModeControls
          mode="read"
          view={readDetailView}
          onViewChange={(view) => onReadDetailViewChange?.(view)}
        />
      ) : (
        <PipelineViewModeControls
          mode="edit"
          view={mainView}
          onViewChange={onMainViewChange}
        />
      )}

      {/* Add Job (hidden in raw mode) */}
      {!readonly && mainView !== 'raw' && (
        <PipelineAddJobButton onAddJob={onAddJob} />
      )}

      {/* Settings toggle */}
      {!readDetail && (
        <PipelineSettingsToggle
          open={activePanel === 'settings'}
          onToggle={() =>
            onActivePanelChange(
              activePanel === 'settings' ? 'steps' : 'settings',
            )
          }
        />
      )}

      {/* Sharing is offered for any pipeline when enabled; non-user pipelines
          share a snapshot copy. */}
      {onShare && (
        <button
          onClick={onShare}
          data-testid="pipeline-share"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium fg-secondary
            hover:fg-primary border rounded-md hover:bg-secondary transition-colors"
        >
          <ShareIcon width={13} height={13} />
          Share
        </button>
      )}

      {!readonly && (
        <>
          <div className="w-px h-5 bg-line-base" />

          {/* Undo/Redo (hidden in raw mode — textarea has native undo) */}
          {mainView !== 'raw' && (
            <PipelineHistoryControls
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={onUndo}
              onRedo={onRedo}
            />
          )}

          {/* Save */}
          <button
            onClick={onSave}
            data-testid="pipeline-save"
            disabled={!isDirty || saving}
            className="px-4 py-1.5 text-xs font-medium bg-accent fg-emphasis rounded-md
              hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    </div>
  );
}
