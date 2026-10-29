// Runtime injection helper for chat events. The E2E-only main-process ingress
// commits through ChatStateService before emitting the compatibility event, so
// tests exercise the same durability ordering as real provider sessions.

const E2E_CHAT_EVENT_INGESTOR_KEY = '__CANOPY_E2E_INGEST_CHAT_EVENT__';

/**
 * Inject a chat event into the main renderer window.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').ChatEvent} event
 * @returns {Promise<void>}
 */
export async function injectChatEvent(electronApp, event) {
  if (!electronApp) {
    throw new Error('injectChatEvent requires an electronApp');
  }
  if (!event || typeof event !== 'object') {
    throw new Error('injectChatEvent requires a chat event payload');
  }

  await electronApp.evaluate(
    async (_electron, { key, payload }) => {
      const ingest = globalThis[key];
      if (typeof ingest !== 'function') {
        throw new Error('Canonical E2E chat-event ingress is unavailable');
      }
      await ingest(payload);
    },
    { key: E2E_CHAT_EVENT_INGESTOR_KEY, payload: event },
  );
}
