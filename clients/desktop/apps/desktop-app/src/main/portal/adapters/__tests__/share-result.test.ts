import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import { CanopyCloudClientError } from '../../../canopy-cloud/client';
import { noteCloudWriteSent } from '../../../canopy-cloud/cloud-write-tracking';
import {
  ShareStageError,
  withShareStage,
} from '../../../sharing/share-operation-result';
import {
  completePortalShareOffLoop,
  withPortalShareUrl,
} from '../share-result';
import type { PortalAdapterContext } from '../types';

const mockGetBaseUrl = jest.fn<string, []>();
jest.mock('../../../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: (): string => mockGetBaseUrl(),
}));

const command = {
  id: 'cmd-1',
  sequence: 7,
  type: 'portal.skills.share_skill',
  payload: {},
  createdAt: '2026-10-15T00:00:00.000Z',
  expiresAt: null,
} as PortalCommandEnvelope;

function createContext(): {
  context: PortalAdapterContext;
  complete: jest.Mock;
  fail: jest.Mock;
} {
  const complete = jest.fn();
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail,
  };
  return { context, complete, fail };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('withPortalShareUrl', () => {
  beforeEach(() => mockGetBaseUrl.mockReset());

  it('resolves the share path against the publishing cloud origin', () => {
    mockGetBaseUrl.mockReturnValue('https://cloud.example.test');

    expect(withPortalShareUrl({ sharePath: '/s/skill-1' })).toEqual({
      sharePath: '/s/skill-1',
      shareUrl: 'https://cloud.example.test/s/skill-1',
    });
  });

  it('leaves results without a share path unchanged', () => {
    mockGetBaseUrl.mockReturnValue('https://cloud.example.test');

    expect(withPortalShareUrl({ message: 'Pending' })).toEqual({
      message: 'Pending',
    });
  });

  it('omits the URL when the cloud origin is unavailable', () => {
    mockGetBaseUrl.mockImplementation(() => {
      throw new Error('not configured');
    });

    expect(withPortalShareUrl({ sharePath: '/s/skill-1' })).toEqual({
      sharePath: '/s/skill-1',
    });
  });
});

describe('completePortalShareOffLoop', () => {
  beforeEach(() => {
    mockGetBaseUrl.mockReset();
    mockGetBaseUrl.mockReturnValue('https://cloud.example.test');
  });

  it('completes a successful share with its absolute URL', async () => {
    const { context, complete, fail } = createContext();

    completePortalShareOffLoop(command, context, () =>
      Promise.resolve({ sharePath: '/s/skill-1' }),
    );
    await settle();

    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(command, {
      sharePath: '/s/skill-1',
      shareUrl: 'https://cloud.example.test/s/skill-1',
    });
  });

  it('completes a classified failure with a structured failure', async () => {
    const { context, complete, fail } = createContext();

    completePortalShareOffLoop(command, context, () =>
      Promise.reject(
        new CanopyCloudClientError(
          'http-error',
          'Subscribe to Business.',
          403,
          'telemetry_scope_prohibited',
          undefined,
          true,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          'org_teams_lapsed',
          undefined,
          'org-ext-1',
        ),
      ),
    );
    await settle();

    const failure: unknown = expect.objectContaining({
      kind: 'organization-plan',
      organizationId: 'org-ext-1',
    });
    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ failure }),
    );
  });

  it('reports a failed pre-flight check as not shared', async () => {
    const { context, complete } = createContext();

    completePortalShareOffLoop(command, context, () =>
      withShareStage('access', () =>
        Promise.reject(
          new CanopyCloudClientError('network-error', 'socket hang up'),
        ),
      ),
    );
    await settle();

    const failure: unknown = expect.objectContaining({
      kind: 'connection',
      stage: 'access',
      commitState: 'not-committed',
    });
    expect(complete).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ failure }),
    );
  });

  it('keeps a failed read after the share was created uncertain', async () => {
    const { context, complete } = createContext();
    // A rollback whose delete pre-read fails leaves the created share live.
    const read = new CanopyCloudClientError('network-error', 'socket hang up');
    read.failedRead = true;

    completePortalShareOffLoop(command, context, () => {
      noteCloudWriteSent();
      return Promise.reject(read);
    });
    await settle();

    const failure: unknown = expect.objectContaining({
      kind: 'connection',
      stage: 'publish',
      commitState: 'unknown',
    });
    expect(complete).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ failure }),
    );
  });

  it("keeps a staged error's own code on the legacy failure event", async () => {
    const { context, fail } = createContext();
    const coded = Object.assign(new Error('Collection not found.'), {
      code: 'not_found',
    });

    completePortalShareOffLoop(command, context, () =>
      Promise.reject(new ShareStageError('access', coded)),
    );
    await settle();

    expect(fail).toHaveBeenCalledWith(
      command,
      'not_found',
      'Collection not found.',
      false,
    );
  });

  it('reports an unclassified failure after a write as uncertain', async () => {
    const { context, complete, fail } = createContext();

    completePortalShareOffLoop(command, context, () => {
      noteCloudWriteSent();
      return Promise.reject(new Error('disk full'));
    });
    await settle();

    // A legacy failure event would read as a definite rejection, and the
    // browser would let the user share again.
    expect(fail).not.toHaveBeenCalled();
    const failure: unknown = expect.objectContaining({
      kind: 'unknown',
      commitState: 'unknown',
    });
    expect(complete).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ failure }),
    );
  });

  it('reports a landed share whose finishing step failed as committed', async () => {
    const { context, complete, fail } = createContext();

    completePortalShareOffLoop(command, context, () =>
      withShareStage('finish', () => Promise.reject(new Error('disk full'))),
    );
    await settle();

    expect(fail).not.toHaveBeenCalled();
    const failure: unknown = expect.objectContaining({
      kind: 'unknown',
      stage: 'finish',
      commitState: 'committed',
    });
    expect(complete).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ failure }),
    );
  });

  it('keeps the legacy failure event for unclassified errors', async () => {
    const { context, complete, fail } = createContext();

    completePortalShareOffLoop(command, context, () =>
      Promise.reject(new Error('disk full')),
    );
    await settle();

    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      command,
      'execution_failed',
      'disk full',
      false,
    );
  });
});
