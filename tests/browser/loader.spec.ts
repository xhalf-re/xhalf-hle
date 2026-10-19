import { expect, test } from '@playwright/test';
import { packageFixture } from '../unit/fixtures';

test('load errors are actionable and retry/stop discards old sessions', async ({
  page,
}) => {
  await page.goto('./');
  const chooser = page.getByLabel('Choose firmware', { exact: true });
  await chooser.setInputFiles({
    name: 'bad.DAT',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3]),
  });
  await expect(page.getByRole('status')).toContainText('INVALID_PACKAGE');
  await chooser.setInputFiles({
    name: 'unknown.DAT',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(packageFixture()),
  });
  await expect(page.getByRole('status')).toContainText('UNKNOWN_FIRMWARE');
  await chooser.setInputFiles({
    name: 'cancel.DAT',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(packageFixture()),
  });
  await page.getByRole('button', { name: 'Stop and release session' }).click();
  await expect(page.getByRole('status')).toContainText('Stopped');
  await page.waitForTimeout(100);
  await expect(page.getByRole('status')).toContainText('Stopped');
  await chooser.setInputFiles({
    name: 'retry.DAT',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0]),
  });
  await expect(page.getByRole('status')).toContainText('INVALID_PACKAGE');
});

test('real DAT validates in a fresh browser with no file upload', async ({
  page,
}) => {
  test.skip(
    !process.env.XHALF_DAT,
    'Real firmware NOT RUN: set XHALF_DAT locally.',
  );
  test.setTimeout(60000);
  const outgoing: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') outgoing.push(request.method());
  });
  await page.goto('./');
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  await expect(page.locator('#diagnostics')).toContainText(
    'xhalf-main-21aa469f',
    { timeout: 45000 },
  );
  expect(outgoing).toEqual([]);
  await page.getByRole('button', { name: 'Stop and release session' }).click();
  await expect(page.getByRole('status')).toContainText('Stopped');
});
