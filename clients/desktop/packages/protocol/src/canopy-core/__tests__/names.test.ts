import {
  CanopyCapabilityNameSchema,
  CanopyEventNameSchema,
  CanopyGrantNameSchema,
  CanopyOperationCodeSchema,
  CanopyOperationNameSchema,
  CanopyStreamNameSchema,
  type PlaneQualifiedName,
  type ValidPlaneQualifiedName,
} from '../names';

const NAME_SCHEMAS = [
  CanopyOperationNameSchema,
  CanopyEventNameSchema,
  CanopyStreamNameSchema,
  CanopyGrantNameSchema,
  CanopyCapabilityNameSchema,
  CanopyOperationCodeSchema,
] as const;

describe('plane-qualified Canopy names', () => {
  it.each([
    'core.session.state.get',
    'core.identity.profileChanged',
    'worker.filesystem.directory.list',
    'worker.filesystem.read',
    'core.client.lease.acquire',
    'core.events.subscribe.item',
    'core.runtime.events.end',
  ])('accepts a canonical core or worker name: %s', (name) => {
    for (const schema of NAME_SCHEMAS) {
      expect(schema.parse(name)).toBe(name);
    }
  });

  it.each([
    '',
    'filesystem.directory.list',
    'core.list',
    'worker.filesystem',
    'daemon.filesystem.directory.list',
    'core.core.session.get',
    'core.worker.session.get',
    'worker.core.filesystem.read',
    'worker.worker.filesystem.read',
    'worker/filesystem/directory/list',
    'worker:filesystem:directory:list',
    'worker.filesystem.directory.list@1',
    'worker.filesystem.Directory.list',
    'worker.file-system.directory.list',
    'worker.filesystem..list',
    ' worker.filesystem.read',
  ])('rejects a non-canonical name: %s', (name) => {
    for (const schema of NAME_SCHEMAS) {
      expect(schema.safeParse(name).success).toBe(false);
    }
  });
});

const validWorkerName: PlaneQualifiedName<'worker'> =
  'worker.filesystem.roots.list';
const definitionName: ValidPlaneQualifiedName<
  'worker.filesystem.roots.list',
  'worker'
> = validWorkerName;
void definitionName;

// @ts-expect-error names require a plane, domain, and terminal segment
const twoSegmentName: PlaneQualifiedName = 'core.session';
// @ts-expect-error doubled plane prefixes are rejected at definition sites
const doubledPlaneName: ValidPlaneQualifiedName<
  'core.worker.session.get',
  'core'
> = 'core.worker.session.get';
// @ts-expect-error unknown planes are not canonical
const unknownPlaneName: PlaneQualifiedName = 'daemon.session.state.get';
void twoSegmentName;
void doubledPlaneName;
void unknownPlaneName;
