import type { RuntimeCore } from '../runtime/core';

/** Hardware image processing is absent for the blank virtual source. The SDK
 * still submits/awaits a bounded CQ job and owns all preview buffers/notifications. */
export class BlankImageJobs {
  jobs = 0;
  constructor(core: RuntimeCore) {
    const { sdk, profile, cpu } = core,
      abi = profile.sdk.image_jobs;
    if (profile.machine.imaging.source !== 'blank')
      throw new Error('Unsupported virtual image source');
    core.bind('imaging.build_blank_job', () => {
      const argument = cpu.readRegister('sp') + (abi.queue_argument - 4) * 4;
      if (abi.queue_argument < 4 || !profile.inRam(argument, 4))
        throw new Error('Image job arguments outside RAM');
      const queue = sdk.u32(argument);
      if (!profile.inRam(queue, abi.commands_offset))
        throw new Error('Image command queue outside RAM');
      const capacity = sdk.u32(queue + abi.capacity_offset),
        length = sdk.u32(queue + abi.length_offset);
      if (
        !capacity ||
        length >= capacity ||
        capacity > 0x100000 ||
        !profile.inRam(queue, abi.commands_offset + capacity * 4, true)
      )
        throw new Error('Invalid image command queue capacity');
      // Independently encoded CQ END. No UI state, ready flags or completion
      // events are changed: normal DMA execution raises the native completion IRQ.
      sdk.put32(queue + abi.commands_offset + length * 4, 0x0f000000);
      sdk.put32(queue + abi.length_offset, length + 1);
      this.jobs++;
      sdk.ret();
    });
  }
}
