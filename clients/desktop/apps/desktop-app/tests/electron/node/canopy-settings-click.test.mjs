import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { createLinuxUiActions } from '../linuxUiActions.mjs';

// Hidden native Linux windows can suspend the animation frames Playwright's
// click/hover "stable" actionability check waits on (30s stall). On Linux the
// Linux UI wrapper clicks the Settings path with `{ force: true }` after
// asserting the control is visible and enabled; macOS and Windows delegate the
// navigation to the wrapped driver, which keeps Playwright's default click.
// These tests run the wrapper around the real `CanopyAppDriver` against a fake
// Playwright `Locator` (class name and `_expect` are what Playwright's real
// `expect` requires) whose ordinary click rejects like the Linux stall.

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

class FakeWindow {
  constructor({ visible = [], disabled = [], onClick = {} } = {}) {
    this.visible = new Set(visible);
    this.disabled = new Set(disabled);
    this.onClick = onClick;
    this.calls = [];
  }

  getByTestId(testId) {
    return new Locator(this, testId);
  }

  // The hosted account page wait selects its frame by page key; the fake
  // reduces that selector to `hosted-page:<pageKey>`.
  locator(selector) {
    const pageKey = /data-hosted-settings-page="([^"]+)"/.exec(selector)?.[1];
    assert.ok(pageKey, `unexpected selector ${selector}`);
    return new Locator(this, `hosted-page:${pageKey}`);
  }
}

class Locator {
  constructor(window, testId) {
    this.window = window;
    this.testId = testId;
  }

  async isVisible() {
    return this.window.visible.has(this.testId);
  }

  async #act(kind, args) {
    this.window.calls.push({ kind, testId: this.testId, args });
    // Linux hidden-window stall: only a forced action skips the stable check.
    if (process.platform === 'linux' && args[0]?.force !== true) {
      throw new Error(`${kind}: waiting for element to be stable (stalled)`);
    }
    if (kind === 'click') this.window.onClick[this.testId]?.(this.window);
  }

  click(...args) {
    return this.#act('click', args);
  }

  hover(...args) {
    return this.#act('hover', args);
  }

  toString() {
    return `getByTestId('${this.testId}')`;
  }

  // Playwright's real `expect(locator).toBeVisible()/toBeEnabled()` delegate here.
  async _expect(expression, { isNot }) {
    const { visible, disabled } = this.window;
    const id = this.testId;
    const truth = {
      'to.be.visible': visible.has(id),
      'to.be.hidden': !visible.has(id),
      'to.be.enabled': !disabled.has(id),
      'to.be.disabled': disabled.has(id),
    }[expression];
    assert.notEqual(truth, undefined, `unexpected expectation ${expression}`);
    return {
      matches: truth,
      received: truth ? 'matched' : 'unmatched',
      log: [],
      timedOut: truth === isNot,
    };
  }
}

function wrapDriver(window) {
  const driver = new CanopyAppDriver(window);
  return { driver, ui: createLinuxUiActions(driver) };
}

const show =
  (...ids) =>
  (window) =>
    ids.forEach((id) => window.visible.add(id));
test('Linux openSettings force-clicks the visible direct Settings action', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['sidebar-account-action-settings'],
    onClick: { 'sidebar-account-action-settings': show('settings-overlay') },
  });
  await wrapDriver(window).ui.openSettings();
  assert.deepEqual(window.calls, [
    {
      kind: 'click',
      testId: 'sidebar-account-action-settings',
      args: [{ force: true }],
    },
  ]);
});

test('Linux openSettings fallback force-clicks the account row and Settings menu item', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['sidebar-account-row'],
    onClick: {
      'sidebar-account-row': show(
        'sidebar-account-menu',
        'sidebar-account-menu-item-settings',
      ),
      'sidebar-account-menu-item-settings': show('settings-overlay'),
    },
  });
  await wrapDriver(window).ui.openSettings();
  assert.deepEqual(
    window.calls.map(({ testId, args }) => [testId, args]),
    [
      ['sidebar-account-row', [{ force: true }]],
      ['sidebar-account-menu-item-settings', [{ force: true }]],
    ],
  );
});

test('Linux openSettings keeps the overlay postcondition after a forced click', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['sidebar-account-action-settings'],
  });
  await assert.rejects(wrapDriver(window).ui.openSettings());
  assert.deepEqual(
    window.calls.map(({ args }) => args),
    [[{ force: true }]],
  );
});

test('Linux openSettingsSection and closeSettings force-click their controls', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['settings-overlay', 'settings-nav-back', 'settings-nav-canopy'],
    onClick: {
      'settings-nav-canopy': show('settings-tab-canopy'),
      'settings-nav-back': (w) => w.visible.delete('settings-overlay'),
    },
  });
  const { ui } = wrapDriver(window);
  await ui.openSettingsSection('canopy');
  await ui.closeSettings();
  assert.deepEqual(
    window.calls.map(({ testId, args }) => [testId, args]),
    [
      ['settings-nav-canopy', [{ force: true }]],
      ['settings-nav-back', [{ force: true }]],
    ],
  );
});

test('Linux openAccountSettingsPage force-clicks the hosted row and waits for the page and its device region', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['settings-overlay', 'settings-nav-account-integrations'],
    onClick: {
      'settings-nav-account-integrations': show(
        'hosted-page:account/integrations',
        'account-device-settings-integrations',
      ),
    },
  });
  await wrapDriver(window).ui.openAccountSettingsPage('integrations');
  assert.deepEqual(
    window.calls.map(({ testId, args }) => [testId, args]),
    [['settings-nav-account-integrations', [{ force: true }]]],
  );
});

test('Linux openAccountSettingsPage rejects a page whose device region never renders', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['settings-nav-account-notifications'],
    onClick: {
      'settings-nav-account-notifications': show(
        'hosted-page:account/notifications',
      ),
    },
  });
  await assert.rejects(
    wrapDriver(window).ui.openAccountSettingsPage('notifications'),
    /toBeVisible/,
  );
});

test('openAccountSettingsPage waits only for the frame on a page without device sections', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['settings-nav-account-security'],
    onClick: {
      'settings-nav-account-security': show('hosted-page:account/security'),
    },
  });
  await wrapDriver(window).ui.openAccountSettingsPage('security');
  assert.deepEqual(
    window.calls.map(({ testId }) => testId),
    ['settings-nav-account-security'],
  );
});

for (const action of ['openSettingsSection', 'closeSettings']) {
  test(`Linux ${action} rejects a click that does not change the Settings surface`, async () => {
    setPlatform('linux');
    const window = new FakeWindow({
      visible: ['settings-overlay', 'settings-nav-canopy', 'settings-nav-back'],
    });
    const { ui } = wrapDriver(window);
    await assert.rejects(
      action === 'openSettingsSection'
        ? ui.openSettingsSection('canopy')
        : ui.closeSettings(),
      action === 'openSettingsSection' ? /toBeVisible/ : /toBeHidden/,
    );
    assert.deepEqual(
      window.calls.map(({ args }) => args),
      [[{ force: true }]],
    );
  });
}

test('Linux click and hover helpers refuse to act on hidden or disabled controls', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['disabled-control'],
    disabled: ['disabled-control'],
  });
  const { ui } = wrapDriver(window);
  for (const testId of ['missing-control', 'disabled-control']) {
    await assert.rejects(
      ui.clickVisibleControl(window.getByTestId(testId), { timeout: 1 }),
    );
    await assert.rejects(
      ui.hoverVisibleControl(window.getByTestId(testId), { timeout: 1 }),
    );
  }
  assert.deepEqual(window.calls, []);
});

test('Linux click and hover helpers force a visible enabled control', async () => {
  setPlatform('linux');
  const window = new FakeWindow({ visible: ['update-prompt'] });
  const { ui } = wrapDriver(window);
  await ui.hoverVisibleControl(window.getByTestId('update-prompt'));
  await ui.clickVisibleControl(window.getByTestId('update-prompt'));
  assert.deepEqual(
    window.calls.map(({ kind, args }) => [kind, args]),
    [
      ['hover', [{ force: true }]],
      ['click', [{ force: true }]],
    ],
  );
});

test('creating and using the Linux wrapper leaves the driver instance and prototype unchanged', async () => {
  setPlatform('linux');
  const window = new FakeWindow({
    visible: ['sidebar-account-action-settings'],
    onClick: { 'sidebar-account-action-settings': show('settings-overlay') },
  });
  const driver = new CanopyAppDriver(window);
  const own = Object.getOwnPropertyDescriptors(driver);
  const prototype = Object.getOwnPropertyDescriptors(CanopyAppDriver.prototype);
  await createLinuxUiActions(driver).openSettings();
  assert.deepEqual(Object.getOwnPropertyDescriptors(driver), own);
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(CanopyAppDriver.prototype),
    prototype,
  );
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform} keeps Playwright's default click for the Settings path`, async () => {
    setPlatform(platform);
    const window = new FakeWindow({
      visible: [
        'sidebar-account-row',
        'settings-nav-canopy',
        'settings-nav-account-account',
        'settings-nav-back',
      ],
      onClick: {
        'sidebar-account-row': show(
          'sidebar-account-menu',
          'sidebar-account-menu-item-settings',
        ),
        'sidebar-account-menu-item-settings': show('settings-overlay'),
        'settings-nav-canopy': show('settings-tab-canopy'),
        'settings-nav-account-account': show(
          'hosted-page:account/account',
          'account-device-settings-account',
        ),
        'settings-nav-back': (w) => w.visible.delete('settings-overlay'),
      },
    });
    const driver = new CanopyAppDriver(window);
    const own = Object.getOwnPropertyDescriptors(driver);
    const prototype = Object.getOwnPropertyDescriptors(
      CanopyAppDriver.prototype,
    );
    const delegated = [];
    const observedDriver = new Proxy(driver, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (
          [
            'openSettings',
            'openSettingsSection',
            'openAccountSettingsPage',
            'closeSettings',
          ].includes(property)
        ) {
          return (...args) => {
            delegated.push(property);
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
    const ui = createLinuxUiActions(observedDriver);
    await ui.openSettings();
    await ui.openSettingsSection('canopy');
    await ui.openAccountSettingsPage('account');
    await ui.closeSettings();
    assert.deepEqual(delegated, [
      'openSettings',
      'openSettingsSection',
      'openAccountSettingsPage',
      'closeSettings',
    ]);
    await ui.clickVisibleControl(window.getByTestId('settings-nav-canopy'));
    await ui.hoverVisibleControl(window.getByTestId('settings-nav-canopy'));
    assert.deepEqual(
      window.calls.map(({ kind, testId, args }) => [kind, testId, args]),
      [
        ['click', 'sidebar-account-row', []],
        ['click', 'sidebar-account-menu-item-settings', []],
        ['click', 'settings-nav-canopy', []],
        ['click', 'settings-nav-account-account', []],
        ['click', 'settings-nav-back', []],
        ['click', 'settings-nav-canopy', []],
        ['hover', 'settings-nav-canopy', []],
      ],
    );
    assert.deepEqual(Object.getOwnPropertyDescriptors(driver), own);
    assert.deepEqual(
      Object.getOwnPropertyDescriptors(CanopyAppDriver.prototype),
      prototype,
    );
  });
}
