import { createContext } from 'react';

/**
 * Whether user bubbles drop their raised surface for a flat muted fill, with
 * no shadow. App Advisor turns it on (early access): its chat already sits on
 * a raised panel. Elsewhere bubbles stay raised.
 */
export const MutedUserBubblesContext = createContext(false);
