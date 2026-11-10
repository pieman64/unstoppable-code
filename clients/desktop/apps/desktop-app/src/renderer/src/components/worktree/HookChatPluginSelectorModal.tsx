import { Button, DialogModal } from '@canopy/ui-shared/components';
import { type JSX, useState } from 'react';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  countPluginSelections,
  emptyPluginSelections,
  normalizePluginSelections,
} from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { ShareablePluginSelector } from '../shared/ShareablePluginSelector';
import { PluginSelector } from '../shared/PluginSelector';

interface BasePluginSelectorModalProps {
  onClose: () => void;
  title?: string;
  helperText?: string;
  ownerDocument?: Document;
}

interface PortablePluginSelectorModalProps extends BasePluginSelectorModalProps {
  mode?: 'portable';
  initial: ShareablePluginRef[];
  onSave: (selections: ShareablePluginRef[]) => void;
}

interface FullPluginSelectorModalProps extends BasePluginSelectorModalProps {
  mode: 'full';
  initial: ChatTabPluginSelections;
  onSave: (selections: ChatTabPluginSelections) => void;
}

type HookChatPluginSelectorModalProps =
  | PortablePluginSelectorModalProps
  | FullPluginSelectorModalProps;

const HOOK_HELPER_COPY =
  'These plugins are added to the chat created by this hook, on top of the project default chat plugins. Only shareable skills and marketplace plugins can be saved to canopy.json.';

/**
 * Shared modal for runtime chat selections and portable pipeline defaults.
 * Runtime mode uses the same full `PluginSelector` as chat composers and
 * settings. Portable mode remains available for pipeline manifests that must
 * resolve across machines.
 */
export function HookChatPluginSelectorModal(
  props: HookChatPluginSelectorModalProps,
): JSX.Element {
  const {
    onClose,
    title = 'Select hook chat plugins',
    helperText = HOOK_HELPER_COPY,
    ownerDocument,
  } = props;
  const fullMode = props.mode === 'full';
  const [portableSelections, setPortableSelections] = useState<
    ShareablePluginRef[]
  >(() => (props.mode === 'full' ? [] : props.initial));
  const [fullSelections, setFullSelections] = useState<ChatTabPluginSelections>(
    () =>
      props.mode === 'full'
        ? normalizePluginSelections(props.initial)
        : emptyPluginSelections(),
  );
  const selectionCount = fullMode
    ? countPluginSelections(fullSelections)
    : portableSelections.length;

  return (
    <DialogModal
      onClose={onClose}
      title={title}
      subtitle={helperText}
      maxWidth="4xl"
      maxHeight="85vh"
      inset="flush"
      scrollableBody={false}
      ownerDocument={ownerDocument}
      footer={
        <>
          <span className="mr-auto text-xs fg-secondary">
            {selectionCount === 0
              ? 'No plugins selected'
              : `${selectionCount} selected`}
          </span>
          <Button size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => {
              if (props.mode === 'full') {
                props.onSave(normalizePluginSelections(fullSelections));
              } else {
                props.onSave(portableSelections);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {/* The selector's table blocks its capability rows (names and
          descriptions). */}
      {fullMode ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="px-6 pt-3 text-xs fg-secondary">{helperText}</p>
          <div className="flex min-h-0 flex-1 flex-col px-6 py-3">
            <PluginSelector
              selections={fullSelections}
              onChange={(nextSelections) =>
                setFullSelections((previousSelections) => ({
                  ...previousSelections,
                  ...nextSelections,
                  mcpHttpAuthPreferences:
                    previousSelections.mcpHttpAuthPreferences,
                }))
              }
              inset={false}
            />
          </div>
        </div>
      ) : (
        <ShareablePluginSelector
          selections={portableSelections}
          onChange={setPortableSelections}
          helperText={helperText}
        />
      )}
    </DialogModal>
  );
}
