let generation = 0;

// Browser pages live in native WebContentsViews, outside this renderer's DOM.
// Their preload reports trusted input through BrowserService, and the event
// subscription records it here for in-flight renderer action guards.
export function noteBrowserUserInteraction(): void {
  generation += 1;
}

export function getBrowserUserInteractionGeneration(): number {
  return generation;
}
