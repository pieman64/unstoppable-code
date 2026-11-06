import {
  CanopyCloudClientError,
  isTransientCanopyCloudFailure,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import type { CloudProjectBindingFailure } from './cloud-project-binding';
import type { CloudProjectTransport } from './cloud-project-client';

/**
 * The cloud project identity routes over the Cloud JSON client: each request
 * under its context's credential, and its `beforeRequest` awaited before
 * every attempt, the client's own read retries included.
 */
export const cloudProjectTransport: CloudProjectTransport = (
  path,
  init,
  context,
) =>
  requestCanopyCloudJson(path, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(context === undefined
      ? {}
      : {
          credentialContext: context.credentials,
          beforeRequest: context.beforeRequest,
        }),
  });

/** A transport failure as the binding reads it: status, code and reason. */
export function cloudProjectFailure(
  error: unknown,
): CloudProjectBindingFailure {
  if (!(error instanceof CanopyCloudClientError)) return { transient: false };
  return {
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.serverCode === undefined ? {} : { code: error.serverCode }),
    ...(error.serverReason === undefined ? {} : { reason: error.serverReason }),
    transient: isTransientCanopyCloudFailure(error),
  };
}
