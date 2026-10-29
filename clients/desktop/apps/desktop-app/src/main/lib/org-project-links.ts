import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getOrgProjectLinksFilePath } from './paths';
import { writeFileAtomically } from './atomic-file';

export interface OrgProjectLinksFile {
  version: 1;
  byAccount: Record<string, Record<string, 'dismissed'>>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    (value === null) === false &&
    Array.isArray(value) === false
  );
}
export function normalizeOrgProjectLinks(value: unknown): OrgProjectLinksFile {
  const byAccount: OrgProjectLinksFile['byAccount'] = {};
  if (isRecord(value) && value.version === 1 && isRecord(value.byAccount)) {
    for (const [accountId, entries] of Object.entries(value.byAccount)) {
      if (
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(accountId) === false ||
        ['__proto__', 'constructor', 'prototype'].includes(accountId) ||
        isRecord(entries) === false
      )
        continue;
      const decisions: Record<string, 'dismissed'> = {};
      for (const [key, decision] of Object.entries(entries)) {
        if (
          /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(key) &&
          decision === 'dismissed'
        )
          decisions[key] = 'dismissed';
      }
      if (Object.keys(decisions).length > 0) byAccount[accountId] = decisions;
    }
  }
  return { version: 1, byAccount };
}
export async function readOrgProjectLinks(): Promise<OrgProjectLinksFile> {
  try {
    return normalizeOrgProjectLinks(
      JSON.parse(await readFile(getOrgProjectLinksFilePath(), 'utf8')),
    );
  } catch {
    return { version: 1, byAccount: {} };
  }
}
export async function writeOrgProjectLinks(value: unknown): Promise<void> {
  const file = getOrgProjectLinksFilePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomically(
    file,
    JSON.stringify(normalizeOrgProjectLinks(value)),
    { mode: 0o600 },
  );
}
let pending: Promise<void> = Promise.resolve();
export function dismissOrgProjectLink(
  accountId: string,
  projectId: string,
  personalWorkspaceId: string,
): Promise<void> {
  const operation = pending.then(async (): Promise<void> => {
    const file = await readOrgProjectLinks();
    await writeOrgProjectLinks({
      version: 1,
      byAccount: {
        ...file.byAccount,
        [accountId]: {
          ...file.byAccount[accountId],
          [`${projectId}:${personalWorkspaceId}`]: 'dismissed',
        },
      },
    });
  });
  pending = operation.catch((): void => {});
  return operation;
}
