import { Gic } from '../../src/runtime/gic';

export const gicConfig = { distributor: 0x1000, cpu_interface: 0x2000 };
export function enabledGic(output?: (asserted: boolean) => void): Gic {
  const gic = new Gic(gicConfig, output);
  gic.write(0x1000, 4, 1n);
  gic.write(0x2000, 4, 1n);
  gic.write(0x2004, 4, 255n);
  for (let offset = 0; offset < 32; offset += 4)
    gic.write(0x1100 + offset, 4, 0xffffffffn);
  for (let offset = 32; offset < 256; offset += 4)
    gic.write(0x1800 + offset, 4, 0x01010101n);
  return gic;
}
