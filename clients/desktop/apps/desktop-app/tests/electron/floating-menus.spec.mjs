import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { setUiScale } from './uiScale.mjs';
import {
  countLeaves,
  DEFAULT_GROUP_IDS,
  seedPanelWorktree,
} from './panelHarness.mjs';

const DEMO_APP_ID = 'ts-pnpm-vite';
const MENU_ITEM_HEIGHT_PRECISION = 1;
const MENU_GEOMETRY_STABILITY_TOLERANCE = 0.25;

async function setVisualMode(
  window,
  { colorMode, sidebarAppearance = 'translucent' },
) {
  await window.emulateMedia({
    colorScheme: colorMode,
    reducedMotion: 'no-preference',
  });
  await window.evaluate(
    ({ dark, appearance }) => {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.setAttribute(
        'data-sidebar-appearance',
        appearance,
      );
    },
    {
      dark: colorMode === 'dark',
      appearance: sidebarAppearance,
    },
  );
}

async function waitForEntryMotion(
  menu,
  expectedItemHeight = 32,
  itemSelector = '[role^="menuitem"], [role="option"], [data-action-row]',
) {
  await expect(menu).toHaveAttribute('data-positioned', 'true');
  await menu.evaluate(async (element) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });
  await expect(menu.locator(itemSelector).first()).toHaveCSS(
    'height',
    `${expectedItemHeight}px`,
    { timeout: 3_000 },
  );
}

async function readMenuContract(
  menu,
  itemSelector = '[role^="menuitem"], [role="option"], [data-action-row]',
  scrollAreaSelector = '[data-overlay-scroll-area]',
) {
  return menu.evaluate(
    (element, { selector, scrollAreaSelector }) => {
      const style = getComputedStyle(element);
      const firstItem = element.querySelector(selector);
      const itemStyle = firstItem ? getComputedStyle(firstItem) : null;
      const rect = element.getBoundingClientRect();
      const placement = element.getAttribute('data-placement');
      const [originX, originY] = style.transformOrigin
        .split(' ')
        .slice(0, 2)
        .map((value) => Number.parseFloat(value));
      const expectedOriginX = placement?.endsWith('-right')
        ? rect.width
        : placement?.endsWith('-center')
          ? rect.width / 2
          : 0;
      const expectedOriginY = placement?.startsWith('top-') ? rect.height : 0;

      const tokenProbe = document.createElement('div');
      tokenProbe.style.backgroundColor = 'var(--bg-quaternary)';
      document.body.append(tokenProbe);
      const tokenBackground = getComputedStyle(tokenProbe).backgroundColor;
      tokenProbe.remove();

      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationEasing: style.animationTimingFunction,
        backgroundColor: style.backgroundColor,
        tokenBackground,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        fontSize: itemStyle?.fontSize,
        itemHeight: firstItem?.getBoundingClientRect().height,
        padding: style.padding,
        // Effective per-edge inset between the menu surface and its rows: the
        // scroll-viewport anatomy moves the inset onto the overlay scroll
        // CONTENT (so the thumb can ride the full surface height) and pulls the
        // scroll area itself full-bleed with a negative margin, so the visible
        // 4px is surface padding + scroll-area margin + content padding.
        effectiveInsets: (() => {
          // Only an edge-to-edge scroll area contributes to the surface inset.
          // A composite's interior list (beside a tab rail, below a header) owns
          // its own padding and must not be counted as outer menu padding.
          const scrollArea = element.querySelector(scrollAreaSelector);
          const content = scrollArea?.querySelector(
            '[data-overlay-scroll-content]',
          );
          const contentStyle = content ? getComputedStyle(content) : null;
          const areaStyle = scrollArea ? getComputedStyle(scrollArea) : null;
          const px = (value) => Number.parseFloat(value) || 0;
          const edge = (side) =>
            px(style[`padding${side}`]) +
            (areaStyle ? px(areaStyle[`margin${side}`]) : 0) +
            (contentStyle ? px(contentStyle[`padding${side}`]) : 0);
          return {
            top: edge('Top'),
            bottom: edge('Bottom'),
            left: edge('Left'),
            right: edge('Right'),
          };
        })(),
        placement,
        pointerEvents: style.pointerEvents,
        rect: {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
        transformOriginDelta: {
          x: Math.abs(originX - expectedOriginX),
          y: Math.abs(originY - expectedOriginY),
        },
        zIndex: style.zIndex,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      };
    },
    { selector: itemSelector, scrollAreaSelector },
  );
}

function expectCanonicalMenuContract(
  contract,
  expectedItemHeight = 32,
  expectedFontSize = '14px',
  expectedHorizontalInset = 4,
  expectedMotion = true,
  expectedBorderRadius = '12px',
) {
  if (expectedMotion) {
    expect(contract.animationName).toBe('floating-menu-enter');
    expect(contract.animationDuration).toBe('0.25s');
    expect(contract.animationEasing).toBe('cubic-bezier(0.22, 1, 0.36, 1)');
  } else {
    expect(contract.animationName).toBe('none');
  }
  expect(contract.backgroundColor).toBe(contract.tokenBackground);
  expect(contract.borderRadius).toBe(expectedBorderRadius);
  expect(contract.boxShadow).not.toBe('none');
  expect(contract.fontSize).toBe(expectedFontSize);
  expect(contract.itemHeight).toBeCloseTo(
    expectedItemHeight,
    MENU_ITEM_HEIGHT_PRECISION,
  );
  // Raw `style.padding` differs by anatomy (scroll-viewport menus carry the
  // vertical inset on the overlay scroll content), so assert the effective
  // per-edge inset instead. Vertically the canonical 4px is a MINIMUM:
  // pickers stack an interior content inset below their search header on top
  // of the surface inset, so their sum reads 8.
  expect(contract.effectiveInsets.top).toBeGreaterThanOrEqual(4);
  expect(contract.effectiveInsets.bottom).toBeGreaterThanOrEqual(4);
  expect(contract.effectiveInsets.left).toBe(expectedHorizontalInset);
  expect(contract.effectiveInsets.right).toBe(expectedHorizontalInset);
  expect(contract.pointerEvents).toBe('auto');
  expect(contract.rect.top).toBeGreaterThanOrEqual(8);
  expect(contract.rect.left).toBeGreaterThanOrEqual(8);
  expect(contract.rect.right).toBeLessThanOrEqual(contract.viewport.width - 8);
  expect(contract.rect.bottom).toBeLessThanOrEqual(
    contract.viewport.height - 8,
  );
  expect(contract.transformOriginDelta.x).toBeLessThanOrEqual(0.5);
  expect(contract.transformOriginDelta.y).toBeLessThanOrEqual(0.5);
  expect(contract.zIndex).toBe('400');
}

async function readPickerAnatomy(menu) {
  return menu.evaluate((element) => {
    const menuRect = element.getBoundingClientRect();
    const menuStyle = getComputedStyle(element);
    const searchHeader = element.querySelector('.canopy-picker-menu-search');
    const search = element.querySelector('input');
    const searchStyle = search ? getComputedStyle(search) : null;
    const searchField = search?.closest('.canopy-picker-menu-search-field');
    const searchFieldStyle = searchField ? getComputedStyle(searchField) : null;
    const list = element.querySelector('.canopy-picker-menu-list');
    const tablist = element.querySelector('.canopy-picker-menu-tabs');
    const tabs = Array.from(
      element.querySelectorAll('.canopy-picker-menu-tab'),
    );
    const section = element.querySelector('.canopy-picker-menu-section');
    const sectionLabel = element.querySelector(
      '.canopy-picker-menu-section-label',
    );
    const footer = element.querySelector('.canopy-picker-menu-footer');
    const rows = Array.from(
      element.querySelectorAll('.canopy-picker-menu-option'),
    ).slice(0, 2);

    return {
      // Includes the interface-scale zoom, so a one-device-pixel hairline is
      // `1 / devicePixelRatio` CSS px whatever the scale.
      devicePixelRatio: window.devicePixelRatio,
      menu: {
        width: menuRect.width,
        overflow: menuStyle.overflow,
        padding: menuStyle.padding,
        radius: menuStyle.borderRadius,
      },
      searchHeader: searchHeader
        ? {
            height: searchHeader.getBoundingClientRect().height,
            paddingTop: getComputedStyle(searchHeader).paddingTop,
            paddingBottom: getComputedStyle(searchHeader).paddingBottom,
            borderBottomWidth: getComputedStyle(searchHeader).borderBottomWidth,
          }
        : null,
      search: search
        ? {
            height: search.getBoundingClientRect().height,
            leftInset: search.getBoundingClientRect().left - menuRect.left,
            textStart:
              search.getBoundingClientRect().left -
              menuRect.left +
              Number.parseFloat(searchStyle?.paddingLeft ?? '0'),
            backgroundColor: searchStyle?.backgroundColor,
            borderWidth: searchStyle?.borderWidth,
            fontSize: searchStyle?.fontSize,
            fontWeight: searchStyle?.fontWeight,
            paddingLeft: searchStyle?.paddingLeft,
            paddingRight: searchStyle?.paddingRight,
            // The row rail (32px tall, 8px text inset) lives on the field
            // wrapper that also holds the magnifying glass; the input just
            // fills it.
            fieldHeight: searchField?.getBoundingClientRect().height,
            fieldPaddingLeft: searchFieldStyle?.paddingLeft,
            fieldPaddingRight: searchFieldStyle?.paddingRight,
          }
        : null,
      list: list
        ? {
            left: list.getBoundingClientRect().left,
            right: list.getBoundingClientRect().right,
            clientRight: list.getBoundingClientRect().left + list.clientWidth,
            overflowX: getComputedStyle(list).overflowX,
            overflowY: getComputedStyle(list).overflowY,
            scrollbarGutter: getComputedStyle(list).scrollbarGutter,
            scrollWidth: list.scrollWidth,
            clientWidth: list.clientWidth,
            offsetWidth: list.offsetWidth,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
          }
        : null,
      tabs: tablist
        ? {
            height: tablist.getBoundingClientRect().height,
            gap: getComputedStyle(tablist).gap,
            paddingBottom: getComputedStyle(tablist).paddingBottom,
            overflowX: getComputedStyle(tablist).overflowX,
            clientWidth: tablist.clientWidth,
            scrollWidth: tablist.scrollWidth,
            items: tabs.map((tab) => ({
              text: tab.textContent?.trim(),
              height: tab.getBoundingClientRect().height,
              fontSize: getComputedStyle(tab).fontSize,
              fontWeight: getComputedStyle(tab).fontWeight,
              clientWidth: tab.clientWidth,
              scrollWidth: tab.scrollWidth,
              whiteSpace: getComputedStyle(tab).whiteSpace,
              tabIndex: tab.getAttribute('tabindex'),
              selected: tab.getAttribute('aria-selected'),
              // Selection cue is an accent underline drawn as ::after on the
              // tab's own bottom edge.
              indicatorHeight: getComputedStyle(tab, '::after').height,
              indicatorContent: getComputedStyle(tab, '::after').content,
            })),
          }
        : null,
      section: section
        ? {
            marginTop: getComputedStyle(section).marginTop,
            paddingTop: getComputedStyle(section).paddingTop,
            borderTopWidth: getComputedStyle(section).borderTopWidth,
            label: sectionLabel
              ? {
                  text: sectionLabel.textContent?.trim(),
                  height: sectionLabel.getBoundingClientRect().height,
                  fontSize: getComputedStyle(sectionLabel).fontSize,
                  fontWeight: getComputedStyle(sectionLabel).fontWeight,
                  textTransform: getComputedStyle(sectionLabel).textTransform,
                }
              : null,
          }
        : null,
      footer: footer
        ? {
            marginTop: getComputedStyle(footer).marginTop,
            paddingTop: getComputedStyle(footer).paddingTop,
            borderTopWidth: getComputedStyle(footer).borderTopWidth,
          }
        : null,
      rows: rows.map((row) => {
        const [leading, content] = row.children;
        const trailing = row.querySelector('[data-picker-selected-check]');
        const rowRect = row.getBoundingClientRect();
        const leadingRect = leading?.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        const trailingRect = trailing?.getBoundingClientRect();
        const style = getComputedStyle(row);
        return {
          height: rowRect.height,
          radius: style.borderRadius,
          fontSize: style.fontSize,
          gap: style.columnGap,
          leadingWidth: leadingRect?.width,
          leftInset: rowRect.left - menuRect.left,
          rightInset: menuRect.right - rowRect.right,
          labelStart: contentRect?.left - menuRect.left,
          checkWidth: trailingRect?.width,
          checkRight: trailingRect?.right,
          checkRightInset: menuRect.right - trailingRect?.right,
          selected: row.getAttribute('aria-selected'),
        };
      }),
    };
  });
}

function expectMatchingPickerAnatomy(
  project,
  worktree,
  { canonicalPixels = true } = {},
) {
  for (const anatomy of [project, worktree]) {
    if (canonicalPixels) {
      // 20.5rem: the project picker opts into a slightly wider maximum than
      // the shared 20rem cap (WorkspaceDropdown's `maximumWidth`).
      expect(anatomy.menu.width).toBeLessThanOrEqual(328.5);
      // Both of the picker surface's VERTICAL insets now ride the overlay
      // scroll content and the search/footer (so the thumb rides the full
      // surface height and the list scrolls under the rounded corners); the
      // visual inset stays 4px on every edge, which `effectiveInsets` and the
      // per-row `leftInset`/`rightInset` below assert.
      expect(anatomy.menu.padding).toBe('0px 4px');
      expect(anatomy.menu.radius).toBe('12px');
      expect(anatomy.search.fontSize).toBe('14px');
      expect(anatomy.search.fieldPaddingLeft).toBe('8px');
      expect(anatomy.search.fieldPaddingRight).toBe('8px');
      expect(anatomy.searchHeader.paddingBottom).toBe('4px');
    }
    expect(anatomy.menu.overflow).toBe('hidden');
    expect(anatomy.search.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(anatomy.search.borderWidth).toBe('0px');
    expect(anatomy.search.fontWeight).toBe('400');
    // The surface no longer pads its top edge, so the search header owns the
    // breathing room above the field — symmetrically, at whatever the current
    // UI scale makes of 4px (the canonical branch above pins the 100% value).
    expect(anatomy.searchHeader.paddingTop).toBe(
      anatomy.searchHeader.paddingBottom,
    );
    // The search header's divider is the house hairline: exactly one device
    // pixel at every interface scale (the scale is a uniform zoom, so the CSS
    // width shrinks as devicePixelRatio grows).
    expect(
      Number.parseFloat(anatomy.searchHeader.borderBottomWidth) *
        anatomy.devicePixelRatio,
    ).toBeCloseTo(1, 2);
    if (canonicalPixels) {
      expect(anatomy.search.fieldHeight).toBeCloseTo(32, 2);
      expect(anatomy.searchHeader.height).toBeGreaterThanOrEqual(39.5);
      expect(anatomy.searchHeader.height).toBeLessThanOrEqual(41.5);
    }
    expect(anatomy.list.overflowX).toBe('hidden');
    expect(anatomy.list.overflowY).toBe('auto');
    expect(anatomy.list.scrollbarGutter).toBe('auto');
    expect(anatomy.list.scrollWidth).toBeLessThanOrEqual(
      anatomy.list.clientWidth,
    );
    for (const row of anatomy.rows) {
      if (canonicalPixels) {
        expect(row.height).toBeCloseTo(32, 2);
        expect(row.radius).toBe('8px');
        expect(row.fontSize).toBe('14px');
        expect(row.gap).toBe('8px');
        expect(row.leadingWidth).toBeCloseTo(16, 2);
        // Only the selected row mounts the 16px check; unselected rows leave
        // the trailing rail free for a status icon.
        if (row.selected === 'true') {
          expect(row.checkWidth).toBeCloseTo(16, 2);
        } else {
          expect(row.checkWidth).toBeUndefined();
        }
      }
    }
    expect(anatomy.rows.map((row) => row.selected)).toEqual(
      expect.arrayContaining(['true', 'false']),
    );
    expect(
      Math.abs(anatomy.rows[0].labelStart - anatomy.rows[1].labelStart),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(anatomy.rows[0].leftInset - anatomy.rows[1].leftInset),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(anatomy.rows[0].rightInset - anatomy.rows[1].rightInset),
    ).toBeLessThanOrEqual(0.5);
    if (anatomy.list.scrollHeight <= anatomy.list.clientHeight + 0.5) {
      expect(anatomy.list.offsetWidth - anatomy.list.clientWidth).toBe(0);
      for (const row of anatomy.rows) {
        expect(Math.abs(row.leftInset - row.rightInset)).toBeLessThanOrEqual(
          0.5,
        );
      }
    }
  }

  for (const [projectMetric, worktreeMetric] of [
    [project.searchHeader.height, worktree.searchHeader.height],
    [project.search.leftInset, worktree.search.leftInset],
    [project.search.textStart, worktree.search.textStart],
  ]) {
    expect(Math.abs(projectMetric - worktreeMetric)).toBeLessThanOrEqual(0.75);
  }
  expect(worktree.menu.padding).toBe(project.menu.padding);
  expect(worktree.menu.radius).toBe(project.menu.radius);
  expect(worktree.search.fontSize).toBe(project.search.fontSize);
  expect(worktree.search.fieldPaddingLeft).toBe(
    project.search.fieldPaddingLeft,
  );
  expect(worktree.search.fieldPaddingRight).toBe(
    project.search.fieldPaddingRight,
  );
  expect(worktree.searchHeader.paddingBottom).toBe(
    project.searchHeader.paddingBottom,
  );
  for (const metric of [
    'height',
    'radius',
    'fontSize',
    'gap',
    'leadingWidth',
    'checkWidth',
    'leftInset',
    'rightInset',
    'labelStart',
    'checkRightInset',
  ]) {
    if (typeof project.rows[0][metric] === 'number') {
      expect(project.rows[0][metric]).toBeCloseTo(worktree.rows[0][metric], 2);
    } else {
      expect(project.rows[0][metric]).toBe(worktree.rows[0][metric]);
    }
  }
  expect(project.search.height).toBeCloseTo(worktree.search.height, 2);
  expect(worktree.tabs).not.toBeNull();
  expect(worktree.tabs.items.map((tab) => tab.text)).toEqual([
    'Worktrees',
    'PRs',
    'Branches',
    'Issues',
  ]);
  expect(worktree.tabs.items.map((tab) => tab.selected)).toEqual([
    'true',
    'false',
    'false',
    'false',
  ]);
  expect(worktree.tabs.items.map((tab) => tab.tabIndex)).toEqual([
    '0',
    '-1',
    '-1',
    '-1',
  ]);
  expect(worktree.tabs.overflowX).toBe('auto');
  // Selection is an accent underline on the tab's own bottom edge now, not a
  // filled capsule, so the list cannot pad below the tabs without floating the
  // indicator off the shared rail.
  expect(worktree.tabs.paddingBottom).toBe('0px');
  expect(worktree.tabs.scrollWidth).toBeLessThanOrEqual(
    worktree.tabs.clientWidth + 0.5,
  );
  for (const tab of worktree.tabs.items) {
    if (canonicalPixels) {
      expect(tab.height).toBeCloseTo(32, 2);
      expect(tab.fontSize).toBe('13px');
      // Only the active tab paints the 2px accent rail; the rest draw no
      // indicator box at all.
      if (tab.selected === 'true') {
        expect(tab.indicatorContent).not.toBe('none');
        expect(tab.indicatorHeight).toBe('2px');
      } else {
        expect(tab.indicatorContent).toBe('none');
      }
    }
    expect(tab.fontWeight).toBe('400');
    expect(tab.whiteSpace).toBe('nowrap');
    expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth);
  }
  expect(worktree.section.label).toMatchObject({
    text: 'Existing worktrees',
    fontWeight: '400',
    textTransform: 'none',
  });
  if (canonicalPixels) {
    expect(worktree.section.marginTop).toBe('4px');
    expect(worktree.section.paddingTop).toBe('4px');
  }
  expect(worktree.section.borderTopWidth).toBe(project.footer.borderTopWidth);
  expect(worktree.section.paddingTop).toBe(project.footer.paddingTop);
  if (canonicalPixels) {
    // An in-list section divider still opens a 4px gap above its rule; the
    // footer sits directly on the scroll content's own 4px bottom inset and
    // would double it with a margin of its own.
    expect(worktree.section.marginTop).toBe('4px');
    expect(project.footer.marginTop).toBe('0px');
    expect(project.menu.width).toBeCloseTo(296, 1);
    expect(worktree.menu.width).toBeCloseTo(296, 1);
    expect(worktree.section.label.height).toBeCloseTo(26, 2);
    expect(worktree.section.label.fontSize).toBe('13px');
  } else {
    expect(worktree.menu.width).toBeGreaterThanOrEqual(project.menu.width);
  }
}

async function readInsetScrollGeometry(menu, longRowTestId) {
  return menu.evaluate((element, rowTestId) => {
    const viewport = element.querySelector(
      '[data-floating-menu-scroll-viewport="true"]',
    );
    const row = element.querySelector(`[data-testid="${rowTestId}"]`);
    const label = element.querySelector(`[data-testid="${rowTestId}-label"]`);
    const icon = element.querySelector(`[data-testid="${rowTestId}-icon"]`);
    if (!viewport || !row || !label || !icon) {
      throw new Error('Inset scroll geometry target missing');
    }

    const menuRect = element.getBoundingClientRect();
    const menuStyle = getComputedStyle(element);
    const viewportRect = viewport.getBoundingClientRect();
    const viewportStyle = getComputedStyle(viewport);
    const rowRect = row.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;

    return {
      menu: {
        top: menuRect.top,
        right: menuRect.right,
        bottom: menuRect.bottom,
        left: menuRect.left,
        paddingTop: Number.parseFloat(menuStyle.paddingTop),
        paddingRight: Number.parseFloat(menuStyle.paddingRight),
        paddingBottom: Number.parseFloat(menuStyle.paddingBottom),
        paddingLeft: Number.parseFloat(menuStyle.paddingLeft),
        overflowY: menuStyle.overflowY,
      },
      viewport: {
        top: viewportRect.top,
        right: viewportRect.right,
        bottom: viewportRect.bottom,
        left: viewportRect.left,
        clientRight: viewportRect.left + viewport.clientWidth,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
        scrollWidth: viewport.scrollWidth,
        scrollTop: viewport.scrollTop,
        maxScrollTop,
        borderRadius: viewportStyle.borderRadius,
        overflowX: viewportStyle.overflowX,
        overflowY: viewportStyle.overflowY,
        overscrollBehavior: viewportStyle.overscrollBehavior,
        scrollbarGutter: viewportStyle.scrollbarGutter,
        nestedScrollableCount: Array.from(
          viewport.querySelectorAll('*'),
        ).filter((candidate) => {
          const overflowY = getComputedStyle(candidate).overflowY;
          return (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            candidate.scrollHeight > candidate.clientHeight
          );
        }).length,
      },
      row: {
        top: rowRect.top,
        left: rowRect.left,
        width: rowRect.width,
        height: rowRect.height,
      },
      label: {
        left: labelRect.left,
        right: labelRect.right,
        height: labelRect.height,
        clientWidth: label.clientWidth,
        scrollWidth: label.scrollWidth,
        whiteSpace: getComputedStyle(label).whiteSpace,
      },
      iconCenterDelta: Math.abs(
        iconRect.top + iconRect.height / 2 - (rowRect.top + rowRect.height / 2),
      ),
    };
  }, longRowTestId);
}

function expectInsetScrollContainment(geometry) {
  const tolerance = 0.51;
  expect(geometry.viewport.top).toBeGreaterThanOrEqual(
    geometry.menu.top + geometry.menu.paddingTop - tolerance,
  );
  expect(geometry.viewport.right).toBeLessThanOrEqual(
    geometry.menu.right - geometry.menu.paddingRight + tolerance,
  );
  expect(geometry.viewport.bottom).toBeLessThanOrEqual(
    geometry.menu.bottom - geometry.menu.paddingBottom + tolerance,
  );
  expect(geometry.viewport.left).toBeGreaterThanOrEqual(
    geometry.menu.left + geometry.menu.paddingLeft - tolerance,
  );
  expect(geometry.viewport.borderRadius).toBe('8px');
  expect(geometry.menu.overflowY).toBe('hidden');
  expect(geometry.viewport.overflowX).toBe('hidden');
  expect(geometry.viewport.overflowY).toBe('auto');
  expect(geometry.viewport.overscrollBehavior).toBe('contain');
  expect(geometry.viewport.scrollbarGutter).toBe('auto');
  expect(geometry.viewport.nestedScrollableCount).toBe(0);
  // Overlay scrollbar anatomy: the native scrollbar is HIDDEN
  // (OverlayScrollArea), so the viewport reserves no gutter — the floating
  // thumb never participates in layout.
  expect(geometry.viewport.offsetWidth - geometry.viewport.clientWidth).toBe(0);
  expect(geometry.viewport.scrollWidth).toBeLessThanOrEqual(
    geometry.viewport.clientWidth,
  );
  expect(geometry.label.right).toBeLessThanOrEqual(
    geometry.viewport.clientRight + tolerance,
  );
}

async function readNonOverflowMenuGeometry(menu, rowTestId) {
  return menu.evaluate((element, testId) => {
    const viewport = element.querySelector(
      '[data-floating-menu-scroll-viewport="true"]',
    );
    const row = element.querySelector(`[data-testid="${testId}"]`);
    if (!viewport || !row) {
      throw new Error('Non-overflow menu geometry target missing');
    }

    const menuRect = element.getBoundingClientRect();
    const menuStyle = getComputedStyle(element);
    const viewportRect = viewport.getBoundingClientRect();
    const viewportStyle = getComputedStyle(viewport);
    const rowRect = row.getBoundingClientRect();
    return {
      menu: {
        left: menuRect.left,
        right: menuRect.right,
        paddingLeft: Number.parseFloat(menuStyle.paddingLeft),
        paddingRight: Number.parseFloat(menuStyle.paddingRight),
      },
      viewport: {
        left: viewportRect.left,
        right: viewportRect.right,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        scrollWidth: viewport.scrollWidth,
        scrollbarGutter: viewportStyle.scrollbarGutter,
      },
      row: {
        left: rowRect.left,
        right: rowRect.right,
        top: rowRect.top,
        width: rowRect.width,
        height: rowRect.height,
      },
      insets: {
        left: rowRect.left - viewportRect.left,
        right: viewportRect.right - rowRect.right,
      },
    };
  }, rowTestId);
}

function expectNonOverflowMenuSymmetry(geometry) {
  expect(geometry.viewport.scrollHeight).toBeLessThanOrEqual(
    geometry.viewport.clientHeight + 0.5,
  );
  expect(geometry.viewport.scrollbarGutter).toBe('auto');
  expect(geometry.viewport.offsetWidth - geometry.viewport.clientWidth).toBe(0);
  expect(geometry.viewport.scrollWidth).toBeLessThanOrEqual(
    geometry.viewport.clientWidth,
  );
  expect(geometry.viewport.left).toBeCloseTo(
    geometry.menu.left + geometry.menu.paddingLeft,
    1,
  );
  expect(geometry.viewport.right).toBeCloseTo(
    geometry.menu.right - geometry.menu.paddingRight,
    1,
  );
  expect(
    Math.abs(geometry.insets.left - geometry.insets.right),
  ).toBeLessThanOrEqual(0.5);
  expect(geometry.row.height).toBeCloseTo(32, MENU_ITEM_HEIGHT_PRECISION);
}

function expectNonOverflowMenuGeometryStable(actual, expected) {
  for (const key of ['left', 'right', 'top', 'width', 'height']) {
    expect(Math.abs(actual.row[key] - expected.row[key])).toBeLessThanOrEqual(
      MENU_GEOMETRY_STABILITY_TOLERANCE,
    );
  }
  for (const key of ['left', 'right']) {
    expect(
      Math.abs(actual.insets[key] - expected.insets[key]),
    ).toBeLessThanOrEqual(MENU_GEOMETRY_STABILITY_TOLERANCE);
  }
}

async function createFocusSink(electronApp) {
  return electronApp.evaluate(async ({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) throw new Error('Missing main window');

    const focusSink = new BrowserWindow({
      width: 240,
      height: 160,
      show: false,
    });
    await focusSink.loadURL('data:text/html,<title>Focus sink</title>');
    return { mainWindowId: mainWindow.id, focusSinkId: focusSink.id };
  });
}

async function focusWindow(electronApp, windowId, previousWindowId) {
  await electronApp.evaluate(
    ({ app, BrowserWindow }, ids) => {
      const target = BrowserWindow.fromId(ids.windowId);
      if (!target) throw new Error(`Missing BrowserWindow ${ids.windowId}`);
      app.focus({ steal: true });
      target.show();
      BrowserWindow.fromId(ids.previousWindowId)?.blur();
      target.focus();
    },
    { windowId, previousWindowId },
  );
}

test.describe('shared floating action menus', () => {
  test('inactive-window Home autofocus preserves a newly focused sidebar control', async () => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });
    let focusSinkId;

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expect(
        window.getByTestId('page-home').getByTestId('home-composer-editor'),
      ).toBeFocused();

      await window.getByTestId('sidebar-nav-overview').click();
      await expect(window.getByTestId('page-home')).toHaveCount(0);

      const focusWindows = await createFocusSink(electronApp);
      focusSinkId = focusWindows.focusSinkId;
      await focusWindow(
        electronApp,
        focusWindows.focusSinkId,
        focusWindows.mainWindowId,
      );
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
            focusWindows.mainWindowId,
          ),
        )
        .toBe(false);

      // Electron's offscreen renderer does not propagate the native blur to
      // the DOM. Bridge that harness-only gap, then request Home focus while
      // the native window is inactive and let a newer user focus win.
      const trigger = window.getByTestId('sidebar-more');
      await window.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', {
          configurable: true,
          value: () => false,
        });
        window.dispatchEvent(new Event('blur'));
      });
      await window.getByTestId('sidebar-create-task').evaluate((element) => {
        element.click();
      });
      await expect(window.getByTestId('page-home')).toBeVisible();
      await window.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      await trigger.focus();
      await expect(trigger).toBeFocused();

      await focusWindow(
        electronApp,
        focusWindows.mainWindowId,
        focusWindows.focusSinkId,
      );
      await window.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', {
          configurable: true,
          value: () => true,
        });
        window.dispatchEvent(new Event('focus'));
      });
      await expect(trigger).toBeFocused();

      await trigger.press('ArrowDown');
      const menu = window.getByTestId('sidebar-more-menu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
    } finally {
      if (focusSinkId != null) {
        await electronApp.evaluate(({ BrowserWindow }, id) => {
          BrowserWindow.fromId(id)?.destroy();
        }, focusSinkId);
      }
      await electronApp
        .firstWindow()
        .then((window) =>
          window.evaluate(() => Reflect.deleteProperty(document, 'hasFocus')),
        )
        .catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('More uses the canonical opaque surface over translucent chrome and supports keyboard/pointer dismissal', async ({}, testInfo) => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await expect(
        window.getByTestId('page-home').getByTestId('home-composer-editor'),
      ).toBeFocused();
      await setVisualMode(window, {
        colorMode: 'light',
        sidebarAppearance: 'translucent',
      });

      const trigger = window.getByTestId('sidebar-more');
      await window.bringToFront();
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await trigger.press('ArrowDown');

      const menu = window.getByTestId('sidebar-more-menu');
      await expect(menu).toBeVisible();
      await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
      await waitForEntryMotion(menu);
      const contract = await readMenuContract(menu);
      // More takes the action-menu rows (small text, tertiary icons).
      expectCanonicalMenuContract(contract, 32, '13px');
      expect(contract.placement).toMatch(/^bottom-(left|center|right)$/);

      // The default More menu holds no nav entries (CAN-3678, CAN-4269);
      // Customize sidebar is the entry every build shows.
      const customize = window.getByTestId('sidebar-more-item-customize');
      const shortGeometry = await readNonOverflowMenuGeometry(
        menu,
        'sidebar-more-item-customize',
      );
      expectNonOverflowMenuSymmetry(shortGeometry);
      await customize.hover();
      expectNonOverflowMenuGeometryStable(
        await readNonOverflowMenuGeometry(menu, 'sidebar-more-item-customize'),
        shortGeometry,
      );
      await customize.focus();
      expectNonOverflowMenuGeometryStable(
        await readNonOverflowMenuGeometry(menu, 'sidebar-more-item-customize'),
        shortGeometry,
      );

      await window.screenshot({
        path: testInfo.outputPath('more-light-translucent-symmetric-focus.png'),
      });

      await window.keyboard.press('End');
      await expect(
        window.getByTestId('sidebar-more-item-customize'),
      ).toBeFocused();
      await window.keyboard.press('Home');
      await expect(menu.locator('[role="menuitem"]').first()).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await trigger.focus();
      await expect(trigger).toBeFocused();
      await trigger.press('ArrowDown');
      await expect(menu).toBeVisible();
      await window.keyboard.press('Tab');
      await expect(menu).toHaveCount(0);

      await trigger.click();
      await expect(menu).toBeVisible();
      const createTask = window.getByTestId('sidebar-create-task');
      // Sidebar controls are intentionally hit-test inert while a portaled
      // menu is open. Exercise the real outside press at the control's
      // coordinates instead of asking Playwright to target the inert node.
      await expect
        .poll(() =>
          createTask.evaluate((element) =>
            getComputedStyle(element).getPropertyValue('pointer-events'),
          ),
        )
        .toBe('none');
      const createTaskBox = await createTask.boundingBox();
      expect(createTaskBox).not.toBeNull();
      await window.mouse.click(
        createTaskBox.x + createTaskBox.width / 2,
        createTaskBox.y + createTaskBox.height / 2,
      );
      await expect(menu).toHaveCount(0);

      const accountTrigger = window.getByTestId('sidebar-account-row');
      await accountTrigger.click();
      const accountMenu = window.getByTestId('sidebar-account-menu');
      await expect(accountMenu).toBeVisible();
      await waitForEntryMotion(accountMenu);
      const accountContract = await readMenuContract(accountMenu);
      // Quiet action-menu rows, like the worktree menu's.
      expectCanonicalMenuContract(accountContract, 32, '13px');
      expect(accountContract.placement).toMatch(/^top-(left|center|right)$/);
      const accountLabels = await accountMenu
        .locator('[role="menuitem"]')
        .allTextContents();
      const trimmedAccountLabels = accountLabels.map((label) => label.trim());
      expect(trimmedAccountLabels).toEqual(
        expect.arrayContaining(['Usage', 'Sign in']),
      );
      // Settings and Send feedback live only on the rail (CAN-4056).
      expect(
        trimmedAccountLabels.filter((label) =>
          /settings|feedback/i.test(label),
        ),
      ).toEqual([]);
      for (const item of ['settings', 'feedback']) {
        await expect(
          window.getByTestId(`sidebar-account-menu-item-${item}`),
        ).toHaveCount(0);
      }
      await expect(
        window.getByTestId('sidebar-account-action-settings'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-action-feedback'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(accountMenu).toHaveCount(0);
      await expect(accountTrigger).toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Composer Plus resolves collisions, reopens cleanly, and stays motionless', async ({}, testInfo) => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: [DEMO_APP_ID],
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await setVisualMode(window, {
        colorMode: 'dark',
        sidebarAppearance: 'opaque',
      });

      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();
      const trigger = home.getByTestId('home-composer-plus-button');
      const menu = window.getByTestId('home-composer-plus-menu');

      await trigger.click();
      await expect(menu).toBeVisible();
      await waitForEntryMotion(menu);
      const defaultContract = await readMenuContract(menu);
      expectCanonicalMenuContract(
        defaultContract,
        32,
        '13px',
        4,
        false,
        '20px',
      );
      expect(defaultContract.placement).toBe('bottom-left');

      await window.screenshot({
        path: testInfo.outputPath('plus-dark-opaque.png'),
      });

      // Trigger dismissal synchronously unmounts the portal. A second click
      // creates a fresh, already-positioned node without entry motion.
      await menu.evaluate((element) => {
        element.setAttribute('data-test-open-instance', 'first');
      });
      await trigger.click();
      await expect(menu).toHaveCount(0);
      await trigger.click();
      await expect(menu).toBeVisible();
      await expect(menu).not.toHaveAttribute(
        'data-test-open-instance',
        'first',
      );
      await expect(menu).toHaveAttribute('data-positioned', 'true');
      expect(
        await menu.evaluate(
          (element) =>
            element
              .getAnimations()
              .filter((animation) => animation.effect?.target === element)
              .length,
        ),
      ).toBe(0);
      await trigger.click();
      await expect(menu).toHaveCount(0);

      // Place the real trigger at the top-right viewport edge. The home
      // composer deliberately disables flipping, so collision handling shifts
      // the menu into view while preserving its requested bottom-left origin.
      await trigger.evaluate((button) => {
        Object.assign(button.style, {
          position: 'fixed',
          top: '8px',
          right: '8px',
          left: 'auto',
          zIndex: '90',
        });
      });
      await trigger.click();
      await expect(menu).toHaveAttribute('data-placement', 'bottom-left');
      await waitForEntryMotion(menu);
      const flippedContract = await readMenuContract(menu);
      expectCanonicalMenuContract(
        flippedContract,
        32,
        '13px',
        4,
        false,
        '20px',
      );
      expect(flippedContract.placement).toBe('bottom-left');
      await window.screenshot({
        path: testInfo.outputPath('plus-collision-flip-dark.png'),
      });
      await trigger.click();

      await window.emulateMedia({ reducedMotion: 'reduce' });
      await trigger.click();
      await expect(menu).toHaveAttribute('data-positioned', 'true');
      expect(
        await menu.evaluate((element) => ({
          animationName: getComputedStyle(element).animationName,
          entryAnimations: element
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.target === element &&
                animation.animationName === 'floating-menu-enter',
            ).length,
        })),
      ).toEqual({ animationName: 'none', entryAnimations: 0 });
      await trigger.click();
      await expect(menu).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test.describe('reported worktree action menus', () => {
  test('tab add, overflow, layout, and launcher menus share geometry, truncation, collision, and focus behavior', async ({}, testInfo) => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree({
      viewportSize: null,
    });

    try {
      await window.evaluate(async () => {
        await window.api.savePreferences({
          theme: 'unstoppable',
          colorMode: 'light',
          sidebarAppearance: 'translucent',
        });
        document.documentElement.setAttribute('data-theme', 'unstoppable');
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute(
          'data-sidebar-appearance',
          'translucent',
        );
      });
      await window.emulateMedia({
        colorScheme: 'light',
        reducedMotion: 'no-preference',
      });
      await expect
        .poll(() =>
          electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
        )
        .toBe('light');

      // The tab `+` catalog keeps a fixed 32px row under constrained width
      // and height. Its native scrollbar lives in one clipped inner viewport:
      // the canonical surface padding insets it from every rounded edge, while
      // the overflow-aware native gutter truncates labels before the track.
      // The catalog menu moved to the Add panel button (`+` is a direct New
      // Chat now).
      const addTrigger = window.getByTestId(
        `panel-add-panel-${DEFAULT_GROUP_IDS.chat}`,
      );
      await addTrigger.click();
      const addMenu = window.getByTestId('panel-add-menu');
      await expect(addMenu).toBeVisible();
      await waitForEntryMotion(addMenu);
      expectCanonicalMenuContract(await readMenuContract(addMenu), 32, '13px');
      await addMenu.evaluate((element) => {
        element.style.width = '168px';
        element.style.maxHeight = '180px';
      });
      const addScrollViewport = addMenu.locator(
        '[data-floating-menu-scroll-viewport="true"]',
      );
      await expect(addScrollViewport).toHaveCount(1);
      const longRow = window.getByTestId(
        'panel-add-menu-item-activity-card-background-processes',
      );
      const longLabel = window.getByTestId(
        'panel-add-menu-item-activity-card-background-processes-label',
      );
      const longIcon = window.getByTestId(
        'panel-add-menu-item-activity-card-background-processes-icon',
      );

      const longRowTestId =
        'panel-add-menu-item-activity-card-background-processes';

      // Native overflow resolution drops the gutter as soon as filtering
      // makes the catalog short, then restores it with the full catalog. No
      // component measurement state or observer frame is involved.
      await addScrollViewport.evaluate((viewport) => {
        // OverlayScrollArea interposes a content wrapper inside the viewport,
        // so the menu rows are ITS children — iterating the viewport's
        // single-child list would hide nothing.
        const rows =
          viewport.querySelector('[data-overlay-scroll-content]') ?? viewport;
        Array.from(rows.children).forEach((child, index) => {
          child.setAttribute('data-test-original-display', child.style.display);
          if (index >= 2) child.style.display = 'none';
        });
      });
      // Order-agnostic: measure against whatever row leads the catalog (the
      // menu excludes `chat` now, so the old new-chat row is gone).
      const leadRowTestId = await addScrollViewport
        .locator('[data-testid^="panel-add-menu-item-"]')
        .first()
        .getAttribute('data-testid');
      await expect
        .poll(() => readNonOverflowMenuGeometry(addMenu, leadRowTestId))
        .toMatchObject({
          viewport: {
            scrollbarGutter: 'auto',
          },
        });
      const filteredGeometry = await readNonOverflowMenuGeometry(
        addMenu,
        leadRowTestId,
      );
      expectNonOverflowMenuSymmetry(filteredGeometry);

      await addScrollViewport.evaluate((viewport) => {
        const rows =
          viewport.querySelector('[data-overlay-scroll-content]') ?? viewport;
        Array.from(rows.children).forEach((child) => {
          child.style.display =
            child.getAttribute('data-test-original-display') ?? '';
          child.removeAttribute('data-test-original-display');
        });
      });
      await expect
        .poll(() =>
          addScrollViewport.evaluate(
            (viewport) => viewport.scrollHeight - viewport.clientHeight,
          ),
        )
        .toBeGreaterThan(0);

      const scrollPositions = [0, 0.5, 1];
      for (const ratio of scrollPositions) {
        await addScrollViewport.evaluate((viewport, nextRatio) => {
          viewport.scrollTop =
            (viewport.scrollHeight - viewport.clientHeight) * nextRatio;
        }, ratio);
        const geometry = await readInsetScrollGeometry(addMenu, longRowTestId);
        expectInsetScrollContainment(geometry);
        expect(geometry.viewport.maxScrollTop).toBeGreaterThan(0);
        expect(
          Math.abs(
            geometry.viewport.scrollTop -
              geometry.viewport.maxScrollTop * ratio,
          ),
        ).toBeLessThanOrEqual(1);
      }

      await addScrollViewport.evaluate((viewport) => {
        viewport.scrollTop = 0;
      });
      await addScrollViewport.hover();
      await window.mouse.wheel(0, 160);
      await expect
        .poll(() =>
          addScrollViewport.evaluate((viewport) => viewport.scrollTop),
        )
        .toBeGreaterThan(0);

      // Keep the pointer outside while positioning the row. Otherwise the
      // content can scroll a nested-menu trigger under the stationary pointer
      // and open a flyout that changes the geometry under test.
      await window.mouse.move(700, 500);
      await longRow.evaluate((row) => {
        const viewport = row.closest(
          '[data-floating-menu-scroll-viewport="true"]',
        );
        if (!(viewport instanceof HTMLElement)) {
          throw new Error('Expected floating-menu scroll viewport');
        }
        const rowRect = row.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        viewport.scrollTop +=
          rowRect.top -
          viewportRect.top -
          (viewport.clientHeight - rowRect.height) / 2;
      });
      const readLongRowGeometry = () =>
        readInsetScrollGeometry(addMenu, longRowTestId);
      // Confirm the instant setup scroll put the row fully inside the clipped
      // viewport before recording the geometry that hover/focus must retain.
      await expect
        .poll(async () => {
          const geometry = await readLongRowGeometry();
          return (
            geometry.row.top >= geometry.viewport.top - 0.51 &&
            geometry.row.top + geometry.row.height <=
              geometry.viewport.bottom + 0.51
          );
        })
        .toBe(true);
      const longGeometry = await readLongRowGeometry();
      expect(longGeometry.row.height).toBeCloseTo(32, 2);
      expect(longGeometry.label.whiteSpace).toBe('nowrap');
      expect(longGeometry.label.scrollWidth).toBeGreaterThan(
        longGeometry.label.clientWidth,
      );
      expect(longGeometry.iconCenterDelta).toBeLessThanOrEqual(0.5);
      expectInsetScrollContainment(longGeometry);

      // A locator hover performs its own actionability scroll, which would
      // mutate the geometry this assertion is specifically meant to preserve.
      await window.mouse.move(
        longGeometry.row.left + longGeometry.row.width / 2,
        longGeometry.row.top + longGeometry.row.height / 2,
      );
      expect(await readLongRowGeometry()).toMatchObject({
        row: longGeometry.row,
        label: {
          left: longGeometry.label.left,
          right: longGeometry.label.right,
          height: longGeometry.label.height,
        },
      });
      await longRow.evaluate((row) => row.focus({ preventScroll: true }));
      expect(await readLongRowGeometry()).toMatchObject({
        row: longGeometry.row,
        label: {
          left: longGeometry.label.left,
          right: longGeometry.label.right,
          height: longGeometry.label.height,
        },
      });
      await window.keyboard.press('End');
      const lastAddItem = addMenu.locator('[role="menuitem"]').last();
      await expect(lastAddItem).toBeFocused();
      const keyboardScrollGeometry = await readLongRowGeometry();
      // Inclusive half-pixel tolerance: the chrome rows are fractional
      // (46.5px), so a keyboard scroll to the last item can land exactly
      // 0.5px short of maxScrollTop — `toBeCloseTo(x, 0)` requires < 0.5 and
      // fails on that boundary.
      expect(
        Math.abs(
          keyboardScrollGeometry.viewport.scrollTop -
            keyboardScrollGeometry.viewport.maxScrollTop,
        ),
      ).toBeLessThanOrEqual(0.5);
      const [lastItemBox, scrollViewportBox] = await Promise.all([
        lastAddItem.boundingBox(),
        addScrollViewport.boundingBox(),
      ]);
      expect(lastItemBox).not.toBeNull();
      expect(scrollViewportBox).not.toBeNull();
      expect(lastItemBox.y + lastItemBox.height).toBeLessThanOrEqual(
        scrollViewportBox.y + scrollViewportBox.height + 0.51,
      );

      // The same clipped geometry survives theme token changes and a
      // representative scaled UI. Restore the deterministic review profile
      // immediately afterward for the remaining menu checks.
      await window.keyboard.press('Escape');
      await expect(addMenu).toHaveCount(0);
      await expect(addTrigger).toBeFocused();
      await electronApp.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark';
      });
      await window.emulateMedia({ colorScheme: 'dark' });
      await window.evaluate(() => {
        document.documentElement.classList.add('dark');
      });
      await setUiScale(window, 125);
      await addTrigger.click();
      await expect(addMenu).toBeVisible();
      await addMenu.evaluate((element) => {
        element.style.width = '210px';
        element.style.maxHeight = '225px';
      });
      const scaledDarkGeometry = await readInsetScrollGeometry(
        addMenu,
        longRowTestId,
      );
      expectInsetScrollContainment(scaledDarkGeometry);
      await window.screenshot({
        path: testInfo.outputPath(
          'tab-add-scrollbar-contained-dark-scale-125.png',
        ),
      });
      await window.keyboard.press('Escape');
      await electronApp.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light';
      });
      await window.emulateMedia({ colorScheme: 'light' });
      await window.evaluate(() => {
        document.documentElement.classList.remove('dark');
      });
      await setUiScale(window, 100);

      // The project launcher filters disabled applications through the live
      // preferences API, keeps app artwork in the common rail, and exposes
      // safe Copy path / Settings actions.
      const openTrigger = window.getByTestId('worktree-open-trigger');
      await openTrigger.click();
      const openMenu = window.getByTestId('worktree-open-menu');
      await expect(openMenu).toBeVisible();
      await waitForEntryMotion(openMenu);
      expectCanonicalMenuContract(await readMenuContract(openMenu), 32, '13px');
      const [expectedAppIds, renderedAppIds] = await Promise.all([
        window.evaluate(async () => {
          const [apps, preferences] = await Promise.all([
            window.api.detectApps(),
            window.api.loadPreferences(),
          ]);
          return apps
            .filter((app) => !preferences.disabledOpenApps.includes(app.id))
            .map((app) => app.id);
        }),
        openMenu
          .locator('[data-testid^="worktree-open-app-"]')
          .evaluateAll((rows) =>
            rows.map((row) =>
              row.getAttribute('data-testid').replace('worktree-open-app-', ''),
            ),
          ),
      ]);
      expect(renderedAppIds).toEqual(expectedAppIds);
      const launcherRailGeometry = await openMenu.evaluate((element) =>
        Array.from(element.querySelectorAll('[role="menuitem"]')).map((row) => {
          const icon = row.firstElementChild?.getBoundingClientRect();
          // The label is no longer reliably the LAST child: app rows end
          // with the selected-app checkmark slot, while Copy path/Settings
          // rows end with the label — find it by its truncation classes.
          const labelElement =
            row.querySelector('.truncate') ?? row.lastElementChild;
          const label = labelElement?.getBoundingClientRect();
          return {
            height: row.getBoundingClientRect().height,
            iconWidth: icon?.width,
            labelLeft: label?.left,
            whiteSpace: labelElement
              ? getComputedStyle(labelElement).whiteSpace
              : null,
          };
        }),
      );
      expect(launcherRailGeometry.every((row) => row.height === 32)).toBe(true);
      expect(launcherRailGeometry.every((row) => row.iconWidth === 16)).toBe(
        true,
      );
      expect(
        Math.max(...launcherRailGeometry.map((row) => row.labelLeft)) -
          Math.min(...launcherRailGeometry.map((row) => row.labelLeft)),
      ).toBeLessThanOrEqual(0.5);
      expect(
        launcherRailGeometry.every((row) => row.whiteSpace === 'nowrap'),
      ).toBe(true);

      await openMenu.getByTestId('worktree-open-settings').focus();
      await window.keyboard.press('Escape');
      await expect(openMenu).toHaveCount(0);
      await expect(openTrigger).toBeFocused();
      await openTrigger.click();
      await window.getByTestId('worktree-open-copy-path').click();
      await expect(openMenu).toHaveCount(0);
      await expect
        .poll(() =>
          electronApp.evaluate(({ clipboard }) => clipboard.readText()),
        )
        .not.toBe('');
      await expect(openTrigger).toBeFocused();
      await openTrigger.click();
      const outsideTarget = window.getByTestId('sidebar-create-task');
      await expect(outsideTarget).toHaveCSS('pointer-events', 'none');
      const outsideTargetBox = await outsideTarget.boundingBox();
      if (!outsideTargetBox) {
        throw new Error('Expected sidebar outside target to have a box');
      }
      await window.mouse.click(
        outsideTargetBox.x + outsideTargetBox.width / 2,
        outsideTargetBox.y + outsideTargetBox.height / 2,
      );
      await expect(openMenu).toHaveCount(0);
      await expect
        .poll(() =>
          window.evaluate(() => document.body.dataset.sidebarMenuOpen ?? null),
        )
        .toBeNull();

      // The layout menu starts with the approved thumbnail choices rather
      // than action rows, and exposes the Advanced-only save action below.
      const saveTrigger = window.getByTestId(
        'worktree-top-save-layout-default',
      );
      await saveTrigger.click();
      const saveMenu = window.getByTestId('save-layout-default-menu');
      await expect(saveMenu).toBeVisible();
      await waitForEntryMotion(saveMenu, 76);
      const saveContract = await readMenuContract(saveMenu);
      expectCanonicalMenuContract(saveContract, 76, '13px');
      expect(
        await saveMenu.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      ).toBe(256);
      await window.keyboard.press('Escape');
      await expect(saveMenu).toHaveCount(0);
      await expect(saveTrigger).toBeFocused();
      await saveTrigger.click();
      await window.getByTestId('save-layout-default-item').click();
      await expect(saveMenu).toHaveCount(0);
      await expect
        .poll(() =>
          existsSync(path.join(userDataDir, 'default-panel-layout.json')),
        )
        .toBe(true);
      await expect(saveTrigger).toBeFocused();

      // The tab overflow menu uses the same semantic hover/focus state (Split
      // commands are not selected), skips dividers, flips at the lower edge,
      // and dispatches the existing split command before returning focus.
      const overflowTrigger = window.getByTestId(
        `panel-group-menu-${DEFAULT_GROUP_IDS.chat}`,
      );
      await overflowTrigger.evaluate((button) => {
        Object.assign(button.style, {
          position: 'fixed',
          right: '8px',
          bottom: '8px',
          top: 'auto',
          zIndex: '90',
        });
      });
      await overflowTrigger.click();
      const overflowMenu = window.getByTestId(
        `panel-group-actions-menu-${DEFAULT_GROUP_IDS.chat}`,
      );
      await expect(overflowMenu).toBeVisible();
      await waitForEntryMotion(overflowMenu);
      const overflowContract = await readMenuContract(overflowMenu);
      expectCanonicalMenuContract(overflowContract, 32, '13px');
      expect(overflowContract.placement).toMatch(/^top-/);
      const splitUp = window.getByTestId(
        `panel-group-split-${DEFAULT_GROUP_IDS.chat}-up`,
      );
      await expect(splitUp).not.toHaveAttribute('aria-selected');
      await expect(splitUp).not.toHaveAttribute('aria-checked');
      const splitGeometry = await splitUp.boundingBox();
      await splitUp.hover();
      expect(await splitUp.boundingBox()).toEqual(splitGeometry);
      await splitUp.focus();
      expect(await splitUp.boundingBox()).toEqual(splitGeometry);
      await window.keyboard.press('End');
      await expect(
        window.getByTestId(`panel-group-close-${DEFAULT_GROUP_IDS.chat}`),
      ).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(overflowMenu).toHaveCount(0);
      await expect(overflowTrigger).toBeFocused();

      await overflowTrigger.click();
      await window.mouse.click(
        outsideTargetBox.x + outsideTargetBox.width / 2,
        outsideTargetBox.y + outsideTargetBox.height / 2,
      );
      await expect(overflowMenu).toHaveCount(0);

      const leavesBeforeSplit = await countLeaves(window);
      await overflowTrigger.click();
      await window
        .getByTestId(`panel-group-split-${DEFAULT_GROUP_IDS.chat}-up`)
        .click();
      await expect(overflowMenu).toHaveCount(0);
      await expect.poll(() => countLeaves(window)).toBe(leavesBeforeSplit + 1);
      await expect(overflowTrigger).toBeFocused();
      await overflowTrigger.evaluate((button) =>
        button.removeAttribute('style'),
      );

      await window.screenshot({
        path: testInfo.outputPath(
          'reported-worktree-menus-light-unstoppable-translucent.png',
        ),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

test.describe('shared floating selectors', () => {
  test('project, branch, and model pickers share the deterministic visual and keyboard contract', async ({}, testInfo) => {
    const { electronApp, userDataDir } = await launchCanopy({
      seedDemoWorkspaces: true,
      // Two projects, because the default cowork project is deliberately not
      // offered as a picker row (CAN-2363). One listed row cannot overflow
      // the shrunk list this test needs to exercise the scrollbar contract.
      demoWorkspaceApps: [DEMO_APP_ID, 'ts-npm-next'],
      viewportSize: null,
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await window.evaluate(async () => {
        await window.api.savePreferences({
          theme: 'unstoppable',
          colorMode: 'light',
          sidebarAppearance: 'translucent',
        });
        document.documentElement.setAttribute('data-theme', 'unstoppable');
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute(
          'data-sidebar-appearance',
          'translucent',
        );
      });
      await window.emulateMedia({
        colorScheme: 'light',
        reducedMotion: 'no-preference',
      });
      await expect
        .poll(() =>
          window.evaluate(() => ({
            theme: document.documentElement.getAttribute('data-theme'),
            dark: document.documentElement.classList.contains('dark'),
            sidebar: document.documentElement.getAttribute(
              'data-sidebar-appearance',
            ),
          })),
        )
        .toEqual({
          theme: 'unstoppable',
          dark: false,
          sidebar: 'translucent',
        });
      await expect
        .poll(() =>
          electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
        )
        .toBe('light');

      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      await expect(home).toBeVisible();

      const workspaceTrigger = home.getByTestId('home-workspace-select');
      const workspaceMenu = window.getByTestId('home-workspace-popover');
      await workspaceTrigger.focus();
      await window.keyboard.press('ArrowDown');
      await expect(workspaceMenu).toBeVisible();
      await expect(window.getByTestId('home-workspace-search')).toBeFocused();
      await waitForEntryMotion(workspaceMenu);
      expectCanonicalMenuContract(await readMenuContract(workspaceMenu));
      await expect(workspaceMenu).toHaveAttribute('role', 'dialog');
      const projectPickerAnatomy = await readPickerAnatomy(workspaceMenu);

      const [workspaceMenuBox, workspaceTriggerBox, workspacePlacement] =
        await Promise.all([
          workspaceMenu.boundingBox(),
          workspaceTrigger.boundingBox(),
          workspaceMenu.getAttribute('data-placement'),
        ]);
      expect(workspaceMenuBox).not.toBeNull();
      expect(workspaceTriggerBox).not.toBeNull();
      expect(workspaceMenuBox.width).toBeGreaterThanOrEqual(
        workspaceTriggerBox.width - 0.5,
      );
      const pickerGap = workspacePlacement?.startsWith('top-')
        ? workspaceTriggerBox.y - (workspaceMenuBox.y + workspaceMenuBox.height)
        : workspaceMenuBox.y -
          (workspaceTriggerBox.y + workspaceTriggerBox.height);
      expect(pickerGap).toBeCloseTo(8, 1);

      // A short picker must not reserve a phantom scrollbar gutter. When the
      // same owner viewport becomes constrained, native overflow must reserve
      // and contain the gutter without introducing horizontal overflow.
      expect(projectPickerAnatomy.list.scrollHeight).toBeLessThanOrEqual(
        projectPickerAnatomy.list.clientHeight + 0.5,
      );
      const workspaceList = workspaceMenu.locator('.canopy-picker-menu-list');
      await workspaceList.evaluate((list) => {
        list.style.height = '40px';
        list.style.flex = '0 0 40px';
      });
      await expect
        .poll(async () => {
          const anatomy = await readPickerAnatomy(workspaceMenu);
          return anatomy.list.scrollHeight > anatomy.list.clientHeight;
        })
        .toBe(true);
      const overflowingProjectAnatomy = await readPickerAnatomy(workspaceMenu);
      expect(
        // Overlay anatomy: the picker list's native scrollbar is hidden, so
        // it reserves NO layout gutter.
        overflowingProjectAnatomy.list.offsetWidth -
          overflowingProjectAnatomy.list.clientWidth,
      ).toBe(0);
      expect(overflowingProjectAnatomy.list.scrollWidth).toBeLessThanOrEqual(
        overflowingProjectAnatomy.list.clientWidth,
      );
      for (const row of overflowingProjectAnatomy.rows) {
        // Only the selected row mounts a check now — the rail is free for a
        // status icon otherwise — so skip the rows that have none.
        if (row.checkRight === undefined) continue;
        expect(row.checkRight).toBeLessThanOrEqual(
          overflowingProjectAnatomy.list.clientRight + 0.5,
        );
      }
      await workspaceList.evaluate((list) => {
        list.scrollTop = list.scrollHeight;
      });
      expect(await workspaceList.evaluate((list) => list.scrollTop)).toBe(
        overflowingProjectAnatomy.list.scrollHeight -
          overflowingProjectAnatomy.list.clientHeight,
      );
      await workspaceList.evaluate((list) => {
        list.removeAttribute('style');
      });

      await window.keyboard.press('Escape');
      await expect(workspaceMenu).toHaveCount(0);
      await expect(workspaceTrigger).toBeFocused();

      // Move the real trigger to the top-right edge. The shared collision
      // layer must flip/shift first, then animate from the resolved attachment.
      await workspaceTrigger.evaluate((button) => {
        button.style.setProperty('position', 'fixed', 'important');
        button.style.setProperty('top', '8px', 'important');
        button.style.setProperty('right', '8px', 'important');
        button.style.setProperty('left', 'auto', 'important');
        button.style.setProperty('width', '180px', 'important');
        button.style.setProperty('z-index', '90', 'important');
        // The selector overhang is its own stacking context (z-10) beneath the
        // composer box (z-20) — the tuck that slides its bottom edge under the
        // composer. In place that never overlaps, but relocating the trigger
        // over the composer traps the button's own z-index inside that layer,
        // so lift the overhang for the duration of this collision check.
        const overhang = button.closest(
          '[data-testid="home-composer-context-overhang"]',
        );
        overhang?.style.setProperty('z-index', '90', 'important');
      });
      await workspaceTrigger.click();
      // Which bottom attachment the layer resolves to depends on how far the
      // menu overhangs its trigger — the project picker's 18.5rem minimum is
      // wider than this 180px trigger, so it centers rather than left-aligns.
      // The contract under test is the flip/shift itself plus the viewport
      // containment and transform-origin assertions below.
      await expect(workspaceMenu).toHaveAttribute(
        'data-placement',
        /^bottom-(left|center)$/,
      );
      await waitForEntryMotion(workspaceMenu);
      const collisionContract = await readMenuContract(workspaceMenu);
      expectCanonicalMenuContract(collisionContract);
      expect(collisionContract.transformOriginDelta.x).toBeLessThanOrEqual(0.5);
      const shiftedMenuBox = await workspaceMenu.boundingBox();
      const viewportWidth = await window.evaluate(() => window.innerWidth);
      expect(shiftedMenuBox).not.toBeNull();
      expect(shiftedMenuBox.x).toBeGreaterThanOrEqual(8);
      expect(
        viewportWidth - (shiftedMenuBox.x + shiftedMenuBox.width),
      ).toBeGreaterThanOrEqual(8);
      await window.screenshot({
        path: testInfo.outputPath(
          'selectors-light-unstoppable-translucent.png',
        ),
      });
      await window.keyboard.press('Escape');
      await workspaceTrigger.evaluate((button) =>
        button.removeAttribute('style'),
      );

      const branchTrigger = home.getByTestId('home-branch-picker-button');
      await branchTrigger.click();
      const branchMenu = window.getByTestId('home-branch-picker-menu');
      await expect(branchMenu).toBeVisible();
      await expect(
        window.getByTestId('home-branch-picker-search'),
      ).toBeFocused();
      await waitForEntryMotion(branchMenu);
      expectCanonicalMenuContract(await readMenuContract(branchMenu));
      await expect(branchMenu.getByRole('option').first()).toHaveClass(/h-8/);
      const selectedWorktreeOption = branchMenu.locator(
        '[role="option"][aria-selected="true"]',
      );
      const selectedWorktreeBackground = await selectedWorktreeOption.evaluate(
        (option) => getComputedStyle(option).backgroundColor,
      );
      expect(selectedWorktreeBackground).toBe('rgba(0, 0, 0, 0)');
      await selectedWorktreeOption.hover();
      await expect
        .poll(() =>
          selectedWorktreeOption.evaluate(
            (option) => getComputedStyle(option).backgroundColor,
          ),
        )
        .not.toBe(selectedWorktreeBackground);
      const branchTriggerBox = await branchTrigger.boundingBox();
      const branchMenuBox = await branchMenu.boundingBox();
      expect(branchTriggerBox).not.toBeNull();
      expect(branchMenuBox).not.toBeNull();
      expect(branchMenuBox.width).toBeGreaterThanOrEqual(
        branchTriggerBox.width - 0.5,
      );
      const branchPlacement = await branchMenu.getAttribute('data-placement');
      const branchGap = branchPlacement?.startsWith('top-')
        ? branchTriggerBox.y - (branchMenuBox.y + branchMenuBox.height)
        : branchMenuBox.y - (branchTriggerBox.y + branchTriggerBox.height);
      expect(branchGap).toBeCloseTo(8, 1);
      expect(branchGap).toBeCloseTo(pickerGap, 1);
      const worktreePickerAnatomy = await readPickerAnatomy(branchMenu);
      expectMatchingPickerAnatomy(projectPickerAnatomy, worktreePickerAnatomy);
      const worktreesTab = window.getByTestId('home-branch-picker-tab-new');
      const prsTab = window.getByTestId('home-branch-picker-tab-prs');
      await worktreesTab.focus();
      await window.keyboard.press('ArrowRight');
      await expect(prsTab).toBeFocused();
      await expect(prsTab).toHaveAttribute('aria-selected', 'true');
      await expect(prsTab).toHaveAttribute('tabindex', '0');
      await expect(worktreesTab).toHaveAttribute('tabindex', '-1');
      await window.keyboard.press('ArrowLeft');
      await expect(worktreesTab).toBeFocused();
      await expect(worktreesTab).toHaveAttribute('aria-selected', 'true');
      await expect(worktreesTab).toHaveAttribute('tabindex', '0');
      await window.screenshot({
        path: testInfo.outputPath(
          'worktree-selector-light-unstoppable-translucent.png',
        ),
      });
      const branchSearch = window.getByTestId('home-branch-picker-search');
      await branchSearch.focus();
      await branchSearch.fill('no-such-worktree');
      await expect(
        window.getByTestId('home-branch-picker-empty'),
      ).toBeVisible();
      await branchSearch.fill('');
      await expect(
        window.getByTestId('home-branch-picker-new-worktree'),
      ).toBeVisible();

      // The same rail/row/scroll geometry must survive a dark, scaled,
      // constrained viewport without wrapping or horizontal overflow.
      await window.keyboard.press('Escape');
      await expect(branchMenu).toHaveCount(0);
      await window.evaluate(() => {
        document.documentElement.classList.add('dark');
      });
      await setUiScale(window, 125);
      await window.emulateMedia({ colorScheme: 'dark' });
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(360, 700);
      });
      await workspaceTrigger.click();
      await expect(workspaceMenu).toBeVisible();
      await workspaceMenu.evaluate(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 300);
          }),
      );
      const constrainedProjectAnatomy = await readPickerAnatomy(workspaceMenu);
      await window.keyboard.press('Escape');
      await expect(workspaceMenu).toHaveCount(0);
      await branchTrigger.click();
      await expect(branchMenu).toBeVisible();
      await branchMenu.evaluate(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 300);
          }),
      );
      const constrainedAnatomy = await readPickerAnatomy(branchMenu);
      expectMatchingPickerAnatomy(
        constrainedProjectAnatomy,
        constrainedAnatomy,
        { canonicalPixels: false },
      );
      const constrainedViewportWidth = await window.evaluate(
        () => window.innerWidth,
      );
      expect(constrainedAnatomy.menu.width).toBeLessThanOrEqual(
        constrainedViewportWidth - 16 + 0.5,
      );
      await window.screenshot({
        path: testInfo.outputPath(
          'project-worktree-picker-parity-dark-scale-125-constrained.png',
        ),
      });
      await window.keyboard.press('Enter');
      await expect(branchMenu).toHaveCount(0);
      await expect(branchTrigger).toBeFocused();
      await window.evaluate(() => {
        document.documentElement.classList.remove('dark');
      });
      await setUiScale(window, 100);
      await window.emulateMedia({
        colorScheme: 'light',
        reducedMotion: 'no-preference',
      });
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1200, 800);
      });

      const modelTrigger = home.getByTestId('chat-model-picker');
      await modelTrigger.focus();
      await window.keyboard.press('ArrowDown');
      const modelMenu = window.getByTestId('chat-model-menu');
      await expect(modelMenu).toBeVisible();
      // The Home composer's harness picker opens on its search field.
      await expect(modelMenu.getByTestId('chat-model-search')).toBeFocused();
      await modelMenu.getByTestId('chat-model-harness-tab-claude').click();
      const visibleModelRow =
        '[role="menuitemradio"][data-model-id]:not([hidden])';
      await waitForEntryMotion(modelMenu, 32, visibleModelRow);
      expectCanonicalMenuContract(
        await readMenuContract(modelMenu, visibleModelRow),
        32,
      );
      const modelLabelGeometry = await modelMenu.evaluate((element) => {
        const groupLabels = Array.from(
          element.querySelectorAll('[data-testid^="chat-model-group-label-"]'),
        ).filter((label) => label.checkVisibility());
        const selectedLabel = element
          .querySelector(
            '[role="menuitemradio"][data-model-id]:not([hidden])[aria-checked="true"]',
          )
          ?.querySelector('[data-testid^="chat-model-option-label-"]');
        const unselectedLabel = element
          .querySelector(
            '[role="menuitemradio"][data-model-id]:not([hidden])[aria-checked="false"]',
          )
          ?.querySelector('[data-testid^="chat-model-option-label-"]');
        const labels = [...groupLabels, selectedLabel, unselectedLabel];
        return {
          menuWidth: element.getBoundingClientRect().width,
          starts: labels.map(
            (label) => label?.getBoundingClientRect().left ?? null,
          ),
        };
      });
      // Harness navigation shares the wider picker with the model list;
      // model labels still align within that list.
      expect(modelLabelGeometry.menuWidth).toBeCloseTo(304, 1);
      expect(modelLabelGeometry.starts).not.toContain(null);
      expect(
        Math.max(...modelLabelGeometry.starts) -
          Math.min(...modelLabelGeometry.starts),
      ).toBeLessThanOrEqual(0.5);
      await window.keyboard.press('Escape');
      await expect(modelMenu).toHaveCount(0);
      await expect(home.getByTestId('home-composer-editor')).toBeFocused();

      await window.emulateMedia({ reducedMotion: 'reduce' });
      await modelTrigger.click();
      await expect(modelMenu).toHaveAttribute('data-positioned', 'true');
      expect(
        await modelMenu.evaluate((element) => ({
          animationName: getComputedStyle(element).animationName,
          entryAnimations: element
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.target === element &&
                animation.animationName === 'floating-menu-enter',
            ).length,
        })),
      ).toEqual({ animationName: 'none', entryAnimations: 0 });
      await modelTrigger.click();
      await expect(modelMenu).toHaveCount(0);

      await window.emulateMedia({
        colorScheme: 'light',
        reducedMotion: 'no-preference',
      });
      // Project visibility moved out of its own "…" beside the
      // Projects header's overflow menu and into that one menu, so the
      // checkbox rows must hold the action-menu contract they inherited from
      // the picker they replaced: a reserved selection rail, rows that keep
      // the menu open, and focus that returns to the trigger.
      await window.getByTestId('sidebar-section-code-toggle').hover();
      await expect(window.getByTestId('worktree-filter-trigger')).toHaveCount(
        0,
      );
      const projectsMoreTrigger = window.getByTestId(
        'sidebar-section-code-more',
      );
      await projectsMoreTrigger.click();
      const projectsMenu = window.getByTestId('sidebar-section-code-menu');
      await expect(projectsMenu).toBeVisible();
      await waitForEntryMotion(projectsMenu);
      expectCanonicalMenuContract(await readMenuContract(projectsMenu));
      // One menu, both jobs: ordering radios and visibility checkboxes.
      await expect(
        projectsMenu.locator('[role="menuitemradio"]'),
      ).not.toHaveCount(0);
      const firstProjectOption = projectsMenu
        .locator('[role="menuitemcheckbox"]')
        .first();
      await expect(firstProjectOption).toHaveAttribute('aria-checked', 'true');
      const projectRailGeometry = await firstProjectOption.evaluate(
        (option) => {
          const rect = (selector) =>
            option.querySelector(selector)?.getBoundingClientRect();
          const check = rect('[data-testid^="sidebar-projects-show-check-"]');
          const icon = rect('[data-testid^="sidebar-projects-show-icon-"]');
          const label = rect('[data-testid^="sidebar-projects-show-label-"]');
          const counter = rect('[data-testid^="sidebar-projects-show-count-"]');
          if (!check || !icon || !label || !counter) {
            throw new Error('Project visibility rail geometry missing');
          }
          return {
            row: option.getBoundingClientRect().toJSON(),
            check: check.toJSON(),
            icon: icon.toJSON(),
            label: label.toJSON(),
            counter: counter.toJSON(),
          };
        },
      );
      expect(projectRailGeometry.check.left).toBeLessThan(
        projectRailGeometry.icon.left,
      );
      expect(projectRailGeometry.icon.left).toBeLessThan(
        projectRailGeometry.label.left,
      );
      expect(projectRailGeometry.label.left).toBeLessThan(
        projectRailGeometry.counter.left,
      );
      expect(projectRailGeometry.counter.right).toBeLessThanOrEqual(
        projectRailGeometry.row.right - 8 + 0.5,
      );
      const projectLabelStart = projectRailGeometry.label.left;
      await firstProjectOption.click();
      // Multi-select: hiding a project leaves the menu open and the label
      // stays on the reserved rail rather than sliding where the check was.
      await expect(projectsMenu).toBeVisible();
      await expect(firstProjectOption).toHaveAttribute('aria-checked', 'false');
      expect(
        await firstProjectOption
          .locator('[data-testid^="sidebar-projects-show-label-"]')
          .evaluate((label) => label.getBoundingClientRect().left),
      ).toBeCloseTo(projectLabelStart, 2);
      // The header control advertises the active filter without a hover.
      await expect(
        window.getByTestId('sidebar-section-code-more-active-dot'),
      ).toBeVisible();
      await firstProjectOption.click();
      await expect(firstProjectOption).toHaveAttribute('aria-checked', 'true');
      await window.keyboard.press('Escape');
      await expect(projectsMenu).toHaveCount(0);
      await expect(projectsMoreTrigger).toBeFocused();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
