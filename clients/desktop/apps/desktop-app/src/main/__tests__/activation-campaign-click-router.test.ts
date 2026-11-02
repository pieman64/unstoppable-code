import {
  buildCampaignNotificationId,
  handleCampaignNotificationClick,
  notifyCampaignClickStartupUnlocked,
  parseCampaignNotificationId,
  resetCampaignClickRouterForTests,
  setCampaignClickSender,
  setCampaignClickObserver,
} from '../notifications/campaigns/click-router';
import type { CampaignClickPayload } from '../notifications/campaigns/click-router';

beforeEach(() => {
  resetCampaignClickRouterForTests();
});

describe('notification id round-trip', () => {
  it('parses an id it built', () => {
    const id = buildCampaignNotificationId('activation-marketplace');
    expect(parseCampaignNotificationId(id)).toEqual({
      campaignId: 'activation-marketplace',
      variantKey: 'default',
    });
  });

  it('round-trips a non-default variant', () => {
    const id = buildCampaignNotificationId('activation-first-task', 'offer');
    expect(parseCampaignNotificationId(id)).toEqual({
      campaignId: 'activation-first-task',
      variantKey: 'offer',
    });
  });

  it('rejects an id naming a variant this build does not define', () => {
    // A banner sent by a previous build whose variant has since been removed
    // must not route into a dead destination.
    expect(
      parseCampaignNotificationId(
        'activation-campaign:activation-marketplace:offer',
      ),
    ).toBeNull();
  });

  it('rejects ids from other notification sources', () => {
    expect(parseCampaignNotificationId('chat:abc')).toBeNull();
    expect(parseCampaignNotificationId('activation-campaign:')).toBeNull();
    // Missing variant segment.
    expect(
      parseCampaignNotificationId('activation-campaign:activation-marketplace'),
    ).toBeNull();
  });

  it('rejects a real campaign id that has not shipped in this phase', () => {
    // `activation-role-branch` is in the id union but has no definition yet.
    expect(
      parseCampaignNotificationId(
        'activation-campaign:activation-role-branch:default',
      ),
    ).toBeNull();
  });

  it('rejects a well-shaped id naming an unknown campaign', () => {
    // Guards against a stale notification from a previous build resolving to
    // a campaign this version does not define.
    expect(
      parseCampaignNotificationId('activation-campaign:not-a-campaign:default'),
    ).toBeNull();
  });
});

describe('click buffering', () => {
  it('holds the payload until the renderer reports unlocked', () => {
    const sender = jest.fn<boolean, [CampaignClickPayload]>(() => true);
    setCampaignClickSender(sender);
    handleCampaignNotificationClick(
      buildCampaignNotificationId('activation-marketplace'),
    );
    expect(sender).not.toHaveBeenCalled();

    notifyCampaignClickStartupUnlocked();
    expect(sender).toHaveBeenCalledWith({
      campaignId: 'activation-marketplace',
      destination: { kind: 'page', page: 'plugins' },
    });
  });

  it('retries rather than dropping when delivery fails', () => {
    const sender = jest.fn<boolean, [CampaignClickPayload]>(() => false);
    setCampaignClickSender(sender);
    notifyCampaignClickStartupUnlocked();
    handleCampaignNotificationClick(
      buildCampaignNotificationId('activation-marketplace'),
    );
    expect(sender).toHaveBeenCalledTimes(1);

    // A later flush — e.g. a new window's renderer coming up — retries.
    sender.mockReturnValue(true);
    notifyCampaignClickStartupUnlocked();
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('clears the buffer once delivery succeeds', () => {
    const sender = jest.fn<boolean, [CampaignClickPayload]>(() => true);
    setCampaignClickSender(sender);
    notifyCampaignClickStartupUnlocked();
    handleCampaignNotificationClick(
      buildCampaignNotificationId('activation-marketplace'),
    );
    notifyCampaignClickStartupUnlocked();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks whose id does not name a known campaign', () => {
    const sender = jest.fn<boolean, [CampaignClickPayload]>(() => true);
    setCampaignClickSender(sender);
    notifyCampaignClickStartupUnlocked();
    handleCampaignNotificationClick('chat:abc');
    expect(sender).not.toHaveBeenCalled();
  });
});

describe('click observer', () => {
  it('reports the click even before the renderer is ready', () => {
    const observer = jest.fn();
    setCampaignClickObserver(observer);
    handleCampaignNotificationClick(
      buildCampaignNotificationId('activation-marketplace'),
    );
    // The user clicked; that is true regardless of whether a window existed
    // yet to receive the navigation.
    expect(observer).toHaveBeenCalledWith('activation-marketplace');
  });

  it('does not report a click for an unknown id', () => {
    const observer = jest.fn();
    setCampaignClickObserver(observer);
    handleCampaignNotificationClick('activation-campaign:nope:default');
    expect(observer).not.toHaveBeenCalled();
  });
});

it('makes every retired sequence notification inert', () => {
  const sender = jest.fn(() => true);
  const observer = jest.fn();
  setCampaignClickSender(sender);
  setCampaignClickObserver(observer);
  notifyCampaignClickStartupUnlocked();
  for (const item of [
    'start-chat',
    'connect-accounts',
    'add-capability',
    'create-account',
  ]) {
    const id = `activation-campaign:getting-started-sequence:${item}`;
    expect(parseCampaignNotificationId(id)).toBeNull();
    handleCampaignNotificationClick(id);
  }
  expect(sender).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
});
