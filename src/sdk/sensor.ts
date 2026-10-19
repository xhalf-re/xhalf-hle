import type { RuntimeCore } from '../runtime/core';
import bridge from './sensor-register.json';
import { words } from './adapter';

/** Virtual board device registration through the SDK's own configuration API. */
export class SensorRegistration {
  private returning = false;
  registrations = 0;
  constructor(core: RuntimeCore) {
    const { profile, cpu } = core,
      ports = profile.machine.peripherals.frontend.interface_types,
      scratch = profile.scratch('sensor_registration'),
      sdk = profile.sdk.sensor_registration,
      address = profile.address('sdk.sensor.config_initialized');
    if (ports.length !== 4 || ports.some((type) => ![0, 1, 2].includes(type)))
      throw new Error('Unsupported virtual sensor port layout');
    const bytes = new Uint8Array(bridge.length + ports.length * 4);
    bytes.set(bridge);
    bytes.set(
      words([
        profile.address('sdk.sensor.config_set'),
        ports.length,
        sdk.identity_command,
        sdk.interface_command,
        address,
        0,
        ...ports,
      ]),
      bridge.length - 24,
    );
    cpu.write(scratch, bytes);
    core.bind(
      'sdk.sensor.config_initialized',
      () => {
        if (this.returning) {
          this.returning = false;
          const status = core.sdk.u32(scratch + bridge.length - 4);
          if (status)
            throw new Error(`Native sensor registration failed (${status})`);
          this.registrations++;
        } else {
          this.returning = true;
          cpu.writeRegister('pc', scratch);
        }
      },
      true,
    );
  }
}
