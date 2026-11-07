import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrationFirstFrame } from '@canopy/core-transport/node/migration-channel';
import {
  channelPeer,
  connectLinuxLauncherChannel,
  createOwnedChildServices,
  linuxChannelPeer,
  OWNED_CHILD_FILE,
  type OwnedChildLaunch,
} from '../supervision/owned-child';

// L1 native platform qualification: credentials identify the sender at sendmsg
// time, never the socketpair creator, executable, package or migration role.
// host.launch / loaded.launch retain ordinary execution; this qualifies the
// sibling channel launch through that existing native custody boundary.
const suite = process.platform === 'linux' ? describe : describe.skip;
const root = path.resolve(__dirname, '../../../..');
const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '../supervision/owned-child.ts'),
).href;
const source = path.join(
  root,
  'packages/core-platform/native/owned-child/src/owned_child.c',
);
let dir = '';
let addon = '';
let helper = '';
const launches = new Set<OwnedChildLaunch>();

const fixture = `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <signal.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#ifndef SO_PASSPIDFD
#define SO_PASSPIDFD 76
#endif
static void put(const void *p, size_t n) {
  while (n) { ssize_t k = send(3,p,n,MSG_NOSIGNAL); if(k<0 && errno==EINTR)continue;
    if(k<=0)_exit(40); p=(const char*)p+k;n-=k; }
}
int main(int argc, char **argv) {
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
  if(argc==4 && (!strcmp(argv[1],"reverse-final") || !strcmp(argv[1],"reverse-final-holder"))) {
    // A supervisor waits for the actual launcher's death before releasing the
    // child's read barrier. No timing assumptions about death versus EOF.
    if(prctl(PR_SET_CHILD_SUBREAPER,1))return 60;
    int gate[2],ids[2];if(pipe2(gate,O_CLOEXEC)||pipe2(ids,O_CLOEXEC))return 61;
    pid_t launcher=fork();
    if(launcher==0){
      close(gate[1]);close(ids[0]);int pair[2],on=1;
      if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair))_exit(62);
      for(int i=0;i<2;i++){
        setsockopt(pair[i],SOL_SOCKET,SO_PASSCRED,&on,sizeof on);
        setsockopt(pair[i],SOL_SOCKET,SO_PASSPIDFD,&on,sizeof on);
      }
      pid_t child=fork();
      if(child==0){
        int socket=fcntl(pair[1],F_DUPFD_CLOEXEC,10);
        int barrier=fcntl(gate[0],F_DUPFD_CLOEXEC,10);
        if(socket<0||barrier<0)_exit(63);
        close(pair[0]);close(pair[1]);close(gate[0]);close(ids[1]);
        if(dup2(socket,3)<0||dup2(barrier,4)<0)_exit(63);
        close(socket);close(barrier);
        execl(argv[2],argv[2],"-e",argv[3],NULL);_exit(64);
      }
      close(pair[1]);close(gate[0]);char ack;
      if(read(pair[0],&ack,1)!=1)_exit(65);
      pid_t holder=0;
      if(!strcmp(argv[1],"reverse-final-holder")){
        holder=fork();if(holder==0){close(ids[1]);close(0);close(1);close(2);pause();_exit(0);}
      }
      pid_t children[2]={child,holder};write(ids[1],children,sizeof children);close(ids[1]);
      char b[65536];memset(b,'z',sizeof b);
      size_t off=0;while(off<sizeof b){ssize_t n=send(pair[0],b+off,sizeof b-off,MSG_NOSIGNAL);if(n<=0)_exit(66);off+=n;}
      close(pair[0]);_exit(0);
    }
    close(gate[0]);close(ids[1]);pid_t children[2];
    if(read(ids[0],children,sizeof children)!=sizeof children)return 67;
    close(ids[0]);int status;waitpid(launcher,&status,0);
    write(gate[1],"!",1);close(gate[1]);waitpid(children[0],&status,0);
    if(children[1]>0){kill(children[1],SIGKILL);waitpid(children[1],NULL,0);}
    return WIFEXITED(status)?WEXITSTATUS(status):68;
  }
  if(argc==4 && !strcmp(argv[1],"launcher")) {
    int pair[2];int on=1;
    if(socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,pair))return 50;
    setsockopt(pair[0],SOL_SOCKET,SO_PASSCRED,&on,sizeof on);
    setsockopt(pair[1],SOL_SOCKET,SO_PASSCRED,&on,sizeof on);
    pid_t child=fork();
    if(child==0){
      int copy=fcntl(pair[1],F_DUPFD_CLOEXEC,4);if(copy<0 || dup2(copy,3)<0)_exit(51);
      close(copy);execl(argv[2],argv[2],"-e",argv[3],NULL);_exit(52);
    }
    close(pair[1]);send(pair[0],"ready",5,MSG_NOSIGNAL);
    char reply;if(read(pair[0],&reply,1)!=1)return 53;
    pid_t delegated=fork();
    if(delegated==0){send(pair[0],"foreign",7,MSG_NOSIGNAL);_exit(0);}
    waitpid(delegated,NULL,0);int status;waitpid(child,&status,0);close(pair[0]);
    return WIFEXITED(status)?WEXITSTATUS(status):54;
  }
  if(argc!=2)return 41;
  const char *mode=argv[1];
  if(!strcmp(mode,"polled-final") || !strcmp(mode,"polled-final-holder")) {
    char ack;if(read(3,&ack,1)!=1)return 69;
    mode=!strcmp(mode,"polled-final")?"final":"final-holder";
  }
  if(!strcmp(mode,"final") || !strcmp(mode,"final-holder")) {
    char b[65536];memset(b,'z',sizeof b);put(b,sizeof b);
    if(!strcmp(mode,"final-holder") && fork()==0){pause();_exit(0);}
    return 0;
  }
  if(!strcmp(mode,"exit"))return 0;
  if(!strcmp(mode,"frame")) {
    put("c",1);const char *s="anopy-migration-channel-v1\\npayload";put(s,strlen(s));
  }
  if(!strcmp(mode,"bad-frame")){put("not-a-prelude",13);pause();return 0;}
  if(!strcmp(mode,"after") || !strcmp(mode,"exec")) {
    put("ready",5);char c;if(read(3,&c,1)!=1)return 42;
    if(!strcmp(mode,"exec")) { execl(argv[0],argv[0],"echo",NULL);return 43; }
  }
  if(!strncmp(mode,"mixed-",6)) {
    size_t size=strtoul(mode+6,NULL,10);char b[65537];memset(b,'a',sizeof b);
    put(b,size);pid_t pid=fork();if(pid==0){put("foreign",7);_exit(0);}
    waitpid(pid,NULL,0);put("tail",4);pause();return 0;
  }
  if(!strcmp(mode,"before") || !strcmp(mode,"after")) {
    pid_t pid=fork();if(pid==0){put("foreign",7);_exit(0);}
    waitpid(pid,NULL,0);pause();return 0;
  }
  if(!strcmp(mode,"rights") || !strcmp(mode,"truncated")) {
    int count=!strcmp(mode,"rights")?1:100;int fds[100];
    for(int i=0;i<count;i++)fds[i]=open("/dev/null",O_RDONLY);
    char control[CMSG_SPACE(sizeof fds)]={0};char b='x';struct iovec io={&b,1};
    struct msghdr m={0};m.msg_iov=&io;m.msg_iovlen=1;m.msg_control=control;
    m.msg_controllen=CMSG_SPACE(count*sizeof(int));struct cmsghdr *c=CMSG_FIRSTHDR(&m);
    c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(count*sizeof(int));
    memcpy(CMSG_DATA(c),fds,count*sizeof(int));if(sendmsg(3,&m,MSG_NOSIGNAL)!=1)return 44;
    for(int i=0;i<count;i++)close(fds[i]);pause();return 0;
  }
  if(!strcmp(mode,"pid") || !strcmp(mode,"uid") || !strcmp(mode,"gid")) {
    struct ucred cr={getpid(),getuid(),getgid()};
    if(!strcmp(mode,"pid"))cr.pid=getppid();
    if(!strcmp(mode,"uid"))cr.uid++;
    if(!strcmp(mode,"gid"))cr.gid++;
    char control[CMSG_SPACE(sizeof cr)]={0};char b='x';struct iovec io={&b,1};
    struct msghdr m={0};m.msg_iov=&io;m.msg_iovlen=1;m.msg_control=control;m.msg_controllen=sizeof control;
    struct cmsghdr *c=CMSG_FIRSTHDR(&m);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_CREDENTIALS;
    c->cmsg_len=CMSG_LEN(sizeof cr);memcpy(CMSG_DATA(c),&cr,sizeof cr);
    if(sendmsg(3,&m,MSG_NOSIGNAL)<0 && errno==EPERM)put("denied",6);
    pause();return 0;
  }
  if(!strcmp(mode,"no-read")){pause();return 0;}
  char b[257];ssize_t n;
  while((n=read(3,b,sizeof b))>0)put(b,(size_t)n);
  return 0;
}
`;

async function launch(
  mode = 'echo',
  nativePath = addon,
): Promise<OwnedChildLaunch> {
  const result = await createOwnedChildServices({
    os: 'linux',
    nativePath,
  }).spawnWithChannel({
    executable: helper,
    args: [mode],
    environment: {},
  });
  launches.add(result);
  return result;
}

async function readSize(
  channel: OwnedChildLaunch['channel'],
  size: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  while (length < size) {
    const part = await channel.read(AbortSignal.timeout(5000));
    if (part === null) throw new Error('Premature EOF');
    chunks.push(Buffer.from(part));
    length += part.byteLength;
  }
  expect(length).toBe(size);
  return Buffer.concat(chunks);
}

function expectUnavailableAdoption(
  nativePath: string,
  parentPid: number,
): void {
  let failure: unknown;
  try {
    connectLinuxLauncherChannel(nativePath, parentPid);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: 'capability_unavailable',
    message: 'Linux launcher channels require stale-sender pidfds and pidfs.',
  });
}

suite('Linux inherited launcher channel (disabled L1)', () => {
  if (process.platform === 'linux') {
    dir = mkdtempSync(path.join(tmpdir(), 'linux-launcher-'));
    addon = path.join(dir, OWNED_CHILD_FILE);
    helper = path.join(dir, 'sender');
    execFileSync(process.execPath, [
      path.join(root, 'scripts/build-owned-child.mjs'),
      '--out',
      addon,
    ]);
    writeFileSync(path.join(dir, 'sender.c'), fixture);
    execFileSync('/usr/bin/cc', [
      '-Wall',
      '-Wextra',
      '-O2',
      path.join(dir, 'sender.c'),
      '-o',
      helper,
    ]);
  }
  afterEach(async () => {
    for (const { channel, child } of launches) {
      channel.close();
      await child.terminate(AbortSignal.timeout(5000));
    }
    launches.clear();
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const supported =
    process.platform === 'linux' &&
    execFileSync(helper, ['probe'], { encoding: 'utf8' }) === 'available';

  it.each(['no-passpidfd', 'no-pidfs', 'no-stale-sender', 'no-fork'])(
    'refuses %s before spawn/adoption with no descriptor leak',
    async (fault) => {
      const wrapper = path.join(dir, `${fault}.c`);
      const out = path.join(dir, `${fault}.node`);
      writeFileSync(
        wrapper,
        `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/vfs.h>
#include <errno.h>
#include <unistd.h>
#include <string.h>
static pid_t denied_fork(void) {errno=EAGAIN;return -1;}
static ssize_t denied_stale(int fd,struct msghdr *m,int flags) {
  ssize_t n=recvmsg(fd,m,flags);if(n<=0)return n;
  for(struct cmsghdr *c=CMSG_FIRSTHDR(m);c;c=CMSG_NXTHDR(m,c)){
    if(c->cmsg_level==SOL_SOCKET && c->cmsg_type==4 && c->cmsg_len==CMSG_LEN(sizeof(int))){
      int old;memcpy(&old,CMSG_DATA(c),sizeof old);if(old>=0)close(old);
      int refused=-EINVAL;memcpy(CMSG_DATA(c),&refused,sizeof refused);
    }
  }
  return n;
}
static int denied_option(int fd,int level,int option,const void *value,socklen_t length) {
  if(option==76){errno=ENOPROTOOPT;return -1;}
  return setsockopt(fd,level,option,value,length);
}
static int denied_fs(int fd,struct statfs *fs) {
  int result=fstatfs(fd,fs);if(result==0)fs->f_type=0;return result;
}
${fault === 'no-passpidfd' ? '#define setsockopt denied_option' : ''}
${fault === 'no-pidfs' ? '#define fstatfs denied_fs' : ''}
${fault === 'no-stale-sender' ? '#define recvmsg denied_stale' : ''}
${fault === 'no-fork' ? '#define fork denied_fork' : ''}
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
      const count = readdirSync('/proc/self/fd').length;
      await expect(launch('echo', out)).rejects.toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
      expectUnavailableAdoption(out, process.pid);
      expect(readdirSync('/proc/self/fd').length).toBe(count);
    },
  );

  if (!supported) {
    it('explicitly refuses this kernel without stale-sender SCM_PIDFD/pidfs; native channel qualification is unavailable', async () => {
      await expect(launch()).rejects.toMatchObject({
        code: 'capability_unavailable',
        message:
          'Linux launcher channels require stale-sender pidfds and pidfs.',
      });
      expectUnavailableAdoption(addon, process.ppid);
    });
    return;
  }

  it('caches a successful reaped-sender probe per addon instance', async () => {
    const wrapper = path.join(dir, 'probe-once.c');
    const out = path.join(dir, 'probe-once.node');
    writeFileSync(
      wrapper,
      `
#define _GNU_SOURCE
#include <unistd.h>
#include <errno.h>
static pid_t fork_once(void) {
  static unsigned calls=0;if(calls++){errno=EAGAIN;return -1;}return fork();
}
#define fork fork_once
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
    const services = createOwnedChildServices({ os: 'linux', nativePath: out });
    for (let i = 0; i < 2; i++) {
      const result = await services.spawnWithChannel({
        executable: helper,
        args: ['echo'],
        environment: {},
      });
      launches.add(result);
      await result.channel.write(Buffer.from('!'));
      expect(await readSize(result.channel, 1)).toEqual(Buffer.from('!'));
    }
  });

  it('attributes fragmented and coalesced bytes to the actual sender, not the socketpair creator', async () => {
    const { child, channel } = await launch();
    expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
    await channel.write(Buffer.alloc(0));
    expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
    for (const bytes of [
      Buffer.from('c'),
      Buffer.from('anopy-launcher-v1\n'),
      Buffer.alloc(65536, 0xa7),
    ]) {
      await channel.write(bytes);
      expect(await readSize(channel, bytes.length)).toEqual(bytes);
    }
    expect(linuxChannelPeer(channel)).toEqual({
      state: 'connected',
      pid: child.pid,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    });
    expect(() => channelPeer(channel)).toThrow();
  });

  it('preserves application bytes coalesced with the fragmented fixed first frame', async () => {
    const { channel } = await launch('frame');
    const framed = await migrationFirstFrame(
      channel,
      'launcher',
      () => linuxChannelPeer(channel).state === 'connected',
      AbortSignal.timeout(5000),
    );
    expect((await readSize(framed, 7)).toString()).toBe('payload');
  });

  it('refuses malformed synchronization without treating it as authentication', async () => {
    const { channel } = await launch('bad-frame');
    await expect(
      migrationFirstFrame(
        channel,
        'launcher',
        () => true,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow();
    expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
  });

  it('handles duplex backpressure and ordered bytes across native chunk boundaries', async () => {
    const { channel } = await launch();
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const [, read] = await Promise.all([
      channel.write(bytes, AbortSignal.timeout(5000)),
      readSize(channel, bytes.length),
    ]);
    expect(read).toEqual(bytes);
  });

  it('releases per-message sender pidfds without waiting for wrapper collection', async () => {
    const { channel } = await launch();
    const count = readdirSync('/proc/self/fd').length;
    for (let i = 0; i < 64; i++) {
      await channel.write(Buffer.from('x'));
      expect((await readSize(channel, 1)).toString()).toBe('x');
    }
    expect(readdirSync('/proc/self/fd').length).toBe(count);
  });

  it('closes a partially written stream on cancellation', async () => {
    const { channel } = await launch('no-read');
    await expect(
      channel.write(Buffer.alloc(16 * 1024 * 1024), AbortSignal.timeout(50)),
    ).rejects.toThrow();
    await expect(channel.read()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects forged, foreign-load and released native handles, and bounds reads', () => {
    const a = { exports: {} };
    const b = { exports: {} };
    process.dlopen(a, addon);
    process.dlopen(b, addon);
    const invoke = (mod: object, name: string, ...args: unknown[]): unknown => {
      const fn: unknown = Reflect.get(mod, name);
      if (typeof fn !== 'function') throw new Error('Missing native function');
      return Reflect.apply(fn, mod, args);
    };
    const result = invoke(
      a.exports,
      'spawnChannel',
      helper,
      [helper, 'echo'],
      [],
      null,
    );
    if (typeof result !== 'object' || result === null)
      throw new Error('No launch');
    const handle: unknown = Reflect.get(result, 'handle');
    try {
      expect(() => invoke(a.exports, 'channelPeer', {})).toThrow();
      expect(() => invoke(b.exports, 'channelPeer', handle)).toThrow();
      for (const size of [0, -1, 65537])
        expect(() => invoke(a.exports, 'channelRead', handle, size)).toThrow();
      invoke(a.exports, 'channelClose', handle);
      invoke(a.exports, 'channelClose', handle);
      expect(() => invoke(a.exports, 'channelRead', handle, 1)).toThrow();
    } finally {
      expect(invoke(a.exports, 'rollbackSync', handle)).toBe(true);
    }
    expect(() => invoke(a.exports, 'channelPeer', handle)).toThrow();
  });

  it.each(['before', 'after'])(
    'refuses a co-holder sender %s bootstrap',
    async (mode) => {
      const { channel } = await launch(mode);
      if (mode === 'after') {
        expect((await readSize(channel, 5)).toString()).toBe('ready');
        expect(linuxChannelPeer(channel).state).toBe('connected');
        await channel.write(Buffer.from('!'));
      }
      await expect(channel.read(AbortSignal.timeout(5000))).rejects.toThrow();
      expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
    },
  );

  it.each(['rights', 'truncated'])(
    'refuses and closes %s ancillary descriptors',
    async (mode) => {
      const count = readdirSync('/proc/self/fd').length;
      const { channel } = await launch(mode);
      await expect(channel.read(AbortSignal.timeout(5000))).rejects.toThrow();
      expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
      expect(readdirSync('/proc/self/fd').length).toBe(count);
    },
  );

  it.each(['pid', 'uid', 'gid'])(
    'refuses explicit %s impersonation or observes kernel denial',
    async (mode) => {
      const { channel } = await launch(mode);
      // Forge only the parent PID or real UID/GID + 1, not the full expected
      // tuple. This covers kernel denial or local mismatch refusal, not defense
      // against a capable sender forging the expected credentials and pidfd.
      try {
        expect((await readSize(channel, 6)).toString()).toBe('denied');
      } catch (error) {
        expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
        expect(error).toMatchObject({ code: 'unavailable' });
      }
    },
  );

  it.each(['final', 'final-holder'])(
    'drains queued bytes after exit and a non-destructive custody refusal (%s)',
    async (mode) => {
      const { child, channel } = await launch(mode);
      await child.exited;
      expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
      expect(await readSize(channel, 65536)).toEqual(Buffer.alloc(65536, 'z'));
      expect(await channel.read(AbortSignal.timeout(5000))).toBeNull();
      await expect(
        channel.write(Buffer.from('after-exit')),
      ).rejects.toMatchObject({ code: 'unavailable' });
    },
  );

  it.each(['polled-final', 'polled-final-holder'])(
    'drains the final write when polling starts before the peer sends (%s)',
    async (mode) => {
      for (let i = 0; i < 32; i++) {
        const { child, channel } = await launch(mode);
        // read() performs its first native empty poll before awaiting a retry.
        const pending = readSize(channel, 65536);
        await channel.write(Buffer.from('!'));
        expect(await pending).toEqual(Buffer.alloc(65536, 'z'));
        expect(await channel.read(AbortSignal.timeout(5000))).toBeNull();
        channel.close();
        await child.terminate(AbortSignal.timeout(5000));
      }
    },
    15000,
  );

  it('drains a write deterministically scheduled between an empty receive and the death check', async () => {
    const wrapper = path.join(dir, 'eof-race.c');
    const out = path.join(dir, 'eof-race.node');
    writeFileSync(
      wrapper,
      `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <poll.h>
#include <errno.h>
#include <stdbool.h>
static bool racing=false;
static ssize_t race_receive(int fd,struct msghdr *m,int flags) {
  ssize_t n=recvmsg(fd,m,flags);
  if(n<0 && errno==EAGAIN){
    // Release the fixture's final write only after observing the empty socket.
    if(send(fd,"!",1,MSG_NOSIGNAL)!=1)return -1;
    racing=true;errno=EAGAIN;
  }
  return n;
}
static int race_poll(struct pollfd *fds,nfds_t count,int timeout) {
  // linux_live's pidfd check sees death after the final write, not before it.
  if(racing){racing=false;timeout=5000;}
  int n;do{n=poll(fds,count,timeout);}while(n<0 && errno==EINTR);return n;
}
#define recvmsg race_receive
#define poll race_poll
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
    const { channel } = await launch('polled-final-holder', out);
    expect(await readSize(channel, 65536)).toEqual(Buffer.alloc(65536, 'z'));
    expect(await channel.read(AbortSignal.timeout(5000))).toBeNull();
  });

  it.each(['reverse-final', 'reverse-final-holder'])(
    'drains launcher bytes after confirmed parent death (%s)',
    (mode) => {
      const script = `(async()=>{
      const api=await import(${JSON.stringify(moduleUrl)});
      const ch=api.connectLinuxLauncherChannel(${JSON.stringify(addon)},process.ppid);
      await ch.write(Buffer.from('!'));
      const fs=require('node:fs');fs.readSync(4,Buffer.alloc(1),0,1,null);fs.closeSync(4);
      if(api.linuxChannelPeer(ch).state!=='refused')process.exit(70);
      let length=0;for(;;){const b=await ch.read(AbortSignal.timeout(5000));if(b===null)break;
        if(!Buffer.from(b).equals(Buffer.alloc(b.length,'z')))process.exit(71);length+=b.length;}
      if(length!==65536)process.exit(72);
      try{await ch.write(Buffer.from('x'));process.exit(73)}catch(error){if(error.code!=='unavailable')throw error}
      ch.close();
    })().catch(()=>process.exit(74));`;
      execFileSync(helper, [mode, process.execPath, script], {
        timeout: 7000,
        env: { PATH: '/usr/bin:/bin' },
      });
    },
  );

  it.each([65535, 65536, 65537])(
    'never returns foreign bytes coalesced at the %i-byte boundary',
    async (size) => {
      const { channel } = await launch(`mixed-${size}`);
      expect(await readSize(channel, size)).toEqual(Buffer.alloc(size, 'a'));
      await expect(
        channel.read(AbortSignal.timeout(5000)),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(linuxChannelPeer(channel)).toEqual({ state: 'refused' });
    },
  );

  it('reports EOF for empty exit, and refuses writes after peer close', async () => {
    const { child, channel } = await launch('exit');
    await child.exited;
    expect(await channel.read(AbortSignal.timeout(5000))).toBeNull();
    await expect(channel.write(Buffer.from('x'))).rejects.toThrow();
  });

  it('makes the exec limit explicit: same-instance exec remains a credential match', async () => {
    const { child, channel } = await launch('exec');
    expect((await readSize(channel, 5)).toString()).toBe('ready');
    await channel.write(Buffer.from('!'));
    await channel.write(Buffer.from('after-exec'));
    expect((await readSize(channel, 10)).toString()).toBe('after-exec');
    expect(linuxChannelPeer(channel)).toMatchObject({
      state: 'connected',
      pid: child.pid,
    });
  });

  it('adopts fd 3 natively, attributes the launcher and does not inherit the adopted fd on exec', async () => {
    const script = `
      (async () => {
        const api=await import(${JSON.stringify(moduleUrl)});
        const fs=require('node:fs');
        const marker=fs.readlinkSync('/proc/self/fd/3');
        const ch=api.connectLinuxLauncherChannel(${JSON.stringify(addon)},process.ppid);
        const bytes=await ch.read(AbortSignal.timeout(5000));
        const peer=api.linuxChannelPeer(ch);
        const {execFileSync}=require('node:child_process');
        execFileSync(process.execPath,['-e','const fs=require("node:fs");const marker='+JSON.stringify(marker)+';for(const fd of fs.readdirSync("/proc/self/fd")){try{if(fs.readlinkSync("/proc/self/fd/"+fd)===marker)process.exit(9)}catch{}}'],{stdio:'ignore'});
        await ch.write(Buffer.from(JSON.stringify({peer,text:Buffer.from(bytes).toString()})));
        while(await ch.read()!==null){};
      })().catch(()=>process.exit(23));`;
    const result = await createOwnedChildServices({
      os: 'linux',
      nativePath: addon,
    }).spawnWithChannel({
      executable: process.execPath,
      args: ['-e', script],
      environment: { PATH: '/usr/bin:/bin' },
    });
    launches.add(result);
    await result.channel.write(Buffer.from('hello'));
    const reply = await result.channel.read(AbortSignal.timeout(5000));
    expect(reply).not.toBeNull();
    expect(JSON.parse(Buffer.from(reply ?? []).toString())).toEqual({
      peer: {
        state: 'connected',
        pid: process.pid,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      text: 'hello',
    });
  });

  it('refuses a delegated launcher-side sender after successful bootstrap', () => {
    const script = `(async()=>{
      const api=await import(${JSON.stringify(moduleUrl)});
      const channel=api.connectLinuxLauncherChannel(${JSON.stringify(addon)},process.ppid);
      const first=await channel.read(AbortSignal.timeout(5000));
      if(Buffer.from(first||[]).toString()!=='ready'||api.linuxChannelPeer(channel).pid!==process.ppid)process.exit(55);
      await channel.write(Buffer.from('!'));
      try{await channel.read(AbortSignal.timeout(5000));process.exit(56)}catch(error){if(error.code!=='unavailable')throw error;}
      if(api.linuxChannelPeer(channel).state!=='refused')process.exit(57);
      channel.close();
    })().catch(()=>process.exit(58));`;
    execFileSync(helper, ['launcher', process.execPath, script], {
      timeout: 7000,
      env: { PATH: '/usr/bin:/bin' },
    });
  });

  it('refuses wrong parent expectations, forged channels and invalid inputs', () => {
    expect(() => connectLinuxLauncherChannel(addon, process.pid)).toThrow();
    for (const pid of [0, 1, -1, 1.2, NaN, 0x80000000])
      expect(() => connectLinuxLauncherChannel(addon, pid)).toThrow();
    expect(() =>
      linuxChannelPeer({
        read: () => Promise.resolve(null),
        write: () => Promise.resolve(),
        close: () => {},
      }),
    ).toThrow();
  });

  it.each([
    'missing',
    'ambiguous',
    'short',
    'unknown',
    'missing-pidfd',
    'wrong-instance',
  ])(
    'refuses injected %s receive evidence after a real kernel receive',
    async (fault) => {
      // Fault-only builds exercise impossible-to-submit malformed kernel output;
      // normal peer/delegation/SCM_RIGHTS tests above use the unmodified product.
      const wrapper = path.join(dir, `${fault}.c`);
      const out = path.join(dir, `${fault}.node`);
      writeFileSync(
        wrapper,
        `
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <string.h>
static ssize_t injected(int fd, struct msghdr *m, int flags) {
  ssize_t n=recvmsg(fd,m,flags);if(n<=0)return n;
  // Let the real reaped-sender capability probe pass before injecting channel faults.
  static int probed=0;if(!probed){probed=1;return n;}
  struct cmsghdr *c=NULL,*pidfd=NULL;
  for(struct cmsghdr *at=CMSG_FIRSTHDR(m);at;at=CMSG_NXTHDR(m,at)){
    if(at->cmsg_level==SOL_SOCKET && at->cmsg_type==SCM_CREDENTIALS)c=at;
    if(at->cmsg_level==SOL_SOCKET && at->cmsg_type==4)pidfd=at;
  }
  ${fault === 'missing' ? 'if(c){size_t k=CMSG_SPACE(sizeof(struct ucred));size_t off=(char*)c-(char*)m->msg_control;memmove(c,(char*)c+k,m->msg_controllen-off-k);m->msg_controllen-=k;}' : ''}
  ${fault === 'short' ? 'if(c)c->cmsg_len=CMSG_LEN(sizeof(struct ucred)-1);' : ''}
  ${fault === 'unknown' ? 'if(c)c->cmsg_type=0x7777;' : ''}
  ${fault === 'ambiguous' ? 'if(c){size_t len=CMSG_SPACE(sizeof(struct ucred));memcpy((char*)m->msg_control+m->msg_controllen,c,len);m->msg_controllen+=len;}' : ''}
  ${fault === 'missing-pidfd' ? 'if(pidfd){int old;memcpy(&old,CMSG_DATA(pidfd),sizeof old);close(old);size_t k=CMSG_SPACE(sizeof(int));size_t off=(char*)pidfd-(char*)m->msg_control;memmove(pidfd,(char*)pidfd+k,m->msg_controllen-off-k);m->msg_controllen-=k;}' : ''}
  ${fault === 'wrong-instance' ? 'if(pidfd){int old;memcpy(&old,CMSG_DATA(pidfd),sizeof old);close(old);int replacement=syscall(SYS_pidfd_open,getpid(),0);memcpy(CMSG_DATA(pidfd),&replacement,sizeof replacement);}' : ''}
  return n;
}
#define recvmsg injected
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
      const { channel } = await launch('echo', out);
      await channel.write(Buffer.from('frame'));
      await expect(channel.read(AbortSignal.timeout(5000))).rejects.toThrow();
    },
  );
});
