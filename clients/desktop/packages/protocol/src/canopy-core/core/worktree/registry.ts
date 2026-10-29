import { defineCanopyQuery } from '../../definitions';
import {
  CoreWorktreeErrorSchema,
  CoreWorktreeGetParamsSchema,
  CoreWorktreeGetResultSchema,
  CoreWorktreeListParamsSchema,
  CoreWorktreeListResultSchema,
} from './reads';

export const CORE_WORKTREE_QUERIES = {
  'core.worktree.list': defineCanopyQuery({
    plane: 'core',
    domain: 'worktree',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.worktree.read'],
    params: CoreWorktreeListParamsSchema,
    result: CoreWorktreeListResultSchema,
    error: CoreWorktreeErrorSchema,
  }),
  'core.worktree.get': defineCanopyQuery({
    plane: 'core',
    domain: 'worktree',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.worktree.read'],
    params: CoreWorktreeGetParamsSchema,
    result: CoreWorktreeGetResultSchema,
    error: CoreWorktreeErrorSchema,
  }),
};
