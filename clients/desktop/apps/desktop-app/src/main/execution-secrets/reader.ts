import type {
  ExecutionSecretRead,
  ExecutionSecretReader,
} from '@canopy/core-runtime/node/execution-secrets';
import type { ExecutionSecretSourceRef } from '@canopy/protocol/canopy-core';
import { readEnvironmentConfig } from '../lib/user-environment-store';
import {
  environmentSecretSlot,
  ENVIRONMENT_SECRET_RECORD,
} from '../lib/environment-secret-view';
import { readSharedContainerRunEnvironment } from '../shared-containers/run-env-store';
import { readGitHubPatForExecution } from '../lib/github-pat-env';
import { resolveLinearToken } from '../lib/linear-auth';
import { storedSecretRef } from '../lib/stored-secrets';

type StoredSource = Extract<
  ExecutionSecretSourceRef,
  { kind: 'stored-secret' }
>;
async function storedValues(
  source: StoredSource,
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  if (source.family === 'environment') {
    const { data } = await readEnvironmentConfig();
    for (const environment of data.environments) {
      for (const entry of environment.variables) {
        if (entry.secret === true)
          values.set(
            storedSecretRef(
              'environment',
              ENVIRONMENT_SECRET_RECORD,
              environmentSecretSlot(environment.id, entry.key),
            ),
            entry.value,
          );
      }
    }
  } else {
    const entries = await readSharedContainerRunEnvironment(source.record);
    for (const entry of entries)
      values.set(
        storedSecretRef('shared_container.run_env', source.record, entry.key),
        entry.value,
      );
  }
  return values;
}

export const desktopExecutionSecretReader: ExecutionSecretReader = {
  read: async (bindings): Promise<readonly ExecutionSecretRead[]> => {
    const stored = new Map<string, Promise<ReadonlyMap<string, string>>>();
    const tokens = new Map<string, ExecutionSecretRead>();
    const reads: ExecutionSecretRead[] = [];
    for (const { source } of bindings) {
      if (source.kind === 'account-proxy-route') {
        reads.push({ status: 'unsupported' });
        continue;
      }
      if (source.kind === 'integration-token') {
        let read = tokens.get(source.provider);
        if (!read) {
          const value =
            source.provider === 'linear'
              ? await resolveLinearToken()
              : readGitHubPatForExecution();
          read =
            value === null || (source.provider === 'linear' && value === '')
              ? { status: 'missing' }
              : { status: 'ok', value };
          tokens.set(source.provider, read);
        }
        reads.push(read);
        continue;
      }
      if (
        source.family === 'environment' &&
        source.record !== ENVIRONMENT_SECRET_RECORD
      ) {
        reads.push({ status: 'missing' });
        continue;
      }
      const key = `${source.family}\0${source.record}`;
      let values = stored.get(key);
      if (!values) {
        values = storedValues(source);
        stored.set(key, values);
      }
      const value = (await values).get(source.ref);
      reads.push(
        value === undefined ? { status: 'missing' } : { status: 'ok', value },
      );
    }
    return reads;
  },
};
