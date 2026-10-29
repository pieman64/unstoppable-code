import { SettingsOperationError } from '@canopy/protocol/settings';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  MEMORY_RATE_LIMIT_MESSAGE,
  MemoryRequestError,
  memoryRequestError,
  previewMemorySearch,
} from '../api';

const MESSAGES = {
  unexpected: 'Unexpected preview response',
  fallback: 'Unable to preview retrieval',
};

describe('memoryRequestError', () => {
  it('keeps the rate-limit notice for a 429', () => {
    const error = new SettingsOperationError({
      code: 'failed',
      status: 429,
      message: 'Too many requests',
    });
    expect(memoryRequestError(error, MESSAGES).message).toBe(
      MEMORY_RATE_LIMIT_MESSAGE,
    );
  });

  it('uses the fallback copy for other HTTP failures and keeps the facts for logs', () => {
    const error = new SettingsOperationError({
      code: 'not_found',
      status: 404,
      serverCode: 'explorer_missing',
      message: 'Memory explorer not found',
    });
    const mapped = memoryRequestError(error, MESSAGES);
    expect(mapped.message).toBe('Unable to preview retrieval');
    expect(mapped.message).not.toContain('404');
    expect(String(mapped)).not.toContain('Memory explorer not found');
    expect(mapped).toBeInstanceOf(MemoryRequestError);
    expect(mapped).toMatchObject({
      status: 404,
      code: 'not_found',
      serverCode: 'explorer_missing',
      serverDetail: 'Memory explorer not found',
    });
  });

  it('uses the unexpected-response copy for a malformed body', () => {
    const error = new SettingsOperationError({
      code: 'invalid_response',
      status: 200,
    });
    expect(memoryRequestError(error, MESSAGES).message).toBe(
      'Unexpected preview response',
    );
  });

  it('falls back when no response arrived', () => {
    const error = new SettingsOperationError({ code: 'offline' });
    expect(memoryRequestError(error, MESSAGES).message).toBe(
      'Unable to preview retrieval',
    );
  });

  it('keeps errors that did not come from the settings client', () => {
    const error = new Error('boom');
    expect(memoryRequestError(error, MESSAGES)).toBe(error);
  });
});

describe('previewMemorySearch', () => {
  it('reads organization.memory.previewSearch and maps its failure', async () => {
    const client = createFakeSettingsClient({
      'organization.memory.previewSearch': () => {
        throw new SettingsOperationError({ code: 'failed', status: 429 });
      },
    });
    await expect(
      previewMemorySearch(client, 'org-1', 'databases'),
    ).rejects.toThrow(MEMORY_RATE_LIMIT_MESSAGE);
    expect(client.calls).toEqual([
      {
        operation: 'organization.memory.previewSearch',
        input: { organizationId: 'org-1', query: 'databases' },
      },
    ]);
  });
});
