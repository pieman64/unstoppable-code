import { useCallback, useMemo, useState, type JSX } from 'react';
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
import type { BranchDisplayMapping } from '@canopy/desktop-shared/types';
import {
  applyBranchDisplayMapping,
  isValidRegex,
} from '@canopy/desktop-shared/lib/branch-display-mapping';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { Button, ToggleSwitch, FieldError } from '@canopy/ui-shared/components';
import {
  ChevronRightIcon,
  CloseIcon,
  DragHandleIcon,
  ForwardIcon,
  PlusIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSubRow,
  SettingsTextField,
} from './SettingsLayout';

interface BranchDisplayMappingsProps {
  mappings: BranchDisplayMapping[];
  onSave: (mappings: BranchDisplayMapping[]) => void;
}

function generateId(): string {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Inline example adder
// ---------------------------------------------------------------------------

interface ExampleInputProps {
  onAdd: (value: string) => void;
}

function ExampleInput({ onAdd }: ExampleInputProps): JSX.Element {
  const [value, setValue] = useState('');

  const submit = useCallback((): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setValue('');
  }, [value, onAdd]);

  return (
    <div className="flex items-center gap-2">
      <SettingsTextField
        mono
        type="text"
        width="md"
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
          setValue(e.target.value)
        }
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>): void => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="Add example branch…"
        aria-label="Example branch"
      />
      <Button
        size="compact"
        variant="secondary"
        onClick={submit}
        disabled={!value.trim()}
      >
        Add
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable mapping row
// ---------------------------------------------------------------------------

interface MappingRowProps {
  mapping: BranchDisplayMapping;
  onChange: (updated: BranchDisplayMapping) => void;
  onDelete: () => void;
}

/**
 * One mapping as one row of the section's group: the drag handle, switch,
 * and name stay on the row's line, and the matcher, result, options, and
 * examples open under it as sub-rows.
 */
function MappingRow({
  mapping,
  onChange,
  onDelete,
}: MappingRowProps): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: mapping.id });
  // A new custom mapping opens so its matcher can be filled in.
  const [expanded, setExpanded] = useState(
    !mapping.builtin && mapping.matcher === '',
  );

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const regexValid = mapping.matcher === '' || isValidRegex(mapping.matcher);
  const matcherId = `branch-mapping-${mapping.id}-matcher`;
  const matcherErrorId = `${matcherId}-error`;
  const resultId = `branch-mapping-${mapping.id}-result`;
  const replaceHyphensId = `branch-mapping-${mapping.id}-replace-hyphens`;
  const capitalizeId = `branch-mapping-${mapping.id}-capitalize`;

  const previews = useMemo((): Array<{
    input: string;
    output: string | null;
  }> => {
    if (!mapping.matcher || !regexValid || mapping.examples.length === 0)
      return [];
    return mapping.examples.map((ex) => ({
      input: ex,
      output: applyBranchDisplayMapping(ex, mapping),
    }));
  }, [mapping, regexValid]);

  const handleToggle = useCallback((): void => {
    onChange({ ...mapping, enabled: !mapping.enabled });
  }, [mapping, onChange]);

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-3">
      <div className="flex min-h-10 items-center gap-2">
        <span
          className="shrink-0 cursor-grab fg-secondary hover:fg-primary active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon size="sm" className="shrink-0" />
        </span>

        <ToggleSwitch
          id={`branch-display-mapping-switch-${mapping.id}`}
          checked={mapping.enabled}
          label={`Enable ${mapping.label}`}
          onChange={handleToggle}
        />

        {mapping.builtin ? (
          <div className="min-w-0 flex-1">
            <SettingsRow
              htmlFor={`branch-display-mapping-switch-${mapping.id}`}
              label={mapping.label}
            />
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <SettingsTextField
              type="text"
              width="full"
              value={mapping.label}
              onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                onChange({ ...mapping, label: e.target.value })
              }
              placeholder="Mapping name"
              aria-label="Mapping name"
            />
          </div>
        )}

        {!mapping.builtin && (
          <Button
            size="compact"
            variant="secondary"
            iconOnly
            onClick={onDelete}
            aria-label="Delete mapping"
          >
            <TrashIcon size="sm" />
          </Button>
        )}

        <Button
          size="compact"
          variant="secondary"
          iconOnly
          onClick={(): void => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? `Hide ${mapping.label} details`
              : `Show ${mapping.label} details`
          }
        >
          <ChevronRightIcon
            size="sm"
            className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          />
        </Button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 pl-16">
          <SettingsSubRow
            label="Matcher"
            htmlFor={matcherId}
            description="Regular expression matched against the branch name."
            control={
              <SettingsTextField
                mono
                id={matcherId}
                type="text"
                width="md"
                value={mapping.matcher}
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                  onChange({ ...mapping, matcher: e.target.value })
                }
                disabled={mapping.builtin}
                aria-invalid={!regexValid}
                aria-describedby={regexValid ? undefined : matcherErrorId}
                placeholder="^(?:[^\/]+\/)+(.+)$"
              />
            }
          >
            {!regexValid && (
              <FieldError id={matcherErrorId}>Invalid regex pattern</FieldError>
            )}
          </SettingsSubRow>

          <SettingsSubRow
            label="Result"
            htmlFor={resultId}
            description="Use $1, $2 for the matcher's capture groups."
            control={
              <SettingsTextField
                mono
                id={resultId}
                type="text"
                width="md"
                value={mapping.result}
                onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                  onChange({ ...mapping, result: e.target.value })
                }
                disabled={mapping.builtin}
                placeholder="$1"
              />
            }
          />

          <SettingsSubRow
            label="Replace hyphens"
            htmlFor={replaceHyphensId}
            control={
              <ToggleSwitch
                id={replaceHyphensId}
                checked={mapping.settings.replaceHyphens}
                disabled={mapping.builtin}
                label="Replace hyphens"
                onChange={(next): void =>
                  onChange({
                    ...mapping,
                    settings: { ...mapping.settings, replaceHyphens: next },
                  })
                }
              />
            }
          />

          <SettingsSubRow
            label="Capitalize"
            htmlFor={capitalizeId}
            control={
              <ToggleSwitch
                id={capitalizeId}
                checked={mapping.settings.capitalize}
                disabled={mapping.builtin}
                label="Capitalize"
                onChange={(next): void =>
                  onChange({
                    ...mapping,
                    settings: { ...mapping.settings, capitalize: next },
                  })
                }
              />
            }
          />

          <SettingsSubRow
            label="Examples"
            description="Preview how branch names display."
          >
            {previews.length > 0 && (
              <div className="flex flex-col gap-1">
                {previews.map((p, i) => {
                  const isReadonly = i < mapping.readonlyExampleCount;
                  return (
                    <div
                      key={`${mapping.id}-ex-${String(i)}`}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      {isReadonly ? (
                        <span className="w-7 shrink-0" />
                      ) : (
                        <Button
                          size="compact"
                          variant="secondary"
                          iconOnly
                          onClick={(): void =>
                            onChange({
                              ...mapping,
                              examples: mapping.examples.filter(
                                (_, idx) => idx !== i,
                              ),
                            })
                          }
                          aria-label="Remove example"
                        >
                          <CloseIcon size="sm" />
                        </Button>
                      )}
                      <span className="flex min-w-0 items-center gap-1 fg-tertiary">
                        <span className="truncate">
                          {p.input}
                          {p.output === null && ' (no match)'}
                        </span>
                        {p.output !== null && (
                          <>
                            <ForwardIcon
                              size="sm"
                              aria-hidden
                              className="shrink-0"
                            />
                            <span className="sr-only">becomes</span>
                            <span className="truncate font-medium fg-primary">
                              {p.output}
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <ExampleInput
              onAdd={(value: string): void =>
                onChange({
                  ...mapping,
                  examples: [...mapping.examples, value],
                })
              }
            />
          </SettingsSubRow>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BranchDisplayMappings({
  mappings,
  onSave,
}: BranchDisplayMappingsProps): JSX.Element {
  const [localMappings, setLocalMappings] =
    useState<BranchDisplayMapping[]>(mappings);
  const [expanded, setExpanded] = useState(false);

  const enabledCount = useMemo(
    () => localMappings.filter((m) => m.enabled).length,
    [localMappings],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = useMemo(() => localMappings.map((m) => m.id), [localMappings]);

  const update = useCallback(
    (next: BranchDisplayMapping[]): void => {
      setLocalMappings(next);
      onSave(next);
    },
    [onSave],
  );

  const handleChange = useCallback(
    (updated: BranchDisplayMapping): void => {
      update(localMappings.map((m) => (m.id === updated.id ? updated : m)));
    },
    [localMappings, update],
  );

  const handleDelete = useCallback(
    (id: string): void => {
      update(localMappings.filter((m) => m.id !== id));
    },
    [localMappings, update],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = localMappings.findIndex(
        (m) => m.id === String(active.id),
      );
      const newIndex = localMappings.findIndex((m) => m.id === String(over.id));
      if (oldIndex < 0 || newIndex < 0) return;
      update(arrayMove(localMappings, oldIndex, newIndex));
    },
    [localMappings, update],
  );

  const handleAdd = useCallback((): void => {
    const newMapping: BranchDisplayMapping = {
      id: generateId(),
      label: 'Custom mapping',
      matcher: '',
      result: '$1',
      settings: { replaceHyphens: true, capitalize: true },
      enabled: true,
      builtin: false,
      examples: [],
      readonlyExampleCount: 0,
    };
    update([...localMappings, newMapping]);
  }, [localMappings, update]);

  const rulesLabel = expanded ? 'Hide rules' : 'Show rules';

  return (
    <SettingsSection
      title="Branch display mappings"
      description="Turn branch names into readable names in the sidebar. The first matching rule wins."
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <SettingsGroup>
            <SettingsRow
              label="Rules"
              description={`${String(enabledCount)} of ${String(localMappings.length)} enabled`}
              control={
                <>
                  {expanded && (
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={handleAdd}
                    >
                      <PlusIcon size="sm" />
                      Add mapping
                    </Button>
                  )}
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={(): void => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    aria-label={rulesLabel}
                  >
                    <ChevronRightIcon
                      size="sm"
                      className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                    />
                    {expanded ? 'Hide' : 'Show'}
                  </Button>
                </>
              }
            />
            {expanded &&
              localMappings.map((mapping) => (
                <MappingRow
                  key={mapping.id}
                  mapping={mapping}
                  onChange={handleChange}
                  onDelete={() => handleDelete(mapping.id)}
                />
              ))}
            {expanded && (
              <SettingsRow
                label="Regenerate display names"
                description="Apply the current rules to every branch in the sidebar."
                control={
                  <Button
                    size="compact"
                    variant="secondary"
                    onClick={(): void =>
                      useBranchDisplayStore.getState().invalidateCache()
                    }
                  >
                    Regenerate
                  </Button>
                }
              />
            )}
          </SettingsGroup>
        </SortableContext>
      </DndContext>
    </SettingsSection>
  );
}
