import type * as CanopyCloudClientModule from '../canopy-cloud/client';

const requestJsonMock = jest.fn();
const requestPublicJsonMock = jest.fn();

jest.mock('../canopy-cloud/client', () => {
  const actual = jest.requireActual<typeof CanopyCloudClientModule>(
    '../canopy-cloud/client',
  );
  return {
    CanopyCloudClientError: actual.CanopyCloudClientError,
    get requestCanopyCloudJson(): typeof requestJsonMock {
      return requestJsonMock;
    },
    get requestCanopyCloudPublicJson(): typeof requestPublicJsonMock {
      return requestPublicJsonMock;
    },
  };
});

import { CanopyCloudClientError } from '../canopy-cloud/client';
import { reportShareHandoffEvent } from '../canopy-cloud/share-handoff-events';

const EVENT = {
  entity: 'skill' as const,
  externalId: '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f',
  eventType: 'APP_OPENED' as const,
};

const EXPECTED_BODY = JSON.stringify({
  entityType: 'SKILL',
  eventType: 'APP_OPENED',
  audience: 'PUBLIC',
  entityExternalId: EVENT.externalId,
});

describe('reportShareHandoffEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('posts authenticated when credentials exist', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });
    await reportShareHandoffEvent(EVENT);
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/desktop-app/share-events/desktop-handoff',
      { method: 'POST', body: EXPECTED_BODY },
    );
    expect(requestPublicJsonMock).not.toHaveBeenCalled();
  });

  it('classifies plugin handoff events as PLUGIN', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });
    await reportShareHandoffEvent({ ...EVENT, entity: 'plugin' });
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/desktop-app/share-events/desktop-handoff',
      {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'PLUGIN',
          eventType: 'APP_OPENED',
          audience: 'PUBLIC',
          entityExternalId: EVENT.externalId,
        }),
      },
    );
  });

  it('classifies Agent handoff events as AGENT', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });
    await reportShareHandoffEvent({ ...EVENT, entity: 'agent' });
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/desktop-app/share-events/desktop-handoff',
      {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'AGENT',
          eventType: 'APP_OPENED',
          audience: 'PUBLIC',
          entityExternalId: EVENT.externalId,
        }),
      },
    );
  });

  it('classifies workspace handoff events as WORKSPACE_TEMPLATE', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });
    await reportShareHandoffEvent({ ...EVENT, entity: 'workspace' });
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/desktop-app/share-events/desktop-handoff',
      {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'WORKSPACE_TEMPLATE',
          eventType: 'APP_OPENED',
          audience: 'PUBLIC',
          entityExternalId: EVENT.externalId,
        }),
      },
    );
  });

  it('preserves a scoped audience', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });
    await reportShareHandoffEvent({ ...EVENT, audience: 'TEAM' });
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/desktop-app/share-events/desktop-handoff',
      {
        method: 'POST',
        body: JSON.stringify({
          entityType: 'SKILL',
          eventType: 'APP_OPENED',
          audience: 'TEAM',
          entityExternalId: EVENT.externalId,
        }),
      },
    );
  });

  it('falls back to the anonymous transport when signed out', async () => {
    requestJsonMock.mockRejectedValue(
      new CanopyCloudClientError('missing-api-key', 'no key'),
    );
    requestPublicJsonMock.mockResolvedValue({ accepted: true });
    await reportShareHandoffEvent(EVENT);
    expect(requestPublicJsonMock).toHaveBeenCalledWith(
      '/api/v1/desktop-app/share-events/desktop-handoff',
      { method: 'POST', body: EXPECTED_BODY },
    );
  });

  it('swallows transport failures without retrying anonymously', async () => {
    requestJsonMock.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'boom', 500),
    );
    await expect(reportShareHandoffEvent(EVENT)).resolves.toBeUndefined();
    expect(requestPublicJsonMock).not.toHaveBeenCalled();
  });

  it('swallows anonymous-transport failures too', async () => {
    requestJsonMock.mockRejectedValue(
      new CanopyCloudClientError('cloud-not-configured', 'not configured'),
    );
    requestPublicJsonMock.mockRejectedValue(new Error('offline'));
    await expect(reportShareHandoffEvent(EVENT)).resolves.toBeUndefined();
  });
});
