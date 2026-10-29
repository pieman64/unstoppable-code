import { z } from 'zod';
import { DEVICE_PLATFORMS } from '@canopy/protocol/device-relay';
import { REMOTE_SURFACES } from '@canopy/desktop-shared/remote-control/surfaces';
import { ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN } from '../account-proxy/sign-in-pages';
import { RpcRemoteError } from './transport/rpc-peer';

/**
 * Messages exchanged inside an encrypted session between a controlling
 * computer and the computer it controls.
 */
export const REMOTE_METHODS = {
  /** Controller → host: identify the host once the session opens. */
  hello: 'session.hello',
  /** Controller → host: run one tunneled IPC call. */
  invoke: 'ipc.invoke',
  /** Controller → host: store a file attached from the controller's disk. */
  uploadPut: 'upload.put',
  /**
   * Controller → host: read part of a host file the controller opens in its
   * own default app. Hosts released before it answer with an unknown-method
   * error, which the controller treats as "not supported".
   */
  fileRead: 'file.read',
  /** Host → controller: show a picker for a handler's file dialog. */
  dialogOpen: 'dialog.open',
  /**
   * Host → controller: show, create hidden, or hide the controller's App
   * Advisor window for the host.
   */
  appAdvisorWindow: 'appAdvisor.window',
  /**
   * Host → controller: open an account proxy sign-in page in the
   * controller's browser and catch its redirect on the controller's loopback
   * port. Controllers released before it answer with an unknown-method
   * error, and the host asks the user to update or sign in on the host.
   */
  accountProxySignInOpen: 'account-proxy.sign-in.open',
  /** Controller → host: the redirect caught for that sign-in. */
  accountProxySignInCallback: 'account-proxy.sign-in.callback',
  /** Controller → host, pairing sessions only: ask to be allowed in. */
  pairRequest: 'pair.request',
} as const;

export const REMOTE_EVENTS = {
  /** Host → controller: stop listening for an account proxy sign-in. */
  accountProxySignInEnded: 'account-proxy.sign-in.ended',
  /** Controller → host: fire-and-forget IPC send. */
  ipcSend: 'ipc.send',
  /** Host → controller: a push the host's main sent toward its renderers. */
  push: 'ipc.push',
  /**
   * Host → controller, right before the host closes the session on purpose,
   * so the controller does not reconnect on its own.
   */
  ended: 'session.ended',
  /**
   * Controller → host: the controller's App Advisor window for the host
   * opened, closed, gained or lost focus.
   */
  appAdvisorWindowState: 'appAdvisor.windowState',
} as const;

/**
 * Version of the contract between a controlling computer and the computer it
 * controls: the session messages in this file and the shapes of every
 * tunneled IPC channel. The window showing another computer runs this
 * computer's renderer against the other computer's handlers, so two computers
 * may connect only when this matches.
 *
 * Bump it in any change that an older peer would misread: a tunneled
 * channel's arguments, result or push payload changing incompatibly, a channel
 * a controller now relies on being removed or renamed, or a session message
 * changing. Additive changes an older peer tolerates do not need a bump.
 * Version 1 is every release before this check. After a bump, run
 * `npm run remote-control:contract:write`; see docs/remote-control-protocol.md.
 */
export const REMOTE_PROTOCOL_VERSION = 4;

/** What a computer runs, as the other computer of a session sees it. */
export const RemoteVersionSchema = z.object({
  protocolVersion: z.number().int().positive(),
  /** Shown to the user only; compatibility follows `protocolVersion`. */
  appVersion: z.string().min(1).max(64),
});
export type RemoteVersion = z.infer<typeof RemoteVersionSchema>;

/** Controller → host: the controller's version, checked before any call. */
export const HelloParamsSchema = z.object({
  version: RemoteVersionSchema,
});
export type HelloParams = z.infer<typeof HelloParamsSchema>;

export const SessionEndedParamsSchema = z.object({
  reason: z.enum(['disconnected', 'revoked']),
});

export type RemoteSessionEndReason = z.infer<
  typeof SessionEndedParamsSchema
>['reason'];

export const RemoteSurfaceSchema = z.enum(REMOTE_SURFACES);

/**
 * A tunneled call or send, and a push. `surface` names the controller's
 * window: a call's sender, a push's only recipient. A call without one comes
 * from the main window; a push without one goes to every window.
 */
export const InvokeParamsSchema = z.object({
  channel: z.string().min(1).max(256),
  args: z.array(z.unknown()),
  surface: RemoteSurfaceSchema.optional(),
});

export const AppAdvisorWindowParamsSchema = z.object({
  /** `focus_main` brings forward the window showing this computer. */
  action: z.enum(['open', 'ensure', 'close', 'focus_main']),
  focus: z.boolean().optional(),
  /** Reveal without taking focus from another app. */
  background: z.boolean().optional(),
});
export type AppAdvisorWindowParams = z.infer<
  typeof AppAdvisorWindowParamsSchema
>;

export const AppAdvisorWindowStateParamsSchema = z.object({
  open: z.boolean(),
  focused: z.boolean(),
});
export type AppAdvisorWindowStateParams = z.infer<
  typeof AppAdvisorWindowStateParamsSchema
>;

export const UploadPutParamsSchema = z.object({
  fileName: z.string().max(1024),
  bytes: z.instanceof(Uint8Array),
});

export const UploadPutResultSchema = z.object({ path: z.string() });

/**
 * Bytes one `file.read` returns at most. Each read is one session message,
 * and the controller asks for the next part only after storing this one.
 */
export const REMOTE_FILE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** Largest host file a controller copies to open in its own default app. */
export const REMOTE_FILE_OPEN_MAX_BYTES = 240 * 1024 * 1024;

export const REMOTE_FILE_OPEN_TOO_LARGE_MESSAGE =
  'File is too large to open from the other computer.';

/** The file a remote window asked to open, as `file:open-external` names it. */
export const RemoteFileTargetSchema = z.object({
  absolutePath: z.string().min(1).max(4096),
  projectId: z.string().min(1).max(256).optional(),
  worktreeId: z.string().min(1).max(256).optional(),
});
export type RemoteFileTarget = z.infer<typeof RemoteFileTargetSchema>;

export const FileReadParamsSchema = RemoteFileTargetSchema.extend({
  offset: z.number().int().nonnegative().max(REMOTE_FILE_OPEN_MAX_BYTES),
  length: z.number().int().positive().max(REMOTE_FILE_READ_CHUNK_BYTES),
});
export type FileReadParams = z.infer<typeof FileReadParamsSchema>;

export const FileReadResultSchema = z.object({
  /** The file's own name, after symbolic links are followed. */
  fileName: z.string().min(1).max(1024),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAtMs: z.number(),
  bytes: z.instanceof(Uint8Array),
});
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

export const HelloResultSchema = z.object({
  name: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  appVersion: z.string(),
  /** Missing from hosts that predate the version check. */
  version: RemoteVersionSchema.optional(),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;

export const DialogOpenParamsSchema = z.object({
  title: z.string().max(200).optional(),
  properties: z.array(z.string()).max(16),
});
export type DialogOpenParams = z.infer<typeof DialogOpenParamsSchema>;

export const DialogOpenResultSchema = z.object({
  canceled: z.boolean(),
  filePaths: z.array(z.string()),
});
export type DialogOpenResult = z.infer<typeof DialogOpenResultSchema>;

const AccountProxySignInStateSchema = z
  .string()
  .regex(ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN);

export const AccountProxySignInOpenParamsSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  url: z.string().min(1).max(4096),
  state: AccountProxySignInStateSchema,
});
export type AccountProxySignInOpenParams = z.infer<
  typeof AccountProxySignInOpenParamsSchema
>;

export const AccountProxySignInCallbackParamsSchema = z
  .object({
    state: AccountProxySignInStateSchema,
    code: z.string().min(1).max(4096).nullable(),
    error: z.string().min(1).max(1024).nullable(),
  })
  .refine((value) => value.code !== null || value.error !== null);
export type AccountProxySignInCallbackParams = z.infer<
  typeof AccountProxySignInCallbackParamsSchema
>;

export const AccountProxySignInEndedParamsSchema = z.object({
  state: AccountProxySignInStateSchema,
});

export const PairRequestParamsSchema = z.object({
  name: z.string().min(1).max(120),
  platform: z.enum(DEVICE_PLATFORMS),
});
export type PairRequestParams = z.infer<typeof PairRequestParamsSchema>;

export const PairRequestResultSchema = z.object({
  approved: z.boolean(),
  name: z.string().min(1).max(120),
  platform: z.enum(DEVICE_PLATFORMS),
});
export type PairRequestResult = z.infer<typeof PairRequestResultSchema>;

export const REMOTE_PROTOCOL_MISMATCH_CODE = 'remote_protocol_mismatch';

/** A host refusing a controller on another protocol version. */
export class RemoteProtocolMismatchError extends Error {
  readonly code = REMOTE_PROTOCOL_MISMATCH_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'RemoteProtocolMismatchError';
  }
}

export const REMOTE_FILE_TOO_LARGE_CODE = 'remote_file_too_large';

export class RemoteFileTooLargeError extends Error {
  readonly code = REMOTE_FILE_TOO_LARGE_CODE;
  constructor() {
    super(REMOTE_FILE_OPEN_TOO_LARGE_MESSAGE);
    this.name = 'RemoteFileTooLargeError';
  }
}

const UNKNOWN_METHOD_CODE = 'remote_unknown_method';

function unknownMethodMessage(method: string): string {
  return `Unknown remote method ${method}.`;
}

export class UnknownRemoteMethodError extends Error {
  readonly code = UNKNOWN_METHOD_CODE;
  constructor(method: string) {
    super(unknownMethodMessage(method));
    this.name = 'UnknownRemoteMethodError';
  }
}

/**
 * Whether the other computer answered that it does not serve `method`.
 * Releases before the error code sent the same message without it.
 */
export function isUnknownRemoteMethodError(
  error: unknown,
  method: string,
): boolean {
  return (
    error instanceof RpcRemoteError &&
    (error.code === UNKNOWN_METHOD_CODE ||
      error.message === unknownMethodMessage(method))
  );
}

export class RemoteChannelUnavailableError extends Error {
  readonly code = 'remote_channel_unavailable';
  constructor(channel: string) {
    super(`"${channel}" is not available while controlling another computer.`);
    this.name = 'RemoteChannelUnavailableError';
  }
}
