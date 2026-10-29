import { createPortal } from 'react-dom';
import { type JSX, useEffect, useId, useState } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { Button } from '@canopy/ui-shared/components';
import { CloseIcon, PluginsIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PluginSelector } from '../shared/PluginSelector';
import { SettingsRow } from './SettingsLayout';
import { useSettingsButtonSize } from '@/hooks/useSettingsButtonSize';

interface SettingsPluginPickerProps {
  label: string;
  description: string;
  selections: ChatTabPluginSelections;
  onChange: (selections: ChatTabPluginSelections) => void;
  disabled?: boolean;
}

function countSelections(selections: ChatTabPluginSelections): number {
  return (
    selections.collectionIds.length +
    selections.skillRefs.length +
    selections.pluginRefs.length +
    (selections.mcpServerRefs?.length ?? 0)
  );
}

export function SettingsPluginPicker({
  label,
  description,
  selections,
  onChange,
  disabled = false,
}: SettingsPluginPickerProps): JSX.Element {
  const settingsButtonSize = useSettingsButtonSize();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ChatTabPluginSelections>(selections);
  const dialogTitleId = useId();

  // Keep the draft in sync with the latest selections whenever the modal is
  // closed; opening clones the current selections so the user starts editing
  // from the persisted state.
  useEffect(() => {
    if (!open) setDraft(selections);
  }, [open, selections]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return (): void => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const count = countSelections(selections);
  const summary = count === 0 ? 'No plugins selected' : `${count} selected`;

  function handleSave(): void {
    onChange(draft);
    setOpen(false);
  }

  function handleClose(): void {
    setOpen(false);
  }

  return (
    <>
      <SettingsRow
        label={label}
        description={description}
        control={
          <>
            <span className="text-xs fg-secondary">{summary}</span>
            <Button
              size={settingsButtonSize}
              variant="secondary"
              disabled={disabled}
              onClick={() => setOpen(true)}
              aria-label="Plugins"
            >
              <PluginsIcon width={14} height={14} aria-hidden="true" />
              Plugins
            </Button>
          </>
        }
      />

      {/* Portaled so the dialog is never a row of the settings group it
          opens from (the group pads and divides every direct child).
          `PluginSelector`'s table blocks its skill, plugin, and MCP server
          rows. */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={dialogTitleId}
              className="flex w-full max-w-2xl flex-col rounded-xl bg-card shadow-xl"
              style={{ maxHeight: '80vh' }}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b px-5 py-4">
                <h2
                  id={dialogTitleId}
                  className="text-m font-medium fg-primary"
                >
                  {label}
                </h2>
                <Button
                  size={settingsButtonSize}
                  variant="ghost"
                  iconOnly
                  onClick={handleClose}
                  aria-label="Close"
                >
                  <CloseIcon width={14} height={14} aria-hidden="true" />
                </Button>
              </div>

              <PluginSelector selections={draft} onChange={setDraft} />

              {/* Footer */}
              <div className="flex justify-end border-t px-5 py-3">
                <Button
                  size={settingsButtonSize}
                  variant="primary"
                  onClick={handleSave}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
