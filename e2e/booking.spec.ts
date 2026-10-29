import { expect, test } from "@playwright/test";

/**
 * The customer's path through the product, in a browser.
 *
 * Deliberately one flow rather than many: everything else is covered by the
 * unit and integration suites, and what only a browser can show is that the
 * server-rendered slots, the client form and the route handler actually line
 * up.
 */

/** A unique email per run, so a repeat does not reuse a customer row. */
const unique = () =>
  `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

test("a customer picks a slot, books it, and cancels", async ({ page }) => {
  await page.goto("/b/snips");
  await expect(page.getByRole("heading", { name: "Snips" })).toBeVisible();

  // The services come from the seed, with their prices.
  await expect(page.getByText("Dry Cut")).toBeVisible();
  await expect(page.getByText("£25.00")).toBeVisible();

  await page.getByRole("link", { name: /Dry Cut/ }).click();
  await expect(page.getByRole("heading", { name: "Dry Cut" })).toBeVisible();
  await expect(page.getByText(/times in Europe\/London/)).toBeVisible();

  // Slots are rendered on the server, so they are present on first paint
  // rather than appearing after a fetch.
  const slots = page.locator("button", { hasText: /^\d{2}:\d{2}$/ });
  await expect(slots.first()).toBeVisible();
  const chosen = await slots.first().textContent();
  expect(chosen).toMatch(/^\d{2}:\d{2}$/);

  await slots.first().click();

  const email = unique();
  await page.getByLabel("Name").fill("E2E Customer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Phone (for reminders)").fill("+447700900123");
  await page.getByRole("button", { name: "Confirm" }).click();

  // The route handler returns the manage token and the form navigates to it.
  await expect(page).toHaveURL(/\/b\/snips\/booked\//);
  await expect(
    page.getByRole("heading", { name: "You are booked in" }),
  ).toBeVisible();
  await expect(page.getByText("E2E Customer")).toBeVisible();
  await expect(page.getByText("Dry Cut")).toBeVisible();
  // The time shown is the one that was clicked.
  await expect(page.getByText(new RegExp(chosen!))).toBeVisible();

  const manageUrl = page.url();

  // That slot is gone from the picker now.
  await page.goto("/b/snips/dry-cut");
  const remaining = await page
    .locator("button", { hasText: /^\d{2}:\d{2}$/ })
    .allTextContents();
  // Ana and Ben both offer a dry cut, so the time may still be available with
  // the other one. What must not happen is the same staff member twice, which
  // the integration tests cover; here it is enough that the page still works.
  expect(remaining.length).toBeGreaterThan(0);

  // Cancelling takes two clicks, because it cannot be undone from the
  // customer's side.
  await page.goto(manageUrl);
  await page.getByRole("button", { name: "Cancel this booking" }).click();
  await expect(page.getByText(/goes back on sale immediately/)).toBeVisible();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();

  await expect(
    page.getByRole("heading", { name: "This booking is cancelled" }),
  ).toBeVisible();
  // And the cancel control is gone.
  await expect(
    page.getByRole("button", { name: "Cancel this booking" }),
  ).toHaveCount(0);
});

test("a service needing a deposit says so before anything is entered", async ({
  page,
}) => {
  await page.goto("/b/snips/full-colour");
  await expect(page.getByText(/£30\.00 deposit/)).toBeVisible();

  await page
    .locator("button", { hasText: /^\d{2}:\d{2}$/ })
    .first()
    .click();
  await expect(
    page.getByText(/A £30\.00 deposit is taken to hold this time/),
  ).toBeVisible();
});

test("the form reports a bad email without contacting the server", async ({
  page,
}) => {
  await page.goto("/b/snips/dry-cut");
  await page
    .locator("button", { hasText: /^\d{2}:\d{2}$/ })
    .first()
    .click();

  await page.getByLabel("Name").fill("E2E Customer");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(
    page.getByText("that does not look like an email address"),
  ).toBeVisible();
  // Still on the picker: nothing was booked.
  await expect(page).toHaveURL(/\/b\/snips\/dry-cut/);
});

test("an unknown business is a 404, not a server error", async ({ page }) => {
  const response = await page.goto("/b/no-such-salon");
  expect(response?.status()).toBe(404);
});

test("a made-up manage token is a 404", async ({ page }) => {
  const response = await page.goto("/b/snips/booked/not-a-real-token");
  expect(response?.status()).toBe(404);
});
