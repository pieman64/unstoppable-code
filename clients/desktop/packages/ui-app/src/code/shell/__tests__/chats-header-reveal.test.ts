/**
 * @jest-environment jsdom
 */
import {
  chatsContentHasRows,
  chatsOcclusionBottom,
  isChatsContentOccluded,
  revealOccludedChats,
} from '../sidebar/chats-header-reveal';

describe('isChatsContentOccluded', () => {
  it('reports occluded once the rows have passed behind the header', () => {
    expect(
      isChatsContentOccluded({ contentBottom: 40, headerBottom: 120 }),
    ).toBe(true);
  });

  it('reports visible while any row still shows below the header', () => {
    expect(
      isChatsContentOccluded({ contentBottom: 121, headerBottom: 120 }),
    ).toBe(false);
  });

  it('treats a sub-pixel overhang as occluded', () => {
    // Sticky offsets are seated from measured heights, so the flush case
    // lands a fraction either side of the header's edge rather than exactly
    // on it. A third of a pixel of a row is not a row.
    expect(
      isChatsContentOccluded({ contentBottom: 120.3, headerBottom: 120 }),
    ).toBe(true);
  });

  it('reports occluded when the rows sit flush with the header edge', () => {
    expect(
      isChatsContentOccluded({ contentBottom: 120, headerBottom: 120 }),
    ).toBe(true);
  });
});

describe('chatsContentHasRows', () => {
  function content(html: string): HTMLElement {
    const node = document.createElement('div');
    node.innerHTML = html;
    return node;
  }

  it('finds a rendered work entry row', () => {
    expect(
      chatsContentHasRows(
        content('<div data-testid="sidebar-work-entry-entry-1"></div>'),
      ),
    ).toBe(true);
  });

  it('matches rows whose testid carries a suffix', () => {
    expect(
      chatsContentHasRows(
        content('<div data-testid="sidebar-work-entry-entry-1-pinned"></div>'),
      ),
    ).toBe(true);
  });

  it('reports no rows for an expanded but empty section', () => {
    // The fade wrapper renders whenever the section is expanded, so geometry
    // alone would read an empty section as "every row is behind the header"
    // and offer a way back to nothing.
    expect(chatsContentHasRows(content('<div class="pb-1"></div>'))).toBe(
      false,
    );
  });

  it('counts the selected chat a collapsed section keeps', () => {
    // Collapsed, the block holds only the selected chat. Scrolled past it,
    // the header is stuck exactly as it is over an expanded list, and must
    // behave the same: a way back, not a disclosure.
    expect(
      chatsContentHasRows(
        content('<div data-testid="sidebar-work-entry-entry-1"></div>'),
      ),
    ).toBe(true);
  });
});

describe('revealOccludedChats', () => {
  function withBottom(element: Element | null, bottom: number): void {
    if (!(element instanceof HTMLElement)) throw new Error('missing element');
    element.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, bottom - 28, 200, 28);
  }

  /**
   * A rail holding a collapsed Chats section: the header, its pin seat, and
   * the block that keeps only the selected chat.
   */
  function mount(contentBottom: number): {
    header: HTMLElement;
    scrollTo: jest.Mock;
  } {
    document.body.innerHTML = `
      <div data-sidebar-viewport id="viewport">
        <div data-sidebar-chats-header id="header"></div>
        <div data-sidebar-chats-selected-pin hidden></div>
        <div data-sidebar-chats-mask id="content">
          <div data-testid="sidebar-work-entry-entry-1"></div>
        </div>
      </div>`;
    const header = document.getElementById('header');
    const viewport = document.getElementById('viewport');
    if (!header || !viewport) throw new Error('missing rail');
    withBottom(header, 80);
    withBottom(document.getElementById('content'), contentBottom);
    const scrollTo = jest.fn();
    viewport.scrollTo = scrollTo;
    return { header, scrollTo };
  }

  it('scrolls a collapsed section back into view once its row is behind the header', () => {
    const { header, scrollTo } = mount(40);
    expect(revealOccludedChats(header)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('leaves a collapsed section whose row still shows to its disclosure', () => {
    const { header, scrollTo } = mount(120);
    expect(revealOccludedChats(header)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('chatsOcclusionBottom', () => {
  function withBottom(element: Element | null, bottom: number): void {
    if (!(element instanceof HTMLElement)) throw new Error('missing element');
    element.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, bottom - 28, 200, 28);
  }

  function mount(seatHidden: boolean): HTMLElement {
    document.body.innerHTML = `
      <div data-sidebar-chats-header id="header"></div>
      <div data-sidebar-chats-selected-pin ${seatHidden ? 'hidden' : ''}>
        <div data-sidebar-selected-pin-part="row" id="copy"></div>
      </div>`;
    const header = document.getElementById('header');
    if (!header) throw new Error('missing header');
    withBottom(header, 80);
    withBottom(document.getElementById('copy'), 108);
    return header;
  }

  it('is the header edge while no chat copy is seated', () => {
    expect(chatsOcclusionBottom(mount(true))).toBe(80);
  });

  it('extends to the seated copy, which occludes the rows too', () => {
    // The rail announces "Back to" against this edge; the click must measure
    // the same one or it collapses a list the header says is hidden.
    expect(chatsOcclusionBottom(mount(false))).toBe(108);
  });

  it('ignores a sibling that is not the Chats seat', () => {
    document.body.innerHTML = `
      <div data-sidebar-chats-header id="header"></div>
      <div data-sidebar-chats-mask id="content"></div>`;
    const header = document.getElementById('header');
    if (!header) throw new Error('missing header');
    withBottom(header, 80);
    withBottom(document.getElementById('content'), 400);
    expect(chatsOcclusionBottom(header)).toBe(80);
  });
});
