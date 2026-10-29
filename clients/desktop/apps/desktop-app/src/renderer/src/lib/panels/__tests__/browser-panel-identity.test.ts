import {
  browserPanelIdFor,
  isRecoveryBrowserId,
  RECOVERY_BROWSER_ID,
} from '../browser-panel-identity';

describe('browser panel identity', () => {
  it('derives a stable panel id from the exact browser id', () => {
    expect(browserPanelIdFor('browser-abc')).toBe('panel-browser-browser-abc');
  });

  it('recognizes only the reserved hydration recovery id', () => {
    expect(isRecoveryBrowserId(RECOVERY_BROWSER_ID)).toBe(true);
    expect(isRecoveryBrowserId('browser-abc')).toBe(false);
  });
});
