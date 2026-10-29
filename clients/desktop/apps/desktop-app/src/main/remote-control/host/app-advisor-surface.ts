import type { BrowserWindow } from 'electron';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import {
  IPC_CHANNELS,
  type AppAdvisorWindowCommand,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type AppAdvisorWindowUiState,
} from '@canopy/desktop-shared/types';
import type { RemoteAppAdvisorWindowHost } from '../../ipc/app-advisor';
import type {
  AppAdvisorWindowParams,
  AppAdvisorWindowStateParams,
} from '../remote-protocol';
import type { HostBridge } from './bridge-window';

export interface RemoteAppAdvisorSurfaceDeps {
  /** The controlling computer's device ID. */
  controllerDeviceId: string;
  bridgeFor: (surface: RemoteSurface) => Promise<HostBridge>;
  /** A started bridge's hidden window, which reaches that controller window. */
  bridgeWindow: (surface: RemoteSurface) => BrowserWindow | null;
  requestWindow: (
    params: AppAdvisorWindowParams,
  ) => Promise<AppAdvisorWindowStateParams>;
  /**
   * Turns an open request into window commands (select a chat, send a quick
   * prompt), resolving them against this computer's data as its own App
   * Advisor window does.
   */
  sendRequestCommands: (
    request: AppAdvisorWindowOpenRequest | undefined,
    send: (command: AppAdvisorWindowCommand) => void,
  ) => Promise<unknown>;
  sendToWindow: (
    window: BrowserWindow | null,
    channel: string,
    payload: unknown,
  ) => void;
  /** Sends ask-user questions routed here again once the window loaded. */
  redeliverQuestions: (surface: RemoteAppAdvisorSurface) => void;
}

const CLOSED_STATE: AppAdvisorWindowState = {
  open: false,
  focused: false,
  layout: 'full',
};

/**
 * One controlling computer's App Advisor window, as this computer's main
 * process sees it. Its calls arrive through the controller's App Advisor
 * bridge; commands, renderer tool requests and state go back through the
 * bridges, and showing or hiding the window is the controller's job.
 */
export class RemoteAppAdvisorSurface implements RemoteAppAdvisorWindowHost {
  private state: AppAdvisorWindowState = CLOSED_STATE;

  readonly routeKey: string;

  constructor(private readonly deps: RemoteAppAdvisorSurfaceDeps) {
    this.routeKey = deps.controllerDeviceId;
  }

  getMainWindow = (): BrowserWindow | null => this.deps.bridgeWindow('main');

  getAppAdvisorWindow = (): BrowserWindow | null =>
    this.deps.bridgeWindow('app-advisor');

  openAppAdvisorWindow = async (
    request?: AppAdvisorWindowOpenRequest,
  ): Promise<AppAdvisorWindowState> => {
    await this.prepare(request);
    this.applyState(
      await this.deps.requestWindow({
        action: 'open',
        ...(request?.focus === undefined ? {} : { focus: request.focus }),
        ...(request?.background === undefined
          ? {}
          : { background: request.background }),
      }),
    );
    if (request?.focusComposer === true) {
      this.sendCommand({ type: 'focus_composer' });
    }
    return this.state;
  };

  ensureAppAdvisorWindow = async (
    request?: AppAdvisorWindowOpenRequest,
  ): Promise<AppAdvisorWindowState> => {
    await this.prepare(request);
    return this.state;
  };

  closeAppAdvisorWindow = async (): Promise<AppAdvisorWindowState> => {
    if (this.getAppAdvisorWindow() === null) return this.state;
    this.applyState(await this.deps.requestWindow({ action: 'close' }));
    return this.state;
  };

  toggleAppAdvisorWindow = (
    request?: AppAdvisorWindowOpenRequest,
  ): Promise<AppAdvisorWindowState> =>
    this.state.open
      ? this.closeAppAdvisorWindow()
      : this.openAppAdvisorWindow({ ...request, focus: true });

  getAppAdvisorWindowState = (): AppAdvisorWindowState => this.state;

  focusMainWindow = async (): Promise<void> => {
    await this.deps.requestWindow({ action: 'focus_main' });
  };

  markAppAdvisorWindowRendererReady = (): AppAdvisorWindowState => {
    this.deps.redeliverQuestions(this);
    return this.state;
  };

  reportAppAdvisorWindowUiState = (state: AppAdvisorWindowUiState): void => {
    this.deps.sendToWindow(
      this.getMainWindow(),
      IPC_CHANNELS.appAdvisorWindowUiStateChanged,
      state,
    );
  };

  /** The controller reported its App Advisor window's state. */
  applyState(next: AppAdvisorWindowStateParams): void {
    this.state = { open: next.open, focused: next.focused, layout: 'full' };
    const state = this.state;
    // One push object for both windows: the session forwards it once each.
    for (const window of [this.getMainWindow(), this.getAppAdvisorWindow()]) {
      this.deps.sendToWindow(
        window,
        IPC_CHANNELS.appAdvisorWindowStateChanged,
        state,
      );
    }
  }

  /**
   * Has the controller create its window before any command is sent: a
   * command for a window it does not have yet would be dropped. Created
   * windows hold commands until their page is ready.
   */
  private async prepare(
    request: AppAdvisorWindowOpenRequest | undefined,
  ): Promise<void> {
    await this.deps.bridgeFor('app-advisor');
    this.applyState(await this.deps.requestWindow({ action: 'ensure' }));
    await this.deps.sendRequestCommands(request, (command) =>
      this.sendCommand(command),
    );
  }

  private sendCommand(command: AppAdvisorWindowCommand): void {
    this.deps.sendToWindow(
      this.getAppAdvisorWindow(),
      IPC_CHANNELS.appAdvisorWindowCommand,
      command,
    );
  }
}
