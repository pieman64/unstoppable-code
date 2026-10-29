import type { JSX } from 'react';

/**
 * The seat for the selected chat's pinned copy, directly under the sticky
 * Chats header.
 *
 * Rendered as the header's next sibling, so it sticks over exactly the range
 * the header does; zero-height, so revealing it moves nothing in the flow.
 * The row copy lives in the inner part and overflows the seat downward. A
 * host rail seats its `top` beneath the header and reveals it; without one
 * (the web portal) it stays hidden and empty.
 */
export function ChatsSelectedPinSeat(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      hidden
      inert
      className="sticky z-40 h-0"
      // Seated by the rail's layout pass beneath the Chats header; this is
      // the pre-measurement fallback.
      style={{ top: '1px' }}
      data-sidebar-chats-selected-pin=""
      data-testid="sidebar-chats-selected-pin"
    >
      <div
        className="sidebar-chats-selected-pin-row"
        data-sidebar-selected-pin-part="row"
      />
    </div>
  );
}
