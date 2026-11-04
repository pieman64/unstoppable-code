// Child process for the cross-process store test: one desktop or CLI writer.
import {
  savePipelineModelAliasPreferences,
  savePipelinePluginCollectionPreferences,
  type PipelinePreferenceWriter,
} from '../plugin-collection-store';

function parseWriter(value: string | undefined): PipelinePreferenceWriter {
  if (value === 'electron_main' || value === 'desktop_cli') return value;
  throw new Error(`Unknown writer: ${String(value)}`);
}

async function main(): Promise<void> {
  const [writerArg, prefix, countArg, startAtArg] = process.argv.slice(2);
  const writer = parseWriter(writerArg);
  const count = Number(countArg);
  const startAt = Number(startAtArg);
  while (Date.now() < startAt) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let index = 0; index < count; index += 1) {
    const locator = {
      type: 'file' as const,
      value: `/${prefix}/${index}.yaml`,
    };
    await savePipelinePluginCollectionPreferences(
      locator,
      {
        tools: {
          disabledDefaultKeys: [`${prefix}-${index}`],
          extraSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
            mcpHttpAuthPreferences: [],
          },
        },
      },
      writer,
    );
    await savePipelineModelAliasPreferences(
      locator,
      { reviewer: { mode: 'inline', base: `${prefix}-model-${index}` } },
      writer,
    );
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
