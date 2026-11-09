import { type JSX, type ReactNode, useEffect, useState } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { LoadingSpinner } from '@canopy/ui-shared/components';
import {
  CloseMediumIcon,
  DownloadIcon,
  RestartIcon,
  TimeslotIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { linuxUpdateCopy } from '@canopy/desktop-shared/lib/linux-update-copy';
import { brand } from '@/lib/brand';
import { useUpdateState } from '@/hooks/useUpdateState';
import { formatVersionLabel } from '@/lib/version-label';
import { pt } from '@/lib/platform-text';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  SidebarFooterBanner,
  SidebarFooterBannerIcon,
  type SidebarFooterBannerIconTone,
} from './SidebarFooterBanner';

type PendingAction = 'download' | 'install' | 'retry';

interface PromptTrailingAction {
  ariaLabel: string;
  icon: JSX.Element;
  onClick: () => void;
  testId: string;
  title?: string;
}

interface PromptView {
  icon: JSX.Element;
  iconTone?: SidebarFooterBannerIconTone;
  label: string;
  ariaLabel: string;
  title?: ReactNode;
  trailing?: JSX.Element;
  trailingAction?: PromptTrailingAction;
  onClick?: () => void;
}

/**
 * Sidebar footer banner covering the full update lifecycle: available (click
 * to download), starting/downloading progress, downloaded (click to restart,
 * trailing action to queue the install for when all agents are idle), queued
 * install (click to restart now, trailing action to cancel the schedule), and
 * download/check errors (click to retry). Only the idle, checking, and
 * not-available phases render nothing.
 */
export function UpdatePrompt(): JSX.Element {
  const { state } = useUpdateState();
  const openSettings = useNavigationStore((s) => s.openSettings);
  const manualLinux = window.platform === 'linux';
  const linuxCopy = linuxUpdateCopy(brand, __CANOPY_RELEASE_FLAVOR__);
  // Local click acknowledgement. The updater phase only advances once the
  // main process emits its next event — the first download-progress event can
  // lag several seconds behind the click — so reflect the requested action
  // immediately instead of leaving the banner looking inert.
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );

  // Every updater event produces a new state object (even repeated errors
  // refresh `checkedAt`), so any state change means the main process has
  // acknowledged — or superseded — the pending action.
  useEffect(() => {
    setPendingAction(null);
  }, [state]);

  const versionLabel = state.info?.version
    ? formatVersionLabel(state.info.version)
    : 'latest release';
  const percent = Math.round(state.progress?.percent ?? 0);

  const spinner = <LoadingSpinner tone="accent" />;

  let view: PromptView | null = null;

  const packageManagerUpdate = manualLinux
    ? state.info?.packageManagerUpdate
    : undefined;

  if (state.phase === 'available') {
    view = packageManagerUpdate
      ? {
          icon: <DownloadIcon size={16} aria-hidden="true" />,
          iconTone: 'accent',
          label: 'Update available',
          ariaLabel: `Update available (${versionLabel}): open update instructions`,
          title: (
            <>
              Version {versionLabel} is ready. {packageManagerUpdate.guidance}{' '}
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {packageManagerUpdate.command}
              </span>
            </>
          ),
          onClick: (): void => {
            openSettings('canopy', {
              scrollTo: 'settings-linux-update-guidance',
            });
          },
        }
      : manualLinux
        ? {
            icon: <DownloadIcon size={16} aria-hidden="true" />,
            iconTone: 'accent',
            label: linuxCopy.downloadLabel,
            ariaLabel: `${linuxCopy.downloadLabel} (${versionLabel}): open the official download`,
            title: state.info?.manualDownload
              ? `${state.info.manualDownload.guidance} ${state.info.manualDownload.checksum.algorithm}: ${state.info.manualDownload.checksum.value}`
              : undefined,
            onClick: state.info?.manualDownload
              ? (): void => {
                  const url = state.info?.manualDownload?.url;
                  if (url)
                    void window.api.browser
                      .openExternal({ url })
                      .catch(() => undefined);
                }
              : undefined,
          }
        : pendingAction
          ? {
              icon: spinner,
              label: 'Starting download…',
              ariaLabel: `Starting download of ${versionLabel}`,
            }
          : {
              icon: <DownloadIcon size={16} aria-hidden="true" />,
              iconTone: 'accent',
              label: 'Update available',
              ariaLabel: `Update available (${versionLabel}): start download`,
              onClick: (): void => {
                setPendingAction('download');
                void window.api.update.downloadUpdate().catch(() => {
                  // Failures surface through the updater state stream as an
                  // error event, which re-renders this banner.
                  setPendingAction(null);
                });
              },
            };
  } else if (state.phase === 'downloading' && !manualLinux) {
    view = {
      icon: spinner,
      label: 'Updating…',
      ariaLabel: `Downloading update ${versionLabel} (${percent}%)`,
      trailing: (
        <span
          className="text-2xs tabular-nums fg-primary"
          data-testid="update-prompt-percent"
        >
          {percent}%
        </span>
      ),
    };
  } else if (state.phase === 'downloaded' && !manualLinux) {
    if (pendingAction) {
      view = {
        icon: spinner,
        label: 'Restarting…',
        ariaLabel: `Restarting to install ${versionLabel}`,
      };
    } else if (state.installPending) {
      view = {
        icon: <TimeslotIcon size={16} aria-hidden="true" />,
        iconTone: 'accent',
        label: 'Update queued',
        ariaLabel: `Update queued (${versionLabel}): installs when agents are idle, click to restart now`,
        onClick: (): void => {
          setPendingAction('install');
          void window.api.update.installUpdate().catch(() => {
            setPendingAction(null);
          });
        },
        trailingAction: {
          icon: <CloseMediumIcon size={16} aria-hidden="true" />,
          ariaLabel: `Cancel the scheduled install of ${versionLabel}`,
          title: 'Cancel scheduled install',
          testId: 'update-prompt-cancel-schedule',
          onClick: (): void => {
            void window.api.update.cancelScheduledUpdate().catch(() => {
              // Failures surface through the updater state stream.
            });
          },
        },
      };
    } else {
      view = {
        icon: <RestartIcon size={16} aria-hidden="true" />,
        iconTone: 'accent',
        label: 'Restart to update',
        ariaLabel: `Update ready (${versionLabel}): restart to install`,
        onClick: (): void => {
          setPendingAction('install');
          void window.api.update.installUpdate().catch(() => {
            setPendingAction(null);
          });
        },
        trailingAction: {
          icon: <TimeslotIcon size={16} aria-hidden="true" />,
          ariaLabel: `Install ${versionLabel} when all agents are idle`,
          title: 'Install when idle',
          testId: 'update-prompt-schedule',
          onClick: (): void => {
            void window.api.update.scheduleUpdate().catch(() => {
              // Failures surface through the updater state stream.
            });
          },
        },
      };
    }
  } else if (state.phase === 'error') {
    view = pendingAction
      ? {
          icon: spinner,
          label: 'Checking for updates…',
          ariaLabel: 'Checking for updates',
        }
      : {
          icon: <WarningIcon size={16} aria-hidden="true" />,
          iconTone: 'destructive',
          label: pt({ default: 'Update failed', linux: 'Check Linux updates' }),
          ariaLabel: pt({
            default: 'Update failed: click to retry',
            linux: 'Check Linux updates: click to retry',
          }),
          title: state.message ?? 'The update could not be completed.',
          onClick: (): void => {
            setPendingAction('retry');
            // A failed download/check leaves the updater outside the
            // downloadable phases, so recover by re-checking; a successful
            // check re-enters the available flow (and auto-download).
            void window.api.update.checkForUpdates().catch(() => {
              setPendingAction(null);
            });
          },
        };
  }

  if (!view) {
    return <></>;
  }

  return (
    <div className="flex flex-col gap-2">
      {manualLinux &&
        state.phase === 'available' &&
        state.info?.manualDownload &&
        linuxCopy.apt && (
          <div
            className="flex flex-col gap-2 text-xs fg-secondary select-text"
            data-testid="update-prompt-linux-guidance"
          >
            <p>{linuxCopy.apt.introduction}</p>
            <code
              className={`block font-mono break-words ${POSTHOG_REPLAY_BLOCK_CLASS}`}
            >
              {linuxCopy.apt.command}
            </code>
            <p>{linuxCopy.apt.bootstrap}</p>
          </div>
        )}
      <SidebarFooterBanner
        ariaLabel={view.ariaLabel}
        surface="status"
        onClick={view.onClick}
        testId="update-prompt"
        title={view.title ?? view.ariaLabel}
        trailingAction={view.trailingAction}
      >
        <SidebarFooterBannerIcon tone={view.iconTone}>
          {view.icon}
        </SidebarFooterBannerIcon>
        <span className="min-w-0 flex-1 truncate">{view.label}</span>
        {view.trailing}
      </SidebarFooterBanner>
    </div>
  );
}
