/**
 * The raised card the sidebar's status prompts share (update, sign-in
 * repair, resume queue, clone progress). Hover washes the card with `bg-subtle`
 * instead of replacing it, so the control keeps its surface.
 */
export const SIDEBAR_STATUS_SURFACE_CLASSNAME =
  'bg-quaternary fg-primary shadow-md';

export const SIDEBAR_STATUS_HOVER_WASH_CLASSNAME =
  'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))] focus-visible:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]';
