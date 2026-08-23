// J04: connect two nodes from the keyboard and refuse the duplicate.
//
// This is the P5 half of journey 4: J04a covers selection and dragging, this one covers edge
// creation — selection through the overlay, the pending connection, validation and the counters.
// Editing and deleting a relationship live in the inspector's own tests; they need an edge picked
// by coordinates, which belongs to part 4 once waypoints make the geometry stable.
import { expect, test } from '@playwright/test';

const unique = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('J04 — connect two nodes', () => {
  test('creates a relationship from the keyboard and refuses a duplicate', async ({ page }) => {
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

    // Two notes. They land near the viewport centre, offset from each other by the placement rule.
    await page.getByTestId('add-note').click();
    await page.getByTestId('add-note').click();
    await expect(page.getByTestId('node-count')).toContainText('2 nodes');

    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;

    // Keyboard connection (N6): select the first card, press C, confirm with Enter.
    //
    // The click lands on the canvas surface even though a card is drawn there: overlay cards are
    // transparent to the pointer, so the engine stays the single hit-test authority (05 §3). If a
    // card ever starts intercepting gestures again, this click fails with "subtree intercepts
    // pointer events" — which is exactly the regression this line guards.
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.locator('[data-state="selected"]')).toHaveCount(1);
    await page.keyboard.press('c');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('node-count')).toContainText('1 edges', { timeout: 10_000 });

    // The same gesture again is a duplicate: it is refused *with a message*, and the count holds.
    await page.keyboard.press('c');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/already connected/i)).toBeVisible();
    await expect(page.getByTestId('node-count')).toContainText('1 edges');
  });
});
