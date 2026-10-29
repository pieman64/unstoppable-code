// Organization projects (CAN-611) are dark-launched: the E2E launcher seeds
// from the LaunchDarkly-enabled-unavailable defaults, where this flag is
// `false`, so a spec that exercises the context switcher or catalog must opt in
// through the E2E override.
export const CANOPY_ORG_PROJECTS_ENABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-shared-org-projects-enabled': true,
  }),
};
