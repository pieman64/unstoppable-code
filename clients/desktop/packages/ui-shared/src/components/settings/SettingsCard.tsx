import type { JSX, ReactNode } from 'react';

/**
 * The first-level settings-card shell shared by the organization Settings
 * subtabs and the personal account surface: an accent icon medallion beside a
 * title, an optional one-line subtitle, and the card body.
 *
 * Hosted account and organization settings render on web and inside the
 * desktop Settings overlay, so this shell lives with the shared display
 * components. Desktop's own local settings panels keep their idiom
 * (`SettingsTabBar`, `PanelSection`).
 */
export const SETTINGS_CARD_CLASS = 'rounded-xl bg-card p-5 shadow-sm';
export const SETTINGS_CARD_ICON_CLASS =
  'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle fg-accent';
/**
 * The card title style. Exported so the bespoke-layout cards that hand-roll
 * their own heading row (and the suites that assert on it) share one literal
 * with the component instead of copying the class string.
 */
export const SETTINGS_CARD_TITLE_CLASS = 'text-m font-semibold fg-primary';
/** The card subtitle style, exported for the same reason as the title. */
export const SETTINGS_CARD_SUBTITLE_CLASS = 'mt-1 text-s fg-secondary';

export interface SettingsCardProps {
  /** Glyph for the accent medallion, e.g. `<CreditCard size={18} />`. */
  icon: ReactNode;
  /**
   * A string renders the canonical `<h2>`. Pass a node only when the heading
   * row carries extra inline chrome (pills, badges) and still owns its own
   * `<h2>`.
   */
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  testId?: string;
}

export function SettingsCard({
  icon,
  title,
  subtitle,
  children,
  testId,
}: SettingsCardProps): JSX.Element {
  return (
    <section className={SETTINGS_CARD_CLASS} data-testid={testId}>
      <div className="flex items-start gap-3">
        <span className={SETTINGS_CARD_ICON_CLASS}>{icon}</span>
        <div className="min-w-0 flex-1">
          {typeof title === 'string' ? (
            <h2 className={SETTINGS_CARD_TITLE_CLASS}>{title}</h2>
          ) : (
            title
          )}
          {subtitle ? (
            <p className={SETTINGS_CARD_SUBTITLE_CLASS}>{subtitle}</p>
          ) : null}
          {children ? <div className="mt-4">{children}</div> : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The bordered row a settings card lists its controls in, matching the Work
 * digests and Push notifications rows.
 */
export const SETTINGS_CARD_ROW_CLASS =
  'flex min-h-16 items-center justify-between gap-4 rounded-lg border px-4 py-3';

export interface SettingsCardSwitchProps {
  readonly id?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /**
   * Set while the value has not been read yet. `aria-checked` stays boolean
   * because WAI-ARIA does not allow `mixed` on `switch`.
   */
  readonly busy?: boolean;
  /** Accessible name. Required: the track renders no text of its own. */
  readonly label: string;
  readonly onChange: (next: boolean) => void;
  readonly dataTestId?: string;
}

/**
 * The on/off switch in a settings card row. Pure display: it reports the
 * requested next value, so the caller owns the async work and the `disabled`
 * window around it.
 */
export function SettingsCardSwitch({
  id,
  checked,
  disabled,
  busy,
  label,
  onChange,
  dataTestId,
}: SettingsCardSwitchProps): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-label={label}
      disabled={disabled}
      data-testid={dataTestId}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        checked
          ? 'bg-accent hover:bg-accent/90'
          : 'bg-fg-secondary/30 hover:bg-fg-secondary/45'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-card shadow-sm transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}
