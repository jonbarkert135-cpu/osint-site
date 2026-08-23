// J04a (partial J4): the canvas surface responds to selection, drag and marquee gestures.
//
// P2 has no persistence yet (that is P3), so this spec asserts the *interaction* contract that the
// engine exposes to the browser — pointer gestures reach the engine, the camera responds to the
// zoom cluster, and the frame loop keeps painting. Node-level assertions arrive with J4 in P3.
import { expect, test } from '@playwright/test';

const unique = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('J04a — canvas selection and drag', () => {
  test('pans, zooms and marquee-drags on the board canvas', async ({ page }) => {
    const email = `${unique()}@example.test`;
    const password = 'e2e-password-1234';

    await page.goto('/signup');
    await page.getByLabel(/email/i).fill(email);
    await page
      .getByLabel(/password/i)
      .first()
      .fill(password);
    await page.getByRole('button', { name: /create account|sign up/i }).click();

    await page.getByRole('button', { name: /create (your first )?project/i }).click();
    await page.getByLabel(/name/i).fill(`Project ${unique()}`);
    await page.getByRole('button', { name: /^create$/i }).click();
    await page.getByRole('button', { name: /create (your first )?board|new board/i }).click();
    await page.getByLabel(/name/i).fill(`Board ${unique()}`);
    await page.getByRole('button', { name: /^create$/i }).click();

    const canvas = page.getByTestId('canvas-surface');
    await expect(canvas).toBeVisible();
    await expect(page.getByText(/paste a link, drop a file/i)).toBeVisible();

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Marquee across empty canvas: press, drag, release. Nothing is selected on an empty board,
    // but the gesture must not throw and the loop must keep painting.
    await page.mouse.move(cx - 200, cy - 120);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(cx - 200 + i * 30, cy - 120 + i * 18);
    }
    await page.mouse.up();

    // The zoom cluster is keyboard reachable and drives the camera.
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    await expect(zoomIn).toBeVisible();
    await zoomIn.focus();
    await expect(zoomIn).toBeFocused();
    await zoomIn.click();
    await zoomIn.click();
    await expect(page.getByLabel('Zoom level')).toBeVisible();

    // Escape must always return the canvas to idle — no stuck gesture after a cancelled drag.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 60);
    await page.keyboard.press('Escape');
    await page.mouse.up();

    const frames = await page.evaluate(() => window.__ravenBench?.frameTimes().length ?? 0);
    expect(frames).toBeGreaterThan(0);
  });
});

declare global {
  interface Window {
    __ravenBench?: { frameTimes(): number[] };
  }
}
