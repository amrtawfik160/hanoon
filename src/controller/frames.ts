import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerMediaKind } from "./models";

export const MAX_SAMPLED_FRAMES = 6;

export type SampledFrame = {
  fileName: string;
  mimeType: "image/jpeg";
  bytes: Uint8Array;
};

export type FrameSampler = (input: {
  bytes: Uint8Array;
  fileName: string;
  signal: AbortSignal;
}) => Promise<readonly SampledFrame[]>;

/**
 * Even stills from a short clip. One frame for a near-still, three for a few
 * seconds, six for anything longer. Times stay inside the clip.
 */
export function frameTimestamps(durationSeconds: number): readonly number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [0];
  const count = durationSeconds < 2 ? 1 : durationSeconds < 6 ? 3 : MAX_SAMPLED_FRAMES;
  if (count === 1) return [0];
  const end = durationSeconds * 0.92;
  return Array.from({ length: count }, (_, index) => Number(((end * index) / (count - 1)).toFixed(3)));
}

export function motionContextPrefix(
  kind: ControllerMediaKind,
  frameCount: number,
  source: "sampled" | "preview" | "original",
): string {
  const clip = kind === "animation" ? "GIF" : "video";
  if (source === "preview") {
    return `The owner sent a ${clip}. Only Telegram's preview still was available — frames could not be sampled from the clip.`;
  }
  if (source === "original") {
    return `The owner sent a ${clip}.`;
  }
  const noun = frameCount === 1 ? "still is" : "stills are";
  return `The owner sent a ${clip}. These ${frameCount} ${noun} sampled in order from that clip.`;
}

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function runCommand(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function probeDurationSeconds(sourcePath: string, signal: AbortSignal): Promise<number> {
  try {
    const result = await runCommand("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      sourcePath,
    ], signal);
    const duration = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch {
    return 0;
  }
}

function stemFrom(fileName: string): string {
  const trimmed = fileName.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
  return trimmed.length > 0 ? trimmed.slice(0, 80) : "telegram-clip";
}

export const sampleMotionFrames: FrameSampler = async (input) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-agent-frames-"));
  const sourcePath = join(directory, "source.bin");
  try {
    await writeFile(sourcePath, input.bytes);
    const duration = await probeDurationSeconds(sourcePath, input.signal);
    const times = frameTimestamps(duration);
    const stem = stemFrom(input.fileName);
    const frames: SampledFrame[] = [];
    for (const [index, time] of times.entries()) {
      if (input.signal.aborted) break;
      const outputPath = join(directory, `frame-${index}.jpg`);
      try {
        const result = await runCommand("ffmpeg", [
          "-y",
          "-ss", String(time),
          "-i", sourcePath,
          "-frames:v", "1",
          "-q:v", "3",
          outputPath,
        ], input.signal);
        if (result.code !== 0) continue;
        const bytes = await readFile(outputPath);
        if (bytes.byteLength === 0) continue;
        frames.push({
          fileName: `${stem}-frame-${String(index + 1).padStart(2, "0")}.jpg`,
          mimeType: "image/jpeg",
          bytes,
        });
      } catch {
        // Missing ffmpeg, a corrupt clip, or a timestamp past EOF — keep going.
      }
    }
    return frames;
  } catch {
    return [];
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};
