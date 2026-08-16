import { expect, it } from "vitest";
import {
  MAX_OUTBOUND_CAPTION,
  boundedCaption,
  outboundFilename,
  planOutboundMedia,
  withinOutboundLimit,
} from "../src/controller/outbound-media";
import { readQueuedMedia } from "../src/services/job-executor-service";

function plan(path: string) {
  const decision = planOutboundMedia(path);
  if (!decision.ok) throw new Error(`expected a plan for ${path}: ${decision.refusal.reason}`);
  return decision.plan;
}

it("sends a screenshot as a photo so it renders inline", () => {
  expect(plan("/tmp/run/checkout-page.png")).toMatchObject({ field: "photo", mimeType: "image/png" });
  expect(plan("/tmp/run/shot.jpeg")).toMatchObject({ field: "photo", mimeType: "image/jpeg" });
});

it("sends a screen recording as a video", () => {
  expect(plan("/tmp/run/checkout-flow.mp4")).toMatchObject({ field: "video", mimeType: "video/mp4" });
  expect(plan("/tmp/run/capture.webm")).toMatchObject({ field: "video", mimeType: "video/webm" });
});

it("sends a gif as a video, because a photo would freeze it", () => {
  expect(plan("/tmp/run/flow.gif")).toMatchObject({ field: "video", mimeType: "image/gif" });
});

it("allows a recording the full clip budget and a still the image budget", () => {
  expect(plan("/tmp/a.mp4").maxBytes).toBeGreaterThan(plan("/tmp/a.png").maxBytes);
  expect(withinOutboundLimit(plan("/tmp/a.png"), 9 * 1024 * 1024)).toBe(true);
  expect(withinOutboundLimit(plan("/tmp/a.png"), 11 * 1024 * 1024)).toBe(false);
  expect(withinOutboundLimit(plan("/tmp/a.mp4"), 11 * 1024 * 1024)).toBe(true);
});

it("refuses an empty file, which would arrive as a broken attachment", () => {
  expect(withinOutboundLimit(plan("/tmp/a.png"), 0)).toBe(false);
});

it("refuses anything that is not a picture of the work", () => {
  // The point of the narrow list: this carries screenshots, not a way to move
  // files off a machine into a chat.
  for (const path of ["/etc/passwd", "/tmp/db.sqlite", "/tmp/secrets.env", "/tmp/report.pdf", "/tmp/notes.txt"]) {
    expect(planOutboundMedia(path).ok).toBe(false);
  }
});

it("refuses a path that is relative, traversing, or malformed", () => {
  for (const path of ["shot.png", "", "/tmp/../../etc/shot.png", "/tmp/\0shot.png", "/tmp/noextension"]) {
    expect(planOutboundMedia(path).ok).toBe(false);
  }
});

it("shows only the file name, never the directory it came from", () => {
  expect(outboundFilename("/root/.bb-server/worktrees/env_8kq/private/checkout.png")).toBe("checkout.png");
  expect(plan("/home/someone/secret-project/shot.png").filename).toBe("shot.png");
});

it("keeps a filename usable when the name is hostile", () => {
  expect(outboundFilename("/tmp/a b;c\"d.png")).toBe("a-b-c-d.png");
  expect(outboundFilename("/tmp/")).toBe("attachment");
  expect(outboundFilename(`/tmp/${"x".repeat(200)}.png`).length).toBeLessThanOrEqual(96);
});

it("clips a caption Telegram would reject rather than losing the message", () => {
  expect(boundedCaption("  the checkout page  ")).toBe("the checkout page");
  expect(boundedCaption("   ")).toBeNull();
  expect(boundedCaption(null)).toBeNull();
  const clipped = boundedCaption("x".repeat(MAX_OUTBOUND_CAPTION + 50));
  expect(clipped).toHaveLength(MAX_OUTBOUND_CAPTION);
  expect(clipped?.endsWith("…")).toBe(true);
});

it("recognises a queued picture only when every field survived the round trip", () => {
  const media = {
    hostId: "host_1",
    path: "/tmp/shot.png",
    field: "photo",
    mimeType: "image/png",
    filename: "shot.png",
    maxBytes: 10 * 1024 * 1024,
    caption: "the checkout page",
  };
  expect(readQueuedMedia({ payload: { media } })).toMatchObject({ field: "photo", filename: "shot.png" });
  expect(readQueuedMedia({ payload: { media: { ...media, caption: null } } })?.caption).toBeNull();

  // The payload has been through JSON and a database, so a half-written row
  // must read as "not media" rather than as a partly-trusted one.
  expect(readQueuedMedia({ payload: { text: "hello" } })).toBeNull();
  expect(readQueuedMedia({ payload: { media: null } })).toBeNull();
  for (const broken of [
    { ...media, field: "document" },
    { ...media, hostId: "" },
    { ...media, path: 42 },
    { ...media, maxBytes: 0 },
    { ...media, maxBytes: "10" },
    { ...media, caption: 7 },
  ]) {
    expect(readQueuedMedia({ payload: { media: broken } })).toBeNull();
  }
});
