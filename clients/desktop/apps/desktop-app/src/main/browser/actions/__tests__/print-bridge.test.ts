import { runInNewContext } from 'node:vm';
import type { RegisteredFrame } from '../../frames/frame-registry';
import {
  PRINT_BINDING,
  printBlockedBySandbox,
  printBridgeScript,
} from '../print-bridge';

function page(): {
  root: Record<string, unknown>;
  calls: string[];
  printed: () => number;
} {
  const calls: string[] = [];
  let native = 0;
  const root: Record<string, unknown> = {
    print: (): void => {
      native += 1;
    },
    [PRINT_BINDING]: (payload: string): void => {
      calls.push(payload);
    },
  };
  root.globalThis = root;
  return { root, calls, printed: (): number => native };
}

describe('printBridgeScript', () => {
  it('reports print() through the binding instead of printing, and hides the binding', () => {
    const { root, calls, printed } = page();
    runInNewContext(printBridgeScript(), root);
    runInNewContext('print(); globalThis.print();', root);
    expect(calls).toEqual(['', '']);
    expect(printed()).toBe(0);
    expect(root[PRINT_BINDING]).toBeUndefined();
  });

  it('installs once, so running it again on the same document keeps the wrapper', () => {
    const { root, calls } = page();
    runInNewContext(printBridgeScript(), root);
    const wrapper = root.print;
    runInNewContext(printBridgeScript(), root);
    expect(root.print).toBe(wrapper);
    runInNewContext('print();', root);
    expect(calls).toEqual(['']);
  });

  it('leaves print alone where the binding is missing', () => {
    const { root, printed } = page();
    delete root[PRINT_BINDING];
    const original = root.print;
    runInNewContext(printBridgeScript(), root);
    expect(root.print).toBe(original);
    runInNewContext('print();', root);
    expect(printed()).toBe(1);
  });
});

describe('printBlockedBySandbox', () => {
  const frames: Record<string, RegisteredFrame> = {
    top: {
      frameId: 'top',
      sessionId: '',
      loaderId: 'l0',
      url: '',
      frameRef: 'f0',
    },
    inner: {
      frameId: 'inner',
      sessionId: '',
      loaderId: 'l1',
      url: '',
      parentId: 'top',
      frameRef: 'f1',
    },
    nested: {
      frameId: 'nested',
      sessionId: 'child-1',
      loaderId: 'l2',
      url: '',
      parentId: 'inner',
      frameRef: 'f2',
    },
  };
  function deps(sandbox: Record<string, string | undefined>): {
    getFrame: (frameId: string) => RegisteredFrame | undefined;
    send: jest.Mock<
      Promise<unknown>,
      [string, Record<string, unknown>, string?]
    >;
  } {
    const owners: Record<string, number> = { inner: 11, nested: 12 };
    return {
      getFrame: (frameId) => frames[frameId],
      send: jest.fn((method: string, params: Record<string, unknown>) => {
        if (method === 'DOM.getFrameOwner')
          return Promise.resolve({
            backendNodeId: owners[String(params.frameId)],
          });
        const frameId = Object.keys(owners).find(
          (key) => owners[key] === params.backendNodeId,
        );
        const value = frameId === undefined ? undefined : sandbox[frameId];
        return Promise.resolve({
          node: {
            attributes:
              value === undefined
                ? ['src', '/x']
                : ['src', '/x', 'sandbox', value],
          },
        });
      }),
    };
  }

  it('allows the page itself and frames that are not sandboxed', async () => {
    await expect(printBlockedBySandbox(deps({}), 'top')).resolves.toBe(false);
    await expect(printBlockedBySandbox(deps({}), 'nested')).resolves.toBe(
      false,
    );
  });

  it('blocks a frame, or a frame inside one, sandboxed without allow-modals', async () => {
    await expect(
      printBlockedBySandbox(deps({ inner: 'allow-scripts' }), 'inner'),
    ).resolves.toBe(true);
    await expect(
      printBlockedBySandbox(deps({ inner: '' }), 'nested'),
    ).resolves.toBe(true);
    await expect(
      printBlockedBySandbox(
        deps({ inner: 'allow-scripts ALLOW-MODALS', nested: 'allow-modals' }),
        'nested',
      ),
    ).resolves.toBe(false);
  });

  it('reads the owner in the parent frame’s session, and blocks a frame it cannot resolve', async () => {
    const reading = deps({});
    await printBlockedBySandbox(reading, 'nested');
    expect(reading.send.mock.calls[0]).toEqual([
      'DOM.getFrameOwner',
      { frameId: 'nested' },
      undefined,
    ]);
    await expect(printBlockedBySandbox(deps({}), 'unknown')).resolves.toBe(
      true,
    );
    const failing = deps({});
    failing.send.mockRejectedValue(new Error('gone'));
    await expect(printBlockedBySandbox(failing, 'inner')).resolves.toBe(true);
  });
});
