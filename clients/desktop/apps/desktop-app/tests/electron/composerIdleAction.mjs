// The chat composer's idle primary action. With text in the box it is Send;
// with an empty box on a host that can dictate, the microphone takes Send's
// place. Either one showing means no turn is running (a running turn shows
// Stop). Use it to wait for a turn to finish without depending on whether
// the host supports dictation.

/** The composer's Send button, or the microphone standing in for it. */
export function composerIdleAction(scope) {
  return scope
    .getByRole('button', { name: 'Send message', exact: true })
    .or(
      scope.locator(
        '[data-testid="voice-input-button"][data-emphasis="primary"]',
      ),
    );
}
