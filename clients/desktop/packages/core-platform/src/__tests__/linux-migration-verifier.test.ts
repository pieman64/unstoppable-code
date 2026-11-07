import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createLinuxMigrationVerifier,
  type PreparedLinuxMigrationTrust,
  type LinuxMigrationCapture,
} from '@canopy/core-runtime/node/vault';
import {
  captureLinuxMigrationPeer,
  createOwnedChildServices,
  type OwnedChildLaunch,
} from '../supervision/owned-child';

// L2 native migration qualification with an injected prelaunch package policy,
// NOT a signed Canopy package or a production prepared-trust producer.
const suite = process.platform === 'linux' ? describe : describe.skip;
const root = path.resolve(__dirname, '../../../..');
let dir = '',
  addon = '',
  helper = '',
  other = '',
  preload = '',
  tracer = '';
const launches = new Set<OwnedChildLaunch>();
const hash = (file: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
function image(
  file: string,
  argv: readonly string[],
): ReturnType<PreparedLinuxMigrationTrust['image']> {
  const stat = statSync(file, { bigint: true });
  return { fileId: `${stat.dev}:${stat.ino}`, digest: hash(file), argv };
}
function trustFixture(
  pin: ReturnType<typeof image>,
  codeDigest: string,
  nativeDigest: string,
): PreparedLinuxMigrationTrust {
  return {
    expectations: {
      os: 'linux',
      installedPackageIdentity: 'fixture-elf-tree',
      continuity: 'process-instance',
      launcherDigest: pin.digest,
      daemonDigest: pin.digest,
      package: {
        flavorId: 'com.fixture.app',
        secureMode: 'secure',
        buildId: 'fixture-build',
        packageDigest: codeDigest,
        codeDigest,
        nativeDigest,
        updateEpoch: 'fixture-update',
      },
    },
    image: () => pin,
    current: () => true,
    onInvalidate: () => () => undefined,
  };
}
async function launch(
  target = helper,
  environment: Record<string, string> = {},
): Promise<OwnedChildLaunch> {
  const result = await createOwnedChildServices({
    os: 'linux',
    nativePath: addon,
  }).spawnWithChannel({
    executable: helper,
    args: [target],
    environment,
  });
  launches.add(result);
  return result;
}
async function read(launch: OwnedChildLaunch, length = 5): Promise<string> {
  let text = '';
  while (text.length < length) {
    const bytes = await launch.channel.read(AbortSignal.timeout(5000));
    if (!bytes) throw new Error('Unexpected EOF');
    text += Buffer.from(bytes).toString();
  }
  return text;
}
function captured(launch: OwnedChildLaunch): LinuxMigrationCapture {
  const result = captureLinuxMigrationPeer(launch.channel);
  if (!result) throw new Error('Missing native L2 capture');
  return result;
}

suite('Disabled Linux L2 native verifier (CAN-5877)', () => {
  if (process.platform === 'linux') {
    dir = mkdtempSync(path.join(tmpdir(), 'linux-migration-verifier-'));
    addon = path.join(dir, 'owned-child.node');
    helper = path.join(dir, 'fixture');
    other = path.join(dir, 'other');
    preload = path.join(dir, 'preload.so');
    tracer = path.join(dir, 'tracer');
    execFileSync(
      process.execPath,
      ['scripts/build-owned-child.mjs', '--out', addon],
      { cwd: root },
    );
    const source = path.join(dir, 'fixture.c');
    writeFileSync(
      source,
      `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/un.h>
#include <stddef.h>
#ifndef SO_PASSPIDFD
#define SO_PASSPIDFD 76
#endif
static void put(const char *p,int n){while(n){int k=send(3,p,n,MSG_NOSIGNAL);if(k<0&&errno==EINTR)continue;if(k<=0)_exit(20);p+=k;n-=k;}}
int main(int argc,char **argv){
  if(argc==2 && !strcmp(argv[1],"probe")) {
    int pair[2],on=1;struct statfs fs;
    int available=socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair)==0;
    if(available){
      available=setsockopt(pair[0],SOL_SOCKET,SO_PASSCRED,&on,sizeof on)==0 &&
        setsockopt(pair[0],SOL_SOCKET,SO_PASSPIDFD,&on,sizeof on)==0;
      if(available){
        pid_t child=fork();
        if(child==0){close(pair[0]);char b='!';_exit(write(pair[1],&b,1)==1?0:1);}
        if(child>0){
          int fd=syscall(SYS_pidfd_open,child,0),status=0;pid_t reaped;
          do{reaped=waitpid(child,&status,0);}while(reaped<0 && errno==EINTR);
          struct stat expected,actual;
          available=reaped==child && WIFEXITED(status) && WEXITSTATUS(status)==0 &&
            fd>=0 && fstatfs(fd,&fs)==0 && fs.f_type==0x50494446 && fstat(fd,&expected)==0;
          union {struct cmsghdr align;char bytes[CMSG_SPACE(sizeof(struct ucred))+CMSG_SPACE(sizeof(int))];} control;
          char b=0;struct iovec io={&b,1};struct msghdr m={0};
          m.msg_iov=&io;m.msg_iovlen=1;m.msg_control=control.bytes;m.msg_controllen=sizeof control.bytes;
          ssize_t n;do{n=recvmsg(pair[0],&m,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);}while(n<0 && errno==EINTR);
          int matches=0,credentials=0;
          if(n==1 && b=='!' && !(m.msg_flags&(MSG_CTRUNC|MSG_TRUNC))){
            for(struct cmsghdr *c=CMSG_FIRSTHDR(&m);c;c=CMSG_NXTHDR(&m,c)){
              if(c->cmsg_level==SOL_SOCKET && c->cmsg_type==4 && c->cmsg_len==CMSG_LEN(sizeof(int))){
                int sender;memcpy(&sender,CMSG_DATA(c),sizeof sender);
                matches+=available && fstatfs(sender,&fs)==0 && fs.f_type==0x50494446 &&
                  fstat(sender,&actual)==0 && expected.st_dev==actual.st_dev && expected.st_ino==actual.st_ino;
                if(sender>=0)close(sender);
              }
              if(c->cmsg_level==SOL_SOCKET && c->cmsg_type==SCM_CREDENTIALS && c->cmsg_len==CMSG_LEN(sizeof(struct ucred))){
                struct ucred cr;memcpy(&cr,CMSG_DATA(c),sizeof cr);
                credentials+=cr.pid==child && cr.uid==getuid() && cr.gid==getgid();
              }
            }
          }
          available=available && matches==1 && credentials==1;
          if(fd>=0)close(fd);
        }else available=0;
      }
      close(pair[0]);close(pair[1]);
    }
    const char *result=available?"available":"unavailable";
    write(1,result,strlen(result));return 0;
  }
if(argc==7){int pair[2],on=1;if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair))return 35;
for(int i=0;i<2;i++)setsockopt(pair[i],SOL_SOCKET,SO_PASSCRED,&on,sizeof on);
pid_t child=fork();if(child==0){int fd=fcntl(pair[1],F_DUPFD_CLOEXEC,10);if(fd<0)_exit(36);close(pair[0]);close(pair[1]);if(dup2(fd,3)<0)_exit(36);close(fd);
execl(argv[2],argv[2],"--import",argv[3],argv[4],argv[5],NULL);_exit(37);}
if(child<0)return 38;close(pair[1]);if(write(pair[0],"start",5)!=5)return 39;
char result[128];int n=read(pair[0],result,sizeof result);if(n<=0)return 40;if(write(1,result,n)!=n)return 45;close(pair[0]);
int status;waitpid(child,&status,0);return WIFEXITED(status)?WEXITSTATUS(status):41;}
if(argc!=2)return 21;put("ready",5);char b;
while(read(3,&b,1)==1){if(b=='q'||b=='h'){if(b=='q')close(3);else if(shutdown(3,SHUT_WR))return 42;int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);struct sockaddr_un addr={.sun_family=AF_UNIX};const char *barrier=getenv("L2_BARRIER");if(fd<0||!barrier||strlen(barrier)>=sizeof addr.sun_path-1)return 43;strcpy(addr.sun_path+1,barrier);if(connect(fd,(struct sockaddr*)&addr,offsetof(struct sockaddr_un,sun_path)+1+strlen(barrier))||write(fd,"closed",6)!=6)return 44;close(fd);pause();return 0;}if(b=='t'){prctl(PR_SET_PTRACER,PR_SET_PTRACER_ANY);put("ready",5);continue;}if(b=='c'){close(3);pause();return 0;}if(b=='x')return 0;if(b=='e'){execl(argv[1],argv[0],argv[1],NULL);return 22;}
if(b=='f'){if(fork()==0){put("other",5);_exit(0);}wait(NULL);}else put("ready",5);}return 0;}
`,
    );
    execFileSync('/usr/bin/cc', ['-O2', source, '-o', helper]);
    copyFileSync(helper, other);
    writeFileSync(
      path.join(dir, 'preload.c'),
      '#include <unistd.h>\n__attribute__((constructor)) static void loaded(void){if(write(3,"p",1)!=1)_exit(46);}\n',
    );
    execFileSync('/usr/bin/cc', [
      '-shared',
      '-fPIC',
      path.join(dir, 'preload.c'),
      '-o',
      preload,
    ]);
    writeFileSync(
      path.join(dir, 'tracer.c'),
      `
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/un.h>
#include <stddef.h>
int main(int argc,char **argv){if(argc!=2)return 30;int pid=atoi(argv[1]);
if(ptrace(PTRACE_ATTACH,pid,0,0)){if(errno==EPERM||errno==EACCES){puts("denied");return 0;}return 31;}
int status;if(waitpid(pid,&status,0)!=pid||!WIFSTOPPED(status))return 32;
if(ptrace(PTRACE_DETACH,pid,0,0))return 33;puts("attached");return 0;}
`,
    );
    execFileSync('/usr/bin/cc', [
      '-O2',
      path.join(dir, 'tracer.c'),
      '-o',
      tracer,
    ]);
  }
  afterEach(async () => {
    for (const item of launches) {
      item.channel.close();
      await item.child.terminate(AbortSignal.timeout(5000));
    }
    launches.clear();
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Match L1's reaped-sender SCM_PIDFD/pidfs probe, not the kernel version.
  const capability =
    process.platform === 'linux'
      ? execFileSync(helper, ['probe'], {
          encoding: 'utf8',
          timeout: 5000,
        })
      : 'unavailable';
  if (capability !== 'available' && capability !== 'unavailable') {
    throw new Error(
      `Unexpected Linux launcher-channel probe result: ${JSON.stringify(capability)}`,
    );
  }
  const supported = capability === 'available';

  if (!supported) {
    it('explicitly refuses this kernel without stale-sender SCM_PIDFD/pidfs; native verifier qualification is unavailable', async () => {
      await expect(launch()).rejects.toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
    });
    return;
  }

  it('verifies the exact preselected ELF/invocation into shared evidence; rejects replay and remote/token claims', async () => {
    const pin = image(helper, [helper, helper]);
    const trust = trustFixture(pin, hash(helper), hash(addon));
    const item = await launch();
    expect(captureLinuxMigrationPeer(item.channel)).toBeNull();
    expect(await read(item)).toBe('ready');
    const verifier = createLinuxMigrationVerifier({
      trust,
      capture: (channel) =>
        channel === item.channel
          ? captureLinuxMigrationPeer(item.channel)
          : null,
    });
    const result = verifier.verifyDestination(item.channel);
    if (!result.verified) throw new Error(result.reason);
    expect(result.evidence).toMatchObject({
      os: 'linux',
      peer: {
        identity: { pid: item.child.pid, continuity: 'process-instance' },
        artifact: {
          installedPackage: {
            identity: 'fixture-elf-tree',
            status: 'verified',
          },
        },
      },
    });
    expect(verifier.lookup(result.handle, item.channel)).toBe(result.evidence);
    expect(verifier.lookup(result.handle, {})).toBeNull();
    expect(verifier.verifyDestination(item.channel)).toEqual({
      verified: false,
      reason: 'replay',
    });
    for (const forged of [
      { token: 'endpoint' },
      { remote: true },
      { role: 'electron-main' },
    ]) {
      expect(
        captureLinuxMigrationPeer({
          ...forged,
          read: () => Promise.resolve(null),
          write: () => Promise.resolve(),
          close: () => undefined,
        }),
      ).toBeNull();
      expect(verifier.verifyLauncher(forged).verified).toBe(false);
    }
    const second = createLinuxMigrationVerifier({
      trust,
      capture: () => captureLinuxMigrationPeer(item.channel),
    });
    expect(second.lookup(result.handle, item.channel)).toBeNull();
    expect(second.verifyDestination(item.channel).verified).toBe(false);
    second.close();
    verifier.close();
  });

  it.each(['image', 'invocation'] as const)(
    'refuses a native %s mismatch',
    async (kind) => {
      const pin = image(kind === 'image' ? other : helper, [
        helper,
        kind === 'invocation' ? 'wrong' : helper,
      ]);
      const item = await launch();
      await read(item);
      const verifier = createLinuxMigrationVerifier({
        trust: trustFixture(pin, hash(helper), hash(addon)),
        capture: () => captureLinuxMigrationPeer(item.channel),
      });
      expect(verifier.verifyDestination(item.channel)).toEqual({
        verified: false,
        reason: kind === 'image' ? 'image' : 'role',
      });
      verifier.close();
    },
  );

  it.each(['exit', 'close', 'eof', 'delegate', 'exec'] as const)(
    'retires native evidence on %s',
    async (action) => {
      const item = await launch(other);
      await read(item);
      const capture = captured(item);
      expect(capture.current()).toBe(true);
      if (action === 'exit') {
        await item.channel.write(Buffer.from('x'));
        await item.child.exited;
      }
      if (action === 'close') item.channel.close();
      if (action === 'eof') {
        await item.channel.write(Buffer.from('c'));
        expect(await item.channel.read(AbortSignal.timeout(5000))).toBeNull();
      }
      if (action === 'delegate') {
        await item.channel.write(Buffer.from('f'));
        await expect(
          item.channel.read(AbortSignal.timeout(5000)),
        ).rejects.toThrow();
      }
      if (action === 'exec') {
        await item.channel.write(Buffer.from('e'));
        expect(await read(item)).toBe('ready');
      }
      expect(capture.current()).toBe(false);
      capture.close();
      capture.close();
      expect(captureLinuxMigrationPeer(item.channel)).toBeNull();
    },
  );

  it.each(['q', 'h'])(
    'refuses peer close/half-close %s without needing another channel read',
    async (command) => {
      const barrier = `\0can5877-${process.pid}-${command}`;
      const server = createServer();
      const closed = new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.once('connection', (socket) => {
          socket.once('data', () => resolve());
          socket.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(barrier, resolve));
      try {
        const item = await launch(helper, { L2_BARRIER: barrier.slice(1) });
        await read(item);
        const capture = captured(item);
        try {
          expect(capture.current()).toBe(true);
          await item.channel.write(Buffer.from(command));
          await closed;
          // No receive has observed EOF: liveness must come from the socket.
          expect(capture.current()).toBe(false);
        } finally {
          capture.close();
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('detects unlink/replacement of the observed executable without rehashing a new pathname', async () => {
    const item = await launch();
    await read(item);
    const capture = captured(item);
    renameSync(helper, `${helper}.old`);
    copyFileSync(other, helper);
    try {
      expect(capture.current()).toBe(false);
    } finally {
      capture.close();
      rmSync(helper);
      renameSync(`${helper}.old`, helper);
    }
  });

  it('states the same-image exec limit: unchanged pidfd/starttime is not an exec generation', async () => {
    const item = await launch();
    await read(item);
    const capture = captured(item);
    await item.channel.write(Buffer.from('e'));
    expect(await read(item)).toBe('ready');
    expect(capture.current()).toBe(true);
    expect(capture.identity.continuity).toBe('process-instance');
    capture.close();
  });

  it('qualifies the preload limit: an injected library does not change the executable evidence', async () => {
    const item = await launch(helper, { LD_PRELOAD: preload });
    expect(await read(item, 6)).toBe('pready');
    const capture = captured(item);
    expect(capture.digest).toBe(hash(helper));
    expect(capture.current()).toBe(true);
    capture.close();
  });

  it('qualifies ptrace/Yama as an external limit, not executable attestation', async () => {
    const item = await launch();
    await read(item);
    const capture = captured(item);
    // Permit a sibling tracer only in this fixture; Yama scope 3 may still deny.
    await item.channel.write(Buffer.from('t'));
    await read(item);
    const outcome = execFileSync(tracer, [String(item.child.pid)], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    expect(['attached', 'denied']).toContain(outcome);
    expect(capture.current()).toBe(true);
    capture.close();
  });

  it.each([
    'main',
    'cli',
    '--type=renderer',
    '--type=utility',
    'product-child',
  ])(
    'qualifies a native launcher invocation %s against the exact prelaunch package',
    (mode) => {
      const loader = pathToFileURL(
        path.join(root, 'node_modules/tsx/dist/loader.mjs'),
      ).href;
      const config = path.join(dir, 'launcher-policy.json');
      const script = path.join(dir, 'launcher-check.mjs');
      const moduleUrl = pathToFileURL(
        path.join(
          root,
          'packages/core-platform/src/supervision/owned-child.ts',
        ),
      ).href;
      const verifierUrl = pathToFileURL(
        path.join(
          root,
          'packages/core-runtime/src/node/vault/migration-linux-verifier.ts',
        ),
      ).href;
      writeFileSync(
        script,
        `
import fs from 'node:fs';
import * as api from ${JSON.stringify(moduleUrl)};
import {createLinuxMigrationVerifier} from ${JSON.stringify(verifierUrl)};
const prepared=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const channel=api.connectLinuxLauncherChannel(${JSON.stringify(addon)},process.ppid);
await channel.read(AbortSignal.timeout(5000));
const verifier=createLinuxMigrationVerifier({trust:{expectations:prepared.expectations,image:()=>prepared.image,current:()=>true,onInvalidate:()=>()=>{}},capture:api.captureLinuxMigrationPeer});
const result=verifier.verifyLauncher(channel);
await channel.write(Buffer.from(result.verified?'verified':result.reason));verifier.close();channel.close();
`,
      );
      const base = ['launcher', process.execPath, loader, script, config];
      const pin = image(helper, [helper, ...base, 'main']);
      const trust = trustFixture(pin, hash(script), hash(addon));
      // This sidecar belongs only to the controlled fixture. Product code has
      // no metadata-to-prepared-trust loader; L3 must authenticate real packages.
      writeFileSync(
        config,
        JSON.stringify({ expectations: trust.expectations, image: pin }),
      );
      const outcome = execFileSync(helper, [...base, mode], {
        encoding: 'utf8',
        timeout: 7000,
        env: { PATH: '/usr/bin:/bin' },
      });
      expect(outcome).toBe(mode === 'main' ? 'verified' : 'role');
    },
  );

  it('verifies the actual launcher in the adopted child, using prelaunch fixture expectations', async () => {
    const pin = image(
      '/proc/self/exe',
      readFileSync('/proc/self/cmdline').toString().slice(0, -1).split('\0'),
    );
    const trust = trustFixture(pin, hash(helper), hash(addon));
    const moduleUrl = pathToFileURL(
      path.join(root, 'packages/core-platform/src/supervision/owned-child.ts'),
    ).href;
    const verifierUrl = pathToFileURL(
      path.join(
        root,
        'packages/core-runtime/src/node/vault/migration-linux-verifier.ts',
      ),
    ).href;
    const loader = pathToFileURL(
      path.join(root, 'node_modules/tsx/dist/loader.mjs'),
    ).href;
    const script = `(async()=>{
      const api=await import(${JSON.stringify(moduleUrl)});
      const {createLinuxMigrationVerifier}=await import(${JSON.stringify(verifierUrl)});
      const channel=api.connectLinuxLauncherChannel(${JSON.stringify(addon)},process.ppid);
      await channel.read(AbortSignal.timeout(5000));
      const trust={expectations:${JSON.stringify(trust.expectations)},image:()=>(${JSON.stringify(pin)}),current:()=>true,onInvalidate:()=>()=>{}};
      const verifier=createLinuxMigrationVerifier({trust,capture:api.captureLinuxMigrationPeer});
      const result=verifier.verifyLauncher(channel);
      await channel.write(Buffer.from(result.verified?'verified':result.reason));
      while(await channel.read()!==null){};verifier.close();
    })().catch(()=>process.exit(24));`;
    const item = await createOwnedChildServices({
      os: 'linux',
      nativePath: addon,
    }).spawnWithChannel({
      executable: process.execPath,
      args: ['--import', loader, '-e', script],
      environment: { PATH: '/usr/bin:/bin' },
    });
    launches.add(item);
    await item.channel.write(Buffer.from('start'));
    expect(await read(item, 8)).toBe('verified');
  });
});
