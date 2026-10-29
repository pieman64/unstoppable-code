/**
 * @jest-environment jsdom
 */
import {
  computeChatsSelectedPinBand,
  computeChatsSelectedPinState,
  computeStickySelectedPinBand,
  computeStickySelectedPinState,
  findChatsSelectedPinHosts,
  findSelectedPinHosts,
  type StickySelectedItemMetrics,
} from '../sidebar/sticky-selected-item';

// A representative sidebar layout: the sticky controls band ends 77px below
// the viewport top, workspace headers are 32px, worktree rows 28px. The
// selected row sits 400px into the scroll content, 8px under its own
// workspace header.
const METRICS: StickySelectedItemMetrics = {
  rowFlowTop: 400,
  rowHeight: 28,
  headerFlowTop: 360,
  headerHeight: 32,
};
const STICKY_BAND_TOP = 77;
const CLIENT_HEIGHT = 500;

function pinStateAt(
  scrollTop: number,
): ReturnType<typeof computeStickySelectedPinState> {
  return computeStickySelectedPinState({
    scrollTop,
    clientHeight: CLIENT_HEIGHT,
    stickyBandTop: STICKY_BAND_TOP,
    metrics: METRICS,
  });
}

describe('computeStickySelectedPinState', () => {
  it('keeps both pins off while the selected row is in view', () => {
    // Row viewport top = 400 - 200 = 200: well inside the viewport.
    expect(pinStateAt(200)).toEqual({ top: false, bottom: 'none' });
  });

  it('activates the top pin once the row would slide under its header seat', () => {
    // Seat top = stickyBandTop + headerHeight = 109. Activation at
    // rowFlowTop - scrollTop <= 109, i.e. scrollTop >= 291.
    expect(pinStateAt(290)).toEqual({ top: false, bottom: 'none' });
    expect(pinStateAt(291)).toEqual({ top: true, bottom: 'none' });
  });

  it('keeps the top pin active arbitrarily far past the project', () => {
    expect(pinStateAt(5_000)).toEqual({ top: true, bottom: 'none' });
  });

  it('never activates the top pin without a resolved sticky band', () => {
    expect(
      computeStickySelectedPinState({
        scrollTop: 5_000,
        clientHeight: CLIENT_HEIGHT,
        stickyBandTop: null,
        metrics: METRICS,
      }),
    ).toEqual({ top: false, bottom: 'none' });
  });

  it('pins the row to the bottom once its seat scrolls below the viewport', () => {
    // Row seat top = 500 - 28 = 472. Bottom pin at
    // rowFlowTop - scrollTop > 472, i.e. scrollTop < -72 ... use a lower
    // scroll: at scrollTop 0 the row viewport top is 400 (< 472): visible.
    const metrics: StickySelectedItemMetrics = {
      ...METRICS,
      rowFlowTop: 900,
      headerFlowTop: 860,
    };
    // Row viewport top = 900 - 420 = 480 > 472 → bottom pin, header at
    // 860 - 420 = 440 which is at/above the header seat (472 - 32 = 440) →
    // header still naturally visible above the pinned row.
    expect(
      computeStickySelectedPinState({
        scrollTop: 420,
        clientHeight: CLIENT_HEIGHT,
        stickyBandTop: STICKY_BAND_TOP,
        metrics,
      }),
    ).toEqual({ top: false, bottom: 'row' });
    // Scrolling further up pushes the header below its own bottom seat too.
    expect(
      computeStickySelectedPinState({
        scrollTop: 419,
        clientHeight: CLIENT_HEIGHT,
        stickyBandTop: STICKY_BAND_TOP,
        metrics,
      }),
    ).toEqual({ top: false, bottom: 'header-row' });
  });

  it('leaves the bottom pin off when the row is exactly seated at the bottom edge', () => {
    const metrics: StickySelectedItemMetrics = {
      ...METRICS,
      rowFlowTop: 472,
      headerFlowTop: 432,
    };
    expect(
      computeStickySelectedPinState({
        scrollTop: 0,
        clientHeight: CLIENT_HEIGHT,
        stickyBandTop: STICKY_BAND_TOP,
        metrics,
      }),
    ).toEqual({ top: false, bottom: 'none' });
  });
});

describe('computeStickySelectedPinBand', () => {
  it('is zero-height everywhere while nothing is pinned', () => {
    expect(
      computeStickySelectedPinBand(
        { top: false, bottom: 'none' },
        METRICS,
        false,
      ),
    ).toEqual({
      topGroupHeight: 0,
      topClipExtension: 0,
      bottomClipExtension: 0,
    });
  });

  it('extends the top band by the row height when the slot header stands in for the same project', () => {
    expect(
      computeStickySelectedPinBand(
        { top: true, bottom: 'none' },
        METRICS,
        false,
      ),
    ).toEqual({
      topGroupHeight: 60,
      topClipExtension: 28,
      bottomClipExtension: 0,
    });
  });

  it('adds the later project header when the slot shows a different project', () => {
    expect(
      computeStickySelectedPinBand(
        { top: true, bottom: 'none' },
        METRICS,
        true,
      ),
    ).toEqual({
      topGroupHeight: 60,
      topClipExtension: 60,
      bottomClipExtension: 0,
    });
  });

  it('sizes the bottom clip to the pinned surfaces', () => {
    expect(
      computeStickySelectedPinBand(
        { top: false, bottom: 'row' },
        METRICS,
        false,
      ).bottomClipExtension,
    ).toBe(28);
    expect(
      computeStickySelectedPinBand(
        { top: false, bottom: 'header-row' },
        METRICS,
        false,
      ).bottomClipExtension,
    ).toBe(60);
  });
});

describe('findSelectedPinHosts', () => {
  it('finds the four part hosts from a project section root', () => {
    document.body.innerHTML = `
      <div data-testid="app-sidebar">
        <div data-sidebar-selected-pin-top>
          <div data-sidebar-selected-pin-part="header" id="th"></div>
          <div data-sidebar-selected-pin-part="row" id="tr"></div>
        </div>
        <div data-testid="sidebar-section-code">
          <div id="origin"></div>
        </div>
        <div data-sidebar-selected-pin-bottom>
          <div data-sidebar-selected-pin-part="header" id="bh"></div>
          <div data-sidebar-selected-pin-part="row" id="br"></div>
        </div>
      </div>`;
    const origin = document.getElementById('origin');
    const hosts = findSelectedPinHosts(origin);
    expect(hosts).not.toBeNull();
    expect(hosts?.topHeader.id).toBe('th');
    expect(hosts?.topRow.id).toBe('tr');
    expect(hosts?.bottomHeader.id).toBe('bh');
    expect(hosts?.bottomRow.id).toBe('br');
  });

  it('returns null when a pin surface is absent (shared-host or loading sidebar)', () => {
    document.body.innerHTML = `
      <div data-testid="app-sidebar">
        <div data-testid="sidebar-section-code"><div id="origin"></div></div>
      </div>`;
    expect(findSelectedPinHosts(document.getElementById('origin'))).toBeNull();
  });

  it('returns null for a detached origin', () => {
    expect(findSelectedPinHosts(null)).toBeNull();
  });
});

describe('grouped selected-item seats', () => {
  const grouped = {
    rowFlowTop: 900,
    rowHeight: 28,
    headerFlowTop: 700,
    headerHeight: 32,
    groupHeaderFlowTop: 800,
    groupHeaderHeight: 28,
  };
  const at = (
    scrollTop: number,
  ): ReturnType<typeof computeStickySelectedPinState> =>
    computeStickySelectedPinState({
      scrollTop,
      clientHeight: 500,
      stickyBandTop: 77,
      metrics: grouped,
    });
  it('seats the top row beneath both headers', () => {
    expect(at(763)).toEqual({ top: true, bottom: 'none' });
    expect(at(762)).toEqual({ top: false, bottom: 'none' });
    expect(computeStickySelectedPinBand(at(763), grouped, false)).toEqual({
      topGroupHeight: 88,
      topClipExtension: 56,
      bottomClipExtension: 0,
    });
  });
  it('progresses from row to group-row to project-group-row at the bottom', () => {
    expect(at(400)).toEqual({ top: false, bottom: 'row' });
    expect(at(350)).toEqual({ top: false, bottom: 'group-row' });
    expect(at(250)).toEqual({ top: false, bottom: 'header-group-row' });
    expect(
      computeStickySelectedPinBand(at(350), grouped, false).bottomClipExtension,
    ).toBe(56);
    expect(
      computeStickySelectedPinBand(at(250), grouped, false).bottomClipExtension,
    ).toBe(88);
  });
  it('keeps headerless unnamed groups in the existing two-tier path', () => {
    const unnamed = { ...grouped, groupHeaderHeight: 0 };
    expect(
      computeStickySelectedPinState({
        scrollTop: 250,
        clientHeight: 500,
        stickyBandTop: 77,
        metrics: unnamed,
      }),
    ).toEqual({ top: false, bottom: 'header-row' });
    expect(
      computeStickySelectedPinBand(
        { top: true, bottom: 'none' },
        unnamed,
        false,
      ).topGroupHeight,
    ).toBe(60);
  });
});

// The Chats section sits ABOVE Projects: its header is stuck under the More
// row, 80px down, and its rows are 28px. The selected chat sits 120px into
// the scroll content, directly under the header at rest.
const CHATS_HEADER_SEAT_BOTTOM = 80;
const CHAT_ROW = { rowFlowTop: 120, rowHeight: 28 };

function chatsPinStateAt(
  scrollTop: number,
  row: { rowFlowTop: number; rowHeight: number } = CHAT_ROW,
): ReturnType<typeof computeChatsSelectedPinState> {
  return computeChatsSelectedPinState({
    scrollTop,
    clientHeight: CLIENT_HEIGHT,
    headerSeatBottom: CHATS_HEADER_SEAT_BOTTOM,
    ...row,
  });
}

describe('computeChatsSelectedPinState', () => {
  it('keeps both pins off while the selected chat is in view', () => {
    expect(chatsPinStateAt(0)).toEqual({ top: false, bottom: 'none' });
    expect(chatsPinStateAt(20)).toEqual({ top: false, bottom: 'none' });
  });

  it('pins under the Chats header once the row starts sliding beneath it', () => {
    // Row viewport top = 120 - scrollTop; the header's seat ends at 80.
    expect(chatsPinStateAt(40)).toEqual({ top: false, bottom: 'none' });
    expect(chatsPinStateAt(41)).toEqual({ top: true, bottom: 'none' });
  });

  it('keeps the chat pinned however far the project list scrolls', () => {
    expect(chatsPinStateAt(8_000)).toEqual({ top: true, bottom: 'none' });
  });

  it('never top-pins at rest, even when the row starts under the seat', () => {
    // Nothing above Chats (every nav item moved into More): the row can sit
    // exactly on the seat line at scrollTop 0, which is not "scrolled away".
    expect(
      chatsPinStateAt(0, {
        rowFlowTop: CHATS_HEADER_SEAT_BOTTOM,
        rowHeight: 28,
      }),
    ).toEqual({ top: false, bottom: 'none' });
  });

  it('pins the row alone to the foot of the rail when it is below the fold', () => {
    // The Chats header is stuck on screen whenever its rows are, so the
    // bottom pin never needs a header copy the way a project row does.
    const far = { rowFlowTop: 900, rowHeight: 28 };
    expect(chatsPinStateAt(0, far)).toEqual({ top: false, bottom: 'row' });
    // Bottom seat top = 500 - 28 = 472: in view at 900 - 428.
    expect(chatsPinStateAt(428, far)).toEqual({ top: false, bottom: 'none' });
    expect(chatsPinStateAt(427, far)).toEqual({ top: false, bottom: 'row' });
  });
});

describe('computeChatsSelectedPinBand', () => {
  it('reserves nothing in the Projects band for either Chats pin', () => {
    // The top copy seats under the Chats header, which the Projects band
    // already stacks beneath; it must not also deepen the band's own clip.
    expect(
      computeChatsSelectedPinBand({ top: true, bottom: 'none' }, 28),
    ).toEqual({
      topGroupHeight: 0,
      topClipExtension: 0,
      bottomClipExtension: 0,
    });
    expect(
      computeChatsSelectedPinBand({ top: false, bottom: 'row' }, 28),
    ).toEqual({
      topGroupHeight: 0,
      topClipExtension: 0,
      bottomClipExtension: 28,
    });
    expect(
      computeChatsSelectedPinBand({ top: false, bottom: 'none' }, 28),
    ).toEqual({
      topGroupHeight: 0,
      topClipExtension: 0,
      bottomClipExtension: 0,
    });
  });
});

describe('findChatsSelectedPinHosts', () => {
  it('finds the seat under the Chats header and the rail-foot row host', () => {
    document.body.innerHTML = `
      <div data-testid="app-sidebar">
        <div data-sidebar-chats-header></div>
        <div data-sidebar-chats-selected-pin>
          <div data-sidebar-selected-pin-part="row" id="ct"></div>
        </div>
        <div data-sidebar-chats-mask><div id="origin"></div></div>
        <div data-sidebar-selected-pin-bottom>
          <div data-sidebar-selected-pin-part="header"></div>
          <div data-sidebar-selected-pin-part="row" id="br"></div>
        </div>
      </div>`;
    const hosts = findChatsSelectedPinHosts(document.getElementById('origin'));
    expect(hosts?.top.id).toBe('ct');
    expect(hosts?.bottomRow.id).toBe('br');
  });

  it('returns null when the rail has no Chats seat (web portal, loading)', () => {
    document.body.innerHTML = `
      <div data-testid="app-sidebar">
        <div data-sidebar-chats-mask><div id="origin"></div></div>
        <div data-sidebar-selected-pin-bottom>
          <div data-sidebar-selected-pin-part="row"></div>
        </div>
      </div>`;
    expect(
      findChatsSelectedPinHosts(document.getElementById('origin')),
    ).toBeNull();
  });
});
