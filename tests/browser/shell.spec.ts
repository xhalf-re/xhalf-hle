import { expect, test } from '@playwright/test';

test('loads the English application shell on the Pages subpath', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(
    page.getByRole('heading', { name: 'X half HLE', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Choose firmware to start.',
  );
  await expect(
    page.getByLabel('Choose firmware', { exact: true }),
  ).toBeAttached();
  await expect(
    page.getByRole('button', { name: 'Pause', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Stop and release session', exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
