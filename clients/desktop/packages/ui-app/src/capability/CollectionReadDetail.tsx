'use client';

import { type JSX, type ReactNode } from 'react';
import type {
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
} from '@canopy/protocol';
import {
  DescriptionMarkdown,
  hasMarkdownDescriptionText,
} from '@canopy/ui-shared';
import {
  Stack,
  Button,
  DetailPageActions,
  ExecutionActionButton,
  Heading,
} from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

export type CollectionReadMemberRef =
  | ({ kind: 'skill' } & CollectionSkillRef)
  | ({ kind: 'plugin' } & CollectionPluginRef)
  | ({ kind: 'mcp' } & CollectionMcpRef);

export interface CollectionReadViewModel {
  name: string;
  description: string;
  memberRefs: CollectionReadMemberRef[];
}

export interface CollectionReadResolvedMember {
  ref: CollectionReadMemberRef;
  entryKey: string;
  name: string;
  description: string;
  source: string;
}

export interface CollectionReadDetailProps {
  statusSection?: ReactNode;
  collection: CollectionReadViewModel;
  resolvedMembers: CollectionReadResolvedMember[];
  onOpenEntry?: (member: CollectionReadResolvedMember) => void;
  onEdit?: () => void;
  onImport?: () => void;
  onAdd?: () => void;
  /**
   * Per member kind: true when that host catalog list was truncated in
   * transfer, so an unmatched reference of that kind may exist beyond the
   * transferred prefix. Its unresolved state then explains it could not be
   * verified instead of claiming absence.
   */
  catalogTruncated?: { skill?: boolean; plugin?: boolean; mcp?: boolean };
}

export function collectionMemberRefKey(ref: CollectionReadMemberRef): string {
  if (ref.kind === 'skill') return `skill:${ref.sourceId}/${ref.skillName}`;
  if (ref.kind === 'plugin') {
    return `plugin:${ref.marketplaceId}/${ref.pluginName}`;
  }
  return `mcp:${ref.serverId}/${ref.configId}`;
}

function unresolvedLabel(ref: CollectionReadMemberRef): string {
  if (ref.kind === 'skill') return `Missing skill: ${ref.skillName}`;
  if (ref.kind === 'plugin') return `Missing plugin: ${ref.pluginName}`;
  return `Missing MCP server: ${ref.serverId}`;
}

const GROUPS = [
  { kind: 'skill' as const, label: 'Skills' },
  { kind: 'plugin' as const, label: 'Plugins' },
  { kind: 'mcp' as const, label: 'MCP servers' },
];

export function CollectionReadDetail({
  collection,
  catalogTruncated,
  resolvedMembers,
  onOpenEntry,
  onEdit,
  onImport,
  onAdd,
  statusSection,
}: CollectionReadDetailProps): JSX.Element {
  const resolvedByRef = new Map(
    resolvedMembers.map((member) => [
      collectionMemberRefKey(member.ref),
      member,
    ]),
  );

  return (
    <div className="flex flex-col gap-4" data-testid="collection-read-detail">
      {statusSection}
      {/* Page actions join the detail's action bar at the top right:
          [Import] [Edit] [Share] [Add]. */}
      <DetailPageActions
        secondary={
          onImport || onEdit ? (
            <>
              {onImport && (
                <Button
                  type="button"
                  size="compact"
                  onClick={onImport}
                  data-testid="collection-read-action-import"
                >
                  Import
                </Button>
              )}
              {onEdit && (
                <Button
                  type="button"
                  size="compact"
                  onClick={onEdit}
                  data-testid="collection-read-action-edit"
                >
                  Edit
                </Button>
              )}
            </>
          ) : undefined
        }
        primary={
          onAdd ? (
            <ExecutionActionButton
              label="Add"
              ariaLabel="Add"
              variant="primary"
              placement="detail"
              onClick={onAdd}
              dataTestId="collection-read-action-add"
              stopKeyDownPropagation={false}
            />
          ) : undefined
        }
      />

      <div className="flex flex-col gap-1.5">
        <p className="text-s fg-secondary">Name</p>
        <Surface variant="group">
          <p className="px-3 py-2 text-s fg-primary">{collection.name}</p>
        </Surface>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-s fg-secondary">Description</p>
        <Surface variant="group">
          <div className="px-3 py-2 text-s fg-primary">
            {hasMarkdownDescriptionText(collection.description) ? (
              <DescriptionMarkdown
                tone="primary"
                dataTestId="share-description"
              >
                {collection.description}
              </DescriptionMarkdown>
            ) : (
              <span className="fg-secondary italic">No description.</span>
            )}
          </div>
        </Surface>
      </div>

      {GROUPS.map(({ kind, label }) => {
        const refs = collection.memberRefs.filter((ref) => ref.kind === kind);
        if (refs.length === 0) return null;
        return (
          <Stack
            as="section"
            gap="inline"
            key={kind}
            data-testid={`collection-read-group-${kind}`}
          >
            <Heading level={2} variant="label">
              {label} ({refs.length})
            </Heading>
            <Surface variant="outline" className="overflow-hidden">
              <div className="divide-y">
                {refs.map((ref) => {
                  const refKey = collectionMemberRefKey(ref);
                  const member = resolvedByRef.get(refKey);
                  if (!member) {
                    return (
                      <div
                        key={refKey}
                        data-testid="collection-read-unresolved"
                        className="bg-secondary/20 px-3 py-2"
                      >
                        <p className="text-s font-medium fg-primary">
                          {unresolvedLabel(ref)}
                        </p>
                        <p className="text-xs fg-secondary">
                          {catalogTruncated?.[ref.kind] === true
                            ? 'Couldn\u2019t verify this member \u2014 the catalog list was truncated in transfer.'
                            : 'This collection member is not available in the current catalog.'}
                        </p>
                      </div>
                    );
                  }
                  const content = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-s font-medium fg-primary">
                          {member.name}
                        </span>
                        <span className="block truncate text-xs fg-secondary">
                          {member.description || member.source}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs fg-secondary">
                        {member.source}
                      </span>
                    </>
                  );
                  return onOpenEntry ? (
                    <button
                      key={refKey}
                      type="button"
                      data-testid="collection-read-member"
                      data-entry-key={member.entryKey}
                      onClick={() => onOpenEntry(member)}
                      className="focus-ring flex w-full items-center gap-3 bg-base px-3 py-2 text-left hover:bg-accent-subtle"
                    >
                      {content}
                    </button>
                  ) : (
                    <div
                      key={refKey}
                      data-testid="collection-read-member"
                      data-entry-key={member.entryKey}
                      className="flex items-center gap-3 bg-base px-3 py-2"
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            </Surface>
          </Stack>
        );
      })}
    </div>
  );
}
