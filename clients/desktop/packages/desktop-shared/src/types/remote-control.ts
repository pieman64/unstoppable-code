import type { DevicePlatform } from '@canopy/protocol/device-relay';

/**
 * Renderer-facing contract for device-to-device remote control.
 * Design: docs/planning/2026-10-05-device-remote-control/README.md
 */

/** Which computer a window shows. */
export type RemoteControlContext =
  | { mode: 'local' }
  | {
      mode: 'remote';
      deviceId: string;
      name: string;
      platform: DevicePlatform;
    };

export type RemoteRelayStatus =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable';

export type RemoteHostConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'error';

export interface RemoteControlDevice {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
}

/** A computer this device has paired with and may control. */
export interface RemoteControlHost extends RemoteControlDevice {
  pairedAt: string;
  online: boolean;
  connection: RemoteHostConnectionStatus;
  error: string | null;
  /**
   * The other computer ended the session or withdrew access. Nothing retries
   * until this computer opens it again; otherwise a dropped connection keeps
   * retrying on its own.
   */
  ended: boolean;
}

/** A device allowed to control this computer. */
export interface RemoteControlController extends RemoteControlDevice {
  pairedAt: string;
  online: boolean;
  /** Whether it is controlling this computer right now. */
  connected: boolean;
}

export type RemoteOutgoingPairingStatus =
  | 'connecting'
  | 'awaiting-approval'
  | 'approved'
  | 'rejected'
  | 'failed';

export interface RemoteOutgoingPairing extends RemoteControlDevice {
  status: RemoteOutgoingPairingStatus;
  /** Six-digit code both computers show; null until the handshake ends. */
  code: string | null;
  error: string | null;
}

export interface RemoteIncomingPairing extends RemoteControlDevice {
  pairingId: string;
  code: string;
}

export interface RemoteControlState {
  /** The feature flag is on. */
  available: boolean;
  /** Signed in to an account the relay can authenticate. */
  signedIn: boolean;
  relayStatus: RemoteRelayStatus;
  relayDetail: string | null;
  thisDevice: RemoteControlDevice | null;
  allowIncoming: boolean;
  hosts: RemoteControlHost[];
  controllers: RemoteControlController[];
  /** Online devices on this account that accept pairing and are not paired. */
  discoverable: RemoteControlDevice[];
  outgoingPairing: RemoteOutgoingPairing | null;
  incomingPairings: RemoteIncomingPairing[];
}

export interface RemoteControlGetStateRequest {
  /** Keep the relay connected for a few minutes to list pairable devices. */
  discover?: boolean;
}

export interface RemoteControlRespondToPairingRequest {
  pairingId: string;
  approve: boolean;
}

export interface RemoteControlForgetDeviceRequest {
  deviceId: string;
  role: 'host' | 'controller';
}

export type RemotePathPickerMode = 'directory' | 'file';

/** Main asks a remote window to pick a path on the controlled computer. */
export interface RemotePathPickerRequest {
  requestId: string;
  mode: RemotePathPickerMode;
  title: string;
}

export interface RemotePathPickerResponse {
  requestId: string;
  /** Absolute path on the controlled computer, or null when cancelled. */
  path: string | null;
}

export interface RemoteDirectoryListRequest {
  /** Absolute directory on the controlled computer; null for home. */
  path: string | null;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
}

export interface RemoteDirectoryListing {
  path: string;
  parent: string | null;
  entries: RemoteDirectoryEntry[];
}

/**
 * Largest file one upload carries. Each upload is one session message, so
 * this stays below the session's 256 MiB message limit with room to spare.
 */
export const REMOTE_UPLOAD_MAX_BYTES = 240 * 1024 * 1024;

export const REMOTE_UPLOAD_TOO_LARGE_MESSAGE =
  'File is too large to send to the other computer.';

export interface RemoteControlApi {
  /** Synchronous: which computer this window shows. */
  getContext(): RemoteControlContext;
  getState(request?: RemoteControlGetStateRequest): Promise<RemoteControlState>;
  onStateChanged(listener: (state: RemoteControlState) => void): () => void;
  /** Opens or focuses a computer's window; null means this computer. */
  openMachine(deviceId: string | null): Promise<void>;
  setAllowIncoming(allow: boolean): Promise<RemoteControlState>;
  startPairing(deviceId: string): Promise<RemoteControlState>;
  cancelPairing(): Promise<RemoteControlState>;
  respondToPairing(
    request: RemoteControlRespondToPairingRequest,
  ): Promise<RemoteControlState>;
  forgetDevice(
    request: RemoteControlForgetDeviceRequest,
  ): Promise<RemoteControlState>;
  disconnectController(deviceId: string): Promise<RemoteControlState>;
  onPathPickerRequest(
    listener: (request: RemotePathPickerRequest) => void,
  ): () => void;
  resolvePathPicker(response: RemotePathPickerResponse): Promise<void>;
  listDirectory(
    request: RemoteDirectoryListRequest,
  ): Promise<RemoteDirectoryListing>;
}
