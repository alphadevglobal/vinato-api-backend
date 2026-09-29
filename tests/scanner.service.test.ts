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
        description: null,
        foodPairings: null,
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

  it("reads the wine description and food pairings for the app's wine page", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply(JSON.stringify({
      displayName: "Quinta do Morgado York Madeira", producerName: "Fante", confidence: 0.9, notes: "",
      description: "Vinho de mesa suave e frutado.", foodPairings: ["Massas", "Pizza", "null", "Queijos", "Churrasco", "Doces", "Frutas"],
    })));
    const result = await scanWith(fetchMock);
    expect(result.data.description).toBe("Vinho de mesa suave e frutado.");
    expect(result.data.foodPairings).toEqual(["Massas", "Pizza", "Queijos", "Churrasco", "Doces"]);
  });

  it("accepts pairings written as text and leaves them empty when missing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelReply('{"displayName":"Vinho","foodPairings":"Massas; Pizza","description":"N/A","confidence":0.9,"notes":""}'));
    const result = await scanWith(fetchMock);
    expect(result.data.foodPairings).toEqual(["Massas", "Pizza"]);
    expect(result.data.description).toBeNull();
  });

  it("asks the model for the description and pairings without changing the transcription rules", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply('{"displayName":"Vinho","confidence":0.9,"notes":""}'));
    await scanWith(fetchMock);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content[0].text as string;
    expect(prompt).toContain("description, foodPairings");
    expect(prompt).toContain("Nunca invente produtor, vinho ou safra");
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

  it("records OpenRouter token usage in the scan trace", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply(
      '{"displayName":"Token Wine","confidence":0.9,"notes":""}',
      { prompt_tokens: 812, completion_tokens: 143, total_tokens: 955 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
    const trace = { modelsTried: [], catalogQueried: false };

    await new OpenRouterWineScanner({ getScannerModels: async () => ({ model: "token-model", fallbackModel: "fallback-model" }) }).scanWineLabel(
      { buffer: Buffer.from("image"), mimetype: "image/jpeg" } as Express.Multer.File,
      trace,
    );

    expect(trace.modelsTried).toEqual([expect.objectContaining({
      model: "token-model",
      ok: true,
      promptTokens: 812,
      completionTokens: 143,
      totalTokens: 955,
    })]);
  });
});

function modelReply(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });
}

async function scanWith(fetchMock: ReturnType<typeof vi.fn>) {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "primary-model";
  process.env.OPENROUTER_FALLBACK_MODEL = "second-model";
  vi.stubGlobal("fetch", fetchMock);
  const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
  return new OpenRouterWineScanner().scanWineLabel({ buffer: Buffer.from("fake-image"), mimetype: "image/jpeg" } as Express.Multer.File);
}
