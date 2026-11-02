import {
  createCorePipelineDefinitionHandlers,
  type CorePipelineDefinitionHandlers,
  type CorePipelineDefinitionHost,
  type PipelineDefinitionService,
} from '@canopy/core-runtime/node/pipeline';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

let desktopService: Promise<PipelineDefinitionService> | undefined;

// Loaded on the first call: the sources import the pipeline, cloud and
// sidebar modules, which import back into the runtime.
export const desktopPipelineDefinitionHost: CorePipelineDefinitionHost = {
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  load: () => {
    desktopService ??=
      import('../pipelines/core-pipeline-definition-sources').then((module) =>
        module.createDesktopPipelineDefinitionService(),
      );
    return desktopService;
  },
};

/** `core.pipeline.definition.*` handlers over the desktop's sources. */
export function createCorePipelineDefinitionAdapter(
  host: CorePipelineDefinitionHost = desktopPipelineDefinitionHost,
): CorePipelineDefinitionHandlers {
  return createCorePipelineDefinitionHandlers(host);
}
