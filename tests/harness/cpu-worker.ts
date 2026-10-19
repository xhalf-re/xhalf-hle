/// <reference lib="webworker" />
import { createUnicornBackend } from '../../src/cpu/unicorn';
import { CooperativeRunner } from '../../src/runtime/cooperative';
import programs from '../arm/programs.json';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const cpu = await createUnicornBackend();
cpu.map(0x40000000, 4096);
cpu.write(0x40000000, Uint8Array.from(programs.loop));
const runner = new CooperativeRunner(
  () => cpu.runSlice(cpu.readRegister('pc') || 0x40000000, 10000),
  (error) => worker.postMessage({ type: 'error', message: String(error) }),
);
worker.onmessage = (event: MessageEvent<{ type: string; id: number }>) => {
  const { type, id } = event.data;
  if (type === 'start') {
    cpu.writeRegister('pc', 0x40000000);
    runner.start();
  }
  if (type === 'stop') runner.stop();
  if (type === 'fault') {
    cpu.writeRegister('pc', 0x70000000);
    runner.start();
  }
  worker.postMessage({ type: 'ack', id, value: cpu.readRegister('r0') });
};
worker.postMessage({ type: 'ready' });
