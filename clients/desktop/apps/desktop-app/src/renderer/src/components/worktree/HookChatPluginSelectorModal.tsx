import { type JSX, useEffect, useState } from 'react';
import type { ShareablePluginRef } from '@canopy/desktop-shared/plugin-refs';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  countPluginSelections,
  emptyPluginSelections,
  normalizePluginSelections,
} from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { ShareablePluginSelector } from '../shared/ShareablePluginSelector';
import { PluginSelector } from '../shared/PluginSelector';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

interface BasePluginSelectorModalProps {
  onClose: () => void;
  title?: string;
  helperText?: string;
  overlayClassName?: string;
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
    overlayClassName = 'z-modal',
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    const modalDocument = ownerDocument ?? document;
    modalDocument.addEventListener('keydown', onKeyDown);
    return (): void => modalDocument.removeEventListener('keydown', onKeyDown);
  }, [onClose, ownerDocument]);

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center bg-overlay-scrim p-4 ${overlayClassName}`}
    >
      {/* The selector's table blocks its capability rows (names and
          descriptions). */}
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-full max-w-4xl flex-col rounded-xl bg-card shadow-xl"
        style={{ maxHeight: '85vh' }}
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-m font-semibold fg-primary">{title}</h2>
            <p className="mt-1 text-xs fg-secondary">{helperText}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary"
            aria-label="Close"
          >
            <AppCatalogCloseIcon width="14" height="14" />
          </button>
        </div>

        {fullMode ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <p className="px-5 pt-3 text-xs fg-secondary">{helperText}</p>
            <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
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

        <div className="flex items-center justify-between border-t px-5 py-3">
          <div className="text-xs fg-secondary">
            {selectionCount === 0
              ? 'No plugins selected'
              : `${selectionCount} selected`}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-s fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (props.mode === 'full') {
                  props.onSave(normalizePluginSelections(fullSelections));
                } else {
                  props.onSave(portableSelections);
                }
              }}
              className="rounded-lg bg-fg-primary/10 px-4 py-1.5 text-s font-medium fg-primary transition hover:bg-fg-primary/15"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
