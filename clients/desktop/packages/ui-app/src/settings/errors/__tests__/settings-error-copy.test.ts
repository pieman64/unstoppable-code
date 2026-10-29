/** @jest-environment jsdom */

import { SettingsOperationError } from '@canopy/protocol/settings';
import { GitHubCloudApiError } from '../../github/github-cloud-api';
import { memoryRequestError } from '../../memory/api';
import { TEAM_API_ERROR_COPY, TeamApiError } from '../../organization/team-api';
import {
  SETTINGS_LOAD_ERROR_COPY,
  SETTINGS_OFFLINE_ERROR_COPY,
  SETTINGS_UNCERTAIN_ERROR_COPY,
  isSettingsAccessLost,
  logSettingsError,
  settingsActionErrorCopy,
  settingsErrorDetail,
  settingsErrorFacts,
  settingsLoadErrorCopy,
} from '../settings-error-copy';

const SENTINEL = 'SENTINEL server body: stack trace at db.query()';

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  setOnline(true);
});

describe('settingsErrorFacts', () => {
  it('reads a settings client failure', () => {
    expect(
      settingsErrorFacts(
        new SettingsOperationError({
          code: 'failed',
          status: 409,
          serverCode: 'last_owner',
          message: SENTINEL,
        }),
      ),
    ).toEqual({
      status: 409,
      code: 'failed',
      serverCode: 'last_owner',
      offline: false,
      uncertain: false,
    });
  });

  it('reads a TeamApiError code as the server code', () => {
    expect(
      settingsErrorFacts(new TeamApiError(402, SENTINEL, 'card_declined')),
    ).toEqual({
      status: 402,
      serverCode: 'card_declined',
      offline: false,
      uncertain: false,
    });
  });

  it('reads a GitHub for cloud failure kind and service code', () => {
    expect(settingsErrorFacts(new GitHubCloudApiError('http', 500))).toEqual({
      status: 500,
      code: 'http',
      offline: false,
      uncertain: false,
    });
    expect(
      settingsErrorFacts(new GitHubCloudApiError('network', null)).offline,
    ).toBe(true);
  });

  it('reads a memory explorer failure', () => {
    const error = memoryRequestError(
      new SettingsOperationError({ code: 'failed', status: 429 }),
      { unexpected: 'Unexpected', fallback: 'Fallback' },
    );
    expect(settingsErrorFacts(error)).toMatchObject({ status: 429 });
  });

  it.each([
    [
      'the settings client offline code',
      new SettingsOperationError({ code: 'offline' }),
    ],
    ['a failed fetch', new TypeError('Failed to fetch')],
    ['an undici fetch failure', new TypeError('fetch failed')],
  ])('marks %s as offline', (_label, error) => {
    expect(settingsErrorFacts(error)).toMatchObject({
      offline: true,
      uncertain: false,
    });
  });

  it('marks an unanswered failure offline while the browser is offline', () => {
    setOnline(false);
    expect(settingsErrorFacts(new Error('boom')).offline).toBe(true);
    // A server answer is never offline.
    expect(settingsErrorFacts(new TeamApiError(500)).offline).toBe(false);
  });

  it('keeps a dropped write uncertain while the browser is offline', () => {
    setOnline(false);
    // The write may have landed before the connection dropped.
    expect(
      settingsErrorFacts(new SettingsOperationError({ code: 'uncertain' })),
    ).toMatchObject({ offline: false, uncertain: true });
  });

  it('does not treat a programming TypeError as offline', () => {
    expect(
      settingsErrorFacts(new TypeError('x is not a function')).offline,
    ).toBe(false);
  });

  it.each([
    ['a 502', new TeamApiError(502)],
    ['a 504', new SettingsOperationError({ code: 'uncertain', status: 504 })],
    ['a dropped write', new SettingsOperationError({ code: 'uncertain' })],
    ['an abort', new DOMException('aborted', 'AbortError')],
    ['a timeout', new DOMException('timed out', 'TimeoutError')],
  ])('marks %s as uncertain', (_label, error) => {
    expect(settingsErrorFacts(error)).toMatchObject({
      offline: false,
      uncertain: true,
    });
  });

  it('does not mark a 500 or 503 answer as uncertain', () => {
    expect(settingsErrorFacts(new TeamApiError(500)).uncertain).toBe(false);
    expect(settingsErrorFacts(new TeamApiError(503)).uncertain).toBe(false);
  });

  it('knows nothing about an unknown failure', () => {
    expect(settingsErrorFacts('boom')).toEqual({
      offline: false,
      uncertain: false,
    });
  });
});

describe('settingsLoadErrorCopy', () => {
  it('uses generic load copy for an unknown failure', () => {
    expect(settingsLoadErrorCopy(new TeamApiError(500, SENTINEL))).toBe(
      SETTINGS_LOAD_ERROR_COPY,
    );
    expect(SETTINGS_LOAD_ERROR_COPY).toBe("Couldn't load this. Try again.");
  });

  it('uses the matching known case by status', () => {
    expect(
      settingsLoadErrorCopy(new TeamApiError(403), [
        { status: 404, copy: 'Not here.' },
        { status: 403, copy: 'Plan gate.' },
      ]),
    ).toBe('Plan gate.');
  });
});

describe('settingsActionErrorCopy', () => {
  const action = 'rename this organization';

  it('matches a known case by status and server code together', () => {
    const known = [
      { status: 409, serverCode: 'live_subscription', copy: 'Cancel first.' },
      { status: 409, copy: 'Conflict.' },
    ];
    expect(
      settingsActionErrorCopy(
        new TeamApiError(409, SENTINEL, 'live_subscription'),
        {
          action,
          known,
        },
      ),
    ).toBe('Cancel first.');
    expect(
      settingsActionErrorCopy(new TeamApiError(409, SENTINEL, 'other'), {
        action,
        known,
      }),
    ).toBe('Conflict.');
  });

  it('matches a known case by server code alone', () => {
    expect(
      settingsActionErrorCopy(
        new SettingsOperationError({
          code: 'failed',
          status: 409,
          serverCode: 'no_saved_card',
        }),
        {
          action,
          known: [{ serverCode: 'no_saved_card', copy: 'Add a card.' }],
        },
      ),
    ).toBe('Add a card.');
  });

  it('matches a known case by client code', () => {
    expect(
      settingsActionErrorCopy(new GitHubCloudApiError('unavailable', 404), {
        action,
        known: [{ code: 'unavailable', copy: 'Not available.' }],
      }),
    ).toBe('Not available.');
  });

  it('never matches a known case without fields', () => {
    expect(
      settingsActionErrorCopy(new TeamApiError(500), {
        action,
        known: [{ copy: 'Never.' }],
      }),
    ).toBe("Couldn't rename this organization. Try again.");
  });

  it('uses offline copy when the request never reached the server', () => {
    expect(
      settingsActionErrorCopy(new TypeError('Failed to fetch'), { action }),
    ).toBe(SETTINGS_OFFLINE_ERROR_COPY);
    expect(SETTINGS_OFFLINE_ERROR_COPY).toBe(
      "You're offline. Check your connection and try again.",
    );
  });

  it('uses uncertain copy when the outcome is unknown', () => {
    expect(settingsActionErrorCopy(new TeamApiError(504), { action })).toBe(
      SETTINGS_UNCERTAIN_ERROR_COPY,
    );
    expect(SETTINGS_UNCERTAIN_ERROR_COPY).toBe(
      "Couldn't confirm that finished. Refresh to check before trying again.",
    );
  });

  it('uses generic action copy and never the server text', () => {
    const copy = settingsActionErrorCopy(new TeamApiError(500, SENTINEL), {
      action,
    });
    expect(copy).toBe("Couldn't rename this organization. Try again.");
    expect(copy).not.toContain('SENTINEL');
  });
});

describe('isSettingsAccessLost', () => {
  it.each([
    new TeamApiError(401),
    new TeamApiError(403),
    new SettingsOperationError({ code: 'forbidden', status: 403 }),
    new SettingsOperationError({ code: 'expired' }),
  ])('is true for lost access: %p', (error) => {
    expect(isSettingsAccessLost(error)).toBe(true);
  });

  it('is false for other failures', () => {
    expect(isSettingsAccessLost(new TeamApiError(404))).toBe(false);
    expect(isSettingsAccessLost(new Error('boom'))).toBe(false);
  });
});

describe('TeamApiError', () => {
  it('keeps the server body out of its message and string form', () => {
    const error = new TeamApiError(500, SENTINEL, 'db_failed');
    expect(error.message).toBe(TEAM_API_ERROR_COPY);
    expect(error.message).not.toContain('SENTINEL');
    expect(String(error)).not.toContain('SENTINEL');
    expect(`${error}`).not.toContain('SENTINEL');
    expect(error.serverDetail).toBe(SENTINEL);
    expect(error).toMatchObject({ status: 500, code: 'db_failed' });
  });
});

describe('settingsErrorDetail', () => {
  it('reads the server text for logs', () => {
    expect(settingsErrorDetail(new TeamApiError(500, SENTINEL))).toBe(SENTINEL);
    expect(
      settingsErrorDetail(
        new SettingsOperationError({
          code: 'failed',
          status: 500,
          message: SENTINEL,
        }),
      ),
    ).toBe(SENTINEL);
    expect(
      settingsErrorDetail(new SettingsOperationError({ code: 'offline' })),
    ).toBeUndefined();
  });
});

describe('logSettingsError', () => {
  it('puts the truncated server text in the message and the full text in meta', () => {
    const warn = jest.fn<void, [string, Record<string, unknown>?]>();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
    };
    const body = `${SENTINEL} ${'x'.repeat(400)}`;
    logSettingsError(
      logger,
      'rename',
      new TeamApiError(500, body, 'db_failed'),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0];
    expect(message).toBe(
      `rename failed (status=500 serverCode=db_failed): ${body.slice(0, 200)}…`,
    );
    expect(meta).toMatchObject({
      status: 500,
      serverCode: 'db_failed',
      detail: body,
      errorName: 'TeamApiError',
    });
  });

  it('logs the facts alone without server text', () => {
    const warn = jest.fn<void, [string, Record<string, unknown>?]>();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn,
      error: jest.fn(),
    };
    logSettingsError(
      logger,
      'load',
      new SettingsOperationError({ code: 'offline' }),
    );
    expect(warn.mock.calls[0][0]).toBe('load failed (code=offline offline)');
  });
});
