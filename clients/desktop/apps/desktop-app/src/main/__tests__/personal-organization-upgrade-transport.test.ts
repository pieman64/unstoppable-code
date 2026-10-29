import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { PortalAdapterContext } from '../portal/adapters/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
const handlers = new Map<
  string,
  (event: unknown, value?: unknown) => unknown
>();
const mockConvert = jest.fn<Promise<unknown>, [unknown, string?]>();
const mockStatus = jest.fn<Promise<unknown>, [string, string?]>();
const mockList = jest.fn<Promise<unknown>, []>();
const mockPromote = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, value?: unknown) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../services/personal-organization-upgrade-host', () => ({
  getPersonalOrganizationUpgradeService: (): {
    convert: typeof mockConvert;
    status: typeof mockStatus;
    list: typeof mockList;
    promote: typeof mockPromote;
  } => ({
    convert: mockConvert,
    status: mockStatus,
    list: mockList,
    promote: mockPromote,
  }),
}));
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { registerPersonalOrganizationUpgradeHandlers } from '../ipc/personal-organization-upgrade';
import { handlePortalPersonalOrganizationProjects } from '../portal/adapters/personal-organization-upgrade-adapter';
const organizationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const request = {
  organizationId,
  operationId,
  workspaceIds: ['checked', 'another'],
  workspaceId: 'checked',
};
beforeEach((): void => {
  jest.resetAllMocks();
  handlers.clear();
  registerPersonalOrganizationUpgradeHandlers();
});
it('registers all five backend IPC operations and rejects invalid nested results', async (): Promise<void> => {
  expect(handlers.size).toBe(6);
  const convert = handlers.get(IPC_CHANNELS.personalOrganizationUpgradeConvert);
  if (!convert) throw new Error('Missing handler');
  mockConvert.mockResolvedValue({
    ...request,
    projects: [{ stage: 'invalid' }],
  });
  await expect(convert(undefined, request)).rejects.toThrow();
  expect(mockConvert).toHaveBeenCalledWith(request);
});
it('rejects invalid IPC requests before invoking the service', async (): Promise<void> => {
  const status = handlers.get(IPC_CHANNELS.personalOrganizationUpgradeStatus);
  if (!status) throw new Error('Missing handler');
  await expect(status(undefined, { operationId: 'bad' })).rejects.toThrow();
  expect(mockStatus).not.toHaveBeenCalled();
});
it('serializes a server refusal so Electron does not discard its typed code', async () => {
  const promote = handlers.get(IPC_CHANNELS.personalOrganizationUpgradePromote);
  if (!promote) throw new Error('Missing handler');
  mockPromote.mockRejectedValue(
    new CanopyCloudClientError(
      'http-error',
      'Disabled',
      409,
      'creation_disabled',
    ),
  );
  await expect(
    promote(undefined, { organizationId, operationId, name: 'Acme' }),
  ).resolves.toEqual({
    error: 'HTTP 409: Disabled',
    code: 'creation_disabled',
    status: 409,
  });
});
function context(sessionId?: string): PortalAdapterContext {
  return {
    ...(sessionId ? { sessionId } : {}),
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  };
}
function command(
  type: PortalCommandEnvelope['type'],
  payload: unknown,
): PortalCommandEnvelope {
  return {
    id: operationId,
    sequence: 1,
    type,
    payload,
    createdAt: '2026-10-08T00:00:00.000Z',
    expiresAt: null,
  };
}
it('binds conversion and status to the initiating desktop session with the full selection', async (): Promise<void> => {
  const adapterContext = context('session-a');
  await handlePortalPersonalOrganizationProjects(
    command('portal.personal_organization.projects.convert', request),
    adapterContext,
  );
  expect(mockConvert).toHaveBeenCalledWith(request, 'session-a');
  await handlePortalPersonalOrganizationProjects(
    command('portal.personal_organization.projects.status', { operationId }),
    adapterContext,
  );
  expect(mockStatus).toHaveBeenCalledWith(operationId, 'session-a');
});
it('refuses an unpaired session and conversion without one explicit workspace', async (): Promise<void> => {
  await handlePortalPersonalOrganizationProjects(
    command('portal.personal_organization.projects.convert', request),
    context(),
  );
  await handlePortalPersonalOrganizationProjects(
    command('portal.personal_organization.projects.convert', {
      ...request,
      workspaceId: undefined,
    }),
    context('session-a'),
  );
  expect(mockConvert).not.toHaveBeenCalled();
});
function observedContext(): {
  adapterContext: PortalAdapterContext;
  complete: jest.Mock;
  fail: jest.Mock;
} {
  const complete = jest.fn();
  const fail = jest.fn();
  return {
    adapterContext: {
      sessionId: 'session-a',
      getWindow: () => null,
      enqueueEvent: jest.fn(),
      complete,
      fail,
    },
    complete,
    fail,
  };
}
it('answers status while a conversion is still running off the serial command loop', async (): Promise<void> => {
  let finish: (operation: unknown) => void = () => {};
  mockConvert.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mockStatus.mockResolvedValue({ operationId, projects: [] });
  const { adapterContext, complete } = observedContext();
  const convert = command('portal.personal_organization.projects.convert', {
    ...request,
  });
  // The Portal loop awaits each handler before the next command, so the
  // handler must return before the conversion settles.
  await handlePortalPersonalOrganizationProjects(convert, adapterContext);
  expect(mockConvert).toHaveBeenCalledWith(request, 'session-a');
  expect(complete).not.toHaveBeenCalled();
  const status = command('portal.personal_organization.projects.status', {
    operationId,
  });
  await handlePortalPersonalOrganizationProjects(status, adapterContext);
  expect(complete).toHaveBeenCalledWith(status, { operationId, projects: [] });
  finish({ operationId, projects: [{ workspaceId: 'checked' }] });
  await new Promise((resolve) => setImmediate(resolve));
  expect(complete).toHaveBeenLastCalledWith(convert, {
    operationId,
    projects: [{ workspaceId: 'checked' }],
  });
});
it('fails a conversion that rejects after the handler returned', async (): Promise<void> => {
  mockConvert.mockRejectedValue(new Error('Destination unavailable'));
  const { adapterContext, complete, fail } = observedContext();
  const convert = command('portal.personal_organization.projects.convert', {
    ...request,
  });
  await handlePortalPersonalOrganizationProjects(convert, adapterContext);
  await new Promise((resolve) => setImmediate(resolve));
  expect(complete).not.toHaveBeenCalled();
  expect(fail).toHaveBeenCalledWith(
    convert,
    'execution_failed',
    'Destination unavailable',
  );
});
it('fails a conversion whose completion cannot be recorded', async (): Promise<void> => {
  mockConvert.mockResolvedValue({ operationId, projects: [] });
  const { adapterContext, complete, fail } = observedContext();
  complete.mockImplementation(() => {
    throw new Error('Result too large');
  });
  const convert = command('portal.personal_organization.projects.convert', {
    ...request,
  });
  await handlePortalPersonalOrganizationProjects(convert, adapterContext);
  await new Promise((resolve) => setImmediate(resolve));
  expect(fail).toHaveBeenCalledWith(
    convert,
    'execution_failed',
    'Result too large',
  );
});
