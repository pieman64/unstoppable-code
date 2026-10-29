import {
  curatedMcpDesktopOnly,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type { McpHttpAuthHandler } from '@canopy/protocol/mcp-servers';

/** The device server already installed for a curated key. */
export interface CuratedMcpDeviceServer {
  readonly id: string;
  readonly type: 'http' | 'command';
  readonly configIds: readonly string[];
  readonly httpAuthHandler?: McpHttpAuthHandler;
  /**
   * The host found the server identical to what its own Add creates for the
   * entry, apart from identity, timestamps, and display text.
   */
  readonly matchesCatalogDefaults: boolean;
}

/** What the host knows about account connections when Add is pressed. */
export interface CuratedMcpAddContext {
  /** The shared-account connections flag, as the host reads it. */
  readonly accountConnectionsEnabled: boolean;
  /** `true` once the account list was read; `false` or unknown otherwise. */
  readonly accountConnectionsAvailable: boolean | undefined;
  /** Configuration to connect under; account rows default to `default`. */
  readonly configId?: string;
  /** The device server this key already has, when it has one. */
  readonly deviceServer?: CuratedMcpDeviceServer;
}

/** A device server's configuration whose references move to the account. */
export interface CuratedMcpReplacedDeviceServer {
  readonly serverId: string;
  readonly configId: string;
}

/** Where Add puts a curated catalog server. */
export type CuratedMcpAddTarget =
  | {
      readonly kind: 'account';
      readonly serverKey: string;
      readonly configId: string;
      /**
       * The device server the account connection replaces once it connects.
       * Its sign-in is never copied: the account runs its own sign-in.
       */
      readonly replacesDeviceServer?: CuratedMcpReplacedDeviceServer;
    }
  | {
      readonly kind: 'device';
      readonly curatedKey: string;
      readonly httpAuthHandler: 'canopy';
      /** The installed device server to sign in; absent creates one. */
      readonly serverId?: string;
      /**
       * The account could connect the entry, but the device server has a
       * setup of its own, so it stays on the device and nothing replaces it.
       */
      readonly keepsDeviceSetup?: true;
    };

type CuratedMcpAddEntry = Pick<
  CuratedMcpServerEntry,
  | 'key'
  | 'providerConnector'
  | 'oauthHints'
  | 'requiredConfigFields'
  | 'availability'
>;

/**
 * A device server the account connection can stand in for: one HTTP
 * configuration on the app's own handler that is exactly what Add creates.
 * Anything set up by hand has no account equivalent, so it stays on the device.
 */
function curatedMcpReplaceableDeviceServer(
  entry: CuratedMcpAddEntry,
  server: CuratedMcpDeviceServer,
): CuratedMcpReplacedDeviceServer | undefined {
  const [configId] = server.configIds;
  if (
    server.type !== 'http' ||
    server.configIds.length !== 1 ||
    configId === undefined ||
    (server.httpAuthHandler !== undefined &&
      server.httpAuthHandler !== 'canopy') ||
    (entry.requiredConfigFields?.length ?? 0) > 0 ||
    !server.matchesCatalogDefaults
  )
    return undefined;
  return { serverId: server.id, configId };
}

/**
 * The one Add rule for a curated catalog server, shared by the Plugins page
 * detail and the MCP tab (REG-3033): an account connection when the shared
 * account flag is on, the account list is readable, and the entry is not
 * desktop only (a provider-only connector, or a server the catalog marks
 * desktop only, which the account broker cannot connect); otherwise a device
 * file that carries the curated key and the app's own sign-in handler.
 *
 * With a device server already installed (REG-3052), the account takes it
 * over when it can: the next sign-in goes through the account and the device
 * server is replaced once the connection is made.
 */
export function curatedMcpAddTarget(
  entry: CuratedMcpAddEntry,
  context: CuratedMcpAddContext,
): CuratedMcpAddTarget {
  const accountReady =
    context.accountConnectionsEnabled &&
    context.accountConnectionsAvailable === true &&
    !curatedMcpDesktopOnly(entry);
  const device = context.deviceServer;
  const replaced =
    accountReady && device
      ? curatedMcpReplaceableDeviceServer(entry, device)
      : undefined;
  if (accountReady && (!device || replaced)) {
    return {
      kind: 'account',
      serverKey: entry.key,
      configId: context.configId ?? 'default',
      ...(replaced ? { replacesDeviceServer: replaced } : {}),
    };
  }
  return {
    kind: 'device',
    curatedKey: entry.key,
    httpAuthHandler: 'canopy',
    ...(device ? { serverId: device.id } : {}),
    ...(accountReady && device ? { keepsDeviceSetup: true } : {}),
  };
}
