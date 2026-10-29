import { expect, test } from '@playwright/test';
import { openLocalConnectionFixture } from './pluginConnectionDesignFixture.mjs';
import { closeCanopy } from './launchCanopy.mjs';

test('MCP detail tests its selected configuration and confirms device deletion (CAN-4265)', async () => {
  const { electronApp, userDataDir, window } =
    await openLocalConnectionFixture();
  try {
    await expect(window.getByTestId('mcp-health-badge')).toHaveText(
      'Auth required',
    );
    await window.getByTestId('mcp-health-test').click();
    await expect(window.getByTestId('mcp-health-result')).toHaveAttribute(
      'data-success',
      'true',
    );
    await expect(window.getByTestId('mcp-health-result-tools')).toContainText(
      'search_messages',
    );
    expect(
      await electronApp.evaluate(() => globalThis.__localDetailCalls.test),
    ).toEqual([{ serverId: 'aabbcc', configId: 'ddeeff' }]);
    await window.getByTestId('mcp-management-delete').click();
    await expect(
      window.getByTestId('mcp-management-delete-dialog'),
    ).toContainText('from this device');
    await window.getByTestId('mcp-management-delete-cancel').click();
    expect(
      await window.evaluate(() =>
        window.mcpServers.loadServer('aabbcc').then(() => true),
      ),
    ).toBe(true);
    await window.getByTestId('mcp-management-delete').click();
    await window.getByTestId('mcp-management-delete-confirm').click();
    await expect(window.getByTestId('mcp-health-section')).toHaveCount(0);
    expect(
      await window.evaluate(() =>
        window.mcpServers
          .loadIndex()
          .then((index) =>
            index.servers.some((server) => server.id === 'aabbcc'),
          ),
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
