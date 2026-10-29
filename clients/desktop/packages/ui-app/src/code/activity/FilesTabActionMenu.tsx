'use client';

import type { JSX } from 'react';
import { FileTreeContextMenu } from './FileTreeContextMenu';
export type FilesTabMenuAction =
  | 'new-file'
  | 'new-folder'
  | 'open'
  | 'mention'
  | 'copy-path'
  | 'rename'
  | 'delete'
  | 'download';
export interface FilesTabActionTarget {
  readonly kind: 'file' | 'directory' | 'background';
  readonly relativePath: string;
  readonly name: string;
  readonly savedCopy: boolean;
  readonly x: number;
  readonly y: number;
}
export interface FilesTabActionMenuProps {
  readonly target: FilesTabActionTarget;
  readonly canMutate: boolean;
  readonly canMention: boolean;
  readonly canDownload: boolean;
  readonly onAction: (
    action: FilesTabMenuAction,
    target: FilesTabActionTarget,
  ) => void;
  readonly onClose: () => void;
}
/** The Files tab's adapter onto the shared file tree right-click menu. */
export function FilesTabActionMenu({
  target,
  canMutate,
  canMention,
  canDownload,
  onAction,
  onClose,
}: FilesTabActionMenuProps): JSX.Element | null {
  const mutable = canMutate && !target.savedCopy;
  const run =
    (action: FilesTabMenuAction): (() => void) =>
    (): void =>
      onAction(action, target);
  return (
    <FileTreeContextMenu
      x={target.x}
      y={target.y}
      onClose={onClose}
      targetKind={target.kind === 'directory' ? 'folder' : target.kind}
      onNewFile={mutable ? run('new-file') : undefined}
      onNewFolder={mutable ? run('new-folder') : undefined}
      onOpen={run('open')}
      onMention={canMention && !target.savedCopy ? run('mention') : undefined}
      onCopyPath={run('copy-path')}
      onRename={mutable ? run('rename') : undefined}
      onDownload={canDownload ? run('download') : undefined}
      onDelete={mutable ? run('delete') : undefined}
    />
  );
}
