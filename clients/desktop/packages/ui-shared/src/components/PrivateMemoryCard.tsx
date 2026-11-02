import { useId, type JSX } from 'react';
import { InfoIcon } from '../icons/InfoIcon';
import { AdvancedDisclosure } from './AdvancedDisclosure';
import { ToggleSwitch } from './ToggleSwitch';
import { Tooltip } from './Tooltip';

const PRIVATE_MEMORY_LABEL = 'Private memory';

/** The Private memory explanation, verbatim wherever it shows (CAN-3562). */
const PRIVATE_MEMORY_EXPLANATION =
  "Agents won't use memory from other projects or your organization. New memories stay here.";

const PRIVATE_MEMORY_ON_HINT = `${PRIVATE_MEMORY_LABEL} on`;

/** Who locks a managed toggle; the organization is named when it is known. */
function privateMemoryManagedLabel(organizationName?: string | null): string {
  const name = organizationName?.trim();
  return name ? `Managed by ${name}` : 'Managed by your organization';
}

export interface PrivateMemoryCardProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** Locks the control while the caller saves or submits. */
  readonly disabled?: boolean;
  /**
   * An organization owns the value: the control is read-only and names its
   * owner. The caller keeps `checked` on the inherited value.
   */
  readonly managed?: boolean;
  readonly organizationName?: string | null;
  /** Why the last save was refused; shown with the control it belongs to. */
  readonly error?: string | null;
  /**
   * `card` frames the setting on its own, as in project settings. `inline`
   * drops the frame for a form that already sits inside a bordered panel.
   */
  readonly surface?: 'card' | 'inline';
  /** Root test id; the switch and managed line append `-toggle` / `-managed`. */
  readonly dataTestId?: string;
}

/**
 * The one Private memory control for project settings, Add project, and an
 * organization's project definition. Pure display: the caller owns the draft,
 * the save, and the managed state.
 */
export function PrivateMemoryCard({
  checked,
  onChange,
  disabled = false,
  managed = false,
  organizationName,
  error,
  surface = 'card',
  dataTestId = 'private-memory',
}: PrivateMemoryCardProps): JSX.Element {
  const switchId = useId();
  return (
    <div
      data-testid={dataTestId}
      data-managed={managed ? 'true' : undefined}
      className={surface === 'card' ? 'rounded-lg border p-4' : ''}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={switchId} className="text-s font-medium fg-primary">
            {PRIVATE_MEMORY_LABEL}
          </label>
          {/* `text-pretty`: a narrow form wraps without a one-word last line. */}
          <p className="mt-1 text-pretty text-xs fg-secondary">
            {PRIVATE_MEMORY_EXPLANATION}
          </p>
          {managed && (
            <p
              className="mt-1 text-xs fg-secondary"
              data-testid={`${dataTestId}-managed`}
            >
              {privateMemoryManagedLabel(organizationName)}
            </p>
          )}
        </div>
        <ToggleSwitch
          id={switchId}
          checked={checked}
          disabled={disabled || managed}
          label={PRIVATE_MEMORY_LABEL}
          onChange={onChange}
          dataTestId={`${dataTestId}-toggle`}
        />
      </div>
      {error && (
        <p
          role="alert"
          className="mt-2 text-xs fg-destructive"
          data-testid={`${dataTestId}-error`}
        >
          {error}
        </p>
      )}
    </div>
  );
}

export interface PrivateMemoryAdvancedOptionProps extends Omit<
  PrivateMemoryCardProps,
  // A create form reports a refused save with its own notice.
  'surface' | 'error'
> {
  /** Test id of the `Advanced` disclosure that holds the control. */
  readonly disclosureTestId?: string;
}

/**
 * Private memory as a create-time choice: off by default, so it waits behind
 * the low-profile `Advanced` disclosure instead of leading the form. A choice
 * left on stays named on the collapsed toggle.
 */
export function PrivateMemoryAdvancedOption({
  disclosureTestId,
  ...cardProps
}: PrivateMemoryAdvancedOptionProps): JSX.Element {
  return (
    <AdvancedDisclosure
      dataTestId={disclosureTestId}
      collapsedHint={cardProps.checked ? PRIVATE_MEMORY_ON_HINT : null}
    >
      <PrivateMemoryCard surface="inline" {...cardProps} />
    </AdvancedDisclosure>
  );
}

export interface PrivateMemoryInlineToggleProps {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  /** Root test id; the switch and info button append `-toggle` / `-info`. */
  readonly dataTestId?: string;
}

/**
 * Private memory as a compact create-time choice beside a form's action: the
 * switch and its label, with the explanation behind an info button whose
 * tooltip opens on hover, focus or tap.
 */
export function PrivateMemoryInlineToggle({
  checked,
  onChange,
  disabled = false,
  dataTestId = 'private-memory',
}: PrivateMemoryInlineToggleProps): JSX.Element {
  const switchId = useId();
  return (
    <div data-testid={dataTestId} className="flex min-w-0 items-center gap-2">
      <ToggleSwitch
        id={switchId}
        checked={checked}
        disabled={disabled}
        label={PRIVATE_MEMORY_LABEL}
        onChange={onChange}
        dataTestId={`${dataTestId}-toggle`}
      />
      <label htmlFor={switchId} className="text-xs fg-secondary">
        {PRIVATE_MEMORY_LABEL}
      </label>
      <Tooltip label={PRIVATE_MEMORY_EXPLANATION}>
        <button
          type="button"
          data-testid={`${dataTestId}-info`}
          aria-label={`About ${PRIVATE_MEMORY_LABEL}`}
          className="focus-ring shrink-0 rounded-full fg-tertiary transition-colors hover:fg-primary"
        >
          <InfoIcon />
        </button>
      </Tooltip>
    </div>
  );
}
