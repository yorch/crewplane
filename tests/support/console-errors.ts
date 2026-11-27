import type { Page } from "@playwright/test";

/**
 * Console messages that are allowed in a browser test. It is empty on
 * purpose: every `console.error`, page error and failed same-origin load
 * (a 404 included, the favicon too) is a defect. A test that provokes an
 * error deliberately must say so itself, by filtering its own collected list.
 */
export const ALLOWED_CONSOLE_ERRORS: RegExp[] = [];

/** Records every page error and console error into `sink`. */
export function failOnConsoleErrors(page: Page, sink: string[]) {
  page.on("pageerror", (error) => sink.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (ALLOWED_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) return;
    sink.push(text);
  });
}

/** What Chromium logs for a request a test aborted on purpose. */
export const INJECTED_NETWORK_FAILURE =
  "Failed to load resource: net::ERR_FAILED";
/**
 * For a test that blocks the network itself: drops only the injected-failure
 * lines (and so proves nothing else was logged). Not an allowlist; it is the
 * test's own declaration and applies to that test alone.
 */
export const withoutInjectedFailures = (errors: string[]) =>
  errors.filter((text) => text !== INJECTED_NETWORK_FAILURE);
