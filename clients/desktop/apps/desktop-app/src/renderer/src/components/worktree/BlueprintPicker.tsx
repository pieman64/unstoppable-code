import { useState, type JSX } from 'react';
import type { DesktopBlueprintCatalogEntry } from '@canopy/desktop-shared/types';
import { WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER } from '@canopy/protocol';
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
 * These are toggle buttons rather than radios because the selection is
 * optional and clicking the active chip clears it, which a radio group cannot
 * express.
 *
 * Selected state uses `inset-ring-*` rather than a `border-<color>` utility:
 * `canopy-tokens.css` declares an unlayered `* { border-color: var(--line-base) }`
 * that makes every border-color utility inert (CAN-2734).
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
    <div data-testid="add-workspace-blueprint-picker">
      <FormSectionHeading
        title="Start from"
        subtitle="Sets up instructions and suggestions. You can change any of this later."
      />
      {loading ? (
        <p className="text-xs fg-secondary">Loading starting points…</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {visible.map((blueprint) => {
              const active = selectedExternalId === blueprint.externalId;
              return (
                <button
                  key={blueprint.externalId}
                  type="button"
                  data-testid={`add-workspace-blueprint-${blueprint.externalId}`}
                  aria-pressed={active}
                  disabled={disabled}
                  title={blueprint.document.description}
                  onClick={() => onSelect(active ? null : blueprint.externalId)}
                  className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition disabled:opacity-60 ${
                    active
                      ? 'bg-secondary fg-primary inset-ring-1 inset-ring-line-accent'
                      : 'bg-secondary/40 fg-secondary hover:fg-primary'
                  }`}
                >
                  {blueprint.document.name}
                </button>
              );
            })}
          </div>
          {sharedTemplates.length > 0 && (
            <div
              className="mt-3 space-y-1.5"
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
                    <button
                      key={template.externalId}
                      type="button"
                      aria-pressed={active}
                      disabled={disabled}
                      title={template.description}
                      onClick={() => onSelect(active ? null : selectionId)}
                      data-testid={`add-workspace-shared-template-${template.externalId}`}
                      className={`focus-ring rounded-lg px-3 py-1.5 text-xs transition disabled:opacity-60 ${
                        active
                          ? 'bg-secondary fg-primary inset-ring-1 inset-ring-line-accent'
                          : 'bg-secondary/40 fg-secondary hover:fg-primary'
                      }`}
                    >
                      {template.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {hidden > 0 && !expanded && (
            <button
              type="button"
              data-testid="add-workspace-blueprint-see-more"
              onClick={() => setExpanded(true)}
              className="focus-ring mt-2 text-xs fg-secondary underline underline-offset-2 hover:fg-primary"
            >
              Show {hidden} more
            </button>
          )}
          {/* The explanation is the heading's subtitle (CAN-3453); only a
              selected starting point's description or the unavailable notice
              sits under the chips. */}
          {unavailable ? (
            <p className="mt-2 text-xs fg-secondary">
              Starting points are unavailable right now.{' '}
              <button
                type="button"
                data-testid="add-workspace-blueprint-retry"
                onClick={onRetry}
                className="focus-ring underline underline-offset-2 hover:fg-primary"
              >
                Try again
              </button>
            </p>
          ) : (
            selectedExternalId !== null && (
              <p
                className="mt-2 text-xs fg-secondary"
                data-testid="add-workspace-blueprint-description"
              >
                {selectedShared?.description ??
                  blueprints.find(
                    (blueprint) => blueprint.externalId === selectedExternalId,
                  )?.document.description ??
                  'You can change any of this later.'}
              </p>
            )
          )}
          {selectedExternalId !== null && selectedRequirements.length > 0 && (
            <div
              className="mt-3 rounded-lg bg-secondary/30 px-3 py-2"
              data-testid="add-workspace-blueprint-requirements"
            >
              <p className="text-xs font-medium fg-primary">
                Set up after creating
              </p>
              <ul className="mt-1 space-y-1">
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
              <p className="mt-1.5 text-xs fg-secondary">
                {`Missing setup won’t stop this ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER} from being added.`}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function sharedTemplateSelectionId(externalId: string): string {
  return `shared:${externalId}`;
}
