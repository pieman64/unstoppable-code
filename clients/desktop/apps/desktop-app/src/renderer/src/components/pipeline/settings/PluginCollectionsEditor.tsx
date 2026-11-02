import { type JSX, useMemo, useState } from 'react';
import {
  buildShareablePluginDisplay,
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/desktop-shared/plugin-refs';
import type {
  PipelinePluginCollection,
  PipelinePluginDefault,
} from '@canopy/desktop-shared/types/pipeline';
import { HookChatPluginSelectorModal } from '@/components/worktree/HookChatPluginSelectorModal';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { TextAreaField } from '../shared/TextAreaField';
import { ToggleField } from '../shared/ToggleField';
import { Tooltip } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import {
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function generateCollectionId(name: string, existingIds: string[]): string {
  const base = slugify(name) || 'collection';
  let candidate = base;
  let n = 1;
  while (existingIds.includes(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

function stripRequired(def: PipelinePluginDefault): ShareablePluginRef {
  if (def.type === 'skill') {
    return {
      type: 'skill',
      source: def.source,
      skill_name: def.skill_name,
    };
  }
  if (def.type === 'codex_plugin') {
    return {
      type: 'codex_plugin',
      marketplace: def.marketplace,
      plugin_name: def.plugin_name,
    };
  }
  if (def.type === 'plugin') {
    return {
      type: 'plugin',
      marketplace: def.marketplace,
      plugin_name: def.plugin_name,
    };
  }
  return {
    type: 'claude_plugin',
    marketplace: def.marketplace,
    plugin_name: def.plugin_name,
  };
}

function attachRequired(
  ref: ShareablePluginRef,
  required: boolean,
): PipelinePluginDefault {
  if (ref.type === 'skill') {
    return required
      ? { ...ref, required: true }
      : {
          type: 'skill',
          source: ref.source,
          skill_name: ref.skill_name,
        };
  }
  if (ref.type === 'codex_plugin') {
    return required
      ? { ...ref, required: true }
      : {
          type: 'codex_plugin',
          marketplace: ref.marketplace,
          plugin_name: ref.plugin_name,
        };
  }
  if (ref.type === 'plugin') {
    return required
      ? { ...ref, required: true }
      : {
          type: 'plugin',
          marketplace: ref.marketplace,
          plugin_name: ref.plugin_name,
        };
  }
  return required
    ? { ...ref, required: true }
    : {
        type: 'claude_plugin',
        marketplace: ref.marketplace,
        plugin_name: ref.plugin_name,
      };
}

interface CollectionItemProps {
  collection: PipelinePluginCollection;
  existingIds: string[];
  onChange: (next: PipelinePluginCollection) => void;
  onRemove: () => void;
  readonly?: boolean;
}

function CollectionItem({
  collection,
  existingIds,
  onChange,
  onRemove,
  readonly = false,
}: CollectionItemProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idDraft, setIdDraft] = useState(collection.id);

  const defaultEntries = useMemo(
    () =>
      collection.defaults.map((def) => {
        const ref = stripRequired(def);
        let key: string;
        try {
          key = getShareablePluginRefKey(ref);
        } catch {
          key = `${def.type}:${JSON.stringify(def)}`;
        }
        return { def, ref, key };
      }),
    [collection.defaults],
  );

  const otherIds = existingIds.filter((id) => id !== collection.id);
  const idError =
    idDraft.trim() === ''
      ? 'ID is required'
      : otherIds.includes(idDraft)
        ? 'ID must be unique'
        : undefined;

  function commitId(): void {
    if (idError) {
      setIdDraft(collection.id);
      return;
    }
    if (idDraft !== collection.id) {
      onChange({ ...collection, id: idDraft });
    }
  }

  function updateRequired(key: string, required: boolean): void {
    const nextDefaults = collection.defaults.map((def, idx) => {
      const entryKey = defaultEntries[idx]?.key;
      if (entryKey !== key) return def;
      return attachRequired(stripRequired(def), required);
    });
    onChange({ ...collection, defaults: nextDefaults });
  }

  function removeDefault(key: string): void {
    const nextDefaults = collection.defaults.filter((_, idx) => {
      return defaultEntries[idx]?.key !== key;
    });
    onChange({ ...collection, defaults: nextDefaults });
  }

  function handlePickerSave(refs: ShareablePluginRef[]): void {
    const requiredByKey = new Map<string, boolean>();
    for (const entry of defaultEntries) {
      requiredByKey.set(entry.key, Boolean(entry.def.required));
    }
    const nextDefaults: PipelinePluginDefault[] = [];
    const seenKeys = new Set<string>();
    for (const ref of refs) {
      let key: string;
      try {
        key = getShareablePluginRefKey(ref);
      } catch {
        continue;
      }
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const required = requiredByKey.get(key) ?? false;
      nextDefaults.push(attachRequired(ref, required));
    }
    onChange({ ...collection, defaults: nextDefaults });
    setPickerOpen(false);
  }

  const currentRefs = defaultEntries.map((entry) => entry.ref);
  const summary = `${collection.defaults.length} plugin${collection.defaults.length === 1 ? '' : 's'}`;

  return (
    <div className="rounded-md border bg-secondary/30">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-fg-primary/[0.04]"
      >
        <AppCatalogChevronRightMediumIcon
          width="12"
          height="12"
          className={`mt-1 shrink-0 fg-secondary transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-s font-medium fg-primary">
            {collection.name || collection.id}
          </div>
          <div className="truncate text-xs fg-secondary">
            {summary}
            {collection.description ? ` — ${collection.description}` : ''}
          </div>
        </div>
        {!readonly && (
          <Tooltip label="Remove collection">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRemove();
                }
              }}
              aria-label="Remove collection"
              className="ml-2 p-1 fg-secondary hover:fg-destructive transition-colors rounded cursor-pointer"
            >
              <AppCatalogCloseIcon width="14" height="14" />
            </span>
          </Tooltip>
        )}
      </button>

      {expanded && (
        <div className="border-t p-3 space-y-3">
          <FormField
            label="ID"
            error={idError}
            hint="Referenced by steps via plugin_collection_id"
          >
            <TextField
              value={idDraft}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={commitId}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="collection-id"
              disabled={readonly}
            />
          </FormField>
          <FormField label="Name">
            <TextField
              value={collection.name}
              onChange={(e) =>
                onChange({ ...collection, name: e.target.value })
              }
              placeholder="Display name"
              disabled={readonly}
            />
          </FormField>
          <FormField label="Description">
            <TextAreaField
              value={collection.description ?? ''}
              onChange={(e) =>
                onChange({
                  ...collection,
                  description: e.target.value || undefined,
                })
              }
              rows={2}
              placeholder="Describe this collection…"
              disabled={readonly}
            />
          </FormField>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium fg-secondary ">
                Defaults
              </label>
              {!readonly && (
                <Button size="compact" onClick={() => setPickerOpen(true)}>
                  Pick plugins
                </Button>
              )}
            </div>
            {defaultEntries.length === 0 ? (
              <p className="text-xs fg-secondary italic">
                No defaults selected. Use “Pick plugins” to add shareable skills
                or marketplace plugins.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {defaultEntries.map((entry) => {
                  const display = buildShareablePluginDisplay(entry.ref);
                  const required = Boolean(entry.def.required);
                  return (
                    <li
                      key={entry.key}
                      className="flex items-center gap-2 rounded-md border bg-base px-2.5 py-1.5"
                    >
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium leading-none bg-accent-subtle fg-accent">
                        {entry.ref.type === 'skill' ? 'Skill' : 'Plugin'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-s fg-primary">
                          {display.title}
                        </div>
                        <div className="truncate text-xs fg-secondary">
                          {display.subtitle}
                        </div>
                      </div>
                      <label className="flex items-center gap-1.5 text-xs fg-secondary">
                        <ToggleField
                          checked={required}
                          onChange={(checked) =>
                            updateRequired(entry.key, checked)
                          }
                          disabled={readonly}
                          label="Required"
                        />
                        <span>Required</span>
                      </label>
                      {!readonly && (
                        <Tooltip label="Remove default">
                          <Button
                            variant="ghost-quiet"
                            size="compact"
                            iconOnly
                            onClick={() => removeDefault(entry.key)}
                            aria-label="Remove default"
                          >
                            <AppCatalogCloseIcon width="12" height="12" />
                          </Button>
                        </Tooltip>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {pickerOpen && (
        <HookChatPluginSelectorModal
          mode="portable"
          title="Select portable workflow defaults"
          initial={currentRefs}
          onSave={handlePickerSave}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

interface PluginCollectionsEditorProps {
  collections: PipelinePluginCollection[];
  onChange: (collections: PipelinePluginCollection[] | undefined) => void;
  readonly?: boolean;
}

export function PluginCollectionsEditor({
  collections,
  onChange,
  readonly = false,
}: PluginCollectionsEditorProps): JSX.Element {
  const existingIds = collections.map((c) => c.id);

  function addCollection(): void {
    const id = generateCollectionId('collection', existingIds);
    const next: PipelinePluginCollection = {
      id,
      name: 'New collection',
      defaults: [],
    };
    onChange([...collections, next]);
  }

  function updateCollection(
    index: number,
    next: PipelinePluginCollection,
  ): void {
    const updated = collections.slice();
    updated[index] = next;
    onChange(updated);
  }

  function removeCollection(index: number): void {
    const updated = collections.filter((_, i) => i !== index);
    onChange(updated.length > 0 ? updated : undefined);
  }

  return (
    <div className="space-y-2">
      {collections.length === 0 ? (
        <p className="text-xs fg-secondary italic">
          No collections defined. Add one so steps can reuse a shared set of
          plugin defaults.
        </p>
      ) : (
        collections.map((collection, index) => (
          <CollectionItem
            key={collection.id || `collection-${index}`}
            collection={collection}
            existingIds={existingIds}
            onChange={(next) => updateCollection(index, next)}
            onRemove={() => removeCollection(index)}
            readonly={readonly}
          />
        ))
      )}

      {!readonly && (
        <button
          type="button"
          onClick={addCollection}
          className="w-full px-3 py-2 text-xs font-medium border border-dashed rounded-md
            fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
        >
          + Add collection
        </button>
      )}
    </div>
  );
}
