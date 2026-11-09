import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { PipelineEditorToolKey } from '@canopy/desktop-shared/lib/pipeline-editor-tools';

/**
 * CAN-5822: the interface tools each Pipeline Editor agent tool needs from
 * the main window's lease. A tool is listed only when its session bound all
 * of them; tools absent here run in main and are always listed.
 */
const REQUIRED_INTERFACE_TOOLS: Partial<
  Record<PipelineEditorToolKey, readonly InterfaceToolName[]>
> = {
  pipeline_list: ['ui.pipeline_editor.list'],
  pipeline_open: ['ui.pipeline_editor.open'],
  pipeline_create: ['ui.pipeline_editor.create'],
  pipeline_get_current: ['ui.pipeline_editor.get_current'],
  pipeline_set_yaml: [
    'ui.pipeline_editor.set_yaml',
    'ui.pipeline_editor.adopt_saved',
  ],
  pipeline_save: [
    'ui.pipeline_editor.prepare_save',
    'ui.pipeline_editor.adopt_saved',
  ],
  navigation_to_list: ['ui.pipeline_editor.to_list'],
};

export function isPipelineEditorToolAdvertised(
  key: PipelineEditorToolKey,
  interfaceTools: readonly InterfaceToolName[] | undefined,
): boolean {
  return (REQUIRED_INTERFACE_TOOLS[key] ?? []).every(
    (name) => interfaceTools?.includes(name) ?? false,
  );
}
