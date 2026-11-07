import type {
  AuthTerminalExitEvent,
  AuthTerminalOutputEvent,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';

type AuthTerminalChannel =
  | typeof IPC_CHANNELS.authTerminalOutput
  | typeof IPC_CHANNELS.authTerminalExit;

type AuthTerminalEventPayload = AuthTerminalOutputEvent | AuthTerminalExitEvent;

export type AuthTerminalEventSender = (
  channel: AuthTerminalChannel,
  payload: AuthTerminalEventPayload,
) => void;
