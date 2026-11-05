import type { PreferencesLoadError } from './codec';

export class PreferencesGenerationExhaustedError extends Error {
  readonly code = 'PREFERENCES_GENERATION_EXHAUSTED';

  constructor() {
    super(
      'Preferences are damaged and cannot record another save. Changes were not saved.',
    );
  }
}

export class PreferencesGenerationUnknownError extends Error {
  readonly code = 'PREFERENCES_GENERATION_UNKNOWN';

  constructor() {
    super(
      'Preferences could not confirm their latest saved version. Changes were not saved.',
    );
  }
}

export class PreferencesRecoveryRequiredError extends Error {
  readonly code = 'PREFERENCES_RECOVERY_REQUIRED';

  constructor(readonly details: PreferencesLoadError) {
    super('Preferences could not be read. Changes were not saved.');
  }
}
