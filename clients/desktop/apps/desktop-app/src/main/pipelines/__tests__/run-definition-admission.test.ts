// CAN-4139: run admission reads the stored definition the start path has
// already authorized against the run's owner, so the navigation context's
// visibility filter must not refuse it.
import {
  createPipelineGoldenWorld,
  type GoldenWorld,
} from '../../__tests__/pipeline-golden/world';
import { admitStoredRunDefinition } from '../run-definition-admission';

jest.mock('../pipeline-install-context', () => ({
  ...jest.requireActual<object>('../pipeline-install-context'),
  // Navigation hides every stored definition.
  filterStoredPipelineContexts: (): Promise<unknown[]> => Promise.resolve([]),
}));

jest.setTimeout(120_000);

let world: GoldenWorld;

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
});

afterAll(() => {
  world.dispose();
});

it('admits a stored definition the selected navigation context hides', async () => {
  const admitted = await admitStoredRunDefinition(world.userPipelineId);
  expect(admitted?.definition).toMatchObject({
    definitionId: world.userPipelineId,
    source: 'user',
  });
});
