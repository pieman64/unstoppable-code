// CAN-4140: run admission reads the stored definition through
// `core.pipeline.definition.get`. A global run's read names its owner, which
// the desktop binding authorizes instead of the navigation context.
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  createPipelineGoldenWorld,
  type GoldenWorld,
} from '../../__tests__/pipeline-golden/world';
import { admitStoredRunDefinition } from '../run-definition-admission';

const ORG = 'org:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const mockOwnerChecks: Array<[string, string | undefined, string | undefined]> =
  [];
let mockOwnerRefusal: string | undefined;

jest.mock('../pipeline-install-context', () => ({
  ...jest.requireActual<object>('../pipeline-install-context'),
  // Navigation hides every stored definition.
  filterStoredPipelineContexts: (): Promise<unknown[]> => Promise.resolve([]),
  assertStoredPipelineContext: (
    localId: string,
    projectId?: string,
    executionContext?: string,
  ): Promise<void> => {
    mockOwnerChecks.push([localId, projectId, executionContext]);
    return mockOwnerRefusal === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(mockOwnerRefusal));
  },
}));

jest.setTimeout(120_000);

let world: GoldenWorld;
let runtime: DesktopCanopyDispatcher;

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
});

afterAll(async () => {
  setDesktopCanopyRuntime(null);
  await runtime.shutdown();
  world.dispose();
});

beforeEach(() => {
  mockOwnerChecks.length = 0;
  mockOwnerRefusal = undefined;
});

it('admits a global run definition the navigation context hides, for its owner', async () => {
  const admitted = await admitStoredRunDefinition(world.userPipelineId, {
    owner: ORG,
  });
  expect(admitted?.definition).toMatchObject({
    definitionId: world.userPipelineId,
    source: 'user',
  });
  expect(mockOwnerChecks).toEqual([[world.userPipelineId, undefined, ORG]]);
});

it('refuses a global run definition its owner may not use', async () => {
  mockOwnerRefusal = 'Workflow unavailable (access-removed)';
  await expect(
    admitStoredRunDefinition(world.userPipelineId, { owner: ORG }),
  ).rejects.toThrow('Workflow unavailable (access-removed)');
});

it('reads any other run definition through the navigation context', async () => {
  await expect(
    admitStoredRunDefinition(world.userPipelineId, { projectId: 'project-1' }),
  ).rejects.toThrow('Workflow unavailable (context-mismatch)');
  expect(mockOwnerChecks).toEqual([]);
});
