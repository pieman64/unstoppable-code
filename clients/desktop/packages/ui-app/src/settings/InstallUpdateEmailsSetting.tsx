import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useCanopyClient } from '@canopy/app-state';
import {
  DelayedLoadingPlaceholder,
  Notice,
  NoticeButton,
  SettingsFormSkeleton,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCardSwitch,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { settingsActionErrorCopy, settingsLoadErrorCopy } from './errors';

/** The default frame's heading, exported so a host frame can reuse it. */
export const INSTALL_UPDATE_EMAILS_TITLE = 'Update emails';

const TOGGLE_ID = 'install-update-emails-toggle';
const LABEL = "Updates to things I've installed";
const DESCRIPTION =
  'Get an email when someone updates a skill, pipeline, automation or other item you installed.';

type SettingState =
  | { readonly kind: 'loading' }
  // The load failed, so there is no real value to show or write.
  | { readonly kind: 'locked'; readonly copy: string }
  | {
      readonly kind: 'ready';
      /** Always the server's value, never the requested one. */
      readonly enabled: boolean;
      readonly saving: boolean;
      /** The value a failed save asked for, kept so Retry can resend it. */
      readonly failedRequest: boolean | null;
      /** Friendly copy for the failed save; null when nothing failed. */
      readonly failureCopy: string | null;
    };

/**
 * The account's "Updates to things I've installed" email preference
 * (CAN-2334), mounted on desktop Settings → Notifications and web Account →
 * Notifications.
 *
 * Renders nothing unless the host reports `installUpdateEmails`. Updates are
 * pessimistic: the switch shows the value the server returned, stays
 * disabled while a save is in flight, and keeps the last server value when a
 * save fails. A failed load shows no switch at all, because a switch can only
 * say on or off and either would claim a value nobody read.
 *
 * The row and its error notice are the shared unit, styled like the other
 * Account → Notifications card rows. The section around them is host chrome:
 * by default a text heading, or the host's own frame through `renderFrame`.
 */
export function InstallUpdateEmailsSetting({
  renderFrame = renderDefaultFrame,
}: InstallUpdateEmailsSettingProps): JSX.Element | null {
  const client = useCanopyClient();
  if (client.capabilities.installUpdateEmails !== true) return null;
  return <InstallUpdateEmailsContent renderFrame={renderFrame} />;
}

export interface InstallUpdateEmailsSettingProps {
  /**
   * Wraps the row and its error notice in the host's settings chrome.
   * Defaults to a text heading over the row.
   */
  readonly renderFrame?: (content: ReactNode) => ReactNode;
}

function renderDefaultFrame(content: ReactNode): ReactNode {
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="install-update-emails-heading"
    >
      <h2
        id="install-update-emails-heading"
        className="text-m font-medium fg-primary"
      >
        {INSTALL_UPDATE_EMAILS_TITLE}
      </h2>
      {content}
    </section>
  );
}

function InstallUpdateEmailsContent({
  renderFrame,
}: {
  readonly renderFrame: (content: ReactNode) => ReactNode;
}): JSX.Element {
  const client = useCanopyClient();
  const [state, setState] = useState<SettingState>({ kind: 'loading' });
  const mounted = useRef(true);
  // Rendered state lags a burst of clicks; this does not.
  const saveInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    setState({ kind: 'loading' });
    client
      .query('account.installUpdateEmails.get', {})
      .then((preference) => {
        if (!mounted.current) return;
        setState({
          kind: 'ready',
          enabled: preference.enabled,
          saving: false,
          failedRequest: null,
          failureCopy: null,
        });
      })
      .catch((caught: unknown) => {
        if (mounted.current) {
          setState({ kind: 'locked', copy: settingsLoadErrorCopy(caught) });
        }
      });
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    (requested: boolean): void => {
      if (saveInFlight.current) return;
      saveInFlight.current = true;
      setState((current) =>
        current.kind === 'ready' && !current.saving
          ? { ...current, saving: true, failedRequest: null, failureCopy: null }
          : current,
      );
      client
        .command('account.installUpdateEmails.set', { enabled: requested })
        .then((preference) => {
          saveInFlight.current = false;
          if (!mounted.current) return;
          setState({
            kind: 'ready',
            enabled: preference.enabled,
            saving: false,
            failedRequest: null,
            failureCopy: null,
          });
        })
        .catch((caught: unknown) => {
          saveInFlight.current = false;
          if (!mounted.current) return;
          const failureCopy = settingsActionErrorCopy(caught, {
            action: 'save this setting',
          });
          setState((current) =>
            current.kind === 'ready'
              ? {
                  ...current,
                  saving: false,
                  failedRequest: requested,
                  failureCopy,
                }
              : current,
          );
        });
    },
    [client],
  );

  const handleToggle = (next: boolean): void => {
    // The switch is disabled while saving; `save` also drops a click that
    // lands before the disabled state renders.
    if (state.kind !== 'ready' || state.saving) return;
    save(next);
  };

  const handleRetry = (): void => {
    if (state.kind === 'locked') {
      load();
      return;
    }
    if (state.kind === 'ready' && state.failedRequest !== null) {
      save(state.failedRequest);
    }
  };

  const error =
    state.kind === 'locked'
      ? state.copy
      : state.kind === 'ready' && state.failedRequest !== null
        ? state.failureCopy
        : null;

  const content = (
    <div
      className="flex flex-col gap-3"
      aria-busy={state.kind === 'loading' || undefined}
      data-testid="install-update-emails-setting"
    >
      {error && (
        <Notice
          intent="destructive"
          data-testid="install-update-emails-error"
          actions={
            <NoticeButton
              onClick={handleRetry}
              data-testid="install-update-emails-retry"
            >
              Retry
            </NoticeButton>
          }
        >
          {error}
        </Notice>
      )}
      {state.kind === 'loading' ? (
        <DelayedLoadingPlaceholder>
          <SettingsFormSkeleton rows={1} />
        </DelayedLoadingPlaceholder>
      ) : (
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="min-w-0">
            {state.kind === 'ready' ? (
              <label
                htmlFor={TOGGLE_ID}
                className="block text-s font-medium fg-primary"
              >
                {LABEL}
              </label>
            ) : (
              <p className="text-s font-medium fg-primary">{LABEL}</p>
            )}
            <p className="text-xs fg-secondary">{DESCRIPTION}</p>
          </div>
          {state.kind === 'ready' && (
            <SettingsCardSwitch
              id={TOGGLE_ID}
              checked={state.enabled}
              disabled={state.saving}
              label={LABEL}
              onChange={handleToggle}
              dataTestId="install-update-emails-toggle"
            />
          )}
        </div>
      )}
    </div>
  );
  return <>{renderFrame(content)}</>;
}
