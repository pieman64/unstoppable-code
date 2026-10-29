import { setOutput } from '../_lib/output';
import { discoverReviewTracks } from './logic';

async function run(): Promise<void> {
  const root = process.env.INPUT_REPOSITORY_ROOT;
  const directory = process.env.INPUT_TRACKS_DIRECTORY;
  if (!root || !directory)
    throw new Error('repository_root and tracks_directory are required');
  const matrix = await discoverReviewTracks(root, directory);
  setOutput('matrix', JSON.stringify(matrix));
  setOutput('reviewer_count', String(matrix.include.length));
  setOutput(
    'track_count',
    String(new Set(matrix.include.map((track) => track.file)).size),
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
