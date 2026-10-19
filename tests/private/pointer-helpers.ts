import type { RuntimeCore } from '../../src/runtime/core';
import type { NativeInput } from '../../src/sdk/input';

/** Test gestures use screen coordinates and observe native scrolling only. */
export function pointerHelpers(
  core: RuntimeCore,
  input: NativeInput,
  until: (condition: () => boolean) => void,
) {
  const gesture = (
    points: {
      action: 'down' | 'move' | 'up';
      x: number;
      y: number;
      elapsed: number;
    }[],
  ) => {
    const time = Number(core.virtualNs / 1000000n);
    for (const p of points)
      input.touch.pointer(p.action, p.x, p.y, time + p.elapsed);
    until(() => input.idle);
  };
  const tap = (x: number, y: number) =>
    gesture([
      { action: 'down', x, y, elapsed: 0 },
      { action: 'up', x, y, elapsed: 80 },
    ]);
  const drag = (start: number, end: number) =>
    gesture([
      { action: 'down', x: 400, y: start, elapsed: 0 },
      { action: 'move', x: 400, y: end, elapsed: 100 },
      { action: 'up', x: 400, y: end, elapsed: 450 },
    ]);
  const row = (index: number) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const callback = core.sdk.word('ui.scrawl_callback'),
        scrollName =
          callback === core.profile.address('ui.main_scrawl')
            ? 'ui.main_scroll'
            : callback === core.profile.address('ui.option_scrawl')
              ? 'ui.option_scroll'
              : 'ui.sub_scroll',
        offset = core.sdk.word(scrollName) | 0,
        y = 110 + index * 101 - offset;
      if (y >= 80 && y <= 440) {
        tap(400, y);
        return;
      }
      drag(y > 440 ? 380 : 100, y > 440 ? 100 : 380);
    }
    throw new Error('Screen drag did not expose test row');
  };
  return { tap, drag, row };
}
