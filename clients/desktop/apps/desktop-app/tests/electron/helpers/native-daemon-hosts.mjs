import { _electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  cp,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { verifyE2eDaemonHosts } from '../../../../../scripts/lib/e2e-core-daemon-artifact.mjs';

const HOST_TIMEOUT_MS = 30_000;

export function requestHost(child, command, timeoutMs = HOST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = `${command}-${Math.random()}`;
    const timer = setTimeout(
      () => finish(new Error(`CLI ${command} timed out`)),
      timeoutMs,
    );
    const onMessage = (message) => {
      if (message.id === id)
        finish(message.error ? new Error(message.error) : null, message.value);
    };
    const onExit = (code, signal) =>
      finish(new Error(`CLI exited during ${command}: ${code ?? signal}`));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ id, command }, (error) => {
      if (error) finish(error);
    });
  });
}

export function withNativeDaemonHosts(testInfo, scenario) {
  return withNativeDaemonArtifacts(testInfo, (directory) =>
    runNativeDaemonHosts(testInfo, scenario, directory),
  );
}

export async function withNativeDaemonArtifacts(testInfo, run) {
  const directory = await realpath(
    await mkdtemp(join('/tmp', 'can4253-native-')),
  );
  let failure;
  try {
    await run(directory);
  } catch (error) {
    failure = error;
    await writeFile(
      join(directory, 'failure.txt'),
      String(error.stack || error),
    );
  } finally {
    try {
      await cp(directory, testInfo.outputPath('native-host'), {
        recursive: true,
        filter: async (source) => !(await lstat(source)).isSocket(),
      });
    } catch (error) {
      if (!failure) failure = error;
      else
        await testInfo.attach('artifact-copy-error.txt', {
          body: String(error),
          contentType: 'text/plain',
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (failure) throw failure;
}

async function runNativeDaemonHosts(testInfo, scenario, directory) {
  const dataRoot = join(directory, 'data');
  await mkdir(dataRoot, { mode: 0o700 });
  const sourceSha = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'])
  ).stdout.trim();
  const {
    executable,
    cliExecutable,
    ownedChildNativePath: nativePath,
  } = verifyE2eDaemonHosts({
    root: process.cwd(),
    sourceSha,
    platform: process.platform,
    arch: process.arch,
  });
  const readDescriptor = async () =>
    JSON.parse(await readFile(join(dataRoot, 'runtime/core.json'), 'utf8'));
  const packageJson = JSON.parse(
    await readFile(resolve('package.json'), 'utf8'),
  );
  const fixture = join(directory, 'main.cjs');
  const cliFixture = join(directory, 'cli.cjs');
  let electron;
  let cliHost;
  let passed = false;
  const artifact = JSON.parse(
    await readFile('.cache/e2e-core-daemon/manifest.json', 'utf8'),
  );
  const report = {
    dataRoot,
    executable,
    cliExecutable,
    nativePath,
    sourceSha,
    artifact,
  };
  const env = {
    ...process.env,
    CAN4213_HOST_INPUTS: JSON.stringify({
      dataRoot,
      runtimeMode: 'dev',
      executable,
      ownedChildNativePath: nativePath,
    }),
  };
  let inspect;
  let cliErrors = '';
  // Production host composition executes in real Electron main; no renderer seam.
  const source = `
    import {app,BrowserWindow} from 'electron';
    import {createElectronDaemonHost,ELECTRON_DAEMON_DEFINITIONS} from './apps/desktop-app/src/main/canopy-runtime/electron-daemon-host';
    import {createElectronDaemonConnectionService} from './apps/desktop-app/src/main/canopy-runtime/electron-daemon-connection';
    import {attachOrStartCanopyDaemon} from '@canopy/core-client/node';
    globalThis.h3Ready=app.whenReady().then(async()=>{
      const window=new BrowserWindow({show:false});
      await window.loadURL('data:text/html,<title>H3 native fixture</title>');
      const inputs=JSON.parse(process.env.CAN4213_HOST_INPUTS);
      const host=await createElectronDaemonHost(inputs);
      let late,reconnect;
      const acquisitions=[];
      const declarations=[];
      const releases=[];
      const evictions=[];
      const service=createElectronDaemonConnectionService({enabled:true,authorityId:async()=>host.authorityId,attach:async(signal)=>{
        const result=await attachOrStartCanopyDaemon({...host.launch,signal,
          attach:(endpoint,setup)=>host.connect({endpoint,...setup,clientName:'desktop',clientVersion:'h3-native',definitions:ELECTRON_DAEMON_DEFINITIONS}),
          dispose:(client)=>client.close()});
        const client=result.value;
        client.onLeaseEvicted(event=>evictions.push(event));
        return {...client,instruction:async(name,params,options)=>{
          const value=await client.instruction(name,params,options);
          if(name==='core.client.lease.acquire'){acquisitions.push({params,result:value});if(reconnect){reconnect.enter();await reconnect.gate;}}
          if(name==='core.client.capabilities.register'){declarations.push(value);if(late){late.enter();await late.gate;}}
          if(name==='core.client.lease.release') releases.push(value);
          return value;
        }};
      }});
      const caller={principalId:'local-user',clientInstanceId:'electron-main-h3',authorityId:host.authorityId,interfaceKind:'desktop',grants:['core.runtime.read']};
      let owner=new AbortController();
      window.webContents.on('did-start-navigation',()=>owner.abort());
      let session=await service.get(caller,owner.signal);
      const reused=await service.get(caller,owner.signal)===session;
      const register=async()=>new Promise((resolve,reject)=>{
        session.lease.register('native-capability',async(lease,client)=>{
          try {resolve(await client.instruction('core.client.capabilities.register',{
            capabilities:[{name:'core.test.native',version:1,inputSchema:{},outputSchema:{}}],
            _meta:{idempotencyKey:'native-'+lease.leaseId}
          }));} catch(error) {reject(error);}
        });
      });
      const stream=await session.client.openStream('core.runtime.events',{});
      const initial={electron:session.client.identity,electronLease:session.lease.lease,reused,
        health:await session.client.query('core.runtime.health.get',{}),
        subscriptionId:stream.openResult.subscriptionId,
        manifest:Array.from(session.client.manifest.operations),
        streams:Array.from(session.client.manifest.streams),
        events:Array.from(session.client.manifest.events),
        mainPid:process.pid,expectedAuthorityId:host.authorityId};
      globalThis.h3State={
        get session(){return session;},
        initial,
        register,
        snapshot:()=>({identity:session.client.identity,lease:session.lease.lease}),
        async pauseReconnect(){
          let enter,complete;
          const entered=new Promise(done=>enter=done),gate=new Promise(done=>complete=done);
          reconnect={enter,gate,complete};await session.client.close();await entered;
          return {identity:session.client.identity,lease:session.lease.lease};
        },
        resumeReconnect(){reconnect.complete();reconnect=undefined;},
        async lateRegistration(){
          let enter,complete;
          const entered=new Promise(done=>enter=done);
          const gate=new Promise(done=>complete=done);
          late={enter,gate};
          const outcome=session.client.instruction('core.client.capabilities.register',{
            capabilities:[{name:'core.test.late',version:1,inputSchema:{},outputSchema:{}}],_meta:{idempotencyKey:'late'}
          }).then(()=>'escaped',error=>error.payload?.kind||String(error));
          await entered;owner.abort();await session.close();complete();late=undefined;
          return {outcome:await outcome,release:releases.at(-1),state:session.lease.state,lease:session.lease.lease};
        },
        async loseOwner(){
          await new Promise(done=>{window.webContents.once('did-finish-load',done);window.webContents.reload();});
          await session.close();
          stream.close();
          return releases.at(-1);
        },
        async reacquire(){
          owner=new AbortController();
          session=await service.get(caller,owner.signal);
          return {identity:session.client.identity,lease:session.lease.lease,
            health:await session.client.query('core.runtime.health.get',{})};
        },
        async releaseRegistered(){
          const result=await session.client.instruction('core.client.lease.release',{reason:'normal_shutdown'});
          owner.abort();
          await session.close();
          return result;
        },
        releases,
        evictions,
        acquisitions,
        declarations,
        cleanup:()=>{reconnect?.complete();return service.dispose();},
      };
      return initial;
    });`;
  const define = {
    __CANOPY_CURSOR_CLI__: JSON.stringify(packageJson['cursor-cli']),
    __CANOPY_E2E__: 'false',
    __CANOPY_RELEASE_FLAVOR__: JSON.stringify('internal'),
    __CANOPY_CLOUD_BASE_URL__: JSON.stringify(''),
    __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: 'false',
  };
  const bundle = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    define,
  };
  try {
    const inspector = join(directory, 'inspect.cjs');
    await build({
      stdin: {
        contents: `import {hostPlatformServices,createPlatformEndpointServices,hostPlatformOperatingSystem} from '@canopy/core-platform'; export const inspect=hostPlatformServices(createPlatformEndpointServices(hostPlatformOperatingSystem())).supervision.inspectProcess;`,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      outfile: inspector,
      ...bundle,
    });
    inspect = createRequire(import.meta.url)(inspector).inspect;
    await build({
      stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' },
      outfile: fixture,
      ...bundle,
      external: ['electron'],
      banner: {
        js: `process.on('uncaughtException', error => {process.stderr.write(String(error.stack)); require('electron').app.exit(1);}); process.on('unhandledRejection', error => {process.stderr.write(String(error.stack)); require('electron').app.exit(1);});`,
      },
    });
    await build({
      stdin: {
        contents: `
        import {daemonStatusAction} from './apps/desktop-cli/src/commands/daemon-status';
        import {createCliDaemonHost} from './apps/desktop-cli/src/runtime';
        import {attachOrStartCanopyDaemon} from '@canopy/core-client/node';
        import {createCanopyClientLease} from '@canopy/core-client';
        import {CORE_TRANSPORT_QUERY_DEFINITIONS,CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,CORE_TRANSPORT_STREAM_DEFINITIONS} from '@canopy/protocol/canopy-core';
        const definitions={queries:CORE_TRANSPORT_QUERY_DEFINITIONS,instructions:CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,streams:CORE_TRANSPORT_STREAM_DEFINITIONS};
        const host=createCliDaemonHost(JSON.parse(process.env.CAN4213_HOST_INPUTS));
        let client,lease,stream;
        const evictions=[];

        const attach=async()=>{
          const result=await attachOrStartCanopyDaemon({...host.launch,
            attach:(endpoint,setup)=>host.connect({endpoint,...setup,clientName:'cli',clientVersion:'h3-native',definitions}),
            dispose:(connected)=>connected.close()});
          return result;
        };
        const start=async()=>{
          const result=await attach();
          client=result.value;
          client.onLeaseEvicted(event=>evictions.push(event));
          lease=createCanopyClientLease({client,attach:async()=>(await attach()).value,
            identity:{clientInstanceId:'cli-h3-native',interfaceKind:'cli',label:'native proof'},
            renewalIntervalMs:15000,presence:()=>({interactive:true,foreground:true})});
          await lease.acquire();
          stream=await client.openStream('core.runtime.events',{});
          return {identity:client.identity,lease:lease.lease,started:result.started,
            subscriptionId:stream.openResult.subscriptionId,
            health:await client.query('core.runtime.health.get',{})};
        };
        const release=async()=>{stream?.close();await lease?.release('normal_shutdown');await client?.close();stream=lease=client=undefined;};
        const status=async(mode)=>{
          const evidence={acquires:[],releases:[],output:[],errors:[]};
          let entered;
          const ready=new Promise(done=>entered=done);
          const command=daemonStatusAction({clientVersion:'can4253',host:()=>({...host,connect:async(options)=>{
            const connected=await host.connect(options);
            return {...connected,instruction:async(name,params,options)=>{
              const value=await connected.instruction(name,params,options);
              if(name==='core.client.lease.acquire')evidence.acquires.push(value);
              if(name==='core.client.lease.release')evidence.releases.push(value);
              return value;
            },query:async(name,params,options)=>{
              evidence.identity=connected.identity;
              evidence.health=await connected.query(name,params,options);
              if(mode==='failure')throw new Error('CAN4253 controlled command failure');
              entered();
              return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
            }};
          }}),io:{stdout:text=>evidence.output.push(text),stderr:text=>evidence.errors.push(text),onSignal:listener=>{const handler=()=>listener('SIGTERM');process.on('SIGTERM',handler);return()=>process.off('SIGTERM',handler);},exit:code=>{throw new Error('forced exit '+code);}}});
          if(mode==='signal'){await ready;process.kill(process.pid,'SIGTERM');}
          evidence.code=await command;return evidence;
        };
        const passive=async()=>{
          await release();const result=await attach();client=result.value;
          client.onLeaseEvicted(event=>evictions.push(event));
          const held=await client.instruction('core.client.lease.acquire',{clientInstanceId:'cli-passive',interfaceKind:'cli',label:'TTL acceptance',renewalIntervalMs:5000,interactive:false,foreground:false,_meta:{idempotencyKey:'passive'}});
          await client.instruction('core.client.capabilities.register',{capabilities:[{name:'core.test.passive',version:1,inputSchema:{},outputSchema:{}}],_meta:{idempotencyKey:'passive-declaration'}});
          stream=await client.openStream('core.runtime.events',{});
          return {lease:held,identity:client.identity};
        };
        process.on('message',async({id,command})=>{
          try {
            const value=command==='status-failure'?await status('failure')
              : command==='status-signal'?await status('signal')
              : command==='passive'?await passive()
              : command==='events'?evictions
              : command==='start'||command==='reacquire' ? await start()
              : command==='health' ? await client.query('core.runtime.health.get',{})
              : command==='release'||command==='exit' ? await release() : null;
            process.send({id,value});
            if(command==='exit') setImmediate(()=>process.exit(0));
          } catch(error) {process.send({id,error:String(error.stack||error)});}
        });`,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      outfile: cliFixture,
      ...bundle,
    });
    electron = await _electron.launch({
      args: [fixture, `--user-data-dir=${join(directory, 'chromium')}`],
      env,
    });
    await electron
      .context()
      .tracing.start({ screenshots: true, snapshots: true });
    electron.process().stderr.on('data', (chunk) => {
      report.electronErrors = ((report.electronErrors || '') + chunk).slice(
        -32768,
      );
    });
    const evidence = await electron.evaluate(async () => globalThis.h3Ready);
    cliHost = fork(cliFixture, [], {
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    cliHost.stderr.on('data', (chunk) => {
      cliErrors = (cliErrors + chunk).slice(-16_384);
    });
    const cliSession = await requestHost(cliHost, 'start');
    const descriptor = await readDescriptor();
    Object.assign(report, {
      evidence,
      cliSession,
      descriptor,
      cliPid: cliHost.pid,
    });
    await scenario({
      electron,
      cliHost,
      evidence,
      cliSession,
      descriptor,
      readDescriptor,
      report,
      dataRoot,
      cliExecutable,
      closeElectron: async () => {
        await electron
          .context()
          .tracing.stop({ path: testInfo.outputPath('native-host-trace.zip') });
        await electron.close();
        electron = undefined;
      },
    });
    passed = true;
  } finally {
    if (electron) {
      await electron
        .context()
        .tracing.stop({ path: testInfo.outputPath('native-host-trace.zip') })
        .catch(() => undefined);
      await electron
        .evaluate(async () => globalThis.h3State?.cleanup())
        .catch(() => undefined);
      await electron.close().catch(() => undefined);
    }
    if (cliHost) {
      if (cliHost.connected)
        await requestHost(cliHost, 'exit', 5_000).catch(() => undefined);
      if (cliHost.exitCode === null && cliHost.signalCode === null)
        cliHost.kill('SIGTERM');
      if (cliHost.exitCode === null && cliHost.signalCode === null)
        await Promise.race([
          new Promise((resolve) => cliHost.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      if (cliHost.exitCode === null && cliHost.signalCode === null) {
        cliHost.kill('SIGKILL');
        await new Promise((resolve) => cliHost.once('exit', resolve));
      }
    }
    const owned =
      report.descriptor ?? (await readDescriptor().catch(() => null));
    if (owned && inspect) {
      const current = await inspect({ pid: owned.pid });
      if (
        !passed &&
        current.state === 'running' &&
        current.startIdentity === owned.startIdentity
      )
        process.kill(owned.pid, 'SIGTERM');
      await expect
        .poll(async () => (await inspect({ pid: owned.pid })).state, {
          timeout: passed ? 45_000 : 10_000,
        })
        .toBe('absent');
      report.processCleanup = 'descriptor owner exited';
    }
    Object.assign(report, { cliErrors, passed });
    await testInfo.attach('native-host-evidence.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    await writeFile(
      join(directory, 'evidence.json'),
      JSON.stringify(report, null, 2),
    );
  }
}
