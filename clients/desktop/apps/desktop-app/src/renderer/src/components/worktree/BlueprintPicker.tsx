import { useState, type JSX } from 'react';
import type { DesktopBlueprintCatalogEntry } from '@canopy/desktop-shared/types';
import { WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER } from '@canopy/protocol';
import {
  Button,
  StartingPointChip,
  Surface,
} from '@canopy/ui-shared/components';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol';
import { FormSectionHeading } from './FormSectionHeading';

/**
 * How many Blueprints render before the rest fold behind a reveal link
 * (CAN-2964 §7.1): the picker must not turn the create panel into a catalog.
 *
 * Six is the size of the curated set, so today it shows in full and no reveal
 * link renders. The link is not dead code — the curated set is server-side
 * editable, so a seventh Blueprint brings it straight back.
 */
const VISIBLE_BLUEPRINT_LIMIT = 6;

export interface BlueprintPickerProps {
  readonly blueprints: readonly DesktopBlueprintCatalogEntry[];
  readonly sharedTemplates?: readonly WorkspaceTemplateShareSummary[];
  readonly loading: boolean;
  readonly unavailable: boolean;
  /**
   * `null` is nothing selected, a string is a Blueprint. There is no third
   * "explicitly empty" state: not picking one IS the empty project, so the
   * picker has no option that means the same thing as leaving it alone.
   */
  readonly selectedExternalId: string | null;
  readonly onSelect: (externalId: string | null) => void;
  readonly onRetry: () => void;
  readonly disabled?: boolean;
}

/**
 * Curated Blueprint picker for the Work-mode create-project panel.
 *
 * Nothing is preselected (CAN-2964 §9.2): confirming the modal without
 * touching the picker takes the plain create path. The picker never reads the
 * onboarding role — leaving that read out is what keeps it from drifting back
 * into a preselect.
 *
 * Each chip is the shared `StartingPointChip`, the same toggle the web
 * Add workspace dialog renders.
 */
export function BlueprintPicker({
  blueprints,
  sharedTemplates = [],
  loading,
  unavailable,
  selectedExternalId,
  onSelect,
  onRetry,
  disabled,
}: BlueprintPickerProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, blueprints.length - VISIBLE_BLUEPRINT_LIMIT);
  const visible =
    expanded || hidden === 0
      ? blueprints
      : blueprints.slice(0, VISIBLE_BLUEPRINT_LIMIT);
  const selectedRequirements =
    blueprints.find((blueprint) => blueprint.externalId === selectedExternalId)
      ?.requirements ?? [];
  const selectedShared = sharedTemplates.find(
    (template) =>
      sharedTemplateSelectionId(template.externalId) === selectedExternalId,
  );

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="add-workspace-blueprint-picker"
    >
      <FormSectionHeading
        title="Start from"
        subtitle="Sets up instructions and suggestions. You can change any of this later."
      />
      {loading ? (
        <p className="text-xs fg-secondary">Loading starting points…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-1.5">
                {visible.map((blueprint) => {
                  const active = selectedExternalId === blueprint.externalId;
                  return (
                    <StartingPointChip
                      key={blueprint.externalId}
                      name={blueprint.document.name}
                      description={blueprint.document.description}
                      selected={active}
                      disabled={disabled}
                      onToggle={() =>
                        onSelect(active ? null : blueprint.externalId)
                      }
                      data-testid={`add-workspace-blueprint-${blueprint.externalId}`}
                    />
                  );
                })}
              </div>
              {sharedTemplates.length > 0 && (
                <div
                  className="flex flex-col gap-1.5"
                  data-testid="add-workspace-shared-templates"
                >
                  <p className="text-xs font-medium fg-secondary">
                    Shared with you
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {sharedTemplates.map((template) => {
                      const selectionId = sharedTemplateSelectionId(
                        template.externalId,
                      );
                      const active = selectedExternalId === selectionId;
                      return (
                        <StartingPointChip
                          key={template.externalId}
                          name={template.name}
                          description={template.description}
                          selected={active}
                          disabled={disabled}
                          onToggle={() => onSelect(active ? null : selectionId)}
                          data-testid={`add-workspace-shared-template-${template.externalId}`}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            {hidden > 0 && !expanded && (
              <p className="text-xs">
                <Button
                  variant="link"
                  data-testid="add-workspace-blueprint-see-more"
                  onClick={() => setExpanded(true)}
                >
                  Show {hidden} more
                </Button>
              </p>
            )}
            {/* The explanation is the heading's subtitle (CAN-3453); only a
              selected starting point's description or the unavailable notice
              sits under the chips. */}
            {unavailable ? (
              <p className="text-xs fg-secondary">
                Starting points are unavailable right now.{' '}
                <Button
                  variant="link"
                  data-testid="add-workspace-blueprint-retry"
                  onClick={onRetry}
                >
                  Try again
                </Button>
              </p>
            ) : (
              selectedExternalId !== null && (
                <p
                  className="text-xs fg-secondary"
                  data-testid="add-workspace-blueprint-description"
                >
                  {selectedShared?.description ??
                    blueprints.find(
                      (blueprint) =>
                        blueprint.externalId === selectedExternalId,
                    )?.document.description ??
                    'You can change any of this later.'}
                </p>
              )
            )}
          </div>
          {selectedExternalId !== null && selectedRequirements.length > 0 && (
            <Surface
              variant="group"
              className=""
              data-testid="add-workspace-blueprint-requirements"
            >
              <div className="flex flex-col gap-1 px-3 py-2">
                <p className="text-xs font-medium fg-primary">
                  Set up after creating
                </p>
                <ul className="flex flex-col gap-1">
                  {selectedRequirements.map((requirement) => (
                    <li
                      key={`${requirement.kind}:${requirement.id}`}
                      className="text-xs fg-secondary"
                    >
                      <span className="fg-primary">
                        {requirement.displayName}
                      </span>{' '}
                      — {requirement.setupHint}
                    </li>
                  ))}
                </ul>
                <p className="text-xs fg-secondary">
                  {`Missing setup won’t stop this ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER} from being added.`}
                </p>
              </div>
            </Surface>
          )}
        </div>
      )}
    </div>
  );
}

function sharedTemplateSelectionId(externalId: string): string {
  return `shared:${externalId}`;
}
