/**
 * @jest-environment jsdom
 */
import {
  NEAREST_FILE_INPUT_FUNCTION,
  describeFileInput,
  describeFileInputNode,
  fileInputConnected,
  frameOrigins,
} from '../upload-files';

/** Runs the page function with `this` bound, as Runtime.callFunctionOn does. */
function nearest(element: Element): Element | null {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    `return (${NEAREST_FILE_INPUT_FUNCTION})`,
  ) as () => (this: Element) => Element | null;
  return make().call(element);
}

describe('NEAREST_FILE_INPUT_FUNCTION', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('takes the target when it is a file input, in any case of its type', () => {
    document.body.innerHTML = '<input id="a" type="FILE">';
    const input = document.getElementById('a');
    if (!input) throw new Error('missing');
    expect(nearest(input)).toBe(input);
  });

  it('finds a hidden input inside a drop zone, then beside it, then around it', () => {
    document.body.innerHTML = `
      <div id="zone"><span><label>Drop<input id="inner" type="file" hidden></label></span></div>
      <div><button id="pick">Choose</button><input id="beside" type="file"></div>
      <section><div><div><button id="deep">Deep</button></div></div><input id="around" type="file"></section>`;
    const zone = document.getElementById('zone');
    const pick = document.getElementById('pick');
    const deep = document.getElementById('deep');
    if (!zone || !pick || !deep) throw new Error('missing');
    expect(nearest(zone)?.id).toBe('inner');
    expect(nearest(pick)?.id).toBe('beside');
    expect(nearest(deep)?.id).toBe('around');
  });

  it('falls back to a file input elsewhere in the document, and to none', () => {
    document.body.innerHTML =
      '<p id="far">Text</p><div><div><div><div><input id="only" type="file"></div></div></div></div>';
    const far = document.getElementById('far');
    if (!far) throw new Error('missing');
    expect(nearest(far)?.id).toBe('only');
    document.body.innerHTML = '<p id="none">Text</p><input type="text">';
    const none = document.getElementById('none');
    if (!none) throw new Error('missing');
    expect(nearest(none)).toBeNull();
  });
});

describe('describeFileInput', () => {
  const target = {
    objectId: 'target-object',
    objectGroup: 'group',
    identity: {
      sessionId: 'frame-session',
      frameId: 'frame',
      loaderId: 'loader',
      backendNodeId: 7,
    },
  };

  it('reads the input from the browser side: its node, multiple, and accept', async () => {
    const calls: Array<[string, Record<string, unknown>, string | undefined]> =
      [];
    const send = (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ): Promise<unknown> => {
      calls.push([method, params, sessionId]);
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({ result: { objectId: 'input-object' } });
      return Promise.resolve({
        node: {
          backendNodeId: 42,
          nodeName: 'INPUT',
          attributes: ['type', 'file', 'multiple', '', 'accept', 'image/png'],
        },
      });
    };
    await expect(describeFileInput(send, target)).resolves.toEqual({
      backendNodeId: 42,
      multiple: true,
      accept: 'image/png',
    });
    expect(calls[0]).toEqual([
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: 'target-object',
        objectGroup: 'group',
        returnByValue: false,
      }),
      'frame-session',
    ]);
    expect(calls[1]).toEqual([
      'DOM.describeNode',
      { objectId: 'input-object' },
      'frame-session',
    ]);
  });

  it('finds nothing when the page has no file input, or the node is not one', async () => {
    await expect(
      describeFileInput(
        () => Promise.resolve({ result: { type: 'object', subtype: 'null' } }),
        target,
      ),
    ).resolves.toBeUndefined();
    await expect(
      describeFileInput(
        (method) =>
          Promise.resolve(
            method === 'Runtime.callFunctionOn'
              ? { result: { objectId: 'x' } }
              : {
                  node: {
                    backendNodeId: 1,
                    nodeName: 'INPUT',
                    attributes: ['type', 'text'],
                  },
                },
          ),
        target,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('describeFileInputNode', () => {
  it('reads a chooser’s input by its node: multiple, accept, and a folder input', async () => {
    const calls: unknown[][] = [];
    await expect(
      describeFileInputNode(
        (method, params, sessionId) => {
          calls.push([method, params, sessionId]);
          return Promise.resolve({
            node: {
              backendNodeId: 9,
              nodeName: 'INPUT',
              attributes: ['type', 'file', 'webkitdirectory', ''],
            },
          });
        },
        'frame-session',
        9,
      ),
    ).resolves.toEqual({ backendNodeId: 9, multiple: false, directory: true });
    expect(calls).toEqual([
      ['DOM.describeNode', { backendNodeId: 9 }, 'frame-session'],
    ]);
  });

  it('finds nothing when the node is gone or is not a file input', async () => {
    await expect(
      describeFileInputNode(
        () => Promise.reject(new Error('No node with given id found')),
        '',
        9,
      ),
    ).resolves.toBeUndefined();
    await expect(
      describeFileInputNode(
        () =>
          Promise.resolve({
            node: { backendNodeId: 9, nodeName: 'DIV', attributes: [] },
          }),
        '',
        9,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('frameOrigins', () => {
  const tree = (frames: {
    id: string;
    origin: string;
    loaderId: string;
  }): Record<string, unknown> => ({
    frameTree: {
      frame: {
        id: frames.id,
        securityOrigin: frames.origin,
        loaderId: frames.loaderId,
      },
      childFrames: [
        {
          frame: {
            id: 'child',
            securityOrigin: 'https://upload.example',
            loaderId: 'child-loader',
          },
        },
      ],
    },
  });

  it('reads the frame’s and the page’s origins from the browser, not the page', async () => {
    const send = (
      _method: string,
      _params: Record<string, unknown>,
      sessionId?: string,
    ): Promise<unknown> =>
      Promise.resolve(
        sessionId
          ? tree({ id: 'oopif-root', origin: 'https://x', loaderId: 'l' })
          : tree({
              id: 'main',
              origin: 'https://app.example',
              loaderId: 'main-loader',
            }),
      );
    await expect(frameOrigins(send, 'session', 'child')).resolves.toEqual({
      frameOrigin: 'https://upload.example',
      topOrigin: 'https://app.example',
      loaderId: 'child-loader',
    });
    await expect(frameOrigins(send, '', 'main')).resolves.toEqual({
      frameOrigin: 'https://app.example',
      topOrigin: 'https://app.example',
      loaderId: 'main-loader',
    });
    await expect(frameOrigins(send, '', 'gone')).resolves.toBeUndefined();
  });
});

describe('fileInputConnected', () => {
  function sendFor(
    connected: unknown,
    calls: unknown[][],
  ): (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown> {
    return (method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      if (method === 'DOM.resolveNode')
        return connected === 'gone'
          ? Promise.reject(new Error('No node with given id found'))
          : Promise.resolve({ object: { objectId: 'input-object' } });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({
          result: { type: 'boolean', value: connected },
        });
      return Promise.resolve({});
    };
  }

  it('reads whether the input is in its document, in its own session, and releases what it resolved', async () => {
    const calls: unknown[][] = [];
    await expect(
      fileInputConnected(sendFor(true, calls), 'frame-session', 9),
    ).resolves.toBe(true);
    const group = (calls[0]?.[1] as { objectGroup?: string }).objectGroup;
    expect(calls).toEqual([
      [
        'DOM.resolveNode',
        { backendNodeId: 9, objectGroup: group },
        'frame-session',
      ],
      [
        'Runtime.callFunctionOn',
        expect.objectContaining({
          objectId: 'input-object',
          returnByValue: true,
        }),
        'frame-session',
      ],
      ['Runtime.releaseObjectGroup', { objectGroup: group }, 'frame-session'],
    ]);
    await expect(
      fileInputConnected(sendFor(false, []), 'frame-session', 9),
    ).resolves.toBe(false);
  });

  it('is false for a node the page no longer has', async () => {
    await expect(fileInputConnected(sendFor('gone', []), '', 9)).resolves.toBe(
      false,
    );
  });
});
