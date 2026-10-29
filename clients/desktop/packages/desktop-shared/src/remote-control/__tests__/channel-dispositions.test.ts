import { IPC_CHANNELS } from '../../types';
import { PIPELINE_CHANNELS } from '../../constants/ipc-channels';
import {
  getRemoteChannelDisposition,
  getRemoteChannelDispositions,
  IPC_REMOTE_DISPOSITIONS,
} from '../channel-dispositions';
import {
  encodeRemoteWindowArgument,
  readRemoteWindowContext,
} from '../window-context';

describe('remote channel dispositions', () => {
  it('classifies every IPC channel', () => {
    for (const key of Object.keys(IPC_CHANNELS)) {
      expect(IPC_REMOTE_DISPOSITIONS).toHaveProperty(key);
    }
    for (const channel of Object.values(PIPELINE_CHANNELS)) {
      expect(getRemoteChannelDispositions().has(channel)).toBe(true);
    }
  });

  it('blocks channels it does not know', () => {
    expect(getRemoteChannelDisposition('made-up:channel')).toBe('blocked');
  });

  it('reads model access from the controlled computer and keeps billing returns local', () => {
    for (const channel of [
      IPC_CHANNELS.modelLibraryWatch,
      IPC_CHANNELS.modelLibraryUnwatch,
      IPC_CHANNELS.modelLibraryChanged,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
    }
    expect(
      getRemoteChannelDisposition(IPC_CHANNELS.deepLinkBillingUnlocked),
    ).toBe('local');
  });

  it('runs the account proxy on the controlled computer, sign-ins included', () => {
    // The controlled computer starts each sign-in and asks the controlling
    // one to open the page and catch its redirect over the session.
    for (const channel of [
      IPC_CHANNELS.accountProxyStatus,
      IPC_CHANNELS.accountProxyChanged,
      IPC_CHANNELS.accountProxySetUpLocal,
      IPC_CHANNELS.accountProxyControlLocal,
      IPC_CHANNELS.accountProxySignIn,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
    }
  });

  it('leaves preload E2E hooks out of the shared policy', () => {
    for (const channel of [
      'canopy:e2e:first-projects-load',
      'canopy:e2e:first-projects-load-stop',
    ]) {
      expect(getRemoteChannelDispositions().has(channel)).toBe(false);
      expect(getRemoteChannelDisposition(channel)).toBe('blocked');
    }
  });

  it('tunnels the core remote workflows', () => {
    for (const channel of [
      IPC_CHANNELS.chatSendMessage,
      IPC_CHANNELS.chatEvent,
      IPC_CHANNELS.chatStateChanged,
      IPC_CHANNELS.terminalSpawn,
      IPC_CHANNELS.terminalOutput,
      IPC_CHANNELS.worktreeCreate,
      IPC_CHANNELS.scriptCancelWorktreeSetup,
      IPC_CHANNELS.repoBrowse,
      IPC_CHANNELS.remoteControlListDirectory,
      IPC_CHANNELS.opencodeConnectionModels,
      IPC_CHANNELS.managedDelegationTranscriptPage,
      IPC_CHANNELS.nativeSubagentInterrupt,
      IPC_CHANNELS.personalOrganizationUpgradeInviteStatus,
      IPC_CHANNELS.referencePreviewGitHub,
      PIPELINE_CHANNELS.EXECUTE,
      PIPELINE_CHANNELS.CANCEL_EXECUTION,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
    }
  });

  it('keeps window chrome and the feature itself on the controller', () => {
    for (const channel of [
      IPC_CHANNELS.updateCheck,
      IPC_CHANNELS.remoteControlInvoke,
      IPC_CHANNELS.remoteControlGetState,
      IPC_CHANNELS.remoteControlPush,
      IPC_CHANNELS.voiceStart,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('local');
    }
  });

  it('blocks secrets, Remote Control pairing and renderer-executed commands', () => {
    for (const channel of [
      IPC_CHANNELS.settingsLoadGitHubPat,
      IPC_CHANNELS.canopyPortalStart,
      IPC_CHANNELS.chatWindowCommand,
      IPC_CHANNELS.chatPortalComposerCommand,
      IPC_CHANNELS.fileShowInFinder,
      IPC_CHANNELS.canopyCoreRelay,
      IPC_CHANNELS.appAdvisorWindowSetFloatingSize,
      // Requests main sends one renderer to answer: a controller's renderer
      // would act on its own state (for example save its own pipeline).
      IPC_CHANNELS.pipelineEditorToolRequest,
      IPC_CHANNELS.pipelineEditorToolResponse,
      // Sign-in attempts belong to the window that started them.
      IPC_CHANNELS.codexLoginStart,
      IPC_CHANNELS.codexLoginCancel,
      IPC_CHANNELS.codexLoginRetryVerification,
      IPC_CHANNELS.codexLoginState,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('blocked');
    }
  });

  it('tunnels App Advisor windows and the renderer tools they answer', () => {
    for (const channel of [
      IPC_CHANNELS.appAdvisorWindowOpen,
      IPC_CHANNELS.appAdvisorWindowEnsure,
      IPC_CHANNELS.appAdvisorWindowClose,
      IPC_CHANNELS.appAdvisorWindowToggle,
      IPC_CHANNELS.appAdvisorWindowGetState,
      IPC_CHANNELS.appAdvisorWindowStateChanged,
      IPC_CHANNELS.appAdvisorWindowRendererReady,
      IPC_CHANNELS.appAdvisorWindowCommand,
      IPC_CHANNELS.appAdvisorReportWindowUiState,
      IPC_CHANNELS.appAdvisorToolRequest,
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
      IPC_CHANNELS.appAdvisorToolResponse,
    ]) {
      expect(getRemoteChannelDisposition(channel)).toBe('tunnel');
    }
  });

  it('round-trips the remote window argument', () => {
    const context = {
      deviceId: 'AAAAAAAAAAAAAAAAAAAAAA',
      name: 'Studio Mac "M2"',
      platform: 'darwin' as const,
    };
    expect(
      readRemoteWindowContext([
        'electron',
        encodeRemoteWindowArgument(context),
      ]),
    ).toEqual({ ...context, surface: 'main' });
    const appAdvisor = { ...context, surface: 'app-advisor' as const };
    expect(
      readRemoteWindowContext([
        'electron',
        encodeRemoteWindowArgument(appAdvisor),
      ]),
    ).toEqual(appAdvisor);
    expect(readRemoteWindowContext(['electron'])).toBeNull();
    expect(
      readRemoteWindowContext(['--canopy-remote-window=%7Bbroken']),
    ).toBeNull();
  });
});
