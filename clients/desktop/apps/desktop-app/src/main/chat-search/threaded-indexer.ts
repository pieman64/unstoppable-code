import {
  isIndexedChatSearchBodies,
  type ChatSearchDoc,
  type ChatSearchSource,
} from './indexer';
import { ChatSearchIndexWorkerRunner } from './index-worker-runner';
import {
  type AsyncIndexMethods,
  type IndexWorkerMethod,
} from './index-worker-contract';
import { isRecord } from '../lib/type-guards';

export type ThreadedChatSearchIndexer = AsyncIndexMethods & {
  ready: Promise<string>;
  /** The worker failed and rejects all further work until replaced. */
  isFailed: () => boolean;
  flush: () => Promise<void>;
  close: () => Promise<void>;
  replaceStreamedScope: (
    projectId: string,
    worktreeId: string,
    source: ChatSearchSource,
    docs: AsyncIterable<ChatSearchDoc>,
    isCurrent?: () => boolean,
  ) => Promise<void>;
};

export function createThreadedChatSearchIndexer(
  dbPath: string,
): ThreadedChatSearchIndexer {
  const runner = new ChatSearchIndexWorkerRunner(dbPath);
  const runVoid = async (
    method: IndexWorkerMethod,
    args: unknown[],
  ): Promise<void> => {
    await runner.run(method, args);
  };
  const methods: AsyncIndexMethods = {
    replaceWorktreePlans: (...args) => runVoid('replaceWorktreePlans', args),
    upsertCoworkArchive: (...args) => runVoid('upsertCoworkArchive', args),
    upsertDoc: (...args) => runVoid('upsertDoc', args),
    deleteArchivedContainerDocs: (...args) =>
      runVoid('deleteArchivedContainerDocs', args),
    deleteChatDoc: (...args) => runVoid('deleteChatDoc', args),
    deleteDocById: (...args) => runVoid('deleteDocById', args),
    deleteWorktreeDocs: (...args) => runVoid('deleteWorktreeDocs', args),
    deleteWorkspaceDocs: (...args) => runVoid('deleteWorkspaceDocs', args),
    getSourceFingerprint: async (...args) => {
      const value = await runner.run('getSourceFingerprint', args);
      if (value === null) return null;
      if (
        !isRecord(value) ||
        typeof value.mtimeMs !== 'number' ||
        typeof value.sizeBytes !== 'number'
      )
        throw new Error('Invalid search index fingerprint response');
      return { mtimeMs: value.mtimeMs, sizeBytes: value.sizeBytes };
    },
    setSourceFingerprint: (...args) => runVoid('setSourceFingerprint', args),
    listSourceFileKeys: async (...args) => {
      const value = await runner.run('listSourceFileKeys', args);
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string')
      )
        throw new Error('Invalid search index source-key response');
      return value;
    },
    deleteSourceFile: (...args) => runVoid('deleteSourceFile', args),
    getMetadata: async (...args) => {
      const value = await runner.run('getMetadata', args);
      if (value !== null && typeof value !== 'string')
        throw new Error('Invalid search index metadata response');
      return value;
    },
    setMetadata: (...args) => runVoid('setMetadata', args),
    getIndexedBodiesIfTranscriptUnchanged: async (...args) => {
      const value = await runner.run(
        'getIndexedBodiesIfTranscriptUnchanged',
        args,
      );
      if (value !== null && !isIndexedChatSearchBodies(value))
        throw new Error('Invalid search index body response');
      return value;
    },
    getIndexedCommittedFingerprint: async (...args) => {
      const value = await runner.run('getIndexedCommittedFingerprint', args);
      if (value !== null && typeof value !== 'string')
        throw new Error('Invalid search index fingerprint response');
      return value;
    },
    replaceActiveBodyIfCommittedUnchanged: async (...args) => {
      const value = await runner.run(
        'replaceActiveBodyIfCommittedUnchanged',
        args,
      );
      if (typeof value !== 'boolean')
        throw new Error('Invalid search index in-flight text response');
      return value;
    },
    updateDocMetadataIfTranscriptUnchanged: async (...args) => {
      const value = await runner.run(
        'updateDocMetadataIfTranscriptUnchanged',
        args,
      );
      if (typeof value !== 'boolean')
        throw new Error('Invalid search index metadata response');
      return value;
    },
    beginStagedScope: async (...args) => {
      const value = await runner.run('beginStagedScope', args);
      if (typeof value !== 'string')
        throw new Error('Invalid search index staging response');
      return value;
    },
    stageScopeDoc: (...args) => runVoid('stageScopeDoc', args),
    commitStagedScope: (...args) => runVoid('commitStagedScope', args),
    discardStagedScope: (...args) => runVoid('discardStagedScope', args),
    beginChildDocumentStage: async (...args) => {
      const value = await runner.run('beginChildDocumentStage', args);
      if (typeof value !== 'string')
        throw new Error('Invalid child-document staging response');
      return value;
    },
    reuseChildDocument: async (...args) => {
      const value = await runner.run('reuseChildDocument', args);
      if (typeof value !== 'boolean')
        throw new Error('Invalid child-document reuse response');
      return value;
    },
    stageChildDocument: (...args) => runVoid('stageChildDocument', args),
    commitChildDocumentStage: async (...args) => {
      const value = await runner.run('commitChildDocumentStage', args);
      if (typeof value !== 'boolean')
        throw new Error('Invalid child-document commit response');
      return value;
    },
    discardChildDocumentStage: (...args) =>
      runVoid('discardChildDocumentStage', args),
  };
  return {
    ...methods,
    ready: runner.ready,
    isFailed: (): boolean => runner.hasFailed(),
    flush: async (): Promise<void> => {
      await runner.run('barrier');
    },
    close: (): Promise<void> => runner.close(),
    replaceStreamedScope: async (
      projectId,
      worktreeId,
      source,
      docs,
      isCurrent = (): boolean => true,
    ): Promise<void> => {
      const job = await methods.beginStagedScope();
      let ordinal = 0;
      try {
        for await (const doc of docs) {
          if (!isCurrent()) return;
          await methods.stageScopeDoc(job, ordinal++, doc);
        }
        if (isCurrent())
          await methods.commitStagedScope(job, projectId, worktreeId, source);
      } finally {
        await methods.discardStagedScope(job);
      }
    },
  };
}
