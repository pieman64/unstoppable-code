/**
 * @jest-environment jsdom
 */
import { scheduleStickyCollapseScrollAdjust } from '../sidebar/sticky-collapse-scroll';

interface Fixture {
  readonly viewport: HTMLElement;
  readonly controls: HTMLElement;
  readonly section: HTMLElement;
  readonly header: HTMLElement;
  readonly flushFrame: () => void;
}

function mockRect(element: HTMLElement, top: number, height: number): void {
  element.getBoundingClientRect = (): DOMRect =>
    new DOMRect(0, top, 100, height);
}

function buildFixture(): Fixture {
  const viewport = document.createElement('div');
  viewport.dataset.testid = 'sidebar-scroll-container';
  const controls = document.createElement('div');
  controls.dataset.testid = 'sidebar-more-sticky-container';
  const section = document.createElement('div');
  const header = document.createElement('div');
  header.className = 'sidebar-workspace-sticky-header';
  section.appendChild(header);
  viewport.append(controls, section);
  document.body.appendChild(viewport);

  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    value: 200,
    writable: true,
  });

  const pendingFrames: FrameRequestCallback[] = [];
  jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback): number => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });

  return {
    viewport,
    controls,
    section,
    header,
    flushFrame: (): void => {
      pendingFrames.shift()?.(0);
    },
  };
}

describe('scheduleStickyCollapseScrollAdjust', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('scrolls a stuck header back below the sticky controls after collapse', () => {
    const { viewport, controls, section, header, flushFrame } = buildFixture();

    // Stuck: the header's painted top is offset 40px into its section.
    mockRect(section, 37, 300);
    mockRect(header, 77, 32);
    mockRect(controls, 1, 76);

    scheduleStickyCollapseScrollAdjust(section);

    // Post-collapse layout: the header ended up 30px above the controls'
    // bottom edge (77px), hidden behind the transparent sticky group.
    section.setAttribute('data-workspace-expanded', 'false');
    mockRect(header, 47, 32);
    flushFrame();

    // 200 + (47 - 77) = 170 aligns the header with its projected slot.
    expect(viewport.scrollTop).toBe(170);
  });

  it('scrolls a projected first-workspace header back below the controls', () => {
    const { viewport, controls, section, header, flushFrame } = buildFixture();
    const onScroll = jest.fn();
    viewport.addEventListener('scroll', onScroll);
    const slot = document.createElement('div');
    slot.dataset.testid = 'sidebar-sticky-workspace-slot';
    slot.dataset.activeWorkspaceId = 'alpha';
    viewport.prepend(slot);
    section.dataset.sidebarWorkspaceId = 'alpha';

    // Projected-slot headers stay in normal flow, so the real header has no
    // sticky offset relative to its section even though its portal copy is
    // the interactive surface above it.
    mockRect(section, 37, 300);
    mockRect(header, 37, 32);
    mockRect(controls, 1, 76);

    scheduleStickyCollapseScrollAdjust(section);

    // Removing the expanded rows must not let the browser's native scroll
    // anchor preserve a trailing workspace and undo our explicit correction.
    expect(viewport.style.overflowAnchor).toBe('none');

    section.setAttribute('data-workspace-expanded', 'false');
    mockRect(header, 47, 32);
    flushFrame();

    expect(viewport.scrollTop).toBe(170);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(viewport.style.overflowAnchor).toBe('none');
    flushFrame();
    expect(viewport.style.overflowAnchor).toBe('');
  });

  it('leaves the scroll alone when the collapse was immediately undone', () => {
    const { viewport, controls, section, header, flushFrame } = buildFixture();

    mockRect(section, 37, 300);
    mockRect(header, 77, 32);
    mockRect(controls, 1, 76);

    scheduleStickyCollapseScrollAdjust(section);

    // Re-expanded before the correction frame ran.
    section.setAttribute('data-workspace-expanded', 'true');
    mockRect(header, 47, 32);
    flushFrame();

    expect(viewport.scrollTop).toBe(200);
  });

  it('leaves the scroll alone when the header was not stuck', () => {
    const { viewport, section, header, controls, flushFrame } = buildFixture();

    mockRect(section, 120, 300);
    mockRect(header, 120, 32);
    mockRect(controls, 1, 76);

    scheduleStickyCollapseScrollAdjust(section);
    flushFrame();

    expect(viewport.scrollTop).toBe(200);
  });

  it('leaves the scroll alone when the collapsed header stays visible', () => {
    const { viewport, controls, section, header, flushFrame } = buildFixture();

    mockRect(section, 37, 300);
    mockRect(header, 77, 32);
    mockRect(controls, 1, 76);

    scheduleStickyCollapseScrollAdjust(section);

    // A header at the slot's own top is already represented by its projection;
    // moving it below the clip band would change which workspace owns the slot.
    section.setAttribute('data-workspace-expanded', 'false');
    mockRect(header, 77, 32);
    flushFrame();

    expect(viewport.scrollTop).toBe(200);
  });
});
