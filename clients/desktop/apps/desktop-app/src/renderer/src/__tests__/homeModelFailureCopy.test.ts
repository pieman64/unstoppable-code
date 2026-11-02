import { initClaudeModels } from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import {
  FIRST_SEND_FAILED_TITLE,
  homeModelDisplayLabel,
  homeModelFailureMessage,
  type HomeModelFailureCause,
} from '../components/home/homeModelFailureCopy';

/** CAN-5021 — every refused first send names its model and the way out. */

const KNOWN = 'claude-fable-copy-test';

beforeAll(() => {
  initClaudeModels([{ id: KNOWN, label: 'Fable 5.1' }]);
});

describe('homeModelDisplayLabel', () => {
  it('uses the catalog’s display name', () => {
    expect(homeModelDisplayLabel(KNOWN)).toBe('Fable 5.1');
  });

  it('falls back to “this model” for an id the catalog does not know', () => {
    expect(homeModelDisplayLabel('claude-unknown-copy-test')).toBe(
      'this model',
    );
    expect(homeModelDisplayLabel('')).toBe('this model');
  });
});

describe('homeModelFailureMessage', () => {
  it('titles the alert', () => {
    expect(FIRST_SEND_FAILED_TITLE).toBe('Couldn’t send');
  });

  it.each<[HomeModelFailureCause, string]>([
    [
      'needs-account',
      `Fable 5.1 needs a free ${brandText.appName} account on AI Credits. Choose another model or sign in.`,
    ],
    [
      'needs-purchase',
      'Fable 5.1 isn’t included in your AI Credits yet. Choose another model.',
    ],
    [
      'not-routable',
      'Fable 5.1 isn’t available on AI Credits. Choose another model.',
    ],
    [
      'org-policy',
      'Fable 5.1 is blocked by your organization’s model policy. Choose another model.',
    ],
    [
      'org-gateway',
      'Fable 5.1 isn’t on your organization’s model gateway. Choose another model.',
    ],
    [
      'unknown-model',
      'Fable 5.1 couldn’t be used to start this chat. Choose another model.',
    ],
    [
      'model-rejected',
      'Fable 5.1 couldn’t be used to start this chat. Choose another model.',
    ],
  ])('explains %s', (cause, message) => {
    expect(homeModelFailureMessage(cause, 'Fable 5.1')).toBe(message);
  });

  it('starts a sentence with the fallback label capitalized', () => {
    expect(
      homeModelFailureMessage(
        'model-rejected',
        homeModelDisplayLabel('claude-unknown-copy-test'),
      ),
    ).toBe(
      'This model couldn’t be used to start this chat. Choose another model.',
    );
    expect(homeModelFailureMessage('unknown-model', '  ')).toBe(
      'This model couldn’t be used to start this chat. Choose another model.',
    );
  });
});
