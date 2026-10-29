import { defineCanopyQuery } from '../../definitions';
import {
  CoreWorkspaceErrorSchema,
  CoreWorkspaceGetParamsSchema,
  CoreWorkspaceGetResultSchema,
  CoreWorkspaceListParamsSchema,
  CoreWorkspaceListResultSchema,
} from './reads';

export const CORE_WORKSPACE_QUERIES = {
  'core.workspace.list': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.read'],
    params: CoreWorkspaceListParamsSchema,
    result: CoreWorkspaceListResultSchema,
    error: CoreWorkspaceErrorSchema,
  }),
  'core.workspace.get': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.read'],
    params: CoreWorkspaceGetParamsSchema,
    result: CoreWorkspaceGetResultSchema,
    error: CoreWorkspaceErrorSchema,
  }),
};
