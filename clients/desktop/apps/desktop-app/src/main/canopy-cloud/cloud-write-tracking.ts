import { AsyncLocalStorage } from 'node:async_hooks';

interface CloudWriteScope {
  writeSent: boolean;
  readonly parent: CloudWriteScope | undefined;
}

const scopes = new AsyncLocalStorage<CloudWriteScope>();

/**
 * Run `task` while recording whether it sent a Cloud request that can change
 * server state. A share that fails before any write is definitely not
 * published; once a write has gone out, a later failure (a rollback's
 * pre-read, a post-publication install record) leaves the outcome uncertain.
 */
export function trackCloudWrites<T>(task: () => Promise<T>): {
  result: Promise<T>;
  writeSent: () => boolean;
} {
  const scope: CloudWriteScope = {
    writeSent: false,
    parent: scopes.getStore(),
  };
  return {
    result: scopes.run(scope, async () => task()),
    writeSent: () => scope.writeSent,
  };
}

/** Mark the enclosing tracked operations as having sent a Cloud write. */
export function noteCloudWriteSent(): void {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    scope.writeSent = true;
  }
}
