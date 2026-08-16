import { expect, it } from "vitest";
import { isPermanentInteractionRejection } from "../src/services/thread-notice-service";

/** The live fault: one of these looped once a second and blocked every answer behind it. */
it("settles the rejection that was looping forever", () => {
  expect(isPermanentInteractionRejection(
    new Error("HTTP 409: Pending interaction pint_m4symx7ej5 is already resolved"),
  )).toBe(true);
});

it("settles an interaction that is gone", () => {
  expect(isPermanentInteractionRejection(new Error("HTTP 404: Not found"))).toBe(true);
  expect(isPermanentInteractionRejection({ status: 400, message: "bad request" })).toBe(true);
  expect(isPermanentInteractionRejection({ statusCode: 403 })).toBe(true);
});

it("keeps retrying the failures a retry actually fixes", () => {
  for (const error of [
    new Error("HTTP 429: Too many requests"),
    new Error("HTTP 408: Request timeout"),
    new Error("HTTP 500: Internal error"),
    new Error("HTTP 503: Service unavailable"),
    { status: 502 },
  ]) {
    expect(isPermanentInteractionRejection(error)).toBe(false);
  }
});

it("retries an error it cannot read, rather than dropping the owner's answer", () => {
  // Guessing "permanent" from an unrecognised shape would silently discard a
  // tap the owner made.
  for (const error of [
    new Error("socket hang up"),
    new Error("fetch failed"),
    null,
    undefined,
    { status: "409" },
    { status: 99 },
    new Error("resolved 409 interactions today"),
  ]) {
    expect(isPermanentInteractionRejection(error)).toBe(false);
  }
});
