import * as yaml from 'js-yaml';
import type { Pipeline } from './document';

/** The YAML document a stored pipeline is saved as, without its `readonly` marker. */
export function serializePipelineDocument(pipeline: Pipeline): string {
  const content: Pipeline = { ...pipeline };
  delete content.readonly;
  return yaml.dump({ pipeline: content }, { lineWidth: 120, noRefs: true });
}
