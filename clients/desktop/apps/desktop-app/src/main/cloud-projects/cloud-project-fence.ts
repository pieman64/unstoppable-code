import type { CloudProjectLinkErrorCode } from '@canopy/desktop-shared/types';
import type {
  CloudProjectClient,
  CloudProjectCredentials,
  CloudProjectRequestContext,
} from './cloud-project-client';

/*
 * The consent fence of cloud project identity (CAN-5190). Identity sends the
 * same kind of metadata as the Personal project list, so it runs only for the
 * account it started with and only while that list is shared (Privacy).
 *
 * The binding and the setup never hold the raw client: they open a fenced one
 * for their account, which binds the account's credential to every request
 * and checks both conditions again right before sending each one, reads
 * included. The same check goes down to the transport as `beforeRequest`, so
 * a retry the transport makes on its own is checked again too. A refusal
 * throws `BindingStop('unavailable')` with nothing sent. Writes to
 * `workspace.json` check the same thing through `require`, so one check
 * decides every effect.
 */

/** A bind, link or publish that stops with a typed result rather than an error. */
export class BindingStop extends Error {
  constructor(readonly code: CloudProjectLinkErrorCode) {
    super(code);
    this.name = 'BindingStop';
  }
}

export interface CloudProjectConsent {
  /** Whether this account is still the one signed in. */
  isActiveAccount(accountId: string): Promise<boolean>;
  /** Whether the Personal project list is shared right now (Privacy). */
  isSharing(): Promise<boolean>;
}

/** The account an operation runs for, from its first request to its last write. */
export interface CloudProjectSessionAccount {
  accountId: string;
  credentials: CloudProjectCredentials;
}

/** A client method without its trailing request context, which the fence supplies. */
type SessionArguments<A extends readonly unknown[]> = A extends readonly [
  ...infer Head,
  (CloudProjectRequestContext | undefined)?,
]
  ? Head
  : never;

/** Every route of {@link CloudProjectClient}, fenced and bound to one account. */
export type FencedCloudProjectClient = {
  [K in keyof CloudProjectClient]: (
    ...args: SessionArguments<Parameters<CloudProjectClient[K]>>
  ) => ReturnType<CloudProjectClient[K]>;
};

export interface CloudProjectFence {
  /** A client whose every request goes out under `account`, while consent holds. */
  open(account: CloudProjectSessionAccount): FencedCloudProjectClient;
  /**
   * Refuses unless `accountId` is still signed in and, unless `sharing` is
   * false (an organization mirror, which shares nothing), the Personal
   * project list is still shared.
   */
  require(accountId: string, options?: { sharing?: boolean }): Promise<void>;
}

export function createCloudProjectFence(
  client: CloudProjectClient,
  consent: CloudProjectConsent,
): CloudProjectFence {
  const require = async (
    accountId: string,
    options: { sharing?: boolean } = {},
  ): Promise<void> => {
    if (
      !(await consent.isActiveAccount(accountId)) ||
      (options.sharing !== false && !(await consent.isSharing()))
    )
      throw new BindingStop('unavailable');
  };
  const open = ({
    accountId,
    credentials,
  }: CloudProjectSessionAccount): FencedCloudProjectClient => {
    const context: CloudProjectRequestContext = {
      credentials,
      beforeRequest: () => require(accountId),
    };
    const send = async <T>(request: () => Promise<T>): Promise<T> => {
      await require(accountId);
      return request();
    };
    return {
      match: (request) => send(() => client.match(request, context)),
      create: (request) => send(() => client.create(request, context)),
      manifest: (projectId) => send(() => client.manifest(projectId, context)),
      updateManifest: (projectId, request) =>
        send(() => client.updateManifest(projectId, request, context)),
      claim: (projectId, request) =>
        send(() => client.claim(projectId, request, context)),
      complete: (instanceId, claim) =>
        send(() => client.complete(instanceId, claim, context)),
      selection: (instanceId) =>
        send(() => client.selection(instanceId, context)),
      updateSelection: (instanceId, selection) =>
        send(() => client.updateSelection(instanceId, selection, context)),
      events: (projectId, after) =>
        send(() => client.events(projectId, after, context)),
      list: (device) => send(() => client.list(device, context)),
      detach: (instanceId, fence) =>
        send(() => client.detach(instanceId, fence, context)),
    };
  };
  return { open, require };
}
