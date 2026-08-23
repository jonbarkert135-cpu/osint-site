/**
 * Shared setup for board journeys: sign a fresh user up, create a project and a board, and return
 * the board URL. Selectors are accessible roles/names on purpose (18_TESTING.md §7).
 */

import { expect, type Page } from '@playwright/test';

export const unique = (): string => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * Diagnostics: turbo buffers the API's own logs until it exits, so a spec that fails because the
 * browser could not reach the API leaves no trace in CI. Echoing failed requests and non-2xx API
 * responses into the Playwright log makes the difference between a 429, a 500 and a dead socket
 * visible in the run output.
 */
export function traceApiFailures(page: Page): void {
  page.on('requestfailed', (req) => {
    console.log(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400)
      console.log(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

export async function signUp(page: Page): Promise<void> {
  traceApiFailures(page);
  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(`${unique()}@example.test`);
  await page
    .getByLabel(/password/i)
    .first()
    .fill('e2e-password-1234');
  await page.getByRole('button', { name: /create account|sign up/i }).click();
  // Signup + the first project-list fetch can exceed the 5s default under CI load (P7 added the
  // project rail query on top of the session bootstrap), so wait explicitly.
  await expect(page.getByRole('button', { name: /create (your first )?project/i })).toBeVisible({
    timeout: 20_000,
  });
}

/** Signs up and lands on a fresh board; returns its URL so the spec can reopen it. */
export async function openNewBoard(page: Page): Promise<string> {
  await signUp(page);

  await page.getByRole('button', { name: /create (your first )?project/i }).click();
  await page.getByLabel(/name/i).fill(`Project ${unique()}`);
  await page.getByRole('button', { name: /^create$/i }).click();

  await page.getByRole('button', { name: /create (your first )?board|new board/i }).click();
  await page.getByLabel(/name/i).fill(`Board ${unique()}`);
  await page.getByRole('button', { name: /^create$/i }).click();

  await expect(page).toHaveURL(/\/b\//);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.getByTestId('node-count')).toBeVisible();
  return page.url();
}

export async function addNotes(page: Page, count: number): Promise<void> {
  const button = page.getByTestId('add-note');
  for (let i = 0; i < count; i += 1) await button.click();
  await expect(page.getByTestId('node-count')).toHaveAttribute('data-nodes', String(count));
}

export const nodeCount = (page: Page): Promise<string | null> =>
  page.getByTestId('node-count').getAttribute('data-nodes');
