import { brandEnvCandidates } from '@canopy/execution-engine/brand/env';

const ACTION_ENV_SUFFIXES = ['OUTPUT', 'OUTPUT_DIR'] as const;
const ACTION_ENV_KEYS = ['CANOPY_GIT_EXECUTABLE'] as const;

type ActionEnvSnapshot = Record<string, string | undefined>;

function setActionEnvironment(env: NodeJS.ProcessEnv): {
  values: ActionEnvSnapshot;
} {
  const original: ActionEnvSnapshot = {};

  for (const suffix of ACTION_ENV_SUFFIXES) {
    for (const name of brandEnvCandidates(suffix)) {
      original[name] = process.env[name];
      if (env[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = env[name];
      }
    }
  }
  for (const name of ACTION_ENV_KEYS) {
    original[name] = process.env[name];
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }

  return {
    values: original,
  };
}

function restoreActionEnvironment(original: {
  values: ActionEnvSnapshot;
}): void {
  for (const [name, value] of Object.entries(original.values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

export async function runWithActionEnvironment<T>(
  env: NodeJS.ProcessEnv,
  action: () => T | Promise<T>,
): Promise<T> {
  const original = setActionEnvironment(env);

  try {
    return await action();
  } finally {
    restoreActionEnvironment(original);
  }
}

export function runWithSynchronousActionEnvironment<T>(
  env: NodeJS.ProcessEnv,
  action: () => T,
): T {
  const original = setActionEnvironment(env);

  try {
    return action();
  } finally {
    restoreActionEnvironment(original);
  }
}
