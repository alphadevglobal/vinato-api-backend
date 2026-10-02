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
        agingPotential: null,
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

  it("keeps the label reading short: the wine sheet is written by a separate call", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply('{"displayName":"Vinho","confidence":0.9,"notes":""}'));
    await scanWith(fetchMock);
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content[0].text as string;
    expect(prompt).not.toContain("description");
    expect(prompt).not.toContain("foodPairings");
    expect(prompt).toContain("Nunca invente produtor, vinho ou safra");
  });

  it("writes the sheet of a new wine from the reading, without the image", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const { OpenRouterWineScanner, normalizeWineSheet } = await import("../src/scanner.service.js");
    const fetchMock = vi.fn().mockResolvedValueOnce(modelReply(JSON.stringify({ description: "Tinto frutado.", foodPairings: ["Massas", "null"], agingPotential: "3 a 5 anos",
      drinkingWindow: [{ from: 4, to: 6, note: "terroso" }, { from: 1, to: 3, note: "frutado" }, { from: 5, to: 2, note: "x" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const sheet = await new OpenRouterWineScanner().describeWine({ displayName: "Miolo Seleção", vintage: "2021", confidence: 0.9, notes: "" });
    expect(sheet).toEqual({ description: "Tinto frutado.", foodPairings: ["Massas"], agingPotential: "3 a 5 anos", drinkingWindow: [{ from: 1, to: 3, note: "frutado" }, { from: 4, to: 6, note: "terroso" }] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0].text).toContain('"displayName":"Miolo Seleção"');
    expect(normalizeWineSheet({})).toEqual({ description: null, foodPairings: null, agingPotential: null, drinkingWindow: null });
    vi.unstubAllGlobals();
  });

  it("moves on to the fallback when the primary answer is cut or not JSON", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"displayName": "Alm' } }] }), { status: 200 }))
      .mockResolvedValueOnce(modelReply('{"displayName":"Almadén Suave","producerName":"Almadén","confidence":0.9,"notes":""}'));
    vi.stubGlobal("fetch", fetchMock);
    const trace = { modelsTried: [] as { model: string; ok: boolean; error?: string }[], catalogQueried: false } as never as { modelsTried: { model: string; ok: boolean; error?: string }[]; catalogQueried: boolean; modelUsed?: string };
    const result = await new OpenRouterWineScanner({ getScannerModels: async () => ({ model: "slow-thinker", fallbackModel: "fast-vision" }) }).scanWineLabel({ buffer: Buffer.from("image"), mimetype: "image/jpeg" } as Express.Multer.File, trace as never);
    expect(result.data.displayName).toBe("Almadén Suave");
    expect(trace.modelsTried.map((attempt) => [attempt.model, attempt.ok])).toEqual([["slow-thinker", false], ["fast-vision", true]]);
    expect(trace.modelsTried[0].error).toContain("MODEL_CUT");
    expect(trace.modelUsed).toBe("fast-vision");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ reasoning: { effort: "low" }, response_format: { type: "json_object" } });
    expect(body.max_tokens).toBeGreaterThanOrEqual(4000);
  });

  it("still gets a second chance when the fallback was set equal to the primary", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
    const { defaultScannerModels } = await import("../src/ai-model-settings.js");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }))
      .mockResolvedValueOnce(modelReply('{"displayName":"Rola Tinto","confidence":0.9,"notes":""}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new OpenRouterWineScanner({ getScannerModels: async () => ({ model: "same", fallbackModel: "same" }) }).scanWineLabel({ buffer: Buffer.from("image"), mimetype: "image/jpeg" } as Express.Multer.File);
    expect(result.data.displayName).toBe("Rola Tinto");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe(defaultScannerModels().fallbackModel);
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

  it("records the billed cost, also for an answer that fails validation", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(modelReply('{"displayName":"","confidence":0.1}', { prompt_tokens: 800, completion_tokens: 20, total_tokens: 820, cost: 0.0004 }))
      .mockResolvedValueOnce(modelReply('{"displayName":"Cost Wine","confidence":0.9,"notes":""}', { prompt_tokens: 810, completion_tokens: 150, total_tokens: 960, cost: 0.0021 }));
    vi.stubGlobal("fetch", fetchMock);
    const { OpenRouterWineScanner } = await import("../src/scanner.service.js");
    const trace = { modelsTried: [], catalogQueried: false };

    await new OpenRouterWineScanner({ getScannerModels: async () => ({ model: "cheap-model", fallbackModel: "better-model" }) }).scanWineLabel(
      { buffer: Buffer.from("image"), mimetype: "image/jpeg" } as Express.Multer.File,
      trace,
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).usage).toEqual({ include: true });
    expect(trace.modelsTried).toEqual([
      expect.objectContaining({ model: "cheap-model", ok: false, totalTokens: 820, costUsd: 0.0004 }),
      expect.objectContaining({ model: "better-model", ok: true, totalTokens: 960, costUsd: 0.0021 }),
    ]);
  });
});

function modelReply(content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number }) {
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
