import { isMcpOAuthBrowserScope } from '@canopy/desktop-shared/types/browser';
import { BrowserProfilePicker } from './BrowserProfilePicker';
import { useId, type JSX, type ReactNode } from 'react';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { Count, Tooltip } from '@canopy/ui-shared';
import { useBrowserBarActions } from './useBrowserBarActions';
import {
  BackIcon,
  CameraIcon,
  DetailsIcon,
  ExternalIcon,
  ForwardIcon,
  MoonIcon,
  PickIcon,
  RecordIcon,
  RefreshIcon,
  CircleStopIcon as StopIcon,
  SunIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { BrowserDownloadsButton } from './BrowserDownloadsButton';
import { Button, Surface, TextInput } from '@canopy/ui-shared/components';

interface BrowserBarProps {
  browserId: string;
  snapshot: BrowserSessionSnapshot;
  inspectorOpen: boolean;
  errorCount: number;
  onToggleInspector: () => void;
}

export function BrowserBar({
  browserId,
  snapshot,
  inspectorOpen,
  errorCount,
  onToggleInspector,
}: BrowserBarProps): JSX.Element {
  const {
    urlDraft,
    setUrlDraft,
    urlError,
    urlPlaceholder,
    urlInputRef,
    handleKeyDown,
    back,
    forward,
    refresh: handleRefresh,
    stop: handleStop,
    setTheme: handleTheme,
    toggleRecording: handleRecord,
    togglePick: handlePick,
    screenshot: handleScreenshot,
    openExternally,
    canOpenExternally,
    isLoading,
  } = useBrowserBarActions(browserId, snapshot);
  const errorId = useId();

  const pickLabel = snapshot.pickMode
    ? 'Exit pick mode'
    : `Pick element for ${CHAT_UNIT_LABEL}`;
  const inspectorAction = inspectorOpen
    ? 'Hide browser details'
    : 'Show browser details';
  // The corner count is a neutral number, so the name says what it counts.
  const inspectorLabel =
    errorCount > 0
      ? `${inspectorAction}, ${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`
      : inspectorAction;

  return (
    <div
      data-testid="browser-bar"
      className="browser-bar flex flex-col border-b bg-card/50"
    >
      <div className="browser-bar-toolbar">
        <div className="browser-bar-nav">
          <IconButton
            onClick={back}
            disabled={!snapshot.canGoBack}
            label="Back"
            dataTestId="browser-back"
          >
            <BackIcon size={14} />
          </IconButton>
          <IconButton
            onClick={forward}
            disabled={!snapshot.canGoForward}
            label="Forward"
            dataTestId="browser-forward"
          >
            <ForwardIcon size={14} />
          </IconButton>
          {isLoading ? (
            <Tooltip label="Stop loading">
              <Button
                variant="ghost-destructive"
                size="sm"
                iconOnly
                data-testid="browser-stop"
                onClick={handleStop}
                aria-label="Stop loading"
              >
                <StopIcon size={14} />
              </Button>
            </Tooltip>
          ) : (
            <IconButton
              onClick={handleRefresh}
              label="Refresh"
              dataTestId="browser-refresh"
            >
              <RefreshIcon size={14} />
            </IconButton>
          )}
        </div>

        <div className="browser-bar-url">
          <TextInput
            ref={urlInputRef}
            type="text"
            density="compact"
            data-testid="browser-url-input"
            value={urlDraft}
            spellCheck={false}
            placeholder={urlPlaceholder}
            onChange={(event): void => setUrlDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Browser URL"
            aria-invalid={urlError !== null}
            aria-describedby={urlError !== null ? errorId : undefined}
            className="min-w-0"
          />
        </div>

        <div className="browser-bar-actions">
          {!isMcpOAuthBrowserScope(snapshot.projectId, snapshot.worktreeId) && (
            <BrowserProfilePicker snapshot={snapshot} />
          )}
          <IconButton
            onClick={openExternally}
            disabled={!canOpenExternally}
            label="Open in external browser"
          >
            <ExternalIcon size={14} />
          </IconButton>

          <Surface
            variant="outline"
            size="small"
            className="flex items-center mx-0.5 shrink-0"
          >
            <IconButton
              onClick={(): void => handleTheme('light')}
              label="Use light theme"
              active={snapshot.themeMode === 'light'}
            >
              <SunIcon size={14} />
            </IconButton>
            <IconButton
              onClick={(): void => handleTheme('dark')}
              label="Use dark theme"
              active={snapshot.themeMode === 'dark'}
            >
              <MoonIcon size={14} />
            </IconButton>
          </Surface>

          {!isMcpOAuthBrowserScope(snapshot.projectId, snapshot.worktreeId) && (
            <>
              <IconButton
                onClick={handleRecord}
                label="Record browser actions"
                active={snapshot.recording}
              >
                <RecordIcon
                  size={14}
                  className={snapshot.recording ? 'fg-destructive' : undefined}
                />
              </IconButton>

              <Tooltip label={pickLabel}>
                <Button
                  variant="ghost"
                  size="sm"
                  pressedHover
                  onClick={handlePick}
                  aria-label={pickLabel}
                  aria-pressed={snapshot.pickMode}
                >
                  <PickIcon size={14} />
                  <span className="browser-bar-pick-label">
                    {CHAT_UNIT_LABEL}
                  </span>
                </Button>
              </Tooltip>

              <IconButton onClick={handleScreenshot} label="Capture screenshot">
                <CameraIcon size={14} />
              </IconButton>

              <BrowserDownloadsButton browserId={browserId} />

              <Tooltip label={inspectorLabel}>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  pressedHover
                  onClick={onToggleInspector}
                  aria-label={inspectorLabel}
                  aria-pressed={inspectorOpen}
                >
                  <DetailsIcon size={14} />
                  {errorCount > 0 && (
                    <Count
                      value={errorCount}
                      placement="icon"
                      aria-hidden
                      data-testid="browser-details-error-count"
                      className="absolute -right-1 -top-1"
                    />
                  )}
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
      {urlError !== null && (
        <div id={errorId} className="px-2 pb-1 text-2xs fg-destructive">
          {urlError}
        </div>
      )}
    </div>
  );
}

interface IconButtonProps {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  dataTestId?: string;
}

function IconButton({
  onClick,
  label,
  disabled,
  active,
  children,
  dataTestId,
}: IconButtonProps): JSX.Element {
  // The tooltip handlers live on the wrapper span, so a disabled button
  // (e.g. Back with no history) still explains itself on hover.
  // The toolbar's 28px ghost icon button. An on/off control (theme, record) passes
  // `active`: it is announced as pressed and holds its hover look while on.
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        data-testid={dataTestId}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        pressedHover={active !== undefined}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
