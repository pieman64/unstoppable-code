import { EventEmitter } from 'node:events';
import type {
  CodexPluginMaterializationRequest,
  CodexPluginMaterializationResult,
} from '../plugins/codex-plugin-materialization-protocol';

class FakeUtilityProcess extends EventEmitter {
  readonly postMessage = jest.fn<void, [CodexPluginMaterializationRequest]>();
  readonly kill = jest.fn(() => true);
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));

import {
  CodexPluginMaterializationTimeoutError,
  materializeCodexPluginsOffMain,
  resetCodexPluginMaterializationWorkerForTests,
} from '../plugins/codex-plugin-materialization-runner';

function materialize(
  timeoutMs = 1_000,
): Promise<CodexPluginMaterializationResult> {
  return materializeCodexPluginsOffMain({
    nativeProjectionRoot: '/tmp/projection',
    plugins: [
      {
        pluginName: 'fixture',
        pluginPath: '/tmp/fixture',
        marketplaceId: 'market',
        category: 'Development',
        provider: 'claude',
        mode: 'compat',
        removeMcpServers: false,
      },
    ],
    skills: [],
    timeoutMs,
  });
}

describe('Codex plugin materialization runner', () => {
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    resetCodexPluginMaterializationWorkerForTests();
    forkMock.mockReset();
    children.length = 0;
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    resetCodexPluginMaterializationWorkerForTests();
  });

  it('reuses a utility process and resolves the serialized result', async () => {
    const resultPromise = materialize();
    await Promise.resolve();
    const request = children[0]?.postMessage.mock.calls[0]?.[0];
    if (request?.type !== 'materialize') {
      throw new Error('Expected a materialize request.');
    }
    children[0]?.emit('message', {
      type: 'result',
      requestId: request.requestId,
      result: {
        selectedPlugins: [
          {
            pluginName: 'fixture',
            category: 'Development',
            cacheDir: '/tmp/cache',
          },
        ],
        warnings: [],
      },
    });

    await expect(resultPromise).resolves.toEqual({
      selectedPlugins: [
        {
          pluginName: 'fixture',
          category: 'Development',
          cacheDir: '/tmp/cache',
        },
      ],
      warnings: [],
    });
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('kills and replaces a worker that exceeds the hard deadline', async () => {
    jest.useFakeTimers();
    const timedOut = materialize(25);
    await Promise.resolve();
    const firstChild = children[0];
    jest.advanceTimersByTime(25);

    expect(firstChild?.kill).toHaveBeenCalledTimes(1);
    let timeoutSettled = false;
    void timedOut.catch(() => {
      timeoutSettled = true;
    });
    await Promise.resolve();
    expect(timeoutSettled).toBe(false);

    const replacement = materialize();
    await Promise.resolve();
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);

    firstChild?.emit('exit', 0);
    await Promise.resolve();
    await Promise.resolve();

    await expect(timedOut).rejects.toBeInstanceOf(
      CodexPluginMaterializationTimeoutError,
    );
    expect(forkMock).toHaveBeenCalledTimes(2);
    const request = children[1]?.postMessage.mock.calls[0]?.[0];
    if (request?.type !== 'materialize') {
      throw new Error('Expected a replacement materialize request.');
    }
    children[1]?.emit('message', {
      type: 'result',
      requestId: request.requestId,
      result: { selectedPlugins: [], warnings: [] },
    });
    await expect(replacement).resolves.toEqual({
      selectedPlugins: [],
      warnings: [],
    });
  });
});
