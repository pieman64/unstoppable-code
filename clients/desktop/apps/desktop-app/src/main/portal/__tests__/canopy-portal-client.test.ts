/* eslint-disable @typescript-eslint/no-unsafe-return */
const mockRequestCanopyCloudBinary = jest.fn<
  Promise<Buffer>,
  [string, unknown]
>();
const mockRequestCanopyCloudNoContent = jest.fn<
  Promise<void>,
  [string, unknown]
>();
const mockRequestCanopyCloudJson = jest.fn<
  Promise<unknown>,
  [string, unknown]
>();
jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual('../../canopy-cloud/client'),
  requestCanopyCloudBinary: (...args: [string, unknown]): Promise<Buffer> =>
    mockRequestCanopyCloudBinary(...args),
  requestCanopyCloudNoContent: (...args: [string, unknown]): Promise<void> =>
    mockRequestCanopyCloudNoContent(...args),
  requestCanopyCloudJson: (...args: [string, unknown]): Promise<unknown> =>
    mockRequestCanopyCloudJson(...args),
}));
/* eslint-enable @typescript-eslint/no-unsafe-return */

import {
  consumePortalChatAttachment,
  downloadPortalChatAttachment,
  sendPortalHeartbeat,
} from '../canopy-portal-client';

describe('portal chat attachment client', () => {
  beforeEach(() => jest.clearAllMocks());

  it('downloads bytes from the session-scoped content route with an octet-stream accept', async () => {
    mockRequestCanopyCloudBinary.mockResolvedValue(Buffer.from([1]));
    await expect(
      downloadPortalChatAttachment({
        sessionId: 'sess 1',
        attachmentId: 'att-1',
      }),
    ).resolves.toEqual(Buffer.from([1]));
    expect(mockRequestCanopyCloudBinary).toHaveBeenCalledWith(
      '/api/v1/portal/sessions/sess%201/attachments/att-1/content',
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({
          Accept: 'application/octet-stream',
        }),
      }),
    );
  });

  it('consumes via DELETE on the attachment route', async () => {
    mockRequestCanopyCloudNoContent.mockResolvedValue(undefined);
    await consumePortalChatAttachment({
      sessionId: 'sess-1',
      attachmentId: 'att-1',
    });
    expect(mockRequestCanopyCloudNoContent).toHaveBeenCalledWith(
      '/api/v1/portal/sessions/sess-1/attachments/att-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('refreshes session capabilities with a heartbeat', async () => {
    mockRequestCanopyCloudJson.mockResolvedValue({
      ok: true,
      status: 'active',
    });

    await sendPortalHeartbeat({
      sessionId: 'sess-1',
      capabilities: { 'portal-v1': true, chat_attachments: true },
    });

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      expect.stringContaining('/portal/sessions/sess-1/heartbeat'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          capabilities: { 'portal-v1': true, chat_attachments: true },
        }),
      }),
    );
  });

  it('sends the client platform with a heartbeat when provided', async () => {
    mockRequestCanopyCloudJson.mockResolvedValue({
      ok: true,
      status: 'active',
    });

    await sendPortalHeartbeat({
      sessionId: 'sess-1',
      clientPlatform: 'mac',
    });

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      expect.stringContaining('/portal/sessions/sess-1/heartbeat'),
      expect.objectContaining({
        body: JSON.stringify({ clientPlatform: 'mac' }),
      }),
    );
  });

  it('omits the client platform from a heartbeat when undefined', async () => {
    mockRequestCanopyCloudJson.mockResolvedValue({
      ok: true,
      status: 'active',
    });

    await sendPortalHeartbeat({
      sessionId: 'sess-1',
      clientPlatform: undefined,
    });

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      expect.stringContaining('/portal/sessions/sess-1/heartbeat'),
      expect.objectContaining({
        body: JSON.stringify({}),
      }),
    );
  });
});
