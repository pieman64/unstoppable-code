const BUNDLED_BINARY_OVERRIDE = /^CANOPY_[A-Z0-9]+_BINARY_PATH$/;

/**
 * Temporarily removes packaged-install binary paths so a test uses the
 * repository's staged development binaries. The returned restoration handle
 * preserves empty strings as values and is safe to call more than once.
 */
export function scrubBundledBinaryOverrides(environment = process.env) {
  const originals = new Map();
  for (const key of Object.keys(environment)) {
    if (!BUNDLED_BINARY_OVERRIDE.test(key)) continue;
    originals.set(key, environment[key]);
    delete environment[key];
  }

  let restored = false;
  return {
    keys: [...originals.keys()],
    restore() {
      if (restored) return;
      restored = true;
      for (const [key, value] of originals) {
        environment[key] = value;
      }
    },
  };
}

export async function withBundledBinaryOverridesScrubbed(
  operation,
  environment = process.env,
) {
  const scrubbed = scrubBundledBinaryOverrides(environment);
  try {
    return await operation();
  } finally {
    scrubbed.restore();
  }
}
