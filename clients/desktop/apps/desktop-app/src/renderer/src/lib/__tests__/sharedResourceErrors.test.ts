/** @jest-environment jsdom */

import {
  SHARED_RESOURCE_ERROR_COPY,
  missingRemoteShareCanBeRecreated,
  resolveSharedResourceErrorMessage,
} from '../sharedResourceErrors';
import { ShareFailureError } from '@canopy/ui-app/sharing';

describe('missingRemoteShareCanBeRecreated', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          account: { id: 'account-a' },
          capabilities: [],
        }),
      },
    });
  });

  it('allows recreation only for a link bound to the current account', async () => {
    await expect(missingRemoteShareCanBeRecreated('account-a')).resolves.toBe(
      true,
    );
    await expect(missingRemoteShareCanBeRecreated('account-b')).resolves.toBe(
      false,
    );
    await expect(missingRemoteShareCanBeRecreated(undefined)).resolves.toBe(
      false,
    );
  });
});

describe('resolveSharedResourceErrorMessage', () => {
  it('explains a structured resource-context refusal in a sentence', () => {
    expect(
      resolveSharedResourceErrorMessage(
        new ShareFailureError({
          version: 1,
          kind: 'unavailable',
          stage: 'publish',
          message: 'Resource unavailable (context-mismatch)',
          commitState: 'not-committed',
          retryable: false,
        }),
      ),
    ).toBe('Switch to the organization that owns this share, then try again.');
  });

  it('returns server-provided message verbatim for 400', () => {
    expect(
      resolveSharedResourceErrorMessage({
        status: 400,
        message: 'rawCollection too large',
      }),
    ).toBe('rawCollection too large');
  });

  it('strips IPC-propagated HTTP 400 prefixes from server validation messages', () => {
    expect(
      resolveSharedResourceErrorMessage(
        new Error('HTTP 400: rawCollection too large'),
      ),
    ).toBe('rawCollection too large');
  });

  it('falls back to INVALID_REQUEST for a 400 with no body', () => {
    expect(resolveSharedResourceErrorMessage({ status: 400 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.INVALID_REQUEST,
    );
  });

  it('maps 401/403 to PERMISSION_DENIED', () => {
    expect(resolveSharedResourceErrorMessage({ status: 401 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.PERMISSION_DENIED,
    );
    expect(resolveSharedResourceErrorMessage({ status: 403 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.PERMISSION_DENIED,
    );
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(resolveSharedResourceErrorMessage({ status: 404 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.NOT_FOUND,
    );
  });

  it('uses the supplied deleteConflictMessage on 409', () => {
    expect(
      resolveSharedResourceErrorMessage(
        { status: 409 },
        { deleteConflictMessage: 'used by Collections' },
      ),
    ).toBe('used by Collections');
  });

  it('falls back to resource conflict copy on 409', () => {
    expect(resolveSharedResourceErrorMessage({ status: 409 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.CONFLICT,
    );
  });

  it('maps 429 to RATE_LIMITED', () => {
    expect(resolveSharedResourceErrorMessage({ status: 429 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.RATE_LIMITED,
    );
  });

  it('maps 5xx to SERVER_ERROR', () => {
    expect(resolveSharedResourceErrorMessage({ status: 500 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.SERVER_ERROR,
    );
    expect(resolveSharedResourceErrorMessage({ status: 503 })).toBe(
      SHARED_RESOURCE_ERROR_COPY.SERVER_ERROR,
    );
  });

  it('maps network / timeout messages to NETWORK_ERROR', () => {
    expect(
      resolveSharedResourceErrorMessage(new Error('ECONNREFUSED at host')),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.NETWORK_ERROR);
    expect(resolveSharedResourceErrorMessage(new Error('fetch failed'))).toBe(
      SHARED_RESOURCE_ERROR_COPY.NETWORK_ERROR,
    );
  });

  it('maps unsupported-capability errors to resource-specific copy', () => {
    expect(
      resolveSharedResourceErrorMessage(
        { code: 'unsupported-capability' },
        { unsupportedResource: 'skills' },
      ),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.SKILLS_UNSUPPORTED);
    expect(
      resolveSharedResourceErrorMessage({
        code: 'unsupported-capability',
        message: 'Canopy Cloud does not support collections-crud-v1.',
      }),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.COLLECTIONS_UNSUPPORTED);
  });

  it('maps IPC-flattened unsupported-capability messages to resource-specific copy', () => {
    expect(
      resolveSharedResourceErrorMessage(
        new Error('Canopy Cloud does not support skills-crud-v1.'),
      ),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.SKILLS_UNSUPPORTED);

    expect(
      resolveSharedResourceErrorMessage(
        new Error('Canopy Cloud does not support collections-crud-v1.'),
      ),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.COLLECTIONS_UNSUPPORTED);
  });

  it('parses embedded HTTP <status> tokens from propagated messages', () => {
    expect(resolveSharedResourceErrorMessage(new Error('HTTP 429: wait'))).toBe(
      SHARED_RESOURCE_ERROR_COPY.RATE_LIMITED,
    );
    expect(
      resolveSharedResourceErrorMessage(new Error('Request failed (404)')),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.NOT_FOUND);
  });

  it('removes the IPC wrapper and error-class prefix from a refusal', () => {
    expect(
      resolveSharedResourceErrorMessage(
        new Error(
          "Error invoking remote method 'automations:shared:update': ResourceContextUnavailableError: Resource unavailable (unsupported-target)",
        ),
      ),
    ).toBe('Resource unavailable (unsupported-target)');
    expect(
      resolveSharedResourceErrorMessage({
        message:
          "Error invoking remote method 'skills:shared:update': Error: Resource unavailable (access-removed)",
      }),
    ).toBe('Resource unavailable (access-removed)');
  });

  it('keeps status, network, and useful messages behind an IPC wrapper', () => {
    expect(
      resolveSharedResourceErrorMessage(
        new Error(
          "Error invoking remote method 'skills:shared:update': Error: HTTP 409: changed",
        ),
      ),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.CONFLICT);
    expect(
      resolveSharedResourceErrorMessage(
        new Error(
          "Error invoking remote method 'skills:shared:update': Error: fetch failed",
        ),
      ),
    ).toBe(SHARED_RESOURCE_ERROR_COPY.NETWORK_ERROR);
    expect(
      resolveSharedResourceErrorMessage(
        new Error(
          "Error invoking remote method 'skills:shared:update': Error: The skill name is already taken.",
        ),
      ),
    ).toBe('The skill name is already taken.');
    expect(resolveSharedResourceErrorMessage(new Error(''))).toBe(
      SHARED_RESOURCE_ERROR_COPY.SERVER_ERROR,
    );
  });
});
