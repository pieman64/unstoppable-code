/* eslint-disable @typescript-eslint/unbound-method -- Injected functions are closure-based test doubles. */
import {
  createExperimentsActionFamily,
  createInMemoryAgentActionReceipts,
  type AgentActionCall,
} from '@canopy/agent-actions';
import type { LabsAvailabilityState } from '../../feature-flags/labs-availability';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { LABS_EXPERIMENTS } from '@canopy/desktop-shared/lib/labs-experiments';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  LabsExperimentsService,
  type LabsExperimentsDependencies,
} from '../../services/labs-experiments-service';
import { desktopExperimentsPort } from '../desktop-experiments-port';

let mockService: LabsExperimentsService;
jest.mock('../../services/labs-experiments-runtime', (): object => ({
  getLabsExperimentsService: (): LabsExperimentsService => mockService,
}));
const call: AgentActionCall<CanopyInjectedToolRuntime> = {
  host: {
    requestUserAnswers: (): ReturnType<
      CanopyInjectedToolRuntime['requestUserAnswers']
    > => Promise.resolve([]),
    loadScriptOutput: (): ReturnType<
      CanopyInjectedToolRuntime['loadScriptOutput']
    > => Promise.reject(new Error('Unused')),
  },
  actorKey: 'test',
  turnKey: 'turn',
  toolUseId: 'write',
};
let deps: LabsExperimentsDependencies;
beforeEach(() => {
  deps = {
    choicesPath: 'choices',
    availabilityPath: 'availability',
    read: (): unknown => null,
    write: jest.fn((): Promise<void> => Promise.resolve()),
    availability: (): LabsAvailabilityState => ({
      snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
      contextIdentity: null,
      liveValues: {},
    }),
    fetchChoices: jest.fn(),
    putChoice: jest.fn(),
    diagnostic: jest.fn(),
    mirror: jest.fn(),
  };
  mockService = new LabsExperimentsService(
    deps,
    { scope: 'local', signedIn: false, ready: true },
    [
      ...LABS_EXPERIMENTS,
      {
        id: 'page-preview',
        name: 'Page',
        description: 'Preview',
        flagKey: 'fixture',
        requiresEarlyAccess: true,
        fixtureAvailability: 'offered',
        pages: ['plugins'],
        sidebarKeys: ['plugins'],
      },
      {
        id: 'hidden-preview',
        name: 'Hidden',
        description: 'Preview',
        flagKey: 'hidden-fixture',
        requiresEarlyAccess: false,
        fixtureAvailability: 'hidden',
        pages: [],
        sidebarKeys: [],
      },
    ],
  );
});
it('writes through the real evaluator and replays only historical receipt fields', async () => {
  const family = createExperimentsActionFamily({
    port: desktopExperimentsPort,
    receipts: createInMemoryAgentActionReceipts<CanopyInjectedToolRuntime>(),
    limits: null,
  });
  const parsed = family.parse({
    type: 'experiments.set_enabled',
    experimentId: 'early-access',
    enabled: true,
  });
  if (!parsed?.ok) throw new Error('Invalid fixture');
  const first = await parsed.dispatch(call);
  expect(mockService.getSnapshot().earlyAccessEnabled).toBe(true);
  await mockService.setChoice({ experimentId: 'early-access', enabled: false });
  expect(await parsed.dispatch(call)).toEqual(first);
  expect(mockService.getSnapshot().earlyAccessEnabled).toBe(false);
  expect(deps.write).toHaveBeenCalledTimes(2);
});
it.each([
  ['unknown', 'invalid_payload'],
  ['hidden-preview', 'missing_capability'],
  ['page-preview', 'missing_capability'],
])('maps the real %s refusal to %s', async (experimentId, code) => {
  await expect(
    desktopExperimentsPort.setEnabled({ experimentId, enabled: true }, call),
  ).rejects.toMatchObject({ code });
});
it('permits explicit opt-out with the prerequisite off and preserves disk failure details', async () => {
  await expect(
    desktopExperimentsPort.setEnabled(
      { experimentId: 'page-preview', enabled: false },
      call,
    ),
  ).resolves.toMatchObject({
    storedChoice: false,
    effectiveEnabledAtCommit: false,
    listedAtCommit: false,
  });
  deps.write = (): Promise<void> => Promise.reject(new Error('Disk full'));
  await expect(
    desktopExperimentsPort.setEnabled(
      { experimentId: 'early-access', enabled: true },
      call,
    ),
  ).rejects.toMatchObject({ code: 'execution_failed', message: 'Disk full' });
  expect(mockService.getSnapshot().earlyAccessEnabled).toBe(false);
});
it('enables a page experiment while Early access is off', async () => {
  await expect(
    desktopExperimentsPort.setEnabled(
      { experimentId: 'overview-page', enabled: true },
      call,
    ),
  ).resolves.toMatchObject({
    storedChoice: true,
    effectiveEnabledAtCommit: true,
    listedAtCommit: true,
  });
  expect(mockService.getSnapshot().earlyAccessEnabled).toBe(false);
});
