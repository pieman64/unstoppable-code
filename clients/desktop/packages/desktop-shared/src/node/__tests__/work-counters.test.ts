import {
  resetChatStorageActivityForTests,
  takeChatStorageActivity,
} from '../chat-storage-activity';
import { serialize } from 'node:v8';
import {
  WORK_COUNTERS_QUERY_KEY,
  WORK_COUNTER_KEY_LIMIT,
  WORK_COUNTER_OVERFLOW_KEY,
  classifyChatStorageFile,
  estimateIpcPayloadBytes,
  installWorkCountersQuery,
  isChatStoragePath,
  recordChatStorageArtifactPublished,
  recordChatStorageAtomicReplacement,
  recordChatStorageCommit,
  recordChatStorageDirectorySync,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
  recordChatStorageIndexClone,
  recordChatStorageIndexParses,
  recordChatStorageIndexSerializations,
  recordChatStorageMutations,
  recordChatStoragePayloadPass,
  recordDelegationSnapshot,
  recordIpcInvoke,
  recordIpcSend,
  recordProviderEventApplied,
  recordProviderEventIngested,
  recordFilesRouteOutcome,
  recordFilesRouteSelected,
  resetWorkCounters,
  snapshotWorkCounters,
  snapshotFilesWorkCounters,
} from '../work-counters';

const SCOPE = '/data/workspaces/w1/chat-storage-v2/scope-1';

function setE2eBuild(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    value,
  });
}

describe('work counters', () => {
  beforeEach(() => {
    setE2eBuild(false);
    resetWorkCounters();
  });

  afterEach(() => {
    setE2eBuild(false);
    Reflect.deleteProperty(globalThis, WORK_COUNTERS_QUERY_KEY);
  });

  it('counts IPC invocations and deliveries per channel and window', () => {
    recordIpcInvoke('chat:load-tabs');
    recordIpcInvoke('chat:load-tabs');
    recordIpcSend('chat:event', 'main', [{ type: 'text' }]);
    recordIpcSend('chat:event', 'app-advisor', [{ type: 'text' }]);
    recordIpcSend('chat:event', 'main', [{ type: 'text' }]);

    expect(snapshotWorkCounters().ipc).toEqual({
      'invoke.chat:load-tabs': 2,
      'send.chat:event.main.messages': 2,
      'send.chat:event.app-advisor.messages': 1,
    });
  });

  it('estimates IPC bytes only in an E2E build that asked for them', () => {
    const args = [{ type: 'text', text: 'hello' }, 7];
    const bytes = serialize(args).byteLength;

    // Production builds never estimate, even when a caller asks.
    resetWorkCounters({ estimateIpcBytes: true });
    recordIpcSend('chat:event', 'main', args);
    expect(snapshotWorkCounters().ipc).toEqual({
      'send.chat:event.main.messages': 1,
    });

    setE2eBuild(true);
    resetWorkCounters();
    recordIpcSend('chat:event', 'main', args);
    expect(snapshotWorkCounters().ipc).toEqual({
      'send.chat:event.main.messages': 1,
    });

    resetWorkCounters({ estimateIpcBytes: true });
    recordIpcSend('chat:event', 'main', args);
    recordIpcSend('chat:event', 'main', args);
    expect(snapshotWorkCounters().ipc).toEqual({
      'send.chat:event.main.messages': 2,
      'send.chat:event.main.bytes': bytes * 2,
    });
    expect(estimateIpcPayloadBytes(args)).toBe(bytes);
  });

  it('counts delegation snapshot stages and estimates bytes only when enabled in E2E', () => {
    const transcript = { detail: '🌲 delegated snapshot' };
    const bytes = Buffer.byteLength(JSON.stringify(transcript), 'utf8');

    recordDelegationSnapshot('offered', transcript);
    recordDelegationSnapshot('published', transcript);
    recordDelegationSnapshot('admitted', transcript);
    expect(snapshotWorkCounters().provider).toEqual({
      'delegationSnapshots.offered': 1,
      'delegationSnapshots.published': 1,
      'delegationSnapshots.admitted': 1,
    });

    // Production ignores byte requests; E2E defaults off after a reset.
    resetWorkCounters({ estimateDelegationBytes: true });
    recordDelegationSnapshot('offered', transcript);
    setE2eBuild(true);
    resetWorkCounters();
    recordDelegationSnapshot('published', transcript);
    expect(snapshotWorkCounters().provider).toEqual({
      'delegationSnapshots.published': 1,
    });

    resetWorkCounters({ estimateDelegationBytes: true });
    recordDelegationSnapshot('offered', transcript);
    recordDelegationSnapshot('published', transcript);
    recordDelegationSnapshot('admitted', transcript);
    expect(snapshotWorkCounters().provider).toEqual({
      'delegationSnapshots.offered': 1,
      'delegationSnapshots.offered.bytes': bytes,
      'delegationSnapshots.published': 1,
      'delegationSnapshots.published.bytes': bytes,
      'delegationSnapshots.admitted': 1,
      'delegationSnapshots.admitted.bytes': bytes,
    });
  });

  it('keeps delegation counts when snapshot JSON serialization fails', () => {
    setE2eBuild(true);
    resetWorkCounters({ estimateDelegationBytes: true });
    const transcript: Record<string, unknown> = {};
    transcript.self = transcript;

    expect(() => recordDelegationSnapshot('offered', transcript)).not.toThrow();
    expect(snapshotWorkCounters().provider).toEqual({
      'delegationSnapshots.offered': 1,
    });
  });

  it('never lets an unserializable payload fail the send it describes', () => {
    setE2eBuild(true);
    resetWorkCounters({ estimateIpcBytes: true });
    const payload = [{ callback: (): void => undefined }];

    expect(estimateIpcPayloadBytes(payload)).toBeUndefined();
    expect(() => recordIpcSend('bad', 'main', payload)).not.toThrow();
    expect(snapshotWorkCounters().ipc).toEqual({
      'send.bad.main.messages': 1,
    });
  });

  it('forwards only transcript classes as transcript scope bytes', () => {
    resetChatStorageActivityForTests();
    recordChatStorageFileWrite(`${SCOPE}/transcripts/c.jsonl`, 4, false);
    recordChatStorageFileWrite(`${SCOPE}/transcripts/c.append.tmp`, 6, true);
    recordChatStorageFileWrite(`${SCOPE}/transcripts/c.active.json`, 100, true);
    expect(takeChatStorageActivity()?.total.transcriptBytesWritten).toBe(10);
  });

  it('classifies chat storage files by the role they play in a v2 scope', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(classifyChatStorageFile(`${SCOPE}/metadata-journal.jsonl`)).toBe(
      'journal',
    );
    expect(
      classifyChatStorageFile(`${SCOPE}/metadata-journal.jsonl.${uuid}.tmp`),
    ).toBe('journal');
    // The delta journal has its own class, apart from the version 2 journal.
    expect(classifyChatStorageFile(`${SCOPE}/delta-journal.log`)).toBe(
      'deltaJournal',
    );
    expect(
      classifyChatStorageFile(`${SCOPE}/delta-journal.log.${uuid}.tmp`),
    ).toBe('deltaJournal');
    expect(
      classifyChatStorageFile(`${SCOPE}/delta-journal-tail-quarantine-1.bin`),
    ).toBe('other');
    expect(classifyChatStorageFile(`${SCOPE}/live-index.json`)).toBe(
      'liveIndex',
    );
    expect(
      classifyChatStorageFile(`${SCOPE}/archive-index.json.${uuid}.tmp`),
    ).toBe('archiveIndex');
    expect(classifyChatStorageFile(`${SCOPE}/recovery-index.json`)).toBe(
      'recoveryIndex',
    );
    expect(
      classifyChatStorageFile(`${SCOPE}/pending-transcripts/${uuid}/0.jsonl`),
    ).toBe('payload');
    expect(classifyChatStorageFile(`${SCOPE}/transcripts/chat-1.jsonl`)).toBe(
      'transcript',
    );
    expect(
      classifyChatStorageFile(
        `${SCOPE}/transcripts/chat-1.${uuid}.rewrite.tmp`,
      ),
    ).toBe('transcript');
    expect(
      classifyChatStorageFile(`${SCOPE}/transcripts/chat-1.${uuid}.append.tmp`),
    ).toBe('appendStaging');
    expect(
      classifyChatStorageFile(
        `${SCOPE}/transcripts/chat-1.active.json.${uuid}.tmp`,
      ),
    ).toBe('activeSidecar');
    expect(
      classifyChatStorageFile(`${SCOPE}/transcripts/chat-1.index.json`),
    ).toBe('transcriptIndex');
    expect(
      classifyChatStorageFile(`${SCOPE}/transcripts/chat-1.turns.json`),
    ).toBe('turnIndex');
    expect(
      classifyChatStorageFile(
        `${SCOPE}/transcripts/message-index/chat-1.${uuid}.tmp/abc.json`,
      ),
    ).toBe('messageIndex');
    expect(
      classifyChatStorageFile(
        `${SCOPE}/transcripts/tool-output/chat-1/sha256-v1-abc.txt`,
      ),
    ).toBe('artifact');
    expect(
      classifyChatStorageFile(
        '/data/workspaces/w1/chat-storage-manifests/scope-1.json',
      ),
    ).toBe('manifest');
    expect(classifyChatStorageFile(`${SCOPE}/unexpected.bin`)).toBe('other');
    expect(
      classifyChatStorageFile(
        'C:\\data\\chat-storage-v2\\scope\\live-index.json',
      ),
    ).toBe('liveIndex');
    expect(classifyChatStorageFile('/data/app-advisor/watchers.json')).toBe(
      undefined,
    );
    expect(isChatStoragePath(`${SCOPE}/transcripts`)).toBe(true);
    expect(isChatStoragePath('/data/workspaces/w1/chat-storage-v2')).toBe(true);
    expect(isChatStoragePath('/data/workspaces/w1/chats')).toBe(false);
  });

  it('counts chat storage syncs, bytes, and replacements only for chat storage paths', () => {
    recordChatStorageFileWrite(`${SCOPE}/metadata-journal.jsonl`, 120, true);
    recordChatStorageFileSync(`${SCOPE}/metadata-journal.jsonl`);
    recordChatStorageFileWrite(`${SCOPE}/transcripts/chat-1.jsonl`, 64, false);
    recordChatStorageFileSync(`${SCOPE}/transcripts/chat-1.jsonl`);
    recordChatStorageDirectorySync(SCOPE);
    recordChatStorageDirectorySync(`${SCOPE}/transcripts`);
    recordChatStorageAtomicReplacement(`${SCOPE}/live-index.json`);
    // Other writers share the same primitives; they are not chat storage.
    recordChatStorageFileWrite('/data/app-advisor/watchers.json', 99, true);
    recordChatStorageFileSync('/data/app-advisor/watchers.json');
    recordChatStorageDirectorySync('/data/app-advisor');
    recordChatStorageAtomicReplacement('/data/app-advisor/watchers.json');

    expect(snapshotWorkCounters().chatStorage).toEqual({
      'serialized.journal.bytes': 120,
      'written.journal.bytes': 120,
      'written.transcript.bytes': 64,
      'syncs.file': 2,
      'syncs.directory': 2,
      atomicReplacements: 1,
    });
  });

  it('counts commits, mutations, index work, artifacts, and provider events', () => {
    recordChatStorageCommit();
    recordChatStorageMutations(3);
    recordChatStorageMutations(0);
    recordChatStorageIndexSerializations(3);
    recordChatStorageIndexClone();
    recordChatStorageIndexClone();
    recordChatStorageIndexParses(3);
    recordChatStoragePayloadPass(true);
    recordChatStoragePayloadPass(false);
    recordChatStorageArtifactPublished();
    recordProviderEventIngested();
    recordProviderEventIngested();
    recordProviderEventApplied();

    const snapshot = snapshotWorkCounters();
    expect(snapshot.chatStorage).toEqual({
      commits: 1,
      mutations: 3,
      indexSerializations: 3,
      indexClones: 2,
      indexParses: 3,
      payloadReads: 2,
      payloadParses: 2,
      payloadHashes: 1,
      artifactsPublished: 1,
    });
    expect(snapshot.provider).toEqual({ eventsIngested: 2, eventsApplied: 1 });
  });

  it('bounds distinct keys per source and reports what overflowed', () => {
    for (let index = 0; index < WORK_COUNTER_KEY_LIMIT + 5; index += 1) {
      recordIpcInvoke(`channel-${index}`);
    }
    recordIpcInvoke('channel-0');

    const ipc = snapshotWorkCounters().ipc;
    expect(Object.keys(ipc)).toHaveLength(WORK_COUNTER_KEY_LIMIT + 1);
    expect(ipc['invoke.channel-0']).toBe(2);
    expect(ipc[WORK_COUNTER_OVERFLOW_KEY]).toBe(5);
  });

  it('starts a new generation on every reset and returns detached snapshots', () => {
    recordProviderEventIngested();
    const before = snapshotWorkCounters();
    const reset = resetWorkCounters();

    expect(reset.generation).toBe(before.generation + 1);
    expect(reset).toEqual({
      generation: before.generation + 1,
      ipc: {},
      chatStorage: {},
      provider: {},
      route: {},
    });
    before.provider.eventsIngested = 99;
    expect(snapshotWorkCounters().provider).toEqual({});
  });

  it('counts the backend each routed Files read used, apart from the other sources', () => {
    resetWorkCounters();
    recordFilesRouteSelected('roots', 'direct');
    recordFilesRouteSelected('roots', 'daemon');
    recordFilesRouteOutcome('roots', 'daemon.queries');
    recordFilesRouteOutcome('roots', 'daemon.retries');
    recordFilesRouteOutcome('roots', 'daemon.queries');
    recordFilesRouteOutcome('roots', 'daemon.served');
    recordFilesRouteSelected('directory', 'daemon');
    recordFilesRouteOutcome('directory', 'daemon.failed.not_found');
    recordFilesRouteSelected('directory', 'direct');
    recordFilesRouteOutcome('directory', 'direct.discarded');

    const snapshot = snapshotWorkCounters();
    expect(snapshot.route).toEqual({
      'files.roots.direct': 1,
      'files.roots.daemon': 1,
      'files.roots.daemon.queries': 2,
      'files.roots.daemon.retries': 1,
      'files.roots.daemon.served': 1,
      'files.directory.daemon': 1,
      'files.directory.daemon.failed.not_found': 1,
      'files.directory.direct': 1,
      'files.directory.direct.discarded': 1,
    });
    expect(snapshot.ipc).toEqual({});
    expect(resetWorkCounters().route).toEqual({});
  });

  it('exposes the snapshot and reset query only in E2E builds', () => {
    expect(installWorkCountersQuery()).toBe(false);
    expect(Reflect.get(globalThis, WORK_COUNTERS_QUERY_KEY)).toBeUndefined();

    setE2eBuild(true);
    expect(installWorkCountersQuery()).toBe(true);
    const query = globalThis.__CANOPY_WORK_COUNTERS__;
    if (!query) throw new Error('Expected the work counters query');

    recordProviderEventIngested();
    expect(query.snapshot().provider).toEqual({ eventsIngested: 1 });
    const reset = query.reset({ estimateIpcBytes: true });
    expect(reset.provider).toEqual({});
    recordIpcSend('chat:event', 'main', ['x']);
    expect(query.snapshot().ipc).toEqual({
      'send.chat:event.main.messages': 1,
      'send.chat:event.main.bytes': serialize(['x']).byteLength,
    });
  });
});

describe('production Files projection', () => {
  it('reads the actual counters without the E2E getter, reset or private keys', () => {
    setE2eBuild(false);
    resetWorkCounters();
    recordIpcInvoke('file-tree:roots');
    recordIpcInvoke('file-tree:directory');
    recordIpcInvoke('file:read-content');
    recordIpcInvoke('file-index:get');
    recordIpcInvoke('file-reference:resolve');
    recordIpcInvoke('file-reference:resolve');
    recordIpcInvoke('/private/credential');
    recordFilesRouteSelected('roots', 'daemon');
    recordFilesRouteSelected('file', 'direct');
    recordFilesRouteSelected('search', 'direct');
    recordFilesRouteSelected('search', 'direct');
    recordFilesRouteSelected('link', 'direct');
    recordFilesRouteOutcome('roots', 'daemon.served');
    recordFilesRouteOutcome('directory', 'daemon.failed.permission_denied');
    const evidence = snapshotFilesWorkCounters();
    expect(evidence).toMatchObject({
      invocations: { roots: 1, directory: 1, file: 1, search: 1, link: 2 },
      overflow: 0,
    });
    expect(evidence.route['files.file.direct']).toBe(1);
    expect(evidence.route['files.link.direct']).toBe(1);
    expect(evidence.route['files.link.daemon']).toBe(0);
    expect(evidence.route['files.file.daemon']).toBe(0);
    // One index call searched two roots.
    expect(evidence.route['files.search.direct']).toBe(2);
    expect(evidence.route['files.search.daemon']).toBe(0);
    expect(evidence.route['files.roots.daemon']).toBe(1);
    expect(evidence.route['files.roots.daemon.served']).toBe(1);
    expect(
      evidence.route['files.directory.daemon.failed.permission_denied'],
    ).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain('private');
    expect(installWorkCountersQuery()).toBe(false);
    evidence.route['files.roots.daemon'] = 99;
    expect(snapshotFilesWorkCounters().route['files.roots.daemon']).toBe(1);
    for (let i = 0; i <= WORK_COUNTER_KEY_LIMIT; i++)
      recordIpcInvoke(`private-${i}`);
    expect(snapshotFilesWorkCounters().overflow).toBeGreaterThan(0);
  });
});
