import { expect } from '@playwright/test';

/**
 * Workspace context (Personal / organization) is switched from the shared
 * switcher at the top of the sidebar (`SidebarContextRow`, CAN-4053) — the
 * same component and placement as the web portal. The account menu carries
 * no context group. These helpers drive the switcher the way a user does.
 *
 * `contextId` is `'personal'` or an organization id, matching the
 * `sidebar-context-option-<contextId>` test ids.
 */
function expectedContext(contextId) {
  return contextId === 'personal'
    ? { kind: 'personal' }
    : { kind: 'organization', organizationId: contextId };
}

/** Opens the context switcher's menu. */
export async function openWorkspaceContextMenu(window) {
  const row = window.getByTestId('sidebar-context-row');
  await expect(row).toBeEnabled();
  await row.click();
  await expect(window.getByTestId('sidebar-context-menu')).toBeVisible();
}

/** Closes the scope switcher's menu with Escape. */
export async function closeWorkspaceContextMenu(window) {
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('sidebar-context-menu')).toHaveCount(0);
}

/**
 * Picks a context from the scope switcher, then waits for main to commit it
 * and for the renderer to show it. Main commits first and the renderer follows
 * on its broadcast, so a step that reads the renderer's context right away
 * (an App Advisor action, the Add project dialog) could still see the old one.
 */
export async function selectWorkspaceContext(window, contextId) {
  await openWorkspaceContextMenu(window);
  await window.getByTestId(`sidebar-context-option-${contextId}`).click();
  await expect
    .poll(async () =>
      window.evaluate(
        async () => (await window.api.workspaceContext.get()).context,
      ),
    )
    .toEqual(expectedContext(contextId));
  const label =
    contextId === 'personal'
      ? 'Personal'
      : await window.evaluate(
          async (organizationId) =>
            (await window.api.workspaceContext.get()).organizations.find(
              (organization) => organization.id === organizationId,
            )?.name,
          contextId,
        );
  expect(label, `organization ${contextId} is listed`).toBeTruthy();
  // The switcher row names the context the renderer holds, and lists any
  // contexts with updates after a comma.
  await expect
    .poll(async () =>
      (
        await window
          .getByTestId('sidebar-context-row')
          .getAttribute('aria-label')
      )?.replace(/, updates in .*$/, ''),
    )
    .toBe(`Workspace context: ${label}`);
}

/**
 * Asserts the scope switcher shows `contextId` as the selected context, then
 * closes its menu. Also serves as a load barrier: the switcher renders only
 * once the organization list has arrived.
 */
export async function expectWorkspaceContext(window, contextId) {
  await openWorkspaceContextMenu(window);
  await expect(
    window.getByTestId(`sidebar-context-option-${contextId}`),
  ).toHaveAttribute('aria-checked', 'true');
  await expectContextSelectionCheckmarkOnly(window);
  await closeWorkspaceContextMenu(window);
}

/** The chevron follows painted text, or the clipped label edge when truncated. */
export async function expectContextChevronAfterText(page) {
  const row = page.getByTestId('sidebar-context-row');
  await expect(row).toHaveCSS('font-size', '16px');
  await expect
    .poll(async () =>
      row.evaluate((el) => {
        const label = el.querySelector('span[title]');
        const range = document.createRange();
        range.selectNodeContents(label);
        const truncated = label.scrollWidth > label.clientWidth + 1;
        const end = truncated
          ? label.getBoundingClientRect().right
          : range.getBoundingClientRect().right;
        const gap = el.lastElementChild.getBoundingClientRect().left - end;
        return Math.abs(
          gap - Number.parseFloat(getComputedStyle(el).columnGap),
        );
      }),
    )
    .toBeLessThan(1);
}

/** Search is one compact action immediately to the right of Activity. */
export async function expectHeaderSearchBesideBell(page) {
  const header = page.locator(
    '[data-testid="sidebar-top-context-row"], [data-testid="portal-sidebar-context-row"]',
  );
  const search = header.locator(
    '[data-testid="sidebar-search"], [data-testid="portal-sidebar-chat-search-toggle"]',
  );
  await expect(search).toHaveCount(1);
  await expect(search).toBeVisible();
  const bell = header.getByTestId('sidebar-activity-toggle');
  await expect(bell).toBeVisible();
  const searchBox = await search.boundingBox();
  const bellBox = await bell.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(bellBox).not.toBeNull();
  expect(searchBox.width).toBe(28);
  expect(searchBox.height).toBe(28);
  expect(
    Math.abs(
      searchBox.y + searchBox.height / 2 - bellBox.y - bellBox.height / 2,
    ),
  ).toBeLessThan(1);
  expect(searchBox.x - bellBox.x - bellBox.width).toBeCloseTo(2, 1);
}

/** Context selection is conveyed by its checkmark, without a persistent fill. */
export async function expectContextSelectionCheckmarkOnly(page) {
  const selected = page
    .getByTestId('sidebar-context-menu')
    .locator('[role="menuitemradio"][aria-checked="true"]');
  await expect(selected).toHaveCount(1);
  await page.mouse.move(0, 0);
  // Measure the resting selection, separately from allowed keyboard focus.
  await selected.evaluate((element) => element.blur());
  await expect(selected.locator('[data-glyph="check"]')).toBeVisible();
  await expect(selected).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

/** The open switcher menu's rows and dividers in order, by test id. */
export async function readWorkspaceContextMenuShape(window) {
  return window
    .getByTestId('sidebar-context-menu')
    .evaluate((menu) =>
      Array.from(
        menu.querySelectorAll(
          '[role="menuitem"], [role="menuitemradio"], [role="separator"]',
        ),
      ).map((element) =>
        element.getAttribute('role') === 'separator'
          ? '---'
          : (element.getAttribute('data-testid') ?? '?'),
      ),
    );
}

/**
 * Expects the open switcher to list Personal and the organizations, then
 * Create an organization, then a divider before the selected context's
 * actions, with focus on the checked context row.
 */
export async function expectWorkspaceContextListFirst(window) {
  const shape = await readWorkspaceContextMenuShape(window);
  const create = shape.indexOf('sidebar-context-create-organization');
  expect(shape[0]).toBe('sidebar-context-option-personal');
  expect(create).toBeGreaterThan(0);
  expect(
    shape
      .slice(0, create)
      .every((id) => id.startsWith('sidebar-context-option-')),
  ).toBe(true);
  expect(shape[create + 1]).toBe('---');
  const actions = shape.slice(create + 2);
  expect(actions.length).toBeGreaterThan(0);
  expect(
    actions.some(
      (id) => id === '---' || id.startsWith('sidebar-context-option-'),
    ),
  ).toBe(false);
  await expect(
    window.locator(
      '[data-testid="sidebar-context-menu"] [aria-checked="true"]',
    ),
  ).toBeFocused();
}
