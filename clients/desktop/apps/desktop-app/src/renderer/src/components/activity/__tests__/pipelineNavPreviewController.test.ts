/**
 * @jest-environment jsdom
 *
 * The per-panel job-list preview state machine: one test per row of the
 * requirements' "Left navigation" table, plus the holds (menus, keyboard
 * focus, unknown-destination leaves) and the release of timers/observers.
 */
import {
  PIPELINE_NAV_PREVIEW_SCOPE_ATTRIBUTE,
  PIPELINE_NAV_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS,
  PipelineNavPreviewController,
} from '../details/pipelineNavPreviewController';

interface Harness {
  controller: PipelineNavPreviewController;
  trigger: HTMLDivElement;
  toggle: HTMLButtonElement;
  overlay: HTMLDivElement;
  firstItem: HTMLButtonElement;
  menuButton: HTMLButtonElement;
  content: HTMLDivElement;
  outside: HTMLButtonElement;
  expanded: () => boolean;
  focusVisible: Set<Element>;
}

function setup(initiallyExpanded = false): Harness {
  document.body.innerHTML = '';
  let expanded = initiallyExpanded;
  const focusVisible = new Set<Element>();
  const controller = new PipelineNavPreviewController({
    isExpanded: (): boolean => expanded,
    setExpanded: (next): void => {
      expanded = next;
    },
    scopeId: 'panel-1',
    isFocusVisible: (element): boolean => focusVisible.has(element),
  });
  const trigger = document.createElement('div');
  const toggle = document.createElement('button');
  trigger.append(toggle);
  const overlay = document.createElement('div');
  const firstItem = document.createElement('button');
  const menuButton = document.createElement('button');
  menuButton.setAttribute('aria-haspopup', 'true');
  menuButton.setAttribute('aria-expanded', 'false');
  overlay.append(firstItem, menuButton);
  const content = document.createElement('div');
  content.tabIndex = -1;
  const outside = document.createElement('button');
  document.body.append(trigger, overlay, content, outside);
  controller.setTriggerElement(trigger);
  controller.setToggleElement(toggle);
  controller.setOverlayElement(overlay);
  controller.setContentElement(content);
  return {
    controller,
    trigger,
    toggle,
    overlay,
    firstItem,
    menuButton,
    content,
    outside,
    expanded: () => expanded,
    focusVisible,
  };
}

describe('PipelineNavPreviewController', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('expanded; toggle click collapses (width released) without previewing', () => {
    const h = setup(true);
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(false);
    h.controller.toggleClick();
    expect(h.expanded()).toBe(false);
    expect(h.controller.previewOpen).toBe(false);
    // The pointer is still resting on the toggle: no instant re-preview.
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(false);
    // Leaving and coming back previews again.
    h.controller.pointerLeave('trigger', h.outside);
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(true);
  });

  it('collapsed; hover on the toggle previews, keyboard focus previews only when focus-visible', () => {
    const h = setup();
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(true);
    h.controller.pointerLeave('trigger', h.outside);
    expect(h.controller.previewOpen).toBe(false);

    // A mouse click focusing the toggle is not keyboard focus.
    h.controller.focusTrigger(h.toggle);
    expect(h.controller.previewOpen).toBe(false);
    h.focusVisible.add(h.toggle);
    h.controller.focusTrigger(h.toggle);
    expect(h.controller.previewOpen).toBe(true);
  });

  it('preview; selecting Summary/job/variant closes it, stays collapsed, and moves focus to content', () => {
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.firstItem);
    h.controller.pointerEnterOverlay();
    h.firstItem.focus();
    h.controller.navigate();
    expect(h.controller.previewOpen).toBe(false);
    expect(h.expanded()).toBe(false);
    expect(document.activeElement).toBe(h.content);
  });

  it('preview; selecting with focus elsewhere leaves focus alone', () => {
    const h = setup();
    h.outside.focus();
    h.controller.pointerEnterTrigger();
    h.controller.navigate();
    expect(h.controller.previewOpen).toBe(false);
    expect(document.activeElement).toBe(h.outside);
  });

  it('preview; branch toggles and the status filter keep it open', () => {
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.overlay);
    h.controller.pointerEnterOverlay();
    // Clicking a branch or the filter is not a selection: nothing closes.
    h.menuButton.setAttribute('aria-expanded', 'true');
    expect(h.controller.previewOpen).toBe(true);
    // The menu holds the preview open even when the pointer leaves for it.
    h.controller.pointerLeave('overlay', h.outside);
    expect(h.controller.previewOpen).toBe(true);
    expect(h.controller.hasPendingWork()).toBe(true);
  });

  it('a menu hold closes the preview once the menu closes with the pointer outside', async () => {
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.overlay);
    h.controller.pointerEnterOverlay();
    h.menuButton.setAttribute('aria-expanded', 'true');
    h.controller.pointerLeave('overlay', h.outside);
    expect(h.controller.previewOpen).toBe(true);
    h.menuButton.setAttribute('aria-expanded', 'false');
    // MutationObserver callbacks are microtasks.
    await Promise.resolve();
    expect(h.controller.previewOpen).toBe(false);
    expect(h.controller.hasPendingWork()).toBe(false);
  });

  it('portalled menu content marked with the preview scope counts as inside', () => {
    const h = setup();
    const portal = document.createElement('div');
    portal.setAttribute(PIPELINE_NAV_PREVIEW_SCOPE_ATTRIBUTE, 'panel-1');
    const menuItem = document.createElement('button');
    portal.append(menuItem);
    document.body.append(portal);
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.overlay);
    h.controller.pointerEnterOverlay();
    h.controller.pointerLeave('overlay', menuItem);
    expect(h.controller.previewOpen).toBe(true);

    const otherScope = document.createElement('div');
    otherScope.setAttribute(PIPELINE_NAV_PREVIEW_SCOPE_ATTRIBUTE, 'panel-2');
    document.body.append(otherScope);
    h.controller.pointerLeave('overlay', otherScope);
    expect(h.controller.previewOpen).toBe(false);
  });

  it('preview; toggle click pins expanded (expanded is set before the preview drops)', () => {
    const h = setup();
    const order: string[] = [];
    h.controller.pointerEnterTrigger();
    h.controller.subscribe(() => {
      order.push(`preview:${String(h.controller.previewOpen)}`);
      order.push(`expanded:${String(h.expanded())}`);
    });
    h.controller.toggleClick();
    expect(h.expanded()).toBe(true);
    expect(h.controller.previewOpen).toBe(false);
    // When the preview closed, the list was already pinned, so the one
    // element stays mounted (no replayed entry).
    expect(order).toEqual(['preview:false', 'expanded:true']);
  });

  it('preview; leaving trigger and list closes it, travel between them does not', () => {
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.firstItem);
    expect(h.controller.previewOpen).toBe(true);
    h.controller.pointerEnterOverlay();
    h.controller.pointerLeave('overlay', h.toggle);
    expect(h.controller.previewOpen).toBe(true);
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.outside);
    expect(h.controller.previewOpen).toBe(false);
    expect(h.expanded()).toBe(false);
  });

  it('keyboard focus inside the preview holds it against pointer travel; focus leaving closes it', () => {
    const h = setup();
    h.focusVisible.add(h.toggle);
    h.toggle.focus();
    h.controller.focusTrigger(h.toggle);
    expect(h.controller.focusFirstPreviewItem()).toBe(true);
    expect(document.activeElement).toBe(h.firstItem);
    h.focusVisible.add(h.firstItem);
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.outside);
    expect(h.controller.previewOpen).toBe(true);
    // Shift+Tab from the first item returns to the toggle, still open.
    expect(h.controller.isFirstPreviewItem(h.firstItem)).toBe(true);
    h.controller.focusToggle();
    expect(document.activeElement).toBe(h.toggle);
    expect(h.controller.previewOpen).toBe(true);
    h.controller.focusLeave(h.outside);
    expect(h.controller.previewOpen).toBe(false);
  });

  it('preview; Escape closes and returns focus to the toggle without reopening', () => {
    const h = setup();
    h.focusVisible.add(h.toggle);
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.overlay);
    h.controller.pointerEnterOverlay();
    h.firstItem.focus();
    // Programmatic focus on the toggle fires the trigger's focus handler.
    h.toggle.addEventListener('focus', () => {
      h.controller.focusTrigger(h.toggle);
    });
    expect(h.controller.escape()).toBe(true);
    expect(document.activeElement).toBe(h.toggle);
    expect(h.controller.previewOpen).toBe(false);
    expect(h.controller.escape()).toBe(false);
  });

  it('a leave with no destination is re-checked before closing', () => {
    jest.useFakeTimers();
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', null);
    expect(h.controller.previewOpen).toBe(true);
    // The pointer turned out to still be over the list.
    h.controller.pointerEnterOverlay();
    jest.advanceTimersByTime(PIPELINE_NAV_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS);
    expect(h.controller.previewOpen).toBe(true);
    h.controller.pointerLeave('overlay', null);
    jest.advanceTimersByTime(PIPELINE_NAV_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS);
    expect(h.controller.previewOpen).toBe(false);
  });

  it('panel hidden dismisses the preview, releases pending work, and ignores opens until visible', () => {
    jest.useFakeTimers();
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', null);
    expect(h.controller.hasPendingWork()).toBe(true);
    h.controller.setEnabled(false);
    expect(h.controller.previewOpen).toBe(false);
    expect(h.controller.hasPendingWork()).toBe(false);
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(false);
    h.controller.setEnabled(true);
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(true);
  });

  it('an owner document change dismisses the preview and its menu observer', () => {
    const h = setup();
    h.controller.pointerEnterTrigger();
    h.controller.pointerLeave('trigger', h.overlay);
    h.controller.pointerEnterOverlay();
    h.menuButton.setAttribute('aria-expanded', 'true');
    h.controller.pointerLeave('overlay', h.outside);
    expect(h.controller.hasPendingWork()).toBe(true);
    h.controller.dismiss();
    expect(h.controller.previewOpen).toBe(false);
    expect(h.controller.hasPendingWork()).toBe(false);
  });

  it('never previews while expanded, and notifies subscribers only on change', () => {
    const h = setup(true);
    const listener = jest.fn();
    h.controller.subscribe(listener);
    h.focusVisible.add(h.toggle);
    h.controller.focusTrigger(h.toggle);
    h.controller.pointerEnterTrigger();
    expect(h.controller.previewOpen).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    h.controller.dispose();
    expect(h.controller.previewOpen).toBe(false);
  });
});
