import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ChatProjectData,
  ChatTabPluginSelections,
  StandaloneProjectFile,
  StandaloneProjectPreset,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_NAME,
} from '@canopy/desktop-shared/types';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { getChatProjectProjectFilePath } from './paths';
import { isRecord } from './type-guards';
import { readStandaloneProjectMetadataFields } from './standalone-project-metadata';

function isPreset(value: unknown): value is StandaloneProjectPreset {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isRecord(value.pluginSelections)
  );
}

function sanitizePresets(
  value: unknown,
): StandaloneProjectPreset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const presets = value.filter(isPreset);
  return presets.length > 0 ? presets : [];
}

function resolveMirroredSelections(
  project: Pick<StandaloneProjectFile, 'defaultPresetId' | 'presets'>,
  fallback?: ChatTabPluginSelections,
): ChatTabPluginSelections | undefined {
  const selectedPreset = project.presets?.find(
    (preset) => preset.id === project.defaultPresetId,
  );
  return selectedPreset?.pluginSelections ?? fallback;
}

export function buildDefaultStandaloneProjectFile(
  project: Pick<ChatProjectData, 'id' | 'name' | 'createdAt'>,
): StandaloneProjectFile {
  return {
    version: 1,
    id: project.id,
    name:
      project.id === DEFAULT_CHAT_PROJECT_ID
        ? DEFAULT_CHAT_PROJECT_NAME
        : project.name.trim() || 'Untitled Project',
    createdAt: project.createdAt,
    settings: {
      archiveRetentionDays: 7,
    },
  };
}

export async function readStandaloneProjectFile(
  projectId: string,
): Promise<StandaloneProjectFile | null> {
  const filePath = getChatProjectProjectFilePath(projectId);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) {
      return null;
    }

    const settings = isRecord(parsed.settings) ? parsed.settings : {};

    return {
      version: 1,
      id: typeof parsed.id === 'string' ? parsed.id : projectId,
      name:
        typeof parsed.name === 'string' && parsed.name.trim()
          ? parsed.name.trim()
          : 'Untitled Project',
      createdAt:
        typeof parsed.createdAt === 'string' && parsed.createdAt
          ? parsed.createdAt
          : new Date().toISOString(),
      ...readStandaloneProjectMetadataFields(parsed),
      ...(sanitizePresets(parsed.presets) !== undefined
        ? { presets: sanitizePresets(parsed.presets) }
        : {}),
      settings: {
        ...(settings.archiveRetentionDays === null ||
        (typeof settings.archiveRetentionDays === 'number' &&
          Number.isInteger(settings.archiveRetentionDays) &&
          settings.archiveRetentionDays >= 0 &&
          settings.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS)
          ? { archiveRetentionDays: settings.archiveRetentionDays }
          : {}),
      },
    };
  } catch {
    return null;
  }
}

function mergeStandaloneProjectState(
  indexProject: ChatProjectData,
  projectFile: StandaloneProjectFile | null,
): ChatProjectData {
  const merged = projectFile ?? buildDefaultStandaloneProjectFile(indexProject);
  return {
    id: indexProject.id,
    name:
      indexProject.id === DEFAULT_CHAT_PROJECT_ID
        ? DEFAULT_CHAT_PROJECT_NAME
        : merged.name || indexProject.name,
    createdAt: merged.createdAt || indexProject.createdAt,
    ...(resolveMirroredSelections(merged, indexProject.defaultPluginSelections)
      ? {
          defaultPluginSelections: resolveMirroredSelections(
            merged,
            indexProject.defaultPluginSelections,
          ),
        }
      : {}),
    ...(merged.color ? { color: merged.color } : {}),
    ...(merged.description ? { description: merged.description } : {}),
    ...(merged.defaultModel ? { defaultModel: merged.defaultModel } : {}),
    ...(merged.defaultPresetId
      ? { defaultPresetId: merged.defaultPresetId }
      : {}),
    ...(merged.presets ? { presets: merged.presets } : {}),
    ...(merged.settings?.archiveRetentionDays !== undefined
      ? { archiveRetentionDays: merged.settings.archiveRetentionDays }
      : {}),
  };
}

export function toStandaloneProjectFile(
  project: ChatProjectData,
  existing?: StandaloneProjectFile | null,
): StandaloneProjectFile {
  const base = existing ?? buildDefaultStandaloneProjectFile(project);
  return {
    ...base,
    version: 1,
    id: project.id,
    name:
      project.id === DEFAULT_CHAT_PROJECT_ID
        ? DEFAULT_CHAT_PROJECT_NAME
        : project.name.trim() || base.name,
    createdAt: project.createdAt || base.createdAt,
    ...(project.color !== undefined ? { color: project.color } : {}),
    ...(project.description !== undefined
      ? { description: project.description }
      : {}),
    ...(project.defaultModel !== undefined
      ? { defaultModel: project.defaultModel }
      : {}),
    ...(project.defaultPresetId !== undefined
      ? { defaultPresetId: project.defaultPresetId }
      : {}),
    ...(project.presets !== undefined ? { presets: project.presets } : {}),
    settings: {
      ...(base.settings ?? {}),
      ...(project.archiveRetentionDays !== undefined
        ? { archiveRetentionDays: project.archiveRetentionDays }
        : {}),
    },
  };
}

export async function saveStandaloneProjectFile(
  projectId: string,
  project: StandaloneProjectFile,
): Promise<void> {
  const filePath = getChatProjectProjectFilePath(projectId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(project, null, 2), 'utf8');
}

export async function loadStandaloneProject(
  indexProject: ChatProjectData,
): Promise<{
  projectFile: StandaloneProjectFile;
  mergedProject: ChatProjectData;
}> {
  const existing = await readStandaloneProjectFile(indexProject.id);
  const mergedProject = mergeStandaloneProjectState(indexProject, existing);
  const projectFile = toStandaloneProjectFile(mergedProject, existing);
  return { projectFile, mergedProject };
}
