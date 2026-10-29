// @capture-keep: reproduction harness for sidebar occlusion defects (CAN-3126)
// @capture-reference: docs/sidebar-scroll-playground.md
// Color modes: defaults to DARK, because the defect is judged in dark mode.
/**
 * Sidebar scroll PLAYGROUND — sweeps the project list past the sticky band and
 * captures every scroll offset where a row is cut, so occlusion defects can be
 * SEEN rather than inferred from a passing assertion.
 *
 * This exists because CAN-3126 was "fixed" three times against fixtures that
 * did not resemble the real app. The conditions below are the ones that matter
 * and that the ordinary specs did not reproduce:
 *
 *   - DARK mode. Every report of this defect is a dark-mode screenshot, and a
 *     hairline of leftover glyph is invisible on light grey and obvious on
 *     near-black.
 *   - TRANSLUCENT sidebar (the default). This is what leaves the sticky band
 *     with no opaque surface, which is the entire reason the occlusion clip
 *     exists. An opaque sidebar cannot show the defect at all.
 *   - Nav items pushed into More, so the band is the short sticky stack the
 *     real rail settles into rather than a tall column of nav rows.
 *   - Chats collapsed, so Projects sits directly under the band.
 *
 * Output in `.playwright/sidebar-scroll-playground/`:
 *   report.md         — every offset where a row is cut, with the frames
 *   cut-<n>.png       — the sidebar at each offending offset
 *   sweep-<n>.png     — a contact sheet across the whole scroll range
 *   geometry.json     — clip line and per-row rects at every sampled offset
 *
 * A clean run writes "no cut rows" and captures the sweep only. Any cut frame
 * is the defect, reproduced.
 *
 *   pnpm run test:electron:captures:built sidebar-scroll-playground.capture-spec.ts --reporter=line --dark-mode
 */
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/seedChatsSectionFixture.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const outDir = path.join(repoRoot, '.playwright', 'sidebar-scroll-playground');

test('sweep the project list past the sticky band', async () => {
  test.setTimeout(300_000);
  mkdirSync(outDir, { recursive: true });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-playground-'));
  // One project with a long worktree list, so a project header sits over its
  // OWN rows for most of the scroll range. The four-project fixture barely
  // exercises that: each project is one row tall, so a header is past its
  // rows almost immediately, and the overlap Sergii reported (a pinned
  // project header painted on top of a row) never comes up.
  const longProject = process.env.PLAYGROUND_FIXTURE === 'long';
  const manyProjects = process.env.PLAYGROUND_FIXTURE === 'many';
  if (longProject) {
    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 50,
      chatEntryCount: 30,
    });
  }
  const { electronApp } = await launchCanopy({
    userDataDir,
    // The harness owns demo seeding (fixtures dir, env wiring). Seeding by
    // hand instead produced a data dir the app could not load at all — an
    // empty rail behind a permanent "Loading…".
    seedDemoWorkspaces: !longProject,
    // `PLAYGROUND_FIXTURE=many` seeds a rail that is mostly COLLAPSED PROJECT
    // HEADERS. Four projects with one of them expanded never puts two headers
    // next to each other for long, and the handoff between a pinned header and
    // the one arriving behind it is exactly where they can print over one
    // another — the state the overlap was reported in.
    demoWorkspaceApps: manyProjects
      ? [
          'ts-pnpm-vite',
          'ts-npm-next',
          'ts-bun-api',
          'go-cli',
          'ts-yarn-cli',
          'ts-npm-nest-monorepo',
          'python-fastapi-uv',
          'python-fastapi-venv',
          'rust-tauri-lite',
        ]
      : ['ts-pnpm-vite', 'ts-npm-next', 'ts-bun-api', 'go-cli'],
    // Short enough that the seeded projects overflow the rail. A window that
    // fits everything has a zero scroll range and this harness then sweeps
    // nothing at all while still reporting "no cut rows" — the exact false
    // negative that let three bad fixes through.
    // The four-project fixture needs a short window to overflow at all. The
    // long-project fixture overflows by itself, and a short window there
    // leaves the band filling most of the rail — roughly one and a half rows
    // of list, which is not the rail anyone is looking at.
    viewportSize: { width: 900, height: longProject ? 900 : 420 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Reproduce the reported environment rather than the harness defaults.
    await window.evaluate(async (navExpanded: boolean) => {
      const prefs = await window.api.loadPreferences();
      await window.api.savePreferences({
        colorMode: 'dark',
        sidebarAppearance: 'translucent',
        sidebarNavLayout: {
          order: prefs.sidebarNavLayout.order,
          moreStartIndex: navExpanded ? prefs.sidebarNavLayout.order.length : 0,
        },
      });
    }, process.env.PLAYGROUND_NAV === 'expanded');
    if (process.env.PLAYGROUND_RAIL === 'shared') {
      await window.evaluate(
        (k: string) => window.localStorage.setItem(k, '1'),
        'canopy.desktop.sharedSidebar',
      );
    }
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });

    const sidebar = window.getByTestId('app-sidebar');
    const viewport = window.getByTestId('sidebar-scroll-container');
    // The shared rail hydrates its project list after the shell is up, so
    // `waitForShell` alone leaves an empty rail and a zero scroll range.
    await window
      .locator('[data-testid="worktree-row"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });

    // PROVE the environment before sweeping it. Setting `colorMode: 'dark'`
    // and getting light mode anyway is not hypothetical — it is what made
    // every earlier capture a washed grey rail while the reports were all
    // near-black, and a sliced glyph is invisible on grey. A harness that
    // silently sweeps the wrong environment is worse than no harness.
    const env = await window.evaluate(() => {
      const root = document.documentElement;
      const rail = document.querySelector('[data-testid="app-sidebar"]');
      const material = document.querySelector('.app-window-material') ?? rail;
      return {
        darkClass: root.classList.contains('dark'),
        appearance: root.getAttribute('data-sidebar-appearance'),
        platform: root.getAttribute('data-platform'),
        materialBg: material
          ? getComputedStyle(material).backgroundColor
          : null,
      };
    });
    if (!env.darkClass) {
      throw new Error(
        `Playground is not in dark mode: ${JSON.stringify(env)}. A sliced glyph is invisible on a light rail, so sweeping one proves nothing.`,
      );
    }
    // On COLOUR, so nobody re-learns this the hard way: with
    // `sidebarAppearance: 'translucent'` (the default, and what the reports
    // use) the rail paints macOS vibrancy. Headless Electron has no vibrancy
    // to composite and falls back to flat grey, while the real app shows
    // near-black. The CSS, the clip, the geometry and the defect are
    // identical — only the material is not. Judge the CUT here, not the shade.

    // Select a worktree. The selected-row pin band only exists while something
    // is selected, and it makes the band deeper — the reported rail always has
    // a selection, so a sweep without one measures a shallower band than the
    // one users actually see.
    if (!manyProjects) {
      await window.locator('[data-testid="worktree-row"]').first().click();
      await window.waitForTimeout(800);
    }

    // Chats collapsed puts Projects directly beneath the band. EXPANDED is a
    // different rail: the Projects header travels a long way before it seats,
    // and a projected copy of the first project can be drawn above its own
    // "Projects" label on the way. Sweep both.
    const chatsExpanded = process.env.PLAYGROUND_CHATS === 'expanded';
    const chatsToggle = window.getByTestId('sidebar-section-chats-toggle');
    if ((await chatsToggle.count()) > 0) {
      const isExpanded =
        (await chatsToggle.getAttribute('aria-expanded')) === 'true';
      if (isExpanded !== chatsExpanded) {
        await chatsToggle.click();
        await window.waitForTimeout(250);
      }
    }

    const range = await viewport.evaluate(
      (el: HTMLElement) => el.scrollHeight - el.clientHeight,
    );
    // Fail loudly rather than sweep nothing.
    if (range < 40) {
      throw new Error(
        `Sidebar scroll range is ${range}px — the fixture does not overflow the rail, so this harness would report "no cut rows" without having looked at anything. Seed more projects or shorten the window.`,
      );
    }
    const STEP = 4;
    /**
     * One sampled scroll offset. Typed rather than `unknown[]` so the verdict
     * below reads the fields it actually reports instead of asserting them
     * back into existence at each use.
     */
    interface GeometrySample {
      viewportStyle: string;
      requested: number;
      scrollTop: number;
      clipTop: number | null;
      bandBottom: number;
      orphans: string[];
      overlaps: string[];
      aboveLabel: string[];
      headerOverlaps: string[];
      dimmedClear: string[];
      diag: {
        markedIds: string[];
        markedFlow: { top: number; h: number }[];
        headerTop: number;
        extHeader: number;
        pinHeight: number;
        pinClip: number;
        flowTop: number;
        rowFade: string[];
        slotState: {
          slotHidden: boolean | null;
          activeWorkspaceId: string | null;
          rows: string[];
          flowHidden: string[];
        };
        slotVar: string;
        slotHidden: boolean | null;
        slotRect: { top: number; bottom: number } | null;
        lineFlow: number | null;
        orphanFlow: { id: string; top: number; h: number }[];
      };
      marked: number;
      deadGap: number;
      visibleRows: number;
      rows: {
        id: string | null;
        top: number;
        bottom: number;
        opacity: string;
        cut: boolean;
      }[];
    }
    const geometry: GeometrySample[] = [];
    const cutFrames: { offset: number; rows: string[] }[] = [];
    const deadFrames: { offset: number; gap: number; detail: string }[] = [];

    for (let offset = 0; offset <= range; offset += STEP) {
      const sample = await viewport.evaluate(
        async (el: HTMLElement, target: number) => {
          el.scrollTop = target;
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
          await new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          );
          const flow = el.querySelector('.sidebar-workspaces-rows-clip');
          if (!flow) return null;
          // With no clip there is no inset to parse. Returning null here skipped
          // every sample and the report then said "0 offsets" — a clean bill of
          // health from a sweep that looked at nothing. Fall back to the band's
          // own bottom edge, which is the line rows must not cross visibly.
          const m =
            getComputedStyle(flow).clipPath.match(/^inset\(([-\d.]+)px/);
          const clipTop = m
            ? flow.getBoundingClientRect().top + Number(m[1])
            : null;
          const rows: {
            id: string | null;
            top: number;
            bottom: number;
            opacity: string;
            cut: boolean;
          }[] = [];
          for (const row of flow.querySelectorAll<HTMLElement>(
            '[data-worktree-id]',
          )) {
            const rowStyle = getComputedStyle(row);
            const r = row.getBoundingClientRect();
            if (r.height < 0.5) continue;
            // The ROW's own opacity, deliberately not folded together with
            // the fade on its contents. This value feeds the dead-space
            // metric, which asks whether a slab of rail is showing nothing
            // where a row should be — a geometric question. A row part-way
            // through its dissolve is not nothing, and counting it as empty
            // reported the whole fade zone as dead space. `opacity: 0` on the
            // row itself means something different: a pinned copy is standing
            // in for it, so the row really is not there.
            rows.push({
              id: row.dataset.worktreeId ?? null,
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              opacity: rowStyle.opacity,
              // Cut: the line passes through a PAINTED row with real content on
              // both sides. 2px of tolerance keeps sub-pixel grazes out.
              cut: false, // set below, once the occlusion line is known
            });
          }
          // THE measurement, and the one this harness was missing.
          //
          // "Is a row sliced?" only catches a clip line landing mid-row. It says
          // nothing about rows being hidden WHOLESALE, so a change that clipped
          // away 380px of the list scored as an improvement while the real app
          // showed a vast empty band. Every failed attempt at this defect was a
          // different way of trading a sliced row for dead space, and none of
          // them registered.
          //
          // Dead space is the gap between the lowest thing the band actually
          // paints and the top of the first row that survives. It should be
          // nothing. A sliced row scores ~0 here (the row is right there), a
          // hidden row scores one row height, and a clip that eats the list
          // scores hundreds.
          let bandBottom = 0;
          for (const selector of [
            '[data-testid="sidebar-more-sticky-container"]',
            '[data-sidebar-projects-header]',
            '[data-sidebar-selected-pin-top]',
            '[data-sidebar-sticky-workspace-slot]',
          ]) {
            const node = el.querySelector<HTMLElement>(selector);
            if (!node || node.hidden) continue;
            const r = node.getBoundingClientRect();
            if (r.height < 0.5) continue;
            if (r.bottom > bandBottom) bandBottom = r.bottom;
          }
          // Project HEADERS paint too. Measuring to the first surviving row
          // alone reports a fat fake gap whenever the clip line happens to land
          // between two projects, because the next row sits below a header the
          // metric pretended was not there.
          const flowPainted: { top: number; bottom: number }[] = rows
            .filter((r) => r.opacity !== '0')
            .map((r) => ({ top: r.top, bottom: r.bottom }));
          for (const header of flow.querySelectorAll<HTMLElement>(
            '.sidebar-workspace-sticky-header',
          )) {
            if (getComputedStyle(header).opacity === '0') continue;
            const r = header.getBoundingClientRect();
            if (r.height < 0.5) continue;
            flowPainted.push({ top: r.top, bottom: r.bottom });
          }
          const line = clipTop ?? bandBottom;
          // THE defect, stated exactly: a row whose branch name is readable
          // while its title is not. Every other metric here is a proxy — "row
          // crosses the line" is normal for any sticky header once the band
          // paints, and chasing it sent four fixes in the wrong direction. This
          // one is the thing in the screenshots.
          const orphans: string[] = [];
          for (const row of flow.querySelectorAll<HTMLElement>(
            '[data-worktree-id]',
          )) {
            const cs = getComputedStyle(row);
            if (cs.opacity === '0' || cs.visibility === 'hidden') continue;
            const title = row.querySelector<HTMLElement>(
              '[data-testid$="worktree-row-title"], [data-testid="worktree-row-title"]',
            );
            const subtitle = row.querySelector<HTMLElement>(
              '[data-testid$="worktree-row-subtitle"], [data-testid="worktree-row-subtitle"]',
            );
            if (!title || !subtitle) continue;
            // The row fades as a unit before it goes under the band, and that
            // fade is on its contents. A row already faded out cannot orphan
            // anything, and counting it would report the defect where the
            // screen shows nothing at all.
            const titleOpacity = Number.parseFloat(
              getComputedStyle(title).opacity,
            );
            const subtitleOpacity = Number.parseFloat(
              getComputedStyle(subtitle).opacity,
            );
            if (subtitleOpacity < 0.1) continue;
            // A rect survives `visibility: hidden`, so the text's own computed
            // visibility has to be read — otherwise suppressing the straddling
            // row's text scores identically to not suppressing it.
            if (getComputedStyle(subtitle).visibility === 'hidden') continue;
            const t = title.getBoundingClientRect();
            const sub = subtitle.getBoundingClientRect();
            if (t.height < 0.5 || sub.height < 0.5) continue;
            // Rows FADE into the band over a ramp now rather than ending at a
            // line, so "readable" is an opacity, not a position. Measuring
            // position alone would report every frame where a row happens to
            // span the ramp, including the ones that look exactly like the
            // Chats list scrolling under its own header.
            const rampPx =
              Number.parseFloat(
                getComputedStyle(flow)
                  .getPropertyValue('--sidebar-workspaces-occlusion-ramp')
                  .trim(),
              ) || 12;
            const paintedAt = (y: number): number =>
              Math.max(0, Math.min(1, (y - line) / rampPx));
            // Fully swallowed title, fully painted branch name — the pairing
            // that reads as a rendering fault. The ramp is wider than the gap
            // between the two, so this should not be reachable at all.
            const titleHidden = paintedAt(t.bottom) * titleOpacity <= 0.1;
            const subtitleVisible = paintedAt(sub.top) * subtitleOpacity >= 0.9;
            if (subtitleVisible && titleHidden) {
              orphans.push(
                `${row.dataset.worktreeId} title ${Math.round(t.top)}-${Math.round(t.bottom)} subtitle ${Math.round(sub.top)}-${Math.round(sub.bottom)} line ${Math.round(line)}`,
              );
            }
          }
          for (const r of rows) {
            const painted = r.opacity !== '0';
            r.cut = painted && r.top < line - 2 && r.bottom > line + 2;
          }
          // A row DIMMED WHILE IT IS NOWHERE NEAR THE BAND. The fade exists to
          // carry a row under the band's bottom edge; a row sitting entirely
          // below that edge has nothing to fade for, and dimming it reads as
          // a shadow rendered for no reason — including at rest, before the
          // band is sticky at all.
          const dimmedClear: string[] = [];
          for (const row of flow.querySelectorAll<HTMLElement>(
            '[data-worktree-id]',
          )) {
            if (getComputedStyle(row).opacity === '0') continue;
            const r = row.getBoundingClientRect();
            if (r.height < 0.5) continue;
            if (r.top < bandBottom + 1) continue;
            const child = row.firstElementChild;
            if (!child) continue;
            const painted = Number.parseFloat(getComputedStyle(child).opacity);
            if (painted < 0.95) {
              dimmedClear.push(
                `${row.dataset.worktreeId} at ${Math.round(r.top)} is ${painted.toFixed(2)} opaque, band ends ${Math.round(bandBottom)}`,
              );
            }
          }
          // A project HEADER SLICED by the clip while still crisp.
          //
          // This is what "the headers overlap" actually is. A 32px header cut
          // part-way down prints the lower half of its glyphs immediately
          // beneath the pinned header above it, and the two names read as one
          // on top of the other. Comparing header rectangles finds nothing —
          // they do not intersect, they abut — so the thing to measure is the
          // same one CAN-3126 needed: is readable text being cut rather than
          // faded?
          const headerOverlaps: string[] = [];
          for (const header of flow.querySelectorAll<HTMLElement>(
            '.sidebar-workspace-sticky-header',
          )) {
            const cs = getComputedStyle(header);
            if (cs.opacity === '0' || cs.visibility === 'hidden') continue;
            const r = header.getBoundingClientRect();
            if (r.height < 0.5) continue;
            const contents = header.firstElementChild;
            if (!contents) continue;
            // Measure the CONTENTS, not the box. A cut through the header's
            // padding removes nothing anyone can see; a cut through its text
            // is the defect. Flagging the box called every padding graze a
            // slice and could never reach zero.
            const c = contents.getBoundingClientRect();
            if (c.height < 0.5) continue;
            if (!(c.top < line - 1 && c.bottom > line + 1)) continue;
            const painted = Number.parseFloat(
              getComputedStyle(contents).opacity,
            );
            if (painted <= 0.1) continue;
            headerOverlaps.push(
              `${header.closest<HTMLElement>('[data-sidebar-workspace-id]')?.dataset.sidebarWorkspaceId ?? '?'} text cut at ${Math.round(line)} (${Math.round(c.top)}-${Math.round(c.bottom)}) still ${painted.toFixed(2)} opaque`,
            );
          }
          // A projected project header drawn ABOVE its own "Projects" label.
          // The label is the top of the Projects section; nothing belonging to
          // that section may be painted above it, and a pinned copy that is
          // reads as the first project jumping up out of the list.
          const projectsLabel = el.querySelector<HTMLElement>(
            '[data-sidebar-projects-header], [data-testid="sidebar-section-code"] .sidebar-sticky-header',
          );
          const aboveLabel: string[] = [];
          // A missing label would make this metric pass for free, which is the
          // false negative this harness exists to avoid.
          if (!projectsLabel) {
            aboveLabel.push('NO PROJECTS LABEL FOUND — metric cannot run');
          }
          if (projectsLabel) {
            const labelRect = projectsLabel.getBoundingClientRect();
            if (labelRect.height >= 0.5) {
              for (const projected of el.querySelectorAll<HTMLElement>(
                '[data-sidebar-sticky-slot-workspace-id]:not([hidden]), [data-sidebar-selected-pin-top]',
              )) {
                if (getComputedStyle(projected).opacity === '0') continue;
                const r = projected.getBoundingClientRect();
                if (r.height < 0.5) continue;
                if (r.top < labelRect.top - 0.5) {
                  aboveLabel.push(
                    `projected header at ${Math.round(r.top)} sits above the Projects label at ${Math.round(labelRect.top)}`,
                  );
                }
              }
            }
          }
          // A row PAINTING INSIDE THE BAND. The clip removes everything above
          // the line, so a row's visible top is the lower of its own top and
          // that line; anything of it still above the band's bottom edge is
          // drawn over the pinned project header, which is the overlap in the
          // report. Rects survive clipping, so the visible top has to be
          // derived rather than read.
          const overlaps: string[] = [];
          for (const row of flow.querySelectorAll<HTMLElement>(
            '[data-worktree-id]',
          )) {
            if (getComputedStyle(row).opacity === '0') continue;
            const r = row.getBoundingClientRect();
            if (r.height < 0.5) continue;
            const visibleTop = Math.max(r.top, line);
            if (visibleTop < bandBottom - 0.5 && r.bottom > visibleTop + 0.5) {
              overlaps.push(
                `${row.dataset.worktreeId} paints ${Math.round(visibleTop)}-${Math.round(Math.min(r.bottom, bandBottom))} inside a band ending ${Math.round(bandBottom)}`,
              );
            }
          }
          const survivors = flowPainted
            .filter((r) => r.bottom > line + 2)
            .sort((a, b) => a.top - b.top);
          const firstSurvivor = survivors[0];
          const deadGap =
            bandBottom > 0 && firstSurvivor
              ? Math.round(Math.max(firstSurvivor.top, line) - bandBottom)
              : 0;
          // Diagnostics for the marking arithmetic. The marker lands on the
          // wrong row on one rail and not the other, and adjusting the formula
          // by inspection has now failed twice. Report the frames the JS is
          // actually working in, so the delta is read rather than guessed.
          const viewportTop = el.getBoundingClientRect().top;
          const flowOf = (node: HTMLElement): { top: number; h: number } => ({
            top: Math.round(
              node.getBoundingClientRect().top - viewportTop + el.scrollTop,
            ),
            h: Math.round(node.getBoundingClientRect().height),
          });
          const markedEls = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-sidebar-occluded-row]',
            ),
          );
          const cs = getComputedStyle(el);
          const px = (name: string): number =>
            Number.parseFloat(cs.getPropertyValue(name)) || 0;
          const diag = {
            markedIds: markedEls.map((n) => n.dataset.worktreeId ?? '?'),
            markedFlow: markedEls.map((n) => flowOf(n)),
            // What the renderer's own arithmetic produces.
            headerTop: px('--sidebar-workspace-header-top'),
            extHeader: px('--sidebar-external-projects-header-height'),
            pinHeight: px('--sidebar-selected-pin-top-height'),
            pinClip: px('--sidebar-selected-pin-top-clip'),
            flowTop: px('--sidebar-workspaces-flow-top'),
            clipStart: px('--sidebar-workspaces-clip-start'),
            clipDistance: px('--sidebar-workspaces-clip-distance'),
            viewportTop: Math.round(viewportTop),
            rowFade: (() => {
              const out: string[] = [];
              for (const row of Array.from(
                flow.querySelectorAll<HTMLElement>('[data-worktree-id]'),
              ).slice(0, 4)) {
                const child = row.firstElementChild;
                out.push(
                  `${row.dataset.worktreeId}:${child ? getComputedStyle(child).opacity : 'none'}/tl:${getComputedStyle(row).getPropertyValue('view-timeline-name') || '?'}`,
                );
              }
              return out;
            })(),
            slotState: (() => {
              const slot = el.querySelector<HTMLElement>(
                '[data-testid="sidebar-sticky-workspace-slot"]',
              );
              const rows = Array.from(
                el.querySelectorAll<HTMLElement>(
                  '[data-sidebar-sticky-slot-workspace-id]',
                ),
              ).map(
                (r) =>
                  `${r.dataset.sidebarStickySlotWorkspaceId}:${r.hidden ? 'hidden' : 'SHOWN'}`,
              );
              const flowHidden = Array.from(
                el.querySelectorAll<HTMLElement>('[data-sidebar-workspace-id]'),
              ).map(
                (w) =>
                  `${w.dataset.sidebarWorkspaceId}:${w.querySelector('.sidebar-workspace-sticky-header')?.getAttribute('data-sidebar-sticky-flow-hidden') ?? 'painted'}`,
              );
              return {
                slotHidden: slot?.hidden ?? null,
                activeWorkspaceId: slot?.dataset.activeWorkspaceId ?? null,
                rows,
                flowHidden,
              };
            })(),
            slotVar: cs
              .getPropertyValue('--sidebar-workspaces-slot-height')
              .trim(),
            slotHidden:
              el.querySelector<HTMLElement>(
                '[data-testid="sidebar-sticky-workspace-slot"]',
              )?.hidden ?? null,
            slotRect: (() => {
              const n = el.querySelector<HTMLElement>(
                '[data-testid="sidebar-sticky-workspace-slot"]',
              );
              if (!n) return null;
              const r = n.getBoundingClientRect();
              return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
            })(),
            // The line the harness measured, expressed in the same flow frame
            // the marking arithmetic uses. This is the number the formula has
            // to reproduce.
            lineFlow:
              line === null
                ? null
                : Math.round(line - viewportTop + el.scrollTop),
            orphanFlow: orphans.map((o) => {
              const id = o.split(' ')[0];
              const node = flow.querySelector<HTMLElement>(
                `[data-worktree-id="${id}"]`,
              );
              return node ? { id, ...flowOf(node) } : { id, top: -1, h: -1 };
            }),
          };
          return {
            // The viewport's inline style, sampled per frame. Custom
            // properties written here inherit into the ENTIRE rail, so every
            // change invalidates style for the Chats list too. Counting how
            // many frames change it is the closest this harness gets to
            // measuring why scrolling struggles.
            viewportStyle: el.getAttribute('style') ?? '',
            scrollTop: Math.round(el.scrollTop),
            clipTop: clipTop === null ? null : Math.round(clipTop),
            bandBottom: Math.round(bandBottom),
            orphans,
            overlaps,
            aboveLabel,
            headerOverlaps,
            dimmedClear,
            diag,
            marked: document.querySelectorAll('[data-sidebar-occluded-row]')
              .length,
            deadGap,
            visibleRows: survivors.length,
            rows,
          };
        },
        offset,
      );
      if (!sample) continue;
      geometry.push({ requested: offset, ...sample });
      // 12px of slack covers the designed inter-group spacing; beyond that a
      // visible slab of sidebar is showing nothing.
      if (sample.deadGap > 12) {
        deadFrames.push({
          offset: sample.scrollTop,
          gap: sample.deadGap,
          detail: `band ends ${sample.bandBottom}, first row ${Math.round(sample.bandBottom + sample.deadGap)}, ${sample.visibleRows} rows visible`,
        });
        if (deadFrames.length <= 8) {
          await sidebar.screenshot({
            path: path.join(
              outDir,
              `dead-${String(sample.scrollTop).padStart(5, '0')}.png`,
            ),
          });
        }
      }
      const cut = sample.rows.filter((r: { cut: boolean }) => r.cut);
      if (cut.length > 0) {
        cutFrames.push({
          offset: sample.scrollTop,
          rows: cut.map(
            (r: { id: string | null; top: number; bottom: number }) =>
              `${r.id} top=${r.top} bottom=${r.bottom} clip=${sample.clipTop}`,
          ),
        });
        if (cutFrames.length <= 12) {
          await sidebar.screenshot({
            path: path.join(
              outDir,
              `cut-${String(sample.scrollTop).padStart(5, '0')}.png`,
            ),
          });
        }
      }
    }

    // Contact sheet across the whole range regardless of outcome.
    const sheetStep = Math.max(STEP, Math.round(range / 8 / STEP) * STEP);
    for (let offset = 0; offset <= range; offset += sheetStep) {
      await viewport.evaluate(async (el: HTMLElement, target: number) => {
        el.scrollTop = target;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
      }, offset);
      await sidebar.screenshot({
        path: path.join(outDir, `sweep-${String(offset).padStart(5, '0')}.png`),
      });
    }

    writeFileSync(
      path.join(outDir, 'geometry.json'),
      JSON.stringify(geometry, null, 2),
    );
    if (geometry.length === 0) {
      throw new Error(
        'Swept the whole scroll range and sampled nothing. A report built from zero samples reads as a clean result while proving the opposite.',
      );
    }
    const orphanFrames = geometry.filter((g) => g.orphans.length > 0);
    const overlapFrames = geometry.filter((g) => g.overlaps.length > 0);
    const aboveLabelFrames = geometry.filter((g) => g.aboveLabel.length > 0);
    const dimmedFrames = geometry.filter((g) => g.dimmedClear.length > 0);
    const headerOverlapFrames = geometry.filter(
      (g) => g.headerOverlaps.length > 0,
    );
    const styleChurn = geometry.filter(
      (g, i) => i > 0 && g.viewportStyle !== geometry[i - 1].viewportStyle,
    ).length;
    const worstGap = deadFrames.reduce((m, f) => Math.max(m, f.gap), 0);
    const lines = [
      '# Sidebar scroll playground',
      '',
      `Scroll range: 0–${range}px, sampled every ${STEP}px (${geometry.length} offsets).`,
      'Dark mode, translucent sidebar, nav in More, Chats collapsed.',
      '',
      '## Verdict',
      '',
      `- **ORPHANED SUBTITLES:** ${orphanFrames.length} offsets`,
      ...orphanFrames
        .slice(0, 8)
        .flatMap((g) => [
          `  - scrollTop ${g.scrollTop}: ${g.orphans[0]}`,
          `    diag ${JSON.stringify(g.diag)}`,
        ]),
      `- **VIEWPORT STYLE REWRITTEN:** ${styleChurn} of ${geometry.length} frames (each one restyles the whole rail)`,
      `- **PROJECT HEADERS SLICED BY THE CLIP:** ${headerOverlapFrames.length} offsets`,
      ...headerOverlapFrames
        .slice(0, 5)
        .map((g) => `  - scrollTop ${g.scrollTop}: ${g.headerOverlaps[0]}`),
      `- **ROWS DIMMED CLEAR OF THE BAND:** ${dimmedFrames.length} offsets`,
      ...dimmedFrames
        .slice(0, 5)
        .map((g) => `  - scrollTop ${g.scrollTop}: ${g.dimmedClear[0]}`),
      `- **PROJECT HEADER ABOVE ITS OWN LABEL:** ${aboveLabelFrames.length} offsets`,
      ...aboveLabelFrames
        .slice(0, 5)
        .map((g) => `  - scrollTop ${g.scrollTop}: ${g.aboveLabel[0]}`),
      `- **ROWS PAINTING INSIDE THE BAND:** ${overlapFrames.length} offsets`,
      ...overlapFrames
        .slice(0, 5)
        .map((g) => `  - scrollTop ${g.scrollTop}: ${g.overlaps[0]}`),
      `- **Dead space:** worst ${worstGap}px across ${deadFrames.length} offsets`,
      `- **Cut rows:** ${cutFrames.length} offsets`,
      '',
      'Dead space is the gap between the lowest thing the band paints and the',
      'first row that survives the clip. It is the measurement that matters:',
      'a sliced row scores near zero (the row is still there), while hiding a',
      'row scores a row height and over-clipping scores hundreds. Judging only',
      'cut rows scored a change that ate 380px of the list as an improvement.',
      '',
      deadFrames.length === 0 ? '## No dead space' : '## Dead space',
      '',
      ...deadFrames
        .slice(0, 8)
        .flatMap((f) => [
          `### scrollTop ${f.offset} — ${f.gap}px`,
          `- ${f.detail}`,
          `![](dead-${String(f.offset).padStart(5, '0')}.png)`,
          '',
        ]),
      cutFrames.length === 0 ? '## No cut rows' : '## Cut rows',
      '',
      ...cutFrames
        .slice(0, 8)
        .flatMap((f) => [
          `### scrollTop ${f.offset}`,
          ...f.rows.map((r) => `- ${r}`),
          `![](cut-${String(f.offset).padStart(5, '0')}.png)`,
          '',
        ]),
    ];
    writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
    // Deliberately no assertion: this is a reproduction harness, and a run
    // that finds the defect must still produce its artifacts.
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
