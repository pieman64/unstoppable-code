import { runInNewContext } from 'node:vm';
import type { BrowserCdpSend } from '../actionability';
import { CLICK_CONTROL_FUNCTION, refuseClickControl } from '../click-control';
import { FormActionError } from '../form-action';

const target = {
  identity: {
    sessionId: 'child',
    frameId: 'f',
    loaderId: 'l',
    backendNodeId: 4,
  },
  frameRef: 'f',
  objectId: 'host-control',
  objectGroup: 'held',
  outOfProcess: true,
};
const option = {
  value: 'amber',
  label: 'Amber',
  selected: false,
  disabled: false,
};

describe('click control refusals before dispatch', () => {
  it('names select_option and returns up to 50 native options', async () => {
    const send = jest
      .fn<ReturnType<BrowserCdpSend>, Parameters<BrowserCdpSend>>()
      .mockResolvedValue({
        result: {
          value: {
            kind: 'select',
            options: Array.from({ length: 70 }, () => option),
          },
        },
      });
    await expect(
      refuseClickControl({ send, target, secret: false }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        next: 'browser.select_option',
        options: Array.from({ length: 50 }, () => option),
      },
    });
    expect(send).toHaveBeenCalledWith(
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: 'host-control',
        arguments: [{ value: false }],
      }),
      'child',
    );
  });
  it('redacts secret select candidates in page and error', async () => {
    const send = jest
      .fn<ReturnType<BrowserCdpSend>, Parameters<BrowserCdpSend>>()
      .mockResolvedValue({ result: { value: { kind: 'select' } } });
    try {
      await refuseClickControl({ send, target, secret: true });
      throw new Error('Expected refusal.');
    } catch (error) {
      expect(error).toBeInstanceOf(FormActionError);
      if (!(error instanceof FormActionError)) throw error;
      expect(error.error).toMatchObject({
        code: 'unsupported_control',
        candidatesRedacted: true,
      });
      expect(error.error.options).toBeUndefined();
      expect(JSON.stringify(error.error)).not.toContain('amber');
    }
    expect(send.mock.calls[0]?.[1].arguments).toEqual([{ value: true }]);
  });
  it('refuses a file input with user choice guidance and no next', async () => {
    const send = jest
      .fn<ReturnType<BrowserCdpSend>, Parameters<BrowserCdpSend>>()
      .mockResolvedValue({ result: { value: { kind: 'file' } } });
    await expect(
      refuseClickControl({ send, target, secret: false }),
    ).rejects.toMatchObject({
      error: {
        code: 'unsupported_control',
        message:
          'Use browser.upload_files to attach files, or browser.request_files to ask the user to choose them.',
        next: 'browser.upload_files',
      },
    });
  });
  it('does not read options for a secret control in the page', () => {
    const control = {
      tagName: 'SELECT',
      get options(): never {
        throw new Error('Secret options were read.');
      },
    };
    const result: unknown = runInNewContext(
      `(${CLICK_CONTROL_FUNCTION}).call(control, true)`,
      { control },
    );
    expect(result).toEqual({ kind: 'select' });
  });
  it('leaves ordinary controls on the existing click pipeline', async () => {
    const send = jest
      .fn<ReturnType<BrowserCdpSend>, Parameters<BrowserCdpSend>>()
      .mockResolvedValue({ result: { value: { kind: 'other' } } });
    await expect(
      refuseClickControl({ send, target, secret: false }),
    ).resolves.toBeUndefined();
  });
});
