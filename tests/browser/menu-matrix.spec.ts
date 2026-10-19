import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { metrics, screenInput } from './native-helpers';

test('native menu matrix uses fixed keys, direct touch and mixed input', async ({
  page,
}) => {
  test.skip(!process.env.XHALF_DAT, 'Real menu matrix NOT RUN: set XHALF_DAT.');
  test.setTimeout(600000);
  const directory = '.private/input-refactor/matrix',
    cases: object[] = [];
  mkdirSync(directory, { recursive: true });
  await page.goto('./');
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  await expect
    .poll(async () => (await metrics(page)).menuReady, { timeout: 120000 })
    .toBe(true);
  const input = screenInput(page);
  const capture = async (
    name: string,
    menu: number,
    index?: number,
    category?: number,
  ) => {
    await expect
      .poll(
        async () => {
          const s = await metrics(page);
          writeFileSync(
            `${directory}/current.json`,
            JSON.stringify({ name, s, cases }, null, 2),
          );
          return (
            s.menu === menu &&
            (index === undefined || s.index === index) &&
            (category === undefined || s.category === category) &&
            s.inputIdle === true
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const s = await metrics(page);
    expect(s.assertions).toBe(0);
    expect(s.inputErrors).toBe(0);
    await page
      .locator('canvas')
      .screenshot({ path: `${directory}/${name}.png` });
    cases.push({ name, menu, index: s.index, category: s.category });
    writeFileSync(`${directory}/results.json`, JSON.stringify(cases, null, 2));
    return s;
  };
  while (Number((await metrics(page)).index) !== 0) await input.key('ArrowUp');
  await capture('01-main', 8193, 0, 0);
  await input.key('ArrowDown');
  await capture('02-key-down', 8193, 1);
  await input.key('Enter');
  await capture('03-key-set', 8195);
  await input.key('Escape');
  await capture('04-key-left', 8193);
  for (let category = 1; category <= 6; category++) {
    await input.tap(50, 333);
    await capture(
      `category-${category}`,
      [8193, 8197, 8205, 8211, 8217, 12289, 32769][category]!,
      undefined,
      category,
    );
  }
  await input.key('Digit1');
  await capture('11-shortcut-shooting', 8193, undefined, 0);
  await input.key('Digit6');
  const setup = await capture('12-setup', 12289);
  await input.key('ArrowDown');
  await capture('13-setup-native-key', 12289, Number(setup.index));
  await input.row(0, 'mainScroll');
  await capture('14-basic-touch', 12304, 0);
  await input.key('ArrowDown');
  await capture('15-basic-native-down', 12304, 0);
  await input.key('ArrowUp');
  await capture('16-basic-native-up', 12304, 0);
  await input.row(4, 'subScroll');
  const language = await capture('17-language-touch', 12312);
  const original = Number(language.index),
    count = Number(language.optionCount),
    next = (original + 1) % count;
  await input.key('ArrowDown');
  await capture('18-language-native-down', 12312, original);
  await input.key('ArrowUp');
  await capture('19-language-native-up', 12312, original);
  await input.row(next, 'optionScroll');
  await capture('20-language-confirm-next', 12312, next);
  await input.row(original, 'optionScroll');
  await capture('21-language-confirm-original', 12312, original);
  const scroll = Number((await metrics(page)).optionScroll);
  await input.drag(380, 100);
  expect(Number((await metrics(page)).optionScroll)).toBeGreaterThan(scroll);
  await capture('22-language-scroll', 12312);
  await input.row(count - 1, 'optionScroll');
  await capture('23-language-last-touch', 12312, count - 1);
  await input.row(0, 'optionScroll');
  await capture('24-language-first-touch', 12312, 0);
  await input.row(original, 'optionScroll');
  await capture('25-language-restore', 12312, original);
  await input.key('KeyB');
  await capture('26-language-back', 12304, 4);
  await input.row(4, 'subScroll');
  await capture('27-language-reopen', 12312, original);
  await input.key('KeyB');
  await capture('28-language-cancel', 12304, 4);
  await input.key('KeyB');
  await capture('29-setup-back', 12289);
  for (let row = 0; row < 7; row++) {
    await input.row(row, 'mainScroll');
    await capture(
      `setup-row-${row}`,
      [12304, 12336, 12352, 12368, 12384, 12400, 12416][row]!,
    );
    await input.key('KeyB');
    await capture(`setup-return-${row}`, 12289);
  }
  await input.key('Digit1');
  await capture('44-mixed-return', 8193, undefined, 0);
  expect(cases).toHaveLength(44);
  expect((await metrics(page)).touchEvents).toBeGreaterThan(0);
});
