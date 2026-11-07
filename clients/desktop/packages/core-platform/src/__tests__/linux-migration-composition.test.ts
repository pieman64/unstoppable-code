import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createLinuxMigrationComposition,
  prepareLinuxMigrationQualification,
  LINUX_MIGRATION_PRODUCTION_ENABLED,
  type LinuxMigrationQualificationPolicy,
} from '../linux-migration';
import { createHostTrustGeneration } from '../prepared-trust';
import {
  createOwnedChildServices,
  type OwnedChildLaunch,
} from '../supervision/owned-child';

const root = path.resolve(__dirname, '../../../..');
const hash = (file: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
const eligible = {
  migrationRole: 'eligible',
  disabledReasons: [],
  violations: [],
};
const suite = process.platform === 'linux' ? describe : describe.skip;
let dir = '',
  addon = '',
  helper = '',
  other = '',
  code = '';
let supportsChannels = false;
const launches = new Set<OwnedChildLaunch>();
const disposers: Array<() => void> = [];
function policy(): LinuxMigrationQualificationPolicy {
  const file = (path: string): { path: string; digest: string } => ({
    path,
    digest: hash(path),
  });
  return {
    source: 'injected-test-policy',
    installForm: 'system-deb',
    packageReport: eligible,
    expectations: {
      os: 'linux',
      installedPackageIdentity: 'labelled-fixture-deb',
      continuity: 'process-instance',
      launcherDigest: hash(helper),
      daemonDigest: hash(helper),
      package: {
        flavorId: 'com.fixture.app',
        secureMode: 'secure',
        buildId: 'fixture-L3',
        packageDigest: hash(code),
        codeDigest: hash(code),
        nativeDigest: hash(addon),
        updateEpoch: 'fixture-1',
      },
    },
    files: {
      launcher: file(helper),
      daemon: file(helper),
      code: file(code),
      native: file(addon),
      peer: file(addon),
    },
    argv: { launcher: [helper, helper], daemon: [helper, helper] },
    current: () => true,
  };
}
function compose(input = policy()): {
  prepared: NonNullable<ReturnType<typeof prepareLinuxMigrationQualification>>;
  composed: NonNullable<ReturnType<typeof createLinuxMigrationComposition>>;
} {
  const prepared = prepareLinuxMigrationQualification(input);
  if (!prepared) throw new Error('Fixture package preparation refused');
  disposers.push(prepared.invalidate);
  const composed = createLinuxMigrationComposition(prepared.capability);
  if (!composed) throw new Error('Fixture capability refused');
  disposers.push(() => composed.close());
  return { prepared, composed };
}
async function launch(
  composed: ReturnType<typeof compose>['composed'],
  target = helper,
): Promise<OwnedChildLaunch | null> {
  try {
    const item = await composed.spawn({
      executable: helper,
      args: [target],
      environment: {},
    });
    launches.add(item);
    let ready = '';
    while (ready.length < 5) {
      const bytes = await item.channel.read(AbortSignal.timeout(5000));
      if (!bytes) throw new Error('Unexpected fixture EOF');
      ready += Buffer.from(bytes).toString();
    }
    expect(ready).toBe('ready');
    return item;
  } catch (error) {
    if (supportsChannels) throw error;
    // Unsupported Linux kernels MUST assert a refusal, never skip qualification.
    expect(error).toMatchObject({
      code: 'capability_unavailable',
      message: 'Linux launcher channels require stale-sender pidfds and pidfs.',
    });
    return null;
  }
}

describe('Linux composition authority boundary', () => {
  it('keeps production disabled and refuses forged, cloned and wrong-scope capabilities', () => {
    expect(LINUX_MIGRATION_PRODUCTION_ENABLED).toBe(false);
    for (const value of [
      null,
      {},
      { scope: 'package-admission' },
      createHostTrustGeneration('native-preparation').issue(),
      createHostTrustGeneration('package-admission').issue(),
    ])
      expect(createLinuxMigrationComposition(value)).toBeNull();
  });
});

suite('Disabled Linux L3 prepared composition (CAN-5890)', () => {
  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'linux-L3-')));
    addon = path.join(dir, 'core-owned-child.node');
    helper = path.join(dir, 'fixture');
    other = path.join(dir, 'other');
    code = path.join(dir, 'fixture.c');
    execFileSync(
      process.execPath,
      ['scripts/build-peer-identity.mjs', '--out', addon],
      { cwd: root },
    );
    writeFileSync(
      code,
      `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
static void put(const char *p,int n){while(n){int k=send(3,p,n,MSG_NOSIGNAL);if(k<0&&errno==EINTR)continue;if(k<=0)_exit(20);p+=k;n-=k;}}
int main(int argc,char **argv){
if(argc==7){int pair[2],on=1;if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair))return 35;
for(int i=0;i<2;i++)if(setsockopt(pair[i],SOL_SOCKET,SO_PASSCRED,&on,sizeof on))return 36;
pid_t child=fork();if(child==0){int fd=fcntl(pair[1],F_DUPFD_CLOEXEC,10);if(fd<0)_exit(37);close(pair[0]);close(pair[1]);if(dup2(fd,3)<0)_exit(38);close(fd);execl(argv[2],argv[2],"--import",argv[3],argv[4],argv[5],NULL);_exit(39);}
if(child<0)return 40;close(pair[1]);if(write(pair[0],"start",5)!=5)return 41;char out[128];int n=read(pair[0],out,sizeof out);if(n<=0)return 42;if(write(1,out,n)!=n)return 43;close(pair[0]);int status;waitpid(child,&status,0);return WIFEXITED(status)?WEXITSTATUS(status):44;}
if(argc!=2)return 21;put("ready",5);char b;while(read(3,&b,1)==1){if(b=='x')return 0;if(b=='c'){close(3);pause();return 0;}if(b=='e'){execl(argv[1],argv[0],argv[1],NULL);return 22;}if(b=='f'){if(fork()==0){put("other",5);_exit(0);}wait(NULL);}else put("ready",5);}return 0;}
`,
    );
    execFileSync('/usr/bin/cc', ['-O2', code, '-o', helper]);
    copyFileSync(helper, other);
    // Establish kernel capability through the canonical addon name independently
    // of composition. Cached fault payloads must not turn positives into refusals.
    try {
      const probe = await createOwnedChildServices({
        os: 'linux',
        nativePath: addon,
      }).spawnWithChannel({
        executable: helper,
        args: [helper],
        environment: {},
      });
      supportsChannels = true;
      probe.channel.close();
      await probe.child.terminate(AbortSignal.timeout(5000));
    } catch (error) {
      expect(error).toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
    }
  });
  afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    for (const item of launches) {
      item.channel.close();
      await item.child.terminate(AbortSignal.timeout(5000));
    }
    launches.clear();
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(['no-passpidfd', 'no-stale-sender'])(
    'refuses missing SCM_PIDFD capability through composed spawn/adoption: %s',
    async (fault) => {
      const wrapper = path.join(dir, `${fault}.c`),
        out = path.join(dir, `${fault}.node`);
      const source = path.join(
        root,
        'packages/core-platform/native/owned-child/src/owned_child.c',
      );
      writeFileSync(
        wrapper,
        `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
static int denied_option(int fd,int level,int option,const void *value,socklen_t length) {
  if(option==76){errno=ENOPROTOOPT;return -1;}return setsockopt(fd,level,option,value,length);
}
static ssize_t denied_stale(int fd,struct msghdr *m,int flags) {
  ssize_t n=recvmsg(fd,m,flags);if(n<=0)return n;
  for(struct cmsghdr *c=CMSG_FIRSTHDR(m);c;c=CMSG_NXTHDR(m,c)){
    if(c->cmsg_level==SOL_SOCKET && c->cmsg_type==4 && c->cmsg_len==CMSG_LEN(sizeof(int))){
      int old;memcpy(&old,CMSG_DATA(c),sizeof old);if(old>=0)close(old);
      int refused=-EINVAL;memcpy(CMSG_DATA(c),&refused,sizeof refused);
    }
  }return n;
}
${fault === 'no-passpidfd' ? '#define setsockopt denied_option' : '#define recvmsg denied_stale'}
#include ${JSON.stringify(source)}
`,
      );
      execFileSync('/usr/bin/cc', [
        '-shared',
        '-fPIC',
        '-O2',
        '-DNAPI_VERSION=8',
        '-I',
        path.resolve(path.dirname(process.execPath), '../include/node'),
        wrapper,
        '-o',
        out,
      ]);
      const p = policy();
      const { prepared, composed } = compose({
        ...p,
        files: { ...p.files, peer: { path: out, digest: hash(out) } },
      });
      await expect(
        composed.spawn({ executable: helper, args: [helper], environment: {} }),
      ).rejects.toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
      let connectionError: unknown;
      try {
        composed.connect(process.pid);
      } catch (error) {
        connectionError = error;
      }
      expect(connectionError).toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
      composed.close();
      prepared.invalidate();
      // A new generation must load its own inode after the fault fd is released.
      const fresh = compose();
      const item = await launch(fresh.composed);
      if (item)
        expect(fresh.composed.verifyDestination(item.channel).verified).toBe(
          true,
        );
    },
  );

  it('composes an exact-image destination, channel-bound receipts and permanent invalidation', async () => {
    const { prepared, composed } = compose();
    expect(
      createLinuxMigrationComposition({ ...prepared.capability }),
    ).toBeNull();
    const item = await launch(composed);
    if (!item) return;
    const result = composed.verifyDestination(item.channel);
    if (!result.verified) throw new Error(result.reason);
    expect(result.evidence).toMatchObject({
      os: 'linux',
      peer: { artifact: { package: { buildId: 'fixture-L3' } } },
    });
    expect(composed.lookup(result.handle, item.channel)).toBe(result.evidence);
    expect(composed.lookup(result.handle, {})).toBeNull();
    expect(composed.verifyDestination(item.channel)).toEqual({
      verified: false,
      reason: 'replay',
    });
    prepared.invalidate();
    expect(composed.lookup(result.handle, item.channel)).toBeNull();
    expect(createLinuxMigrationComposition(prepared.capability)).toBeNull();
    await expect(
      composed.spawn({ executable: helper, args: [helper], environment: {} }),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
  });

  it('refuses an empty install-form identifier', () => {
    expect(
      prepareLinuxMigrationQualification({ ...policy(), installForm: '' }),
    ).toBeNull();
  });
  it.each([
    'AppImage',
    'tar',
    'rpm',
    'snap',
    'flatpak',
    'development',
    'user-writable-deb',
    'unspecified-form',
  ])('refuses unsupported install form %s', (installForm) => {
    expect(
      prepareLinuxMigrationQualification({ ...policy(), installForm }),
    ).toBeNull();
  });
  it.each([
    { migrationRole: 'disabled', disabledReasons: [], violations: [] },
    {
      migrationRole: 'disabled',
      disabledReasons: ['fuse:runAsNode'],
      violations: [],
    },
    { migrationRole: 'eligible', disabledReasons: ['inert'], violations: [] },
    {
      migrationRole: 'eligible',
      disabledReasons: [],
      violations: ['wrong build'],
    },
    {},
    null,
  ])(
    'refuses disabled or malformed package reports %# before native loading',
    (packageReport) => {
      expect(
        prepareLinuxMigrationQualification({ ...policy(), packageReport }),
      ).toBeNull();
    },
  );
  it.each(['launcher', 'daemon', 'code', 'native', 'peer'] as const)(
    'refuses a replaced %s pin',
    (member) => {
      const p = policy();
      expect(
        prepareLinuxMigrationQualification({
          ...p,
          files: {
            ...p.files,
            [member]: {
              ...p.files[member],
              digest: `sha256:${'0'.repeat(64)}`,
            },
          },
        }),
      ).toBeNull();
    },
  );
  it('refuses redirected files and unauthenticated package metadata', () => {
    const link = path.join(dir, 'link');
    symlinkSync(helper, link);
    try {
      const p = policy();
      expect(
        prepareLinuxMigrationQualification({
          ...p,
          files: { ...p.files, launcher: { path: link, digest: hash(helper) } },
        }),
      ).toBeNull();
    } finally {
      rmSync(link);
    }
    expect(
      createLinuxMigrationComposition({
        ...policy(),
        scope: 'package-admission',
      }),
    ).toBeNull();
  });
  it.each([
    'CLI',
    '--type=renderer',
    '--type=utility',
    'product-child',
    '--run-as-node',
  ])('refuses a non-role invocation %s', async (arg) => {
    const p = policy();
    const { composed } = compose({
      ...p,
      argv: { ...p.argv, daemon: [helper, arg] },
    });
    const item = await launch(composed);
    if (!item) return;
    expect(composed.verifyDestination(item.channel)).toEqual({
      verified: false,
      reason: 'role',
    });
  });
  it('refuses remote, token and claimed-Electron channels without native custody', () => {
    const { composed } = compose();
    for (const fake of [
      { token: 'endpoint' },
      { remote: true },
      { role: 'electron-main' },
    ])
      expect(composed.verifyLauncher(fake)).toEqual({
        verified: false,
        reason: 'no-native-peer',
      });
  });
  it.each([
    'exit',
    'close',
    'delegate',
    'exec',
    'update',
    'replacement',
  ] as const)('retires composed evidence on %s', async (action) => {
    let current = true;
    const p = policy();
    const target = action === 'exec' ? other : helper;
    const { composed } = compose({
      ...p,
      argv: { ...p.argv, daemon: [helper, target] },
      current: () => current,
    });
    const item = await launch(composed, target);
    if (!item) return;
    const result = composed.verifyDestination(item.channel);
    if (!result.verified) throw new Error(result.reason);
    if (action === 'exit') {
      await item.channel.write(Buffer.from('x'));
      await item.child.exited;
    }
    if (action === 'close') item.channel.close();
    if (action === 'exec') {
      await item.channel.write(Buffer.from('e'));
      await item.channel.read(AbortSignal.timeout(5000));
    }
    if (action === 'delegate') {
      await item.channel.write(Buffer.from('f'));
      await expect(
        item.channel.read(AbortSignal.timeout(5000)),
      ).rejects.toThrow();
    }
    if (action === 'update') current = false;
    if (action === 'replacement') {
      renameSync(code, `${code}.old`);
      copyFileSync(`${code}.old`, code);
    }
    try {
      expect(composed.lookup(result.handle, item.channel)).toBeNull();
    } finally {
      if (action === 'replacement') {
        rmSync(code);
        renameSync(`${code}.old`, code);
      }
    }
  });

  it.each([
    'main',
    'cli',
    '--type=renderer',
    '--type=utility',
    'product-child',
    '--run-as-node',
  ])(
    'qualifies the actual fixture launcher %s through L1/prepared trust/L2',
    (mode) => {
      const script = path.join(dir, 'check.mjs'),
        config = path.join(dir, 'injected-policy.json');
      const url = pathToFileURL(
        path.join(root, 'packages/core-platform/src/linux-migration.ts'),
      ).href;
      writeFileSync(
        script,
        `
import fs from 'node:fs';
import {prepareLinuxMigrationQualification,createLinuxMigrationComposition} from ${JSON.stringify(url)};
// Labelled injected exact-image policy, NOT signed Canopy package evidence.
const policy=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const prepared=prepareLinuxMigrationQualification({...policy,current:()=>true});
if(!prepared)throw new Error('fixture preparation refused');
const composed=createLinuxMigrationComposition(prepared.capability);
let channel;
try {channel=composed.connect(process.ppid);} catch(error) {if(error.code==='capability_unavailable'){fs.writeSync(3,'capability_unavailable');prepared.invalidate();process.exit(0);}throw error;}
await channel.read(AbortSignal.timeout(5000));
const result=composed.verifyLauncher(channel);
await channel.write(Buffer.from(result.verified?'verified':result.reason));composed.close();prepared.invalidate();
`,
      );
      const loader = pathToFileURL(
        path.join(root, 'node_modules/tsx/dist/loader.mjs'),
      ).href;
      const base = ['launcher', process.execPath, loader, script, config];
      const p = policy();
      writeFileSync(
        config,
        JSON.stringify({
          ...p,
          files: { ...p.files, code: { path: script, digest: hash(script) } },
          expectations: {
            ...p.expectations,
            package: { ...p.expectations.package, codeDigest: hash(script) },
          },
          argv: { ...p.argv, launcher: [helper, ...base, 'main'] },
        }),
      );
      const outcome = execFileSync(helper, [...base, mode], {
        encoding: 'utf8',
        timeout: 10000,
        env: { PATH: '/usr/bin:/bin' },
      });
      if (!supportsChannels && outcome === 'capability_unavailable')
        expect(outcome).toBe('capability_unavailable');
      else expect(outcome).toBe(mode === 'main' ? 'verified' : 'role');
    },
  );
});
