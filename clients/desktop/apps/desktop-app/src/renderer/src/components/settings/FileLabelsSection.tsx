import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  FileLabelBucket,
  FileLabelMatcher,
} from '@canopy/desktop-shared/types';
import { isValidFileLabelPattern } from '@canopy/desktop-shared/file-labels';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DragHandleIcon,
  PlusIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Tooltip } from '@canopy/ui-shared';
import { Button, Notice, ToggleSwitch } from '@canopy/ui-shared/components';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsTextField,
} from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

interface FileLabelsSectionProps {
  labels: FileLabelBucket[];
  saveStatus: 'idle' | 'saving' | 'error';
  onSave: (labels: FileLabelBucket[]) => void;
  /**
   * Monotonic counter from a caller that wants this section expanded (the
   * changed-file filter menus' Settings entry). A non-zero value expands on
   * mount; later increments expand an already-open Files tab.
   */
  expandRequest?: number;
}

// ---------------------------------------------------------------------------
// Section disclosure
// ---------------------------------------------------------------------------

/**
 * Collapsed-by-default state for the Labels list. `expandRequest` opens it
 * from outside (see `FileLabelsSectionProps`).
 */
function useSectionDisclosure(expandRequest: number): {
  expanded: boolean;
  toggle: () => void;
} {
  const [expanded, setExpanded] = useState(expandRequest > 0);
  const lastExpandRequestRef = useRef(expandRequest);
  useEffect(() => {
    if (expandRequest !== lastExpandRequestRef.current) {
      lastExpandRequestRef.current = expandRequest;
      setExpanded(true);
    }
  }, [expandRequest]);
  const toggle = useCallback((): void => setExpanded((v) => !v), []);
  return { expanded, toggle };
}

interface SectionDisclosureButtonProps {
  expanded: boolean;
  onToggle: () => void;
  /** The list's summary while it is hidden, such as `3 globs enabled`. */
  collapsedLabel: string;
  expandedLabel: string;
  dataTestId: string;
}

/** Shows or hides a list; sits in the control slot of the list's header row. */
export function SectionDisclosureButton({
  expanded,
  onToggle,
  collapsedLabel,
  expandedLabel,
  dataTestId,
}: SectionDisclosureButtonProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  return (
    <Button
      size={settingsButtonSize}
      variant="ghost"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid={dataTestId}
    >
      {expanded ? expandedLabel : collapsedLabel}
      <ChevronDownIcon
        size={12}
        className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
      />
    </Button>
  );
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Matcher row
// ---------------------------------------------------------------------------

interface MatcherRowProps {
  matcher: FileLabelMatcher;
  onDraftChange: (updated: FileLabelMatcher) => void;
  onChange: (updated: FileLabelMatcher) => void;
  onDelete: () => void;
}

function MatcherRow({
  matcher,
  onDraftChange,
  onChange,
  onDelete,
}: MatcherRowProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: matcher.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const patternValid =
    matcher.builtin || isValidFileLabelPattern(matcher.pattern);
  const stopId = `file-label-matcher-stop-switch-${matcher.id}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col gap-1"
      data-testid={`file-label-matcher-${matcher.id}`}
    >
      <div className="flex min-h-7 items-center gap-2">
        <span
          className="shrink-0 cursor-grab fg-secondary hover:fg-primary active:cursor-grabbing"
          aria-label="Reorder matcher"
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon size={12} className="shrink-0" />
        </span>
        <ToggleSwitch
          checked={matcher.enabled}
          label={`Enable matcher ${matcher.pattern}`}
          dataTestId={`file-label-matcher-toggle-${matcher.id}`}
          onChange={() => onChange({ ...matcher, enabled: !matcher.enabled })}
        />
        {matcher.builtin ? (
          <code className="min-w-0 flex-1 truncate font-mono text-xs fg-primary">
            {matcher.pattern}
          </code>
        ) : (
          <div className="min-w-0 flex-1">
            <SettingsTextField
              mono
              type="text"
              width="full"
              value={matcher.pattern}
              onChange={(e) =>
                onDraftChange({ ...matcher, pattern: e.target.value })
              }
              onBlur={() => {
                if (isValidFileLabelPattern(matcher.pattern)) {
                  onChange({ ...matcher, pattern: matcher.pattern.trim() });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder="**/*.test.ts"
              aria-label="Matcher glob pattern"
              aria-invalid={!patternValid}
              data-testid={`file-label-matcher-pattern-${matcher.id}`}
            />
          </div>
        )}
        <Tooltip label="When this matcher matches, stop assigning further labels to the file.">
          <span className="flex shrink-0 items-center gap-2">
            <label htmlFor={stopId} className="text-xs fg-secondary">
              Don&apos;t keep matching
            </label>
            <ToggleSwitch
              id={stopId}
              checked={matcher.stopMatching}
              label={`Don't keep matching after ${matcher.pattern}`}
              dataTestId={`file-label-matcher-stop-${matcher.id}`}
              onChange={(next) => onChange({ ...matcher, stopMatching: next })}
            />
          </span>
        </Tooltip>
        {!matcher.builtin && (
          <Button
            size={settingsButtonSize}
            variant="ghost"
            iconOnly
            onClick={onDelete}
            aria-label={`Delete matcher ${matcher.pattern}`}
            data-testid={`file-label-matcher-delete-${matcher.id}`}
          >
            <TrashIcon size={12} />
          </Button>
        )}
      </div>
      {!patternValid && (
        <p className="pl-16 text-xs fg-destructive">
          Enter a valid glob pattern.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-matcher input
// ---------------------------------------------------------------------------

interface AddMatcherInputProps {
  bucketId: string;
  onAdd: (pattern: string) => void;
}

function AddMatcherInput({
  bucketId,
  onAdd,
}: AddMatcherInputProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback((): void => {
    const trimmed = value.trim();
    if (!isValidFileLabelPattern(trimmed)) {
      setError('Enter a valid glob pattern.');
      return;
    }
    onAdd(trimmed);
    setValue('');
    setError(null);
  }, [value, onAdd]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <SettingsTextField
          mono
          type="text"
          width="md"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add glob matcher…"
          aria-label="New glob matcher"
          data-testid={`file-label-add-matcher-input-${bucketId}`}
        />
        <Button
          size={settingsButtonSize}
          variant="secondary"
          onClick={submit}
          disabled={!value.trim()}
          data-testid={`file-label-add-matcher-${bucketId}`}
        >
          Add
        </Button>
      </div>
      {error !== null && (
        <p
          className="text-xs fg-destructive"
          data-testid={`file-label-add-matcher-error-${bucketId}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bucket row
// ---------------------------------------------------------------------------

interface BucketRowProps {
  bucket: FileLabelBucket;
  onDraftChange: (updated: FileLabelBucket) => void;
  onChange: (updated: FileLabelBucket) => void;
  onDelete: () => void;
}

function BucketRow({
  bucket,
  onDraftChange,
  onChange,
  onDelete,
}: BucketRowProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bucket.id });
  const [expanded, setExpanded] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const matcherSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const matcherIds = useMemo(
    () => bucket.matchers.map((m) => m.id),
    [bucket.matchers],
  );

  const handleMatcherChange = useCallback(
    (updated: FileLabelMatcher): void => {
      onChange({
        ...bucket,
        matchers: bucket.matchers.map((m) =>
          m.id === updated.id ? updated : m,
        ),
      });
    },
    [bucket, onChange],
  );

  const handleMatcherDraftChange = useCallback(
    (updated: FileLabelMatcher): void => {
      onDraftChange({
        ...bucket,
        matchers: bucket.matchers.map((m) =>
          m.id === updated.id ? updated : m,
        ),
      });
    },
    [bucket, onDraftChange],
  );

  const handleMatcherDelete = useCallback(
    (id: string): void => {
      onChange({
        ...bucket,
        matchers: bucket.matchers.filter((m) => m.id !== id),
      });
    },
    [bucket, onChange],
  );

  const handleMatcherDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = bucket.matchers.findIndex(
        (m) => m.id === String(active.id),
      );
      const newIndex = bucket.matchers.findIndex(
        (m) => m.id === String(over.id),
      );
      if (oldIndex < 0 || newIndex < 0) return;
      onChange({
        ...bucket,
        matchers: arrayMove(bucket.matchers, oldIndex, newIndex),
      });
    },
    [bucket, onChange],
  );

  const handleAddMatcher = useCallback(
    (pattern: string): void => {
      const matcher: FileLabelMatcher = {
        id: generateId('matcher'),
        pattern,
        enabled: true,
        stopMatching: false,
        builtin: false,
      };
      onChange({ ...bucket, matchers: [...bucket.matchers, matcher] });
    },
    [bucket, onChange],
  );

  const enabledMatchers = bucket.matchers.filter((m) => m.enabled).length;
  const nameValid = bucket.name.trim().length > 0;
  const stopId = `file-label-stop-switch-${bucket.id}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col gap-3"
      data-testid={`file-label-bucket-${bucket.id}`}
    >
      <div className="flex flex-col gap-1">
        <div className="flex min-h-7 items-center gap-2">
          <span
            className="shrink-0 cursor-grab fg-secondary hover:fg-primary active:cursor-grabbing"
            aria-label={`Reorder label ${bucket.name}`}
            {...attributes}
            {...listeners}
          >
            <DragHandleIcon size={12} className="shrink-0" />
          </span>
          <ToggleSwitch
            id={`file-label-switch-${bucket.id}`}
            checked={bucket.enabled}
            label={`Enable label ${bucket.name}`}
            dataTestId={`file-label-toggle-${bucket.id}`}
            onChange={() => onChange({ ...bucket, enabled: !bucket.enabled })}
          />
          {bucket.builtin ? (
            <label
              htmlFor={`file-label-switch-${bucket.id}`}
              className="min-w-0 flex-1 truncate text-s font-medium fg-primary"
            >
              {bucket.name}
            </label>
          ) : (
            <div className="min-w-0 flex-1">
              <SettingsTextField
                type="text"
                width="full"
                value={bucket.name}
                onChange={(e) =>
                  onDraftChange({ ...bucket, name: e.target.value })
                }
                onBlur={() => {
                  if (nameValid) {
                    onChange({ ...bucket, name: bucket.name.trim() });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                placeholder="Label name"
                aria-label="Label name"
                aria-invalid={!nameValid}
                data-testid={`file-label-name-${bucket.id}`}
              />
            </div>
          )}
          <Tooltip label="When a file matches this label, stop assigning further labels.">
            <span className="flex shrink-0 items-center gap-2">
              <label htmlFor={stopId} className="text-xs fg-secondary">
                Stop further labels
              </label>
              <ToggleSwitch
                id={stopId}
                checked={bucket.stopFurtherLabels}
                label={`Stop further labels after ${bucket.name}`}
                dataTestId={`file-label-stop-${bucket.id}`}
                onChange={(next) =>
                  onChange({ ...bucket, stopFurtherLabels: next })
                }
              />
            </span>
          </Tooltip>
          <Button
            size={settingsButtonSize}
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid={`file-label-expand-${bucket.id}`}
          >
            <ChevronRightIcon
              size={12}
              className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
            />
            {`${enabledMatchers}/${bucket.matchers.length} matcher${bucket.matchers.length === 1 ? '' : 's'}`}
          </Button>
          {!bucket.builtin && (
            <Button
              size={settingsButtonSize}
              variant="ghost"
              iconOnly
              onClick={onDelete}
              aria-label={`Delete label ${bucket.name}`}
              data-testid={`file-label-delete-${bucket.id}`}
            >
              <TrashIcon />
            </Button>
          )}
        </div>
        {!nameValid && (
          <p className="pl-16 text-xs fg-destructive">Enter a label name.</p>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 pl-16">
          <DndContext
            sensors={matcherSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleMatcherDragEnd}
          >
            <SortableContext
              items={matcherIds}
              strategy={verticalListSortingStrategy}
            >
              {bucket.matchers.map((matcher) => (
                <MatcherRow
                  key={matcher.id}
                  matcher={matcher}
                  onDraftChange={handleMatcherDraftChange}
                  onChange={handleMatcherChange}
                  onDelete={() => handleMatcherDelete(matcher.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <AddMatcherInput bucketId={bucket.id} onAdd={handleAddMatcher} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

/**
 * The Files page's Labels section: the ordered file-label buckets, one per
 * row of the section's group, behind the section's disclosure. Follows the
 * `BranchDisplayMappings` editing model: local mirror state, valid changes
 * saved through `onSave`, text drafts committed on blur, dnd-kit vertical
 * reordering, built-in rows toggle/reorder-only, custom rows fully editable.
 */
export function FileLabelsSection({
  labels,
  saveStatus,
  onSave,
  expandRequest = 0,
}: FileLabelsSectionProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const { expanded, toggle } = useSectionDisclosure(expandRequest);
  const changedFilesTitle = useEarlyAccessTitle('Changed Files');
  const [localLabels, setLocalLabels] = useState<FileLabelBucket[]>(labels);
  const lastSavedLabelsRef = useRef<FileLabelBucket[]>(labels);

  useEffect(() => {
    lastSavedLabelsRef.current = labels;
  }, [labels]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(() => localLabels.map((b) => b.id), [localLabels]);

  const update = useCallback(
    (next: FileLabelBucket[]): void => {
      setLocalLabels(next);
      const savedById = new Map(
        lastSavedLabelsRef.current.map((bucket) => [bucket.id, bucket]),
      );
      const persistable = next.map((bucket) => {
        const savedBucket = savedById.get(bucket.id);
        const name =
          bucket.name.trim().length > 0
            ? bucket.name
            : (savedBucket?.name ?? bucket.name);
        const savedMatchersById = new Map(
          savedBucket?.matchers.map((matcher) => [matcher.id, matcher]) ?? [],
        );
        const matchers = bucket.matchers.map((matcher) => {
          if (matcher.builtin || isValidFileLabelPattern(matcher.pattern)) {
            return matcher;
          }
          const savedMatcher = savedMatchersById.get(matcher.id);
          return savedMatcher
            ? { ...matcher, pattern: savedMatcher.pattern }
            : matcher;
        });
        return { ...bucket, name, matchers };
      });
      const valid = persistable.every(
        (bucket) =>
          bucket.name.trim().length > 0 &&
          bucket.matchers.every(
            (matcher) =>
              matcher.builtin || isValidFileLabelPattern(matcher.pattern),
          ),
      );
      if (valid) {
        lastSavedLabelsRef.current = persistable;
        onSave(persistable);
      }
    },
    [onSave],
  );

  const handleDraftChange = useCallback((updated: FileLabelBucket): void => {
    setLocalLabels((current) =>
      current.map((bucket) => (bucket.id === updated.id ? updated : bucket)),
    );
  }, []);

  const handleChange = useCallback(
    (updated: FileLabelBucket): void => {
      update(localLabels.map((b) => (b.id === updated.id ? updated : b)));
    },
    [localLabels, update],
  );

  const handleDelete = useCallback(
    (id: string): void => {
      update(localLabels.filter((b) => b.id !== id));
    },
    [localLabels, update],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = localLabels.findIndex((b) => b.id === String(active.id));
      const newIndex = localLabels.findIndex((b) => b.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      update(arrayMove(localLabels, oldIndex, newIndex));
    },
    [localLabels, update],
  );

  const handleAdd = useCallback((): void => {
    const bucket: FileLabelBucket = {
      id: generateId('label'),
      name: 'New label',
      enabled: true,
      stopFurtherLabels: false,
      builtin: false,
      matchers: [],
    };
    update([...localLabels, bucket]);
  }, [localLabels, update]);

  // The summary counts what is saved, so it matches the rest of the app.
  const enabledLabels = labels.filter((b) => b.enabled).length;

  return (
    <SettingsSection
      title="Changed files"
      dataTestId="settings-files-labels-section"
    >
      {expanded && saveStatus === 'error' && (
        <Notice intent="destructive" data-testid="settings-files-labels-error">
          Unable to save Labels settings.
        </Notice>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <SettingsGroup>
            <SettingsRow
              label="Labels"
              description={`Labels such as Tests and Documentation filter the ${changedFilesTitle} card and Review Changes view. They match in order, and a file can get several.`}
              control={
                <>
                  {expanded && (
                    <Button
                      size={settingsButtonSize}
                      variant="secondary"
                      onClick={handleAdd}
                      data-testid="file-labels-add-label"
                    >
                      <PlusIcon size={14} />
                      Add label
                    </Button>
                  )}
                  <SectionDisclosureButton
                    expanded={expanded}
                    onToggle={toggle}
                    collapsedLabel={`${enabledLabels}/${labels.length} labels enabled`}
                    expandedLabel="Hide labels"
                    dataTestId="settings-files-labels-section-toggle"
                  />
                </>
              }
            />
            {expanded &&
              localLabels.map((bucket) => (
                <BucketRow
                  key={bucket.id}
                  bucket={bucket}
                  onDraftChange={handleDraftChange}
                  onChange={handleChange}
                  onDelete={() => handleDelete(bucket.id)}
                />
              ))}
          </SettingsGroup>
        </SortableContext>
      </DndContext>
    </SettingsSection>
  );
}
