/**
 * @jest-environment jsdom
 */
import { useChatStore } from '@/stores/chatStore';

describe('composerTextPresent', () => {
  afterEach(() => {
    const { composerTextPresent, setComposerTextPresent } =
      useChatStore.getState();
    for (const tabId of Object.keys(composerTextPresent)) {
      setComposerTextPresent(tabId, false);
    }
  });

  it('tracks per-tab presence and removes entries when cleared', () => {
    const store = useChatStore.getState();
    store.setComposerTextPresent('tab-a', true);
    expect(useChatStore.getState().composerTextPresent['tab-a']).toBe(true);

    store.setComposerTextPresent('tab-a', false);
    // Cleared tabs are removed rather than kept as false so the record does
    // not grow unbounded across a session, and empty-state affordances
    // (CAN-1809 suggested prompts) read absent tabs as "no draft".
    expect('tab-a' in useChatStore.getState().composerTextPresent).toBe(false);
  });

  it('is a no-op when the value does not change', () => {
    const store = useChatStore.getState();
    const before = useChatStore.getState().composerTextPresent;
    store.setComposerTextPresent('tab-b', false);
    expect(useChatStore.getState().composerTextPresent).toBe(before);
  });
});
