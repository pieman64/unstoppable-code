import type { JSX } from 'react';
import { Skeleton } from '@canopy/ui-shared/components';
import {
  CollectionEditorFields,
  CollectionReadDetail,
  type CollectionReadResolvedMember,
  type CollectionReadViewModel,
} from '@canopy/ui-app/capability';

/**
 * Loading states for a collection's detail. Each renders the loaded parts
 * with plain samples inside `Skeleton`, so skullet measures them into bars
 * and the loaded collection replaces the skeleton in place. Wrap each in
 * `DelayedLoadingPlaceholder` so a fast read never flashes it.
 */

const noop = (): void => undefined;

const SAMPLE_COLLECTION: CollectionReadViewModel = {
  name: 'Release tooling',
  description: 'Skills and plugins the team uses to cut a release.',
  memberRefs: [
    { kind: 'skill', sourceId: 'sample', skillName: 'release-notes' },
    { kind: 'skill', sourceId: 'sample', skillName: 'changelog' },
    { kind: 'plugin', marketplaceId: 'sample', pluginName: 'deploy-checks' },
  ],
};

const SAMPLE_MEMBERS: CollectionReadResolvedMember[] = [
  {
    ref: { kind: 'skill', sourceId: 'sample', skillName: 'release-notes' },
    entryKey: 'sample/release-notes',
    name: 'release-notes',
    description: 'Drafts release notes from merged pull requests',
    source: 'Custom',
  },
  {
    ref: { kind: 'skill', sourceId: 'sample', skillName: 'changelog' },
    entryKey: 'sample/changelog',
    name: 'changelog',
    description: 'Keeps the changelog in step with each release',
    source: 'Custom',
  },
  {
    ref: {
      kind: 'plugin',
      marketplaceId: 'sample',
      pluginName: 'deploy-checks',
    },
    entryKey: 'sample/deploy-checks',
    name: 'deploy-checks',
    description: 'Runs the checks a deploy needs',
    source: 'Marketplace',
  },
];

/** A collection's read view: name, description, and its member groups. */
export function CollectionReadDetailSkeleton({
  label,
  testId,
}: {
  readonly label: string;
  readonly testId: string;
}): JSX.Element {
  return (
    <Skeleton loading label={label} testId={testId}>
      <CollectionReadDetail
        collection={SAMPLE_COLLECTION}
        resolvedMembers={SAMPLE_MEMBERS}
      />
    </Skeleton>
  );
}

/** A shared collection's editor: its name and description fields. */
export function CollectionEditorFieldsSkeleton({
  label,
  testId,
}: {
  readonly label: string;
  readonly testId: string;
}): JSX.Element {
  return (
    <Skeleton loading label={label} testId={testId}>
      <div className="flex flex-col gap-4">
        <CollectionEditorFields
          name={SAMPLE_COLLECTION.name}
          description={SAMPLE_COLLECTION.description}
          onNameChange={noop}
          onDescriptionChange={noop}
        />
      </div>
    </Skeleton>
  );
}
