import { expect, test } from 'vitest';
import { PeripheralBus } from '../../src/devices/bus';
import { GpioInputs } from '../../src/devices/gpio-input';
import { I2cController } from '../../src/devices/i2c';
import { TouchController } from '../../src/devices/touch';
import { NativeInput } from '../../src/sdk/input';
import { FirmwareProfile } from '../../src/firmware/profile';
import type { RuntimeCore } from '../../src/runtime/core';
import { enabledGic } from './gic-fixture';
import { GpioInterrupts } from '../../src/devices/gpio';
import { SerialControllers } from '../../src/devices/serial';
import { FirstSetup } from '../../src/runtime/first-setup';

function fixture() {
  const profile = new FirmwareProfile(),
    bus = new PeripheralBus(),
    gic = enabledGic(),
    config = profile.machine.peripherals,
    gpio = new GpioInputs(config.gpio_input, gic),
    i2c = new I2cController(config.i2c, bus.clock),
    touch = new TouchController(config.touch, bus.clock, gpio);
  bus.attach(gpio);
  bus.attach(i2c);
  i2c.attach(config.touch.port, config.touch.address, touch);
  const port = config.i2c.ports[0]!,
    base = port.base,
    edge = config.gpio_input.edge_base;
  bus.write(base, 1, 0x11n);
  bus.write(base + 8, 1, BigInt(config.touch.address << 1));
  const startRead = (register = 0x12, length = 3) => {
    bus.write(port.status, 4, 0xffffffffn);
    bus.write(base + 0x20, 1, BigInt(register));
    bus.write(base + 2, 1, 3n);
    bus.write(base + 0xa, 1, BigInt(length - 1));
    bus.write(base + 4, 1, 1n);
  };
  const read = (register = 0x12, length = 3) => {
    startRead(register, length);
    bus.clock.advance(bus.clock.now + BigInt(config.i2c.transfer_ns));
    return Array.from({ length }, () => Number(bus.read(base + 0x24, 1)));
  };
  const scan = () =>
    bus.clock.advance(bus.clock.now + BigInt(config.touch.sample_interval_ns));
  return {
    profile,
    config,
    bus,
    gic,
    gpio,
    i2c,
    touch,
    base,
    port,
    edge,
    startRead,
    read,
    scan,
  };
}

test('GPIO retains masked edges, routes rising/falling independently, and requires W1C before EOI', () => {
  const f = fixture(),
    bit = 8n;
  f.gpio.signal(3, false);
  expect(f.bus.read(f.edge + 4, 4)).toBe(bit);
  expect(f.gic.highest()).toBe(1023);
  f.bus.write(f.edge + 16, 4, bit);
  expect(f.gic.acknowledge()).toBe(99);
  f.gic.complete(99);
  expect(f.gic.acknowledge()).toBe(99);
  f.bus.write(f.edge + 4, 1, bit);
  f.gic.complete(99);
  expect(f.gic.highest()).toBe(1023);
  f.bus.write(f.edge + 8, 4, bit);
  f.gpio.signal(3, true);
  expect(f.gic.acknowledge()).toBe(67);
  f.bus.write(f.edge, 4, bit);
  f.gic.complete(67);
  f.bus.write(f.edge + 20, 4, bit);
  f.gpio.signal(3, false);
  expect(f.gic.highest()).toBe(1023);
  expect(f.bus.read(f.edge + 4, 4)).toBe(bit);
});

test('GPIO input registers are owned by physical levels and ignore guest writes', () => {
  const f = fixture(),
    address = 0x1000a10e;
  expect(f.bus.read(address, 1)).toBe(3n);
  f.bus.write(address, 1, 0n);
  expect(f.bus.read(address, 1)).toBe(3n);
  f.gpio.drive(address, 1, false);
  expect(f.bus.read(address, 1)).toBe(2n);
  f.bus.reset();
  expect(f.bus.read(address, 1)).toBe(3n);
});

test('both serial ports notify native consumers through GPIO completion latches', () => {
  const f = fixture(),
    gpio = new GpioInterrupts(f.config.gpio, f.gic, f.bus.clock),
    serial = new SerialControllers(f.config.serial, f.bus.clock, (source) =>
      gpio.signal(source),
    );
  f.bus.attach(gpio);
  f.bus.attach(serial);
  f.bus.write(f.config.gpio.base + 0x20, 4, 0x55n);
  for (let port = 0; port < 2; port++)
    for (const field of [4, 0x44])
      f.bus.write(
        f.config.serial.base + port * f.config.serial.stride + field,
        1,
        1n,
      );
  f.bus.clock.advance(BigInt(f.config.serial.transfer_ns));
  expect(f.bus.read(f.config.gpio.base, 4)).toBe(0x55n);
  expect(f.gic.acknowledge()).toBe(186);
  f.bus.write(f.config.gpio.base, 4, 0x55n);
  f.gic.complete(186);
  expect(f.gic.highest()).toBe(1023);
  expect(serial.transfers).toBe(4);
});

test('I2C returns controller bytes through the FIFO only after guest-time completion', () => {
  const f = fixture();
  f.startRead(0x3f, 1);
  expect(f.bus.read(f.port.status, 4)).toBe(0n);
  expect(f.bus.read(f.base + 4, 1)).toBe(1n);
  f.bus.clock.advance(999n);
  expect(f.bus.read(f.port.status, 4)).toBe(0n);
  f.bus.clock.advance(1000n);
  expect(f.bus.read(f.port.status + 2, 2)).toBe(1n);
  expect(f.bus.read(f.base + 4, 1)).toBe(0n);
  expect(f.bus.read(f.base + 0x24, 1)).toBe(1n);
  expect(f.bus.read(f.base + 0x24, 1)).toBe(255n);
  f.bus.write(f.port.status + 2, 2, 1n);
  expect(f.bus.read(f.port.status, 4)).toBe(0n);
});

test('touch registers support partial reads and the controller bounds both FIFOs', () => {
  const f = fixture();
  f.touch.pointer('down', 100, 110, 0);
  f.scan();
  expect(f.read(0x12, 1)).toEqual([0x82]);
  expect(f.read(0x13, 2)).toEqual([110, 28]);
  expect(() => f.startRead(0x12, 17)).toThrow(/capacity/);
  for (let i = 0; i < 16; i++) f.bus.write(f.base + 0x20, 1, 0n);
  expect(() => f.bus.write(f.base + 0x20, 1, 0n)).toThrow(/overflow/);
});

test('I2C routes targets per port, reports NACK, and reset cancels an unfinished transfer', () => {
  const f = fixture();
  f.bus.write(f.base + 8, 1, 0xfen);
  f.startRead();
  f.bus.clock.advance(1000n);
  expect(f.bus.read(f.port.status + 2, 2)).toBe(3n);
  expect(f.i2c.nacks).toBe(1);
  f.startRead();
  f.bus.write(f.config.i2c.reset, 1, 0x10n);
  f.bus.clock.advance(2000n);
  expect(f.bus.read(f.port.status, 4)).toBe(0n);
  expect(f.i2c.transfers).toBe(1);
  f.bus.write(f.base, 1, 0n);
  f.startRead();
  expect(f.bus.clock.pending).toBe(0);
});

test('touch uses native packed coordinates and keeps reporting a stationary held contact', () => {
  const f = fixture();
  f.bus.write(f.edge + 16, 4, 8n);
  f.touch.pointer('down', 100, 110, 200);
  expect(f.gic.highest()).toBe(1023);
  f.scan();
  expect(f.gic.acknowledge()).toBe(99);
  f.bus.write(f.edge + 4, 4, 8n);
  f.gic.complete(99);
  expect(f.read()).toEqual([0x82, 110, 28]); // X=110, Y=640-100, contact bit.
  expect(f.touch.busy).toBe(true);
  f.scan();
  expect(f.gic.acknowledge()).toBe(99);
  expect(f.read()).toEqual([0x82, 110, 28]);
  f.touch.pointer('up', 100, 110, 280);
  f.bus.clock.advance(89000000n);
  expect(f.read()[0]! & 0x80).toBe(0x80);
  f.bus.clock.advance(100000000n);
  expect(f.read()).toEqual([0, 0, 0]);
  expect(f.touch.busy).toBe(false);
});

test('motion coalescing retains press, final movement and release without an unbounded event queue', () => {
  const f = fixture();
  f.touch.pointer('down', 100, 110, 0);
  for (let i = 1; i <= 1000; i++)
    f.touch.pointer('move', 100 + (i % 200), 210, i);
  f.touch.pointer('up', 200, 300, 1100);
  expect(f.touch.samples.map(({ action }) => action)).toEqual([
    'down',
    'move',
    'up',
  ]);
  expect(f.touch.samples[1]).toMatchObject({ x: 200, y: 300 });
  expect(f.bus.clock.pending).toBe(1);
  expect(() => f.touch.pointer('down', 640, 0, 0)).toThrow(/Invalid/);
  expect(() => f.touch.pointer('down', 0, 0, NaN)).toThrow(/Invalid/);
  f.bus.reset();
  expect(f.bus.clock.pending).toBe(0);
  expect(f.touch.busy).toBe(false);
});

test('cancellation drops an unsampled gesture and releases a sampled contact through the chip', () => {
  const f = fixture();
  f.touch.pointer('down', 200, 110, 0);
  f.touch.cancelPointer();
  expect(f.touch.busy).toBe(false);
  expect(f.bus.clock.pending).toBe(0);
  f.touch.pointer('down', 200, 110, 0);
  f.scan();
  expect(f.read()[0]! & 0x80).toBe(0x80);
  f.touch.cancelPointer();
  f.scan();
  expect(f.read()).toEqual([0, 0, 0]);
  expect(f.touch.busy).toBe(false);
  expect(f.i2c.nacks).toBe(0);
});

test('input before the guest enables IRQs cannot hold the host queue indefinitely', () => {
  const f = fixture();
  f.touch.pointer('down', 100, 110, 0);
  f.touch.pointer('up', 100, 110, 80);
  for (let i = 0; i < 12; i++) f.scan();
  expect(f.touch.settled).toBe(true);
  expect(f.bus.clock.pending).toBe(0);
  expect(f.touch.reports).toBe(0);
  expect(f.bus.read(f.edge + 4, 4)).toBe(8n);
});

test('profiles reject off-screen gestures and unresolved gesture sequences', () => {
  const profile = new FirmwareProfile(),
    machine = structuredClone(profile.machine);
  machine.peripherals.input.gestures.return[1]![0] = 640;
  expect(() => new FirmwareProfile(undefined, machine)).toThrow(/input device/);
  const other = structuredClone(profile.machine);
  other.peripherals.input.sequences.tab[0] = 'missing';
  expect(() => new FirmwareProfile(undefined, other)).toThrow(/input device/);
});

test('keyboard gestures reach the physical device without CPU, SDK calls or menu inspection', () => {
  const f = fixture(),
    core = {
      profile: f.profile,
      touch: f.touch,
      virtualNs: 0n,
    } as unknown as RuntimeCore,
    input = new NativeInput(core);
  input.press('return');
  input.press('return');
  input.release('return');
  expect(input.pending).toHaveLength(1);
  input.poll();
  expect(f.touch.samples.map(({ action, x, y }) => [action, x, y])).toEqual([
    ['down', 400, 211],
    ['up', 400, 211],
  ]);
  f.scan();
  expect(f.read()).toEqual([0x80, 211, 240]);
  for (const key of [
    'up',
    'down',
    'left',
    'right',
    'm',
    'tab',
    'ui-back',
    'ui-confirm',
    '1',
    '7',
  ]) {
    input.press(key);
    input.release(key);
  }
  expect(input.pending.length).toBeGreaterThan(10);
  const count = input.pending.length;
  input.press('toString');
  input.press('unknown');
  expect(input.pending).toHaveLength(count);
});

test('startup advances one page at a time and stops setup taps when preview becomes active', () => {
  const profile = new FirmwareProfile(),
    actions: string[] = [],
    state = { id: 12290, mode: 12288 },
    core = {
      profile,
      virtualNs: 2000000000n,
      sdk: { menuState: () => state },
    } as unknown as RuntimeCore,
    pending: string[] = [],
    touch = { busy: false },
    input = {
      pending,
      touch,
      idle: true,
      press: (key: string) => {
        actions.push(key);
        pending.push(key);
      },
      release: () => {},
    } as unknown as NativeInput,
    startup = new FirstSetup(core, input);
  startup.poll();
  expect(actions).toEqual(['setup-skip']);
  state.id = 12296;
  core.virtualNs += 200000000n;
  startup.poll();
  expect(actions).toHaveLength(1);
  pending.length = 0;
  touch.busy = true;
  startup.poll();
  expect(actions).toHaveLength(1);
  touch.busy = false;
  startup.poll();
  expect(actions).toEqual(['setup-skip', 'ui-back']);
  pending.length = 0;
  state.id = 12301;
  state.mode = profile.firmware.ui.view_mode;
  core.virtualNs += 200000000n;
  startup.poll();
  expect(actions.at(-1)).toBe('m');
  pending.length = 0;
  state.id = profile.firmware.ui.roles['shooting.main']!;
  core.virtualNs += 200000000n;
  startup.poll();
  expect(actions.at(-1)).toBe('up');
  const count = actions.length;
  pending.length = 0;
  core.virtualNs += 200000000n;
  startup.poll();
  expect(actions).toHaveLength(count);
});

test('the skip key emits one physical tap rather than clicks across multiple setup pages', () => {
  const f = fixture(),
    core = {
      profile: f.profile,
      touch: f.touch,
      virtualNs: 0n,
    } as unknown as RuntimeCore,
    input = new NativeInput(core);
  input.press('tab');
  input.release('tab');
  expect(input.pending).toHaveLength(1);
  input.poll();
  expect(f.touch.samples.map(({ action, x, y }) => [action, x, y])).toEqual([
    ['down', 50, 294],
    ['up', 50, 294],
  ]);
});
