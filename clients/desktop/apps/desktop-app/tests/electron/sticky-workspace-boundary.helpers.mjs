// Shared deterministic setup/geometry for the normal regression and captures.
export async function prepareWorkspaceBoundary(window, app, collapsed) {
  await app.waitForShell();
  const codeId = await window.evaluate(async (collapsed) => {
    const loaded = await window.api.loadProjects();
    const projects = loaded.items;
    const cowork = projects.find((item) => item.id === 'cowork-default');
    const code = projects.find((item) => item.type !== 'cowork');
    if (!cowork || !code) throw new Error('Expected Cowork and Code fixtures');
    const ordered = [
      cowork,
      code,
      ...projects.filter((item) => item !== cowork && item !== code),
    ];
    await window.api.saveProjects(
      ordered.map((item, order) => ({
        ...item,
        order,
        ...(item === cowork ? { collapsed } : {}),
      })),
      { replaceWorkspaceOrder: true },
    );
    const prefs = await window.api.loadPreferences();
    await window.api.savePreferences({
      sidebarNavLayout: {
        order: prefs.sidebarNavLayout.order,
        moreStartIndex: 0,
      },
    });
    return code.id;
  }, collapsed);
  await window.reload();
  await app.waitForShell();
  await window
    .locator(`[data-testid="worktree-row"][data-project-id="${codeId}"]`)
    .first()
    .click();
  await window.mouse.move(700, 300);
  await window
    .getByTestId('sidebar-scroll-container')
    .evaluate(async (element) => {
      let previous = element.scrollTop;
      let since = performance.now();
      const deadline = since + 5000;
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (element.scrollTop !== previous) since = performance.now();
        previous = element.scrollTop;
        if (performance.now() - since >= 1000) return;
      }
      throw new Error('Sidebar selection scroll did not settle');
    });
  return codeId;
}

export async function sampleWorkspaceBoundary(viewport, codeId, distance) {
  return viewport.evaluate(
    async (element, { codeId, distance }) => {
      const header = element.querySelector(
        `[data-sidebar-workspace-id="${codeId}"] .sidebar-workspace-sticky-header`,
      );
      const controls = element.querySelector(
        '[data-testid="sidebar-more-sticky-container"]',
      );
      const line =
        element.getBoundingClientRect().top +
        Number.parseFloat(
          element.style.getPropertyValue('--sidebar-workspace-header-top'),
        );
      element.scrollTop += header.getBoundingClientRect().top - line - distance;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const slot = element.querySelector(
        '[data-sidebar-sticky-workspace-slot]',
      );
      const flow = element.querySelector('.sidebar-workspaces-rows-clip');
      const flowRect = flow.getBoundingClientRect();
      const inset = Number.parseFloat(
        getComputedStyle(flow).clipPath.match(/^inset\(([-\d.]+)px/)?.[1] ??
          'NaN',
      );
      const clipTop = flowRect.top + inset;
      const headers = [];
      for (const row of slot.querySelectorAll(
        '[data-sidebar-sticky-slot-workspace-id]:not([hidden])',
      )) {
        const rect = row.getBoundingClientRect();
        const top = Math.max(rect.top, slot.getBoundingClientRect().top);
        if (rect.bottom > top + 0.5)
          headers.push({
            source: 'slot',
            id: row.dataset.sidebarStickySlotWorkspaceId,
            top,
            bottom: rect.bottom,
          });
      }
      const topPin = element.querySelector('[data-sidebar-selected-pin-top]');
      const headerSeat =
        line +
        (topPin && !topPin.hidden ? topPin.getBoundingClientRect().height : 0);
      let upcomingHeader = null;
      if (topPin && !topPin.hidden) {
        const rect = topPin
          .querySelector('[data-sidebar-selected-pin-part="header"]')
          .getBoundingClientRect();
        headers.push({
          source: 'selected-pin',
          id: codeId,
          top: rect.top,
          bottom: rect.bottom,
        });
      }
      for (const row of element.querySelectorAll(
        '.sidebar-workspace-sticky-header',
      )) {
        const rect = row.getBoundingClientRect();
        if (!upcomingHeader && rect.top > headerSeat) {
          upcomingHeader = { top: rect.top, bottom: rect.bottom };
        }
        if (getComputedStyle(row).opacity === '0') continue;
        const top = Math.max(rect.top, clipTop);
        if (rect.bottom > top + 0.5)
          headers.push({
            source: 'flow',
            id: row.closest('[data-sidebar-workspace-id]').dataset
              .sidebarWorkspaceId,
            top,
            bottom: rect.bottom,
          });
      }
      // Rows the occlusion clip cuts THROUGH rather than hiding outright.
      // The clip line is a plain pixel offset, so nothing stops it landing
      // mid-row and leaving a stranded subtitle under the pinned header with
      // no title above it (CAN-3126). A row is either fully shown or fully
      // hidden; anything straddling the line by more than a rounding wobble
      // is the defect.
      const straddling = [];
      // `[data-worktree-id]` is the painted row surface both rails render
      // (the shared `WorktreeRow`), and the element the per-row occlusion
      // hides. Measuring the outer frame instead would report a straddle for
      // a row that paints nothing.
      for (const row of element.querySelectorAll(
        '.sidebar-workspaces-rows-clip [data-worktree-id]',
      )) {
        const style = getComputedStyle(row);
        if (style.opacity === '0' || style.visibility === 'hidden') continue;
        // A row fades out as a UNIT as it passes under the band, and that
        // fade lives on its CONTENTS — the row itself deliberately stays at
        // opacity 1, because row-level opacity is how a pinned copy hides its
        // in-flow original. Reading only the row therefore reports a straddle
        // for a row whose text is already invisible, which is the state this
        // design produces on purpose. Read what is actually painted.
        const contents = row.firstElementChild;
        const painted = contents
          ? Number.parseFloat(getComputedStyle(contents).opacity)
          : 1;
        if (painted < 0.1) continue;
        const rect = row.getBoundingClientRect();
        if (rect.height < 0.5) continue;
        if (rect.top < clipTop - 0.5 && rect.bottom > clipTop + 0.5)
          straddling.push({
            worktreeId: row.dataset.worktreeId ?? null,
            opacity: style.opacity,
            paintedOpacity: painted,
            top: rect.top,
            bottom: rect.bottom,
          });
      }
      return {
        distance,
        straddling,
        scrollTop: element.scrollTop,
        line,
        controlsBottom: controls.getBoundingClientRect().bottom,
        clipTop,
        upcomingHeader,
        headers: headers.sort((a, b) => a.top - b.top),
      };
    },
    { codeId, distance },
  );
}
