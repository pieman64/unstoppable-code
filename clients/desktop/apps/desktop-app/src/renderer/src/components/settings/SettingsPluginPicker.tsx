import { type JSX, useEffect, useState } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { Button, DialogModal } from '@canopy/ui-shared/components';
import { PluginsIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PluginSelector } from '../shared/PluginSelector';
import { SettingsRow } from './SettingsLayout';

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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ChatTabPluginSelections>(selections);

  // Keep the draft in sync with the latest selections whenever the modal is
  // closed; opening clones the current selections so the user starts editing
  // from the persisted state.
  useEffect(() => {
    if (!open) setDraft(selections);
  }, [open, selections]);

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
              size="compact"
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

      {/* The shared dialog portals to the page body, so it is never a row
          of the settings group it opens from (the group pads and divides
          every direct child). `PluginSelector`'s table blocks its skill,
          plugin, and MCP server rows. No focus trap: the selector's own
          collection editor opens in a dialog of its own outside this card. */}
      {open && (
        <DialogModal
          title={label}
          maxWidth="2xl"
          onClose={handleClose}
          scrollableBody={false}
          footer={
            <>
              <Button size="compact" variant="secondary" onClick={handleClose}>
                Cancel
              </Button>
              <Button size="compact" variant="primary" onClick={handleSave}>
                Save
              </Button>
            </>
          }
        >
          <PluginSelector selections={draft} onChange={setDraft} />
        </DialogModal>
      )}
    </>
  );
}
