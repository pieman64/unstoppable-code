import assert from 'node:assert/strict';
import test from 'node:test';

import { connectMockCloudAccount } from '../seeders/connectMockCloudAccount.mjs';

test('connectMockCloudAccount saves, announces, and verifies the expected account', async () => {
  const events = [];
  const account = {
    hasApiKey: true,
    email: 'developer@example.test',
    credentialSource: 'api-key',
  };
  const browserWindow = {
    api: {
      async saveCanopyCloudApiKey({ apiKey }) {
        assert.equal(apiKey, 'csk_test');
        return {
          status: { authenticated: true, missingCapabilities: [] },
          account,
        };
      },
      async loadCanopyCloudAccount() {
        return account;
      },
    },
    dispatchEvent(event) {
      events.push(event.type);
    },
  };
  const page = {
    async evaluate(operation, argument) {
      const previous = globalThis.window;
      globalThis.window = browserWindow;
      try {
        return await operation(argument);
      } finally {
        globalThis.window = previous;
      }
    },
  };

  const result = await connectMockCloudAccount(page, 'csk_test', {
    expectedAccount: { email: 'developer@example.test' },
  });

  assert.equal(result.account, account);
  assert.deepEqual(events, ['canopy:cloud-account-changed']);
});
