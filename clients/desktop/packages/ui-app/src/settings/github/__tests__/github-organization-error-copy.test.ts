import {
  settingsActionErrorCopy,
  settingsLoadErrorCopy,
} from '../../errors/settings-error-copy';
import { TeamApiError } from '../../organization/team-api';
import {
  GITHUB_CONNECT_ERROR_COPY,
  GITHUB_CONNECT_KNOWN_ERRORS,
  GITHUB_PICKER_ERROR_COPY,
  GITHUB_PICKER_KNOWN_ERRORS,
  GITHUB_PICKER_NOT_ADMIN_COPY,
} from '../github-organization-error-copy';

const SENTINEL = 'SENTINEL server body ghp_leaked';

describe('organization GitHub error copy', () => {
  it.each(Object.entries(GITHUB_PICKER_ERROR_COPY))(
    'maps the picker code %s to its local copy, never the server text',
    (code, copy) => {
      const error = new TeamApiError(409, SENTINEL, code);
      const shown = settingsLoadErrorCopy(error, GITHUB_PICKER_KNOWN_ERRORS);
      expect(shown).toBe(copy);
      expect(shown).not.toContain('SENTINEL');
    },
  );

  it.each(Object.entries(GITHUB_CONNECT_ERROR_COPY))(
    'maps the connect code %s to its local copy, never the server text',
    (code, copy) => {
      const error = new TeamApiError(400, SENTINEL, code);
      const shown = settingsActionErrorCopy(error, {
        action: 'connect GitHub',
        known: GITHUB_CONNECT_KNOWN_ERRORS,
      });
      expect(shown).toBe(copy);
      expect(shown).not.toContain('SENTINEL');
    },
  );

  it('keeps the suspended-installation copy specific to each flow', () => {
    const error = new TeamApiError(
      409,
      SENTINEL,
      'github-installation-suspended',
    );
    expect(settingsLoadErrorCopy(error, GITHUB_PICKER_KNOWN_ERRORS)).toBe(
      'The GitHub installation is suspended. Reconnect GitHub first.',
    );
    expect(
      settingsActionErrorCopy(error, {
        action: 'connect GitHub',
        known: GITHUB_CONNECT_KNOWN_ERRORS,
      }),
    ).toBe(
      'The GitHub installation is suspended. Unsuspend it on GitHub, then reconnect.',
    );
  });

  it('answers a picker 403 without a code with the role copy', () => {
    const error = new TeamApiError(403, SENTINEL);
    expect(settingsLoadErrorCopy(error, GITHUB_PICKER_KNOWN_ERRORS)).toBe(
      GITHUB_PICKER_NOT_ADMIN_COPY,
    );
  });

  it('falls back to generic copy for an unknown code', () => {
    const error = new TeamApiError(502, SENTINEL, 'github-something-new');
    expect(
      settingsActionErrorCopy(error, {
        action: 'connect GitHub',
        known: GITHUB_CONNECT_KNOWN_ERRORS,
      }),
    ).toBe(
      "Couldn't confirm that finished. Refresh to check before trying again.",
    );
    expect(
      settingsActionErrorCopy(new TeamApiError(500, SENTINEL, 'nope'), {
        action: 'connect GitHub',
        known: GITHUB_CONNECT_KNOWN_ERRORS,
      }),
    ).toBe("Couldn't connect GitHub. Try again.");
  });
});
