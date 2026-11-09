import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CORE_TERMINAL_SETTINGS_GRANTS,
  type CanopyCallerDescriptor,
  type CoreTerminalSettings,
  type CoreTerminalPreset,
} from '@canopy/protocol/canopy-core';
import type {
  TerminalSettings,
  TerminalPreset,
  UpdateTerminalSettingsRequest,
  UpdateTerminalSettingsResponse,
} from '@canopy/desktop-shared/types';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { isTerminalPresetImageDataUrl } from '@canopy/desktop-shared/lib/terminal-preset-images';
import {
  captureTerminalPresetImages,
  withStagedTerminalPresetImages,
  terminalPresetImageArtifactId,
} from './core-terminal-settings-adapter';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { preserveRuntimeCauseError } from './runtime-cause-error';

export type TerminalSettingsDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

class MissingPresetImageError extends Error {
  constructor() {
    super('Terminal preset image is unavailable.');
  }
}

function toWindow(
  settings: CoreTerminalSettings,
  images: ReadonlyMap<string, string>,
): TerminalSettings {
  const image = (id: string): string => {
    const url = images.get(id);
    if (url === undefined) throw new MissingPresetImageError();
    return url;
  };
  return {
    revision: settings.revision,
    disabledTerminalShellProfileIds: [...settings.disabledProfileIds],
    terminalPresets: settings.presets.map(
      (preset): TerminalPreset => ({
        id: preset.presetId,
        name: preset.name,
        terminalProfileId: preset.profileId,
        command: preset.command,
        enabled: preset.enabled,
        ...(preset.icon === null
          ? {}
          : {
              icon:
                preset.icon.kind === 'character'
                  ? { ...preset.icon }
                  : {
                      kind: 'image',
                      ...(preset.icon.lightArtifactId === null
                        ? {}
                        : { lightDataUrl: image(preset.icon.lightArtifactId) }),
                      ...(preset.icon.darkArtifactId === null
                        ? {}
                        : { darkDataUrl: image(preset.icon.darkArtifactId) }),
                    },
            }),
      }),
    ),
  };
}

export async function readTerminalSettingsThroughCore(
  dispatcher: TerminalSettingsDispatcher,
  caller: CanopyCallerDescriptor,
): Promise<TerminalSettings> {
  const { result, images } = await captureTerminalPresetImages(() =>
    preserveRuntimeCauseError(
      dispatcher.query(
        'core.terminal.settings.get',
        {},
        { caller: { ...caller, grants: [CORE_TERMINAL_SETTINGS_GRANTS.read] } },
      ),
    ),
  );
  return toWindow(result, images);
}

export async function updateTerminalSettingsThroughCore(
  dispatcher: TerminalSettingsDispatcher,
  caller: CanopyCallerDescriptor,
  request: UpdateTerminalSettingsRequest,
): Promise<UpdateTerminalSettingsResponse> {
  if (
    typeof request !== 'object' ||
    request === null ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    typeof request.idempotencyKey !== 'string' ||
    !Array.isArray(request.disabledTerminalShellProfileIds) ||
    !Array.isArray(request.terminalPresets)
  )
    throw new Error('Invalid terminal settings request.');
  try {
    validateId(request.idempotencyKey, 'idempotency key');
  } catch {
    throw new Error('Invalid terminal settings request.');
  }
  const dataUrls: string[] = [];
  for (const preset of request.terminalPresets) {
    if (preset.icon?.kind !== 'image') continue;
    for (const url of [preset.icon.lightDataUrl, preset.icon.darkDataUrl]) {
      if (url === undefined) continue;
      if (!isTerminalPresetImageDataUrl(url))
        return {
          ok: false,
          error: {
            code: 'invalid',
            message:
              'Preset icons must be PNG, JPEG, GIF, WebP, or SVG images.',
          },
        };
      dataUrls.push(url);
    }
  }
  const presets = request.terminalPresets.map(
    (preset): CoreTerminalPreset => ({
      presetId: preset.id,
      name: preset.name,
      profileId: preset.terminalProfileId,
      command: preset.command,
      enabled: preset.enabled,
      icon: !preset.icon
        ? null
        : preset.icon.kind === 'character'
          ? { ...preset.icon }
          : {
              kind: 'image',
              lightArtifactId:
                preset.icon.lightDataUrl === undefined
                  ? null
                  : terminalPresetImageArtifactId(preset.icon.lightDataUrl),
              darkArtifactId:
                preset.icon.darkDataUrl === undefined
                  ? null
                  : terminalPresetImageArtifactId(preset.icon.darkDataUrl),
            },
    }),
  );
  const params = {
    scope: {},
    expectedRevision: request.expectedRevision,
    disabledProfileIds: request.disabledTerminalShellProfileIds,
    presets,
    _meta: { idempotencyKey: request.idempotencyKey },
  };
  try {
    const { result, images } = await withStagedTerminalPresetImages(
      dataUrls,
      () =>
        captureTerminalPresetImages(() =>
          dispatcher.instruction('core.terminal.settings.update', params, {
            caller: {
              ...caller,
              grants: [
                CORE_TERMINAL_SETTINGS_GRANTS.read,
                CORE_TERMINAL_SETTINGS_GRANTS.write,
              ],
            },
            metadata: params._meta,
          }),
        ),
    );
    const available = new Map(
      dataUrls.map((url) => [terminalPresetImageArtifactId(url), url]),
    );
    for (const [id, url] of images) available.set(id, url);
    try {
      return { ok: true, settings: toWindow(result, available) };
    } catch (error) {
      if (!(error instanceof MissingPresetImageError)) throw error;
      return {
        ok: true,
        settings: await readTerminalSettingsThroughCore(dispatcher, caller),
      };
    }
  } catch (error) {
    if (error instanceof CanopyOperationError) {
      if (error.payload.code === 'core.terminal.settingsConflict')
        return {
          ok: false,
          error: {
            code: 'conflict',
            message:
              'Terminal settings changed in another window. Review them and try again.',
            settings: await readTerminalSettingsThroughCore(dispatcher, caller),
          },
        };
      if (
        [
          'core.terminal.settingsInvalid',
          'core.terminal.presetDuplicate',
          'core.terminal.presetIconMissing',
        ].includes(error.payload.code ?? '')
      )
        return {
          ok: false,
          error: {
            code: 'invalid',
            message:
              'Could not save Terminal settings. Check the preset and try again.',
          },
        };
      if (error.runtimeCause instanceof Error) throw error.runtimeCause;
    }
    throw error;
  }
}
