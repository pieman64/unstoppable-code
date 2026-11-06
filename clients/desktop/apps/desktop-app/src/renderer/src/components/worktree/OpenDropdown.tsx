import {
  type JSX,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  ActionMenuRowStyle,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  FloatingMenu,
  PickerMenuOptionCheck,
  SECONDARY_SURFACE_HOVER_CLASS,
  SECONDARY_SURFACE_SHELL_CLASS,
  Tooltip,
} from '@canopy/ui-shared';
import {
  ChevronDownMediumIcon,
  CopyIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { DetectedApp } from '@canopy/desktop-shared/types';
import { copyTextToClipboard } from '@/lib/clipboard';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import { useNavigationStore } from '@/stores/navigationStore';
import { selectPreferredOpenApp } from './openInAppSelection';

interface OpenDropdownProps {
  projectId: string;
  worktreeId: string;
}

export function OpenDropdown({
  projectId,
  worktreeId,
}: OpenDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<DetectedApp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastAppId, setLastAppId] = useState('');
  const [disabledApps, setDisabledApps] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const openSettings = useNavigationStore((s) => s.openSettings);

  // Load apps and preferences on mount
  useEffect(() => {
    void window.api
      .detectApps()
      .then((detected) => {
        setApps(detected);
      })
      .catch(() => {
        setApps([]);
      })
      .finally(() => {
        setLoaded(true);
      });
    void window.api.loadPreferences().then((prefs) => {
      setLastAppId(prefs.lastOpenApp);
      setDisabledApps(prefs.disabledOpenApps);
    });
  }, []);

  // Refresh preferences each time dropdown opens
  const refreshPreferences = useCallback((): void => {
    void window.api.loadPreferences().then((prefs) => {
      setDisabledApps(prefs.disabledOpenApps);
      setLastAppId(prefs.lastOpenApp);
    });
  }, []);

  const handleOpenApp = useCallback(
    (appId: string): void => {
      setOpen(false);
      setLastAppId(appId);
      void window.api.openInApp({ projectId, worktreeId, appId });
      void window.api.savePreferences({ lastOpenApp: appId });
    },
    [projectId, worktreeId],
  );

  const handleCopyPath = useCallback((): void => {
    setOpen(false);
    void window.api
      .getWorktreePath({ projectId, worktreeId })
      .then((path) => copyTextToClipboard(path));
  }, [projectId, worktreeId]);

  const handleOpenSettings = useCallback((): void => {
    setOpen(false);
    openSettings('applications');
  }, [openSettings]);

  const visibleApps = apps.filter((a) => !disabledApps.includes(a.id));
  // The split button's icon segment: the last-used app, falling back to the
  // first visible app so the control keeps its shape before any use.
  const splitApp = selectPreferredOpenApp(apps, {
    lastOpenApp: lastAppId,
    disabledOpenApps: disabledApps,
  });

  return (
    <div className="relative flex items-center">
      {/* Split control on the house secondary surface — the same shell the
          shared Button secondary and action chips compose through
          SECONDARY_SURFACE_CLASS: [app icon] | divider | [chevron menu]. The
          shell sits on the wrapper and the hover overlay on each segment so
          only the hovered half lights up. */}
      <div
        className={`electron-no-drag inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-full ${SECONDARY_SURFACE_SHELL_CLASS}`}
      >
        {splitApp && splitApp.icon && (
          <>
            {/* Icon-only below 560px, so the app name has to live in a
                tooltip. Uses the shared Tooltip (not the native `title`) so
                it matches the rest of the chrome and appears promptly. */}
            <Tooltip
              label={`Open in ${splitApp.name}`}
              className="items-stretch"
            >
              <button
                type="button"
                data-testid="worktree-open-app"
                onClick={() => handleOpenApp(splitApp.id)}
                className={`focus-ring flex w-7 items-center justify-center gap-1.5 text-xs font-medium fg-primary transition-colors ${SECONDARY_SURFACE_HOVER_CLASS} @[560px]/prbar:w-auto @[560px]/prbar:justify-start @[560px]/prbar:px-2.5`}
                aria-label={`Open in ${splitApp.name}`}
              >
                {/* Compact mode: below a 560px status region the label drops and
                  the control is just [app icon] | [chevron]. */}
                <span className="hidden @[560px]/prbar:inline">Open in</span>
                <img
                  src={splitApp.icon}
                  alt=""
                  className="h-4 w-4"
                  draggable={false}
                />
              </button>
            </Tooltip>
            <span
              aria-hidden="true"
              className="my-1.5 w-px shrink-0 bg-line-base"
            />
          </>
        )}
        <Tooltip label="Open in…" className="items-stretch" suppressed={open}>
          <button
            ref={triggerRef}
            type="button"
            data-testid="worktree-open-trigger"
            onClick={() => {
              refreshPreferences();
              setOpen((prev) => !prev);
            }}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-label="Open in…"
            className={`focus-ring flex items-center transition-colors ${SECONDARY_SURFACE_HOVER_CLASS} ${
              splitApp && splitApp.icon
                ? 'w-7 justify-center'
                : 'gap-1 px-2.5 text-xs font-medium fg-primary'
            }`}
          >
            {(!splitApp || !splitApp.icon) && 'Open in'}
            <ChevronDownMediumIcon size={16} className="shrink-0 fg-primary" />
          </button>
        </Tooltip>
      </div>

      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        aria-label="Open project"
        data-testid="worktree-open-menu"
        data-canopy-browser-native-overlay="true"
        className="w-34 max-w-[calc(100vw-16px)]"
      >
        {/* The action-menu rows: small text, tertiary glyphs. App icons are
            product marks and keep their own colors. */}
        <ActionMenuRowStyle>
          {!loaded ? (
            <DropdownMenuLabel>
              {pt(uiText.applications.detecting)}
            </DropdownMenuLabel>
          ) : visibleApps.length === 0 ? (
            <DropdownMenuLabel>
              {pt(uiText.applications.empty)}
            </DropdownMenuLabel>
          ) : (
            visibleApps.map((appItem) => (
              <DropdownMenuItem
                key={appItem.id}
                data-testid={`worktree-open-app-${appItem.id}`}
                className="min-w-0"
                onClick={() => handleOpenApp(appItem.id)}
              >
                <DropdownMenuItemIcon>
                  {appItem.icon ? (
                    <img
                      src={appItem.icon}
                      alt=""
                      className="h-4 w-4"
                      draggable={false}
                    />
                  ) : null}
                </DropdownMenuItemIcon>
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                  {appItem.name}
                </span>
                <PickerMenuOptionCheck selected={appItem.id === splitApp?.id} />
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuDivider />
          <DropdownMenuItem
            data-testid="worktree-open-copy-path"
            className="min-w-0"
            onClick={handleCopyPath}
          >
            <DropdownMenuItemIcon>
              <CopyIcon />
            </DropdownMenuItemIcon>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              Copy path
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="worktree-open-settings"
            className="min-w-0"
            onClick={handleOpenSettings}
          >
            <DropdownMenuItemIcon>
              <SettingsIcon />
            </DropdownMenuItemIcon>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              Settings
            </span>
          </DropdownMenuItem>
        </ActionMenuRowStyle>
      </FloatingMenu>
    </div>
  );
}
