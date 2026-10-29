import { type JSX, useState } from 'react';
import type { PipelineScalar } from '@canopy/desktop-shared/types/pipeline';
import { TextField } from './TextField';
import { EnlargeValueModal } from './EnlargeValueModal';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import { Tooltip } from '@canopy/ui-shared';
import {
  MaximizeIcon as AppCatalogMaximizeIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';

type ValueType = 'string' | 'number' | 'boolean';

const TYPE_LABELS: Record<ValueType, string> = {
  string: 'Abc',
  number: '123',
  boolean: 'T/F',
};

const TYPE_ORDER: ValueType[] = ['string', 'number', 'boolean'];

interface KeyValueEditorProps {
  value: Record<string, PipelineScalar>;
  onChange: (value: Record<string, PipelineScalar>) => void;
  stringOnly?: boolean;
  readonly?: boolean;
}

function detectType(val: PipelineScalar): ValueType {
  if (typeof val === 'boolean') return 'boolean';
  if (typeof val === 'number') return 'number';
  return 'string';
}

function coerceToType(val: PipelineScalar, target: ValueType): PipelineScalar {
  if (target === 'boolean') {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    return val === 'true' || val === '1';
  }
  if (target === 'number') {
    if (typeof val === 'number') return val;
    if (typeof val === 'boolean') return val ? 1 : 0;
    const num = Number(val);
    return Number.isNaN(num) ? 0 : num;
  }
  // string
  return String(val);
}

export function KeyValueEditor({
  value,
  onChange,
  stringOnly,
  readonly = false,
}: KeyValueEditorProps): JSX.Element {
  const entries = Object.entries(value);
  const [newKey, setNewKey] = useState('');
  const [enlargeKey, setEnlargeKey] = useState<string | null>(null);

  function updateKey(oldKey: string, newKeyName: string): void {
    // Prevent empty key names and overwriting an existing key
    if (!newKeyName || (newKeyName !== oldKey && newKeyName in value)) return;
    const updated: Record<string, PipelineScalar> = {};
    for (const [k, v] of Object.entries(value)) {
      updated[k === oldKey ? newKeyName : k] = v;
    }
    onChange(updated);
  }

  function updateValue(key: string, newVal: string): void {
    const current = value[key];
    // Only coerce to number if the existing value is already numeric
    if (typeof current === 'number') {
      if (newVal === '') {
        onChange({ ...value, [key]: newVal });
        return;
      }
      const num = Number(newVal);
      onChange({ ...value, [key]: Number.isNaN(num) ? newVal : num });
      return;
    }
    onChange({ ...value, [key]: newVal });
  }

  function toggleBooleanValue(key: string): void {
    const current = value[key];
    onChange({ ...value, [key]: !current });
  }

  function cycleType(key: string): void {
    const current = value[key];
    const currentType = detectType(current);
    const currentIdx = TYPE_ORDER.indexOf(currentType);
    const nextType = TYPE_ORDER[(currentIdx + 1) % TYPE_ORDER.length];
    onChange({ ...value, [key]: coerceToType(current, nextType) });
  }

  function removeEntry(key: string): void {
    const updated = { ...value };
    delete updated[key];
    onChange(updated);
  }

  function addEntry(): void {
    if (newKey && !(newKey in value)) {
      onChange({ ...value, [newKey]: '' });
      setNewKey('');
    }
  }

  function handleEnlargeSave(key: string, newVal: PipelineScalar): void {
    onChange({ ...value, [key]: newVal });
  }

  return (
    <div className="space-y-3">
      {entries.map(([key, val]) => {
        const valType = detectType(val);
        return (
          <div
            key={key}
            className="rounded-md border bg-secondary/30 p-2 space-y-2"
          >
            {/* Row 1: key name + type button + enlarge button + delete */}
            <div className="flex gap-2 items-center">
              <TextField
                value={key}
                onChange={(e) => updateKey(key, e.target.value)}
                placeholder="Key"
                className="flex-1"
                disabled={readonly}
              />
              {!stringOnly && !readonly && (
                <ActionTooltip
                  title={`Type: ${valType}`}
                  description="Select to cycle"
                >
                  <button
                    type="button"
                    onClick={() => cycleType(key)}
                    aria-label={`Type: ${valType}. Select to cycle`}
                    className="px-1.5 py-1.5 text-3xs font-mono leading-none fg-secondary
                      hover:fg-primary bg-secondary rounded transition-colors min-w-8 text-center"
                  >
                    {TYPE_LABELS[valType]}
                  </button>
                </ActionTooltip>
              )}
              {!readonly && (
                <Tooltip label="Edit in expanded view">
                  <button
                    type="button"
                    onClick={() => setEnlargeKey(key)}
                    aria-label="Edit in expanded view"
                    className="p-1.5 fg-secondary hover:fg-primary transition-colors rounded"
                  >
                    <AppCatalogMaximizeIcon width="14" height="14" />
                  </button>
                </Tooltip>
              )}
              {!readonly && (
                <button
                  type="button"
                  onClick={() => removeEntry(key)}
                  className="p-1.5 fg-secondary hover:fg-destructive transition-colors rounded"
                >
                  <AppCatalogCloseIcon width="14" height="14" />
                </button>
              )}
            </div>

            {/* Row 2: value input (full width) */}
            <div>
              {!stringOnly && valType === 'boolean' ? (
                <button
                  type="button"
                  onClick={() => toggleBooleanValue(key)}
                  disabled={readonly}
                  className={`w-full px-3 py-2 text-s rounded-md border transition-colors text-left ${
                    val
                      ? 'bg-accent-subtle border-line-accent fg-accent'
                      : 'bg-base fg-secondary'
                  } ${readonly ? 'opacity-70 cursor-not-allowed' : ''}`}
                >
                  {val ? 'true' : 'false'}
                </button>
              ) : valType === 'number' ? (
                <TextField
                  value={String(val)}
                  onChange={(e) => updateValue(key, e.target.value)}
                  placeholder="Value"
                  type="number"
                  disabled={readonly}
                />
              ) : (
                <textarea
                  value={String(val)}
                  onChange={(e) => updateValue(key, e.target.value)}
                  placeholder="Value"
                  rows={2}
                  disabled={readonly}
                  className={`w-full px-3 py-2 text-s bg-base border rounded-md
 fg-primary placeholder:fg-secondary font-mono
 focus:outline-none focus:ring-2 focus:ring-line-accent/50 focus:border-line-accent
 transition-colors resize-y min-h-15 ${readonly ? 'opacity-70 cursor-not-allowed' : ''}`}
                />
              )}
            </div>
          </div>
        );
      })}
      {!readonly && (
        <div className="flex gap-2 items-center">
          <TextField
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="New key…"
            className="flex-1"
            onKeyDown={(e) => e.key === 'Enter' && addEntry()}
          />
          <button
            onClick={addEntry}
            disabled={!newKey || newKey in value}
            className="px-3 py-2 text-xs font-medium bg-secondary fg-primary rounded-md
              hover:bg-accent-subtle transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      )}

      {/* Enlarge modal */}
      {enlargeKey !== null && enlargeKey in value && (
        <EnlargeValueModal
          inputKey={enlargeKey}
          value={value[enlargeKey]}
          valueType={detectType(value[enlargeKey])}
          onSave={(newVal) => handleEnlargeSave(enlargeKey, newVal)}
          onClose={() => setEnlargeKey(null)}
        />
      )}
    </div>
  );
}
