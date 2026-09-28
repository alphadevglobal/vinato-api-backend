import { afterEach, describe, expect, it, vi } from "vitest";

describe("OpenRouterWineScanner", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to the free model when OpenRouter returns insufficient credits", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_MODEL = "paid-model";
    process.env.OPENROUTER_FALLBACK_MODEL = "free-model";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: "Insufficient credits. Add credits." },
          }),
          { status: 402 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"displayName":"Fallback Wine","confidence":0.82,"notes":"ok"}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
    const scanner = new OpenRouterWineScanner();
    const result = await scanner.scanWineLabel({
      buffer: Buffer.from("fake-image"),
      mimetype: "image/png",
    } as Express.Multer.File);

    expect(result).toEqual({
      success: true,
      data: {
        displayName: "Fallback Wine",
        producerTitle: null,
        producerName: null,
        wine: null,
        country: null,
        region: null,
        subRegion: null,
        colour: null,
        type: null,
        subType: null,
        designation: null,
        classification: null,
        vintage: null,
        alcoholContent: null,
        grapes: null,
        volume: null,
        confidence: 0.82,
        notes: "ok",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("paid-model");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe("free-model");
  });
  it("drops placeholder words the model writes for missing values", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply('{"displayName":"null MALBEC ARGENTINO","producerName":"null","wine":"MALBEC ARGENTINO","region":"N/A","vintage":"null","confidence":0.8,"notes":""}'));
    const result = await scanWith(fetchMock);

    expect(result.data.displayName).toBe("MALBEC ARGENTINO");
    expect(result.data.producerName).toBeNull();
    expect(result.data.region).toBeNull();
    expect(result.data.vintage).toBeNull();
  });

  it("uses models selected at runtime for each scan", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply('{"displayName":"Runtime Wine","confidence":0.9,"notes":""}'));
    vi.stubGlobal("fetch", fetchMock);
    const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
    const getScannerModels = vi.fn(async () => ({ model: "runtime/vision-model", fallbackModel: "runtime/fallback" }));

    await new OpenRouterWineScanner({ getScannerModels }).scanWineLabel({ buffer: Buffer.from("image"), mimetype: "image/jpeg" } as Express.Multer.File);

    expect(getScannerModels).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("runtime/vision-model");
  });
});

function modelReply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

async function scanWith(fetchMock: ReturnType<typeof vi.fn>) {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "primary-model";
  process.env.OPENROUTER_FALLBACK_MODEL = "second-model";
  vi.stubGlobal("fetch", fetchMock);
  const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
  return new OpenRouterWineScanner().scanWineLabel({ buffer: Buffer.from("fake-image"), mimetype: "image/jpeg" } as Express.Multer.File);
}
