import type { PortalConnectionStatus } from '@canopy/protocol/portal';

/**
 * Local-side worker status. Distinct from `PortalConnectionStatus` because it
 * also models pre-pairing, stopping, and error states that exist purely on the
 * local side.
 */
export type CanopyPortalWorkerStatus =
  | 'disabled'
  | 'starting'
  | 'pending_auth'
  | 'active'
  | 'reconnecting'
  | 'inactive'
  | 'stopping'
  | 'error';

/**
 * Aggregated, renderer-safe view of the local Canopy Portal worker. The main
 * process is the single source of truth for these fields; the renderer only
 * receives copies via `canopyPortal:getState` or the broadcast
 * `canopyPortal:stateChanged` event.
 *
 * `pairingCode` and `pairingCodeExpiresAt` cross the IPC boundary solely so
 * the modal can display the code. The renderer must not persist the pairing
 * code or write it to the clipboard automatically.
 *
 * NOTE: This shape intentionally does not surface any server identity
 * (`selectedServerId`, `selectedServerName`, `selectedServerBaseUrl`). The
 * desktop app is bound to exactly one Canopy Cloud backend at build time, so
 * there is no user-facing server selection to render. If the main-process
 * persistence layer needs an internal `serverId` it must keep it on its own
 * persisted-session record — never on `CanopyPortalState`.
 */
export interface CanopyPortalState {
  status: CanopyPortalWorkerStatus;
  connectionStatus: PortalConnectionStatus;
  /** Server-assigned `PortalSession.externalId` once created. */
  sessionId: string | null;
  /**
   * 6-digit code shown to the user. Cleared once a device redeems it. While
   * the session is `active`, "Pair another device" re-arms a fresh code on the
   * same session without disconnecting devices that are already paired
   * (CAN-2981).
   */
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  /**
   * This machine's name as registered with the server (the session's
   * `clientName`), so the pairing QR code can say which machine it connects
   * (CAN-2938). `null` only before the main process has reported state.
   */
  machineName: string | null;
  /**
   * The host code agents use to address this app install through the hosted
   * Tasks MCP, as the server returned it on the latest heartbeat. Stable per
   * install. `null` until a heartbeat returns one (older servers never do),
   * and reset when the session stops or re-pairs.
   */
  hostCode: string | null;
  activatedAt: string | null;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
  /** Human-readable error message; cleared on the next successful state change. */
  error: string | null;
}

export interface StartCanopyPortalResponse {
  state: CanopyPortalState;
}

export interface StopCanopyPortalResponse {
  state: CanopyPortalState;
}

export interface RegenerateCanopyPortalPairingCodeResponse {
  state: CanopyPortalState;
}

export interface CancelCanopyPortalPairingCodeResponse {
  state: CanopyPortalState;
}

/**
 * Preload bridge surface for the renderer. Mirrors the IPC channels declared
 * under `IPC_CHANNELS.canopyPortal*`.
 */
export interface CanopyPortalApi {
  getState(): Promise<CanopyPortalState>;
  start(): Promise<StartCanopyPortalResponse>;
  stop(): Promise<StopCanopyPortalResponse>;
  /**
   * Arms a fresh pairing code on the already-active session so another device
   * can pair without disconnecting the ones already connected (CAN-2981).
   * Rejects unless the session is `active`.
   */
  regeneratePairingCode(): Promise<RegenerateCanopyPortalPairingCodeResponse>;
  /**
   * Drops a re-armed code before it is redeemed; connected devices and the
   * session are untouched (CAN-2981). A no-op when nothing is armed.
   */
  cancelPairingCode(): Promise<CancelCanopyPortalPairingCodeResponse>;
  /**
   * Subscribes to broadcast state changes. Returns a disposer; the renderer
   * must call it on unmount to detach the underlying IPC listener.
   */
  onStateChanged(callback: (state: CanopyPortalState) => void): () => void;
}
