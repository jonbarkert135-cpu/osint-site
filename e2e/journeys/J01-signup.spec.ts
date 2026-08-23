// J01: a brand-new user signs up, creates a project and a board, and lands on the empty canvas.
// Selectors are accessible roles/names on purpose — if this spec breaks, the UI lost a label.
import { expect, test } from '@playwright/test';

const unique = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('signup creates an account, a project, a board and an empty canvas', async ({ page }) => {
  const email = `${unique()}@example.test`;
  const password = 'e2e-password-1234';

  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(email);
  await page
    .getByLabel(/password/i)
    .first()
    .fill(password);
  await page.getByRole('button', { name: /create account|sign up/i }).click();

  // Lands in the authenticated shell with the "no projects yet" empty state.
  await expect(page.getByRole('button', { name: /create (your first )?project/i })).toBeVisible();

  const projectName = `Project ${unique()}`;
  await page.getByRole('button', { name: /create (your first )?project/i }).click();
  await page.getByLabel(/name/i).fill(projectName);
  await page.getByRole('button', { name: /^create$/i }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

  const boardName = `Board ${unique()}`;
  await page.getByRole('button', { name: /create (your first )?board|new board/i }).click();
  await page.getByLabel(/name/i).fill(boardName);
  await page.getByRole('button', { name: /^create$/i }).click();

  await expect(page).toHaveURL(/\/b\//);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();

  // Session survives a reload — no flash of the unauthenticated shell (N2 groundwork).
  await page.reload();
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});
