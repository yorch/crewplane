import type { BrowserContext, Page } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { captureScenarioVideo, captureScreenshot } from "./capture.ts";
import type { EvidenceCaptureInput, EvidenceStore } from "./contract.ts";

const input: Omit<EvidenceCaptureInput, "mime"> = {
  route: "synthetic",
  scenario: "initial",
  step: 0,
  browser: "chromium",
  viewport: { width: 390, height: 844 },
  outcome: "captured",
  findingIds: [],
  recheckOf: null,
};
it("captures PNG bytes directly to the store without navigating", async () => {
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("controlled bytes"));
  const append = vi.fn().mockResolvedValue({ artifactId: "opaque" });
  await captureScreenshot(
    { screenshot } as unknown as Page,
    { append } as unknown as EvidenceStore,
    "qa_run",
    input,
  );
  expect(screenshot).toHaveBeenCalledWith({ type: "png", timeout: 10000 });
  expect(append).toHaveBeenCalledWith(
    "qa_run",
    { ...input, mime: "image/png" },
    Buffer.from("controlled bytes"),
  );
});
it("requires explicit bounded video and an already configured recording context", async () => {
  const context = {
    newPage: async () => ({ video: () => null, close: async () => {} }),
  } as unknown as BrowserContext;
  for (const maxDurationMs of [0, 30001, Infinity])
    await expect(
      captureScenarioVideo(context, {} as EvidenceStore, "id", input, {
        enabled: true,
        maxDurationMs,
        scenario: async () => {},
      }),
    ).rejects.toThrow();
  await expect(
    captureScenarioVideo(context, {} as EvidenceStore, "id", input, {
      enabled: true,
      maxDurationMs: 1000,
      scenario: async () => {},
    }),
  ).rejects.toThrow("explicit context");
});

it("closes timed-out scenario pages, retains bounded failure video and deletes temporary recording", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "capture-test-"));
  const path = join(dir, "synthetic.webm");
  const bytes = Buffer.from([26, 69, 223, 163, 119, 101, 98, 109]);
  await writeFile(path, bytes);
  const close = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const context = {
    newPage: async () => ({
      video: () => ({ path: async () => path, delete: remove }),
      close,
    }),
  } as unknown as BrowserContext;
  const append = vi.fn().mockResolvedValue({ artifactId: "opaque" });
  try {
    await captureScenarioVideo(
      context,
      { append } as unknown as EvidenceStore,
      "run",
      input,
      {
        enabled: true,
        maxDurationMs: 5,
        scenario: async () => new Promise(() => {}),
      },
    );
    expect(close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      "run",
      { ...input, mime: "video/webm", outcome: "finding" },
      bytes,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["close", "path", "open"] as const)(
  "attempts deletion after %s failure and preserves the primary error",
  async (failure) => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "capture-failure-"));
    const primary = new Error(`controlled ${failure} failure`);
    const remove = vi
      .fn()
      .mockRejectedValue(new Error("secondary deletion failure"));
    const close = vi.fn().mockImplementation(async () => {
      if (failure === "close") throw primary;
    });
    const path = vi.fn().mockImplementation(async () => {
      if (failure === "path") throw primary;
      return join(dir, "missing.webm");
    });
    const context = {
      newPage: async () => ({ video: () => ({ path, delete: remove }), close }),
    } as unknown as BrowserContext;
    const append = vi.fn();
    try {
      const result = captureScenarioVideo(
        context,
        { append } as unknown as EvidenceStore,
        "run",
        input,
        { enabled: true, maxDurationMs: 100, scenario: async () => {} },
      );
      if (failure === "open")
        await expect(result).rejects.toMatchObject({ code: "ENOENT" });
      else await expect(result).rejects.toBe(primary);
      expect(close).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
      expect(append).not.toHaveBeenCalled();
      if (failure === "close") expect(path).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
