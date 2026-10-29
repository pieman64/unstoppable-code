import { REMOTE_PROTOCOL_VERSION, type RemoteVersion } from './remote-protocol';

/** Whether two computers speak the same remote-control protocol. */
export function compatibleRemoteVersions(
  left: RemoteVersion,
  right: RemoteVersion,
): boolean {
  return left.protocolVersion === right.protocolVersion;
}

/**
 * Why this computer cannot control `hostName`, shown in the window that would
 * show it, naming the computer to update. `host` is null when the host
 * predates the version check, so it is the older one.
 */
export function describeHostVersionMismatch(
  hostName: string,
  hostAppVersion: string,
  host: RemoteVersion | null,
  local: RemoteVersion,
): string {
  const hostIsOlder =
    host === null || host.protocolVersion < local.protocolVersion;
  const update = hostIsOlder ? hostName : 'this computer';
  return `${hostName} runs version ${hostAppVersion}, which this computer (version ${local.appVersion}) can't control. Update ${update} to connect.`;
}

/**
 * The host's refusal of a controller that predates the version check, and
 * so is older. Such a controller shows this text as is, so it is written
 * from its side.
 */
export function describeLegacyControllerRefusal(
  hostName: string,
  host: RemoteVersion,
): string {
  return `${hostName} runs version ${host.appVersion}, which this computer can't control. Update this computer to connect.`;
}

/**
 * This computer's version. E2E builds may override the protocol version with
 * `CANOPY_E2E_REMOTE_PROTOCOL_VERSION`, so a spec can run two versions apart.
 */
export function currentRemoteVersion(
  appVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  e2e: boolean = false,
): RemoteVersion {
  const override = e2e
    ? Number(env.CANOPY_E2E_REMOTE_PROTOCOL_VERSION?.trim() ?? '')
    : Number.NaN;
  return {
    protocolVersion:
      Number.isInteger(override) && override > 0
        ? override
        : REMOTE_PROTOCOL_VERSION,
    appVersion,
  };
}
