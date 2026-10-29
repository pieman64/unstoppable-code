import { createContext } from 'react';

/**
 * Whether a transcript pins each user message at its top while that turn's
 * output scrolls by. On by default; a compact surface (the floating App
 * Advisor panel) turns it off, so its user messages scroll with the rest.
 */
export const PinUserMessagesContext = createContext(true);
