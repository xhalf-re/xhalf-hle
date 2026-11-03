import { createDynarmicBackend } from '../../src/cpu/dynarmic';
import programs from '../arm/programs.json';

/** More unique modules than Firefox's executable-memory allocation tolerates
 * without reclamation. All guest bytes come from our synthetic ARM fixture. */
export async function jitCacheContract() {
  const cpu = await createDynarmicBackend();
  const base = 0x42000000,
    count = 70000,
    end = base + count * 4;
  const bytes = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) bytes.set(programs.loop.slice(0, 4), i * 4);
  cpu.map(base, 0x80000);
  cpu.write(base, bytes);
  let pc = base;
  const deadline = performance.now() + 90000;
  try {
    while (pc !== end) {
      cpu.run(pc, 256, end);
      pc = cpu.readRegister('pc');
      if (performance.now() > deadline)
        throw Error('JIT cache reclamation timeout');
      await new Promise((resolve) =>
        setTimeout(resolve, cpu.executionStats.jitRetryPending ? 50 : 0),
      );
    }
    const result = cpu.readRegister('r0');
    const before = cpu.executionStats.jitCompiledBlocks;
    do {
      cpu.run(base, 1, end);
      if (cpu.executionStats.jitRetryPending)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (performance.now() > deadline)
        throw Error('Evicted block recompile timeout');
    } while (cpu.executionStats.jitRetryPending);
    return {
      result,
      afterRecompile: cpu.readRegister('r0'),
      recompiled: cpu.executionStats.jitCompiledBlocks > before,
      ...cpu.executionStats,
    };
  } finally {
    cpu.destroy();
  }
}
