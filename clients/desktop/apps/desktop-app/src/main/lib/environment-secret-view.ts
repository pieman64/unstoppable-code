import type {
  EnvironmentConfigData,
  EnvironmentConfigView,
  UserEnvironmentEntryView,
} from '@canopy/desktop-shared/types/user-environment';
import {
  createStoredSecretResolver,
  StoredSecretError,
  toStoredSecretValue,
} from './stored-secrets';

// One record holds every environment, so a kept value may move between
// environments, as duplicating or reorganizing them does.
const RECORD = 'config';

function slot(environmentId: string, key: string): string {
  return `${environmentId}/${key}`;
}

/** The reply form: values marked secret become stored-secret values. */
export function projectEnvironmentConfig(
  data: EnvironmentConfigData,
): EnvironmentConfigView {
  return {
    ...data,
    environments: data.environments.map((environment) => ({
      ...environment,
      variables: environment.variables.map(
        (entry): UserEnvironmentEntryView =>
          entry.secret === true
            ? {
                ...entry,
                value: toStoredSecretValue(
                  'environment',
                  RECORD,
                  slot(environment.id, entry.key),
                  entry.value,
                ),
              }
            : entry,
      ),
    })),
  };
}

/**
 * Replaces each kept stored secret in a save with the value `current` holds.
 * Refuses the save when a reference names no stored secret, or when a kept
 * value would lose its secret mark and come back as text on the next load.
 * Any other non-string value becomes empty, as normalization would make it.
 */
export function resolveEnvironmentConfigInput(
  next: EnvironmentConfigView,
  current: EnvironmentConfigData,
): EnvironmentConfigData {
  const resolver = createStoredSecretResolver(
    'environment',
    RECORD,
    current.environments.flatMap((environment) =>
      environment.variables
        .filter((entry) => entry.secret === true)
        .map((entry) => ({
          slot: slot(environment.id, entry.key),
          value: entry.value,
        })),
    ),
  );
  if (!Array.isArray(next.environments)) {
    return { ...next, environments: [] };
  }
  return {
    ...next,
    environments: next.environments.map((environment) => ({
      ...environment,
      variables: Array.isArray(environment.variables)
        ? environment.variables.map((entry) => {
            const { value } = entry;
            if (typeof value !== 'object' || value === null) {
              return {
                ...entry,
                value: typeof value === 'string' ? value : '',
              };
            }
            if (entry.secret !== true) {
              throw new StoredSecretError(
                'stored_secret_reveal',
                'Re-enter a saved secret before unmarking it as secret.',
              );
            }
            return { ...entry, value: resolver.resolve(value) };
          })
        : [],
    })),
  };
}
