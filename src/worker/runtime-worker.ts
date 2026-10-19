/// <reference lib="webworker" />
import { FirmwareError } from '../firmware/errors';
import { loadBundle } from '../firmware/package';
import type { FirmwareBundle } from '../firmware/package';
import { FirmwareProfile } from '../firmware/profile';
import type { Command, WorkerEvent } from './protocol';
import { createUnicornBackend } from '../cpu/unicorn';
import { RuntimeCore } from '../runtime/core';
import { SdkServices } from '../sdk/services';
import { GuestCalls } from '../sdk/guest';
import { ProgressWatch } from '../runtime/progress';
import { NativeDisplay } from '../sdk/display';
import { SdkGraphics } from '../sdk/graphics';
import { NativeInput } from '../sdk/input';
import { FirstSetup } from '../runtime/first-setup';
import { BulkAcceleration } from '../sdk/acceleration';
import { sdkPoint } from '../sdk/coordinates';
import { CooperativeRunner } from '../runtime/cooperative';

const worker = self as unknown as DedicatedWorkerGlobalScope;
let activeSession = 0,
  generation = 0;
let abort: AbortController | undefined;
let bundle: FirmwareBundle | undefined, profile: FirmwareProfile | undefined;
const send = (event: WorkerEvent, transfers: Transferable[] = []) =>
  worker.postMessage(event, transfers);
let display: NativeDisplay | undefined,
  input: NativeInput | undefined,
  manualSetup = false;
let epoch: { wall: number; virtual: bigint } | undefined;
let core: RuntimeCore | undefined, runner: CooperativeRunner | undefined;
let state = 'empty';
let bootReady = false;
let inputBurst = false;
let metricsDirty = false;
function releaseRuntime(): void {
  runner?.stop();
  runner = undefined;
  core?.destroy();
  core = undefined;
  display = undefined;
  input = undefined;
  epoch = undefined;
  bootReady = false;
  metricsDirty = false;
}
function release(): void {
  releaseRuntime();
  abort?.abort();
  bundle = undefined;
  profile = undefined;
}
async function startRuntime(
  request: number,
  session: number,
  reset = false,
): Promise<void> {
  if (
    !bundle ||
    !profile ||
    (state === 'starting' && !reset) ||
    (core && !reset)
  )
    return;
  if (reset) {
    generation++;
    releaseRuntime();
  }
  const current = generation;
  state = 'starting';
  send({ type: 'state', state: 'starting', request, session });
  const cpu = await createUnicornBackend(profile.machine.cpu_model);
  if (current !== generation) {
    cpu.destroy();
    return;
  }
  try {
    core = new RuntimeCore(cpu, profile, bundle);
    new GuestCalls(core);
    new SdkServices(core);
    const graphics = new SdkGraphics(core);
    const acceleration = new BulkAcceleration(core);
    input = new NativeInput(core);
    display = new NativeDisplay(core, (frame) =>
      send({ type: 'frame', ...frame, request, session }, [frame.pixels]),
    );
    const startup = manualSetup ? undefined : new FirstSetup(core, input);
    core.nextCall = () => {
      startup?.poll();
      return input!.nextCall();
    };
    core.completeCall = (call, status) => {
      if (call.kind === 'input') input!.complete(status);
    };
    core.afterStep = () => {
      display!.poll();
    };
    const started = performance.now();
    const watch = new ProgressWatch();
    let last = 0,
      ready = false,
      lastMenuSignature = '';
    runner = new CooperativeRunner(
      () => {
        const pendingInput =
          !!input && (input.pending.length > 0 || input.touch.busy);
        if (epoch && !inputBurst && !pendingInput) {
          const ahead =
            Number(core!.virtualNs - epoch.virtual) / 1e6 -
            (performance.now() - epoch.wall);
          if (ahead > 10) return Math.min(ahead - 10, 20);
        }
        core!.step();
        const inputAfterStep =
          !!input && (input.pending.length > 0 || input.touch.busy);
        if (inputBurst && !inputAfterStep && epoch)
          epoch = { wall: performance.now(), virtual: core!.virtualNs };
        inputBurst = inputAfterStep;
        const menu = core!.sdk.menuState(),
          menuSignature = `${menu?.id ?? 0}:${menu?.index ?? 0}:${menu?.category ?? 0}:${input!.idle}:${display!.frameCount}`;
        if (
          metricsDirty ||
          menuSignature !== lastMenuSignature ||
          performance.now() - last >= 200
        ) {
          last = performance.now();
          metricsDirty = false;
          lastMenuSignature = menuSignature;
          const metrics = core!.diagnostics();
          metrics.bootMs = last - started;
          metrics.inputQueued = input!.pending.length;
          metrics.memoryCalls = acceleration.memoryCalls;
          metrics.graphicsMs = graphics.graphicsMs;
          metrics.rasterCalls = acceleration.rasterCalls;
          metrics.pixelCalls = acceleration.pixelCalls;
          metrics.accelerationFallbacks = acceleration.fallbacks;
          metrics.inputSent = input!.sent;
          metrics.inputErrors = input!.errors;
          metrics.touchBusy = input!.touch.busy;
          metrics.touchEvents = input!.touch.events;
          metrics.touchIgnored = input!.touch.ignored;
          metrics.pointerQueued = input!.touch.samples.filter(
            (sample) => !!sample.pointer,
          ).length;
          metrics.inputIdle = input!.idle;
          metrics.frameDrops = display!.dropped;
          metrics.frames = display!.frameCount;
          metrics.displaySubmissions = display!.submissions;
          metrics.frameCurrent = display!.current;
          metrics.frameSettled =
            display!.inFlight === 0 && metrics.frameCurrent;
          metrics.framesInFlight = display!.inFlight;
          metrics.nativeFrames = core!.panel.vsyncs;
          metrics.nativeFrameCompletions = core!.panel.scanAcknowledgements;
          metrics.coalescedVsyncs = core!.panel.coalescedVsyncs;
          metrics.menuReady =
            metrics.menu === profile!.firmware.ui.roles['shooting.main'] &&
            metrics.category === 0 &&
            input!.idle &&
            metrics.frameSettled;
          if (
            !epoch &&
            (metrics.menuReady ||
              (manualSetup && metrics.uiCreated && Number(metrics.menu) > 0))
          )
            epoch = { wall: performance.now(), virtual: core!.virtualNs };
          const progress = watch.sample(
            `${metrics.threads}:${metrics.storageReadBytes}:${metrics.menu}:${metrics.threadRuns}`,
            last,
          );
          metrics.stalled = progress.stalled;
          metrics.unchangedMs = progress.unchangedMs;
          send({ type: 'metrics', metrics, request, session });
          if (
            !ready &&
            metrics.uiCreated &&
            metrics.hostRan &&
            Number(metrics.menu) > 0
          ) {
            ready = true;
            bootReady = true;
            state = 'running';
            send({ type: 'state', state: 'running', request, session });
          }
          if (!ready && last - started > 120000)
            throw new Error(
              'Native UI initialization exceeded the 120 second boot deadline',
            );
          if (!manualSetup && !epoch && last - started > 120000)
            throw new Error(
              'Native main menu startup exceeded the 120 second boot deadline',
            );
        }
      },
      (error) => {
        const pc = core?.cpu.readRegister('pc');
        state = 'error';
        send({
          type: 'error',
          code: 'RUNTIME_ERROR',
          message: `${error instanceof Error ? error.message : 'Runtime failed'}${pc === undefined ? '' : ` · PC 0x${pc.toString(16)}`}`,
          request,
          session,
        });
        release();
      },
      () => (epoch ? 16 : 112),
    );
    runner.start();
  } catch (error) {
    cpu.destroy();
    throw error;
  }
}
worker.onmessage = async (event: MessageEvent<Command>) => {
  const command = event.data,
    { request, session } = command;
  if (command.type !== 'load' && session !== activeSession) return;
  if (command.type === 'stop') {
    generation++;
    release();
    send({ type: 'state', state: 'stopped', request, session });
    return;
  }
  if (command.type !== 'load') {
    try {
      if (command.type === 'frameAck') {
        display?.acknowledge(command.frame, command.pixels);
        metricsDirty = true;
      } else if (command.type === 'key') {
        inputBurst = true;
        if (command.down) input?.press(command.key);
        else input?.release(command.key);
      } else if (command.type === 'pointer') {
        if (command.action === 'cancel') {
          input?.touch.cancelPointer();
          inputBurst = false;
          return;
        }
        inputBurst = true;
        const scan = display?.description();
        if (!core || !input || !scan) return;
        const rotation = core.profile.machine.display.rotation_quarters,
          odd = Math.abs(rotation % 2) === 1,
          size = {
            width: odd ? scan.height : scan.width,
            height: odd ? scan.width : scan.height,
          },
          abi = core.profile.sdk.input;
        const point = sdkPoint(
          { x: command.x, y: command.y },
          size,
          scan,
          rotation,
          abi.pointer_space,
          { width: abi.pointer_size[0]!, height: abi.pointer_size[1]! },
        );
        input.touch.pointer(command.action, point.x, point.y, command.time);
      } else if (command.type === 'start' || command.type === 'reset')
        await startRuntime(request, session, command.type === 'reset');
      else if (command.type === 'pause' && runner) {
        runner.stop();
        state = 'paused';
        send({ type: 'state', state: 'paused', request, session });
      } else if (command.type === 'resume' && runner && state === 'paused') {
        if (epoch && core)
          epoch = { wall: performance.now(), virtual: core.virtualNs };
        runner.start();
        state = bootReady ? 'running' : 'starting';
        send({
          type: 'state',
          state: bootReady ? 'running' : 'starting',
          request,
          session,
        });
      }
    } catch (error) {
      release();
      state = 'error';
      send({
        type: 'error',
        code: 'RUNTIME_ERROR',
        message: error instanceof Error ? error.message : 'Startup failed',
        request,
        session,
      });
    }
    return;
  }
  generation++;
  const current = generation;
  activeSession = session;
  release();
  abort = new AbortController();
  manualSetup = command.manualSetup;
  const signal = abort.signal,
    started = performance.now();
  try {
    if (
      !(command.file instanceof File) ||
      !command.file.size ||
      command.file.size > 512 * 1024 * 1024
    )
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'Choose a complete DAT file no larger than 512 MiB.',
      );
    send({ type: 'state', state: 'loading', request, session });
    send({
      type: 'progress',
      stage: 'Reading local file',
      fraction: 0.1,
      request,
      session,
    });
    state = 'loading';
    const bytes = await command.file.arrayBuffer();
    if (current !== generation) return;
    send({
      type: 'progress',
      stage: 'Parsing SUNP and resource identities',
      fraction: 0.3,
      request,
      session,
    });
    const parsed = await loadBundle(new Uint8Array(bytes), signal);
    if (current !== generation) return;
    const selected = new FirmwareProfile();
    send({
      type: 'progress',
      stage: 'Validating firmware and SDK contracts',
      fraction: 0.65,
      request,
      session,
    });
    await selected.preflight(parsed, signal);
    if (current !== generation) return;
    bundle = parsed;
    profile = selected;
    state = 'loaded';
    send({
      type: 'progress',
      stage: 'Package and resources validated',
      fraction: 1,
      request,
      session,
    });
    send({
      type: 'metrics',
      metrics: {
        profile: profile.id,
        loadMs: performance.now() - started,
        payloadBytes: bundle.payload.length,
        resourceABytes: bundle.images.A.length,
        resourceBBytes: bundle.images.B.length,
      },
      request,
      session,
    });
    send({
      type: 'state',
      state: 'loaded',
      profile: profile.id,
      request,
      session,
    });
    await startRuntime(request, session);
  } catch (error) {
    if (current !== generation) return;
    release();
    send({
      type: 'error',
      code: error instanceof FirmwareError ? error.code : 'RUNTIME_ERROR',
      message:
        error instanceof FirmwareError
          ? error.message
          : 'Unable to parse the file. Choose a complete DAT and try again.',
      request,
      session,
    });
  }
};
