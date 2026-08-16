import { expect, it } from "vitest";
import {
  environmentChangeShouldWake,
  threadChangeShouldWake,
  threadInteractionsChanged,
} from "../src/bb/realtime-events";

it("wakes on thread activity and status, not on title or pin changes", () => {
  expect(threadChangeShouldWake(["events-appended"])).toBe(true);
  expect(threadChangeShouldWake(["status-changed", "title-changed"])).toBe(true);
  expect(threadChangeShouldWake(["title-changed", "pin-state-changed"])).toBe(false);
});

it("wakes on environment git and work changes, not on creation alone", () => {
  expect(environmentChangeShouldWake(["git-refs-changed"])).toBe(true);
  expect(environmentChangeShouldWake(["work-status-changed"])).toBe(true);
  expect(environmentChangeShouldWake(["environment-created"])).toBe(false);
});

it("recognizes an interaction change, which can retire a card the owner already answered", () => {
  expect(threadInteractionsChanged(["interactions-changed"])).toBe(true);
  expect(threadInteractionsChanged(["events-appended", "interactions-changed"])).toBe(true);
  expect(threadInteractionsChanged(["events-appended", "status-changed"])).toBe(false);
});
