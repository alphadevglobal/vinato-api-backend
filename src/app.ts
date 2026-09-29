import { createRequire } from "node:module";
import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import { badRequest, HttpError, internalServerError, notFound } from "./http-error.js";
import { openApiDocument } from "./openapi.js";
import { validRating } from "./reviews.repository.js";
import { newScanTrace, type ScanAuditEntry } from "./scan-audit.repository.js";
import type { AppDependencies, AsyncRequestHandler, ScannedWineData, ScanWineLabelResult, Wine, WineListQuery } from "./types.js";
import { verifySocialToken, type SocialProvider } from "./social-auth.js";
import { requestJson, type ModelAttempt, type OpenRouterUsage } from "./openrouter.js";
import { openRouterAccount } from "./openrouter-account.js";
import { CHECK_BUDGET_MS, TRANSCRIPTION_BUDGET_MS } from "./wine-list.service.js";
import { DISPOSABLE_EMAIL_MESSAGE, isDisposableEmailAddress } from "./email-policy.js";

const require = createRequire(import.meta.url);
const helmet = require("helmet") as (options?: { contentSecurityPolicy?: boolean }) => RequestHandler;

const acceptedMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

// Wine lists: several photos of the pages or one PDF (the app compresses the photos;
// Vercel limits a request body to about 4.5 MB).
const listUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, callback) => {
    if (!acceptedMimeTypes.has(file.mimetype) && file.mimetype !== "application/pdf") {
      callback(badRequest(`Tipo de arquivo não suportado: "${file.mimetype}". Envie fotos (JPEG, PNG, WEBP, HEIC) ou um PDF.`));
      return;
    }
    callback(null, true);
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!acceptedMimeTypes.has(file.mimetype)) {
      callback(
        badRequest(
          `Tipo de arquivo não suportado: "${file.mimetype}". Formatos aceitos: image/jpeg, image/jpg, image/png, image/webp, image/gif, image/heic, image/heif`,
        ),
      );
      return;
    }

    callback(null, true);
  },
});

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.use(cors());
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "3mb" }));

  app.get("/", (_req, res) => {
    res.send("Hello World!");
  });

  app.get("/api/docs-json", (_req, res) => {
    res.json(openApiDocument);
  });

  const swaggerUiOptions = {
    customCss: ".swagger-ui .topbar .download-url-wrapper { display: none }",
    swaggerOptions: {
      persistAuthorization: true,
    },
  };
  app.get(/^\/api\/docs$/, (_req, res) => {
    res.redirect(302, "/api/docs/");
  });
  app.use("/api/docs", swaggerUi.serve);
  app.get("/api/docs/", swaggerUi.setup(openApiDocument, swaggerUiOptions));

  app.get(
    "/wines",
    asyncHandler(async (req, res) => {
      const query = parseWineListQuery(req.query);
      res.json(await dependencies.wineRepository.findAll(query));
    }),
  );

  app.post(
    "/auth/register",
    asyncHandler(async (req, res) => {
      const accounts = requireAccounts(dependencies);
      const displayName = requiredText(req.body?.displayName, "Nome");
      const email = requiredEmail(req.body?.email);
      rejectDisposableEmail(email);
      const password = requiredPassword(req.body?.password);
      try {
        res.status(201).json(await accounts.register(displayName, email, password));
      } catch (error) {
        if ((error as Error).message === "EMAIL_ALREADY_EXISTS") {
          throw new HttpError(409, "Este e-mail já está cadastrado.", "Conflict");
        }
        throw error;
      }
    }),
  );

  app.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      const accounts = requireAccounts(dependencies);
      let result;
      try { result = await accounts.login(requiredEmail(req.body?.email), requiredPassword(req.body?.password)); }
      catch (error) {
        if ((error as Error).message === "ACCOUNT_BLOCKED") throw new HttpError(403, "Esta conta está bloqueada. Fale com o suporte VINATO.", "Forbidden");
        throw error;
      }
      if (!result) throw new HttpError(401, "E-mail ou senha incorretos.", "Unauthorized");
      res.json(result);
    }),
  );

  app.post(
    "/auth/social",
    asyncHandler(async (req, res) => {
      const accounts = requireAccounts(dependencies);
      const provider = req.body?.provider;
      if (provider !== "apple" && provider !== "google") throw badRequest("Provedor social inválido.");
      const idToken = requiredToken(req.body?.idToken);
      try {
        const identity = await verifySocialToken(provider as SocialProvider, idToken);
        if (!identity.emailVerified) throw new Error("UNVERIFIED_SOCIAL_EMAIL");
        if (isDisposableEmailAddress(identity.email)) throw new Error("DISPOSABLE_EMAIL");
        res.json(await accounts.socialLogin(provider, identity.subject, identity.email, asString(req.body?.displayName)));
      } catch (error) {
        const code = (error as Error).message;
        if (code === "ACCOUNT_BLOCKED") throw new HttpError(403, "Esta conta está bloqueada. Fale com o suporte VINATO.", "Forbidden");
        if (code === "DISPOSABLE_EMAIL") throw new HttpError(400, DISPOSABLE_EMAIL_MESSAGE, "Bad Request");
        if (code === "GOOGLE_AUTH_NOT_CONFIGURED") throw new HttpError(503, "Login Google aguardando configuração.", "Service Unavailable");
        throw new HttpError(401, "Não foi possível validar sua identidade.", "Unauthorized");
      }
    }),
  );

  app.get(
    "/auth/me",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      res.json(user);
    }),
  );

  app.patch(
    "/me/avatar",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      const avatarUrl = validateAvatar(req.body?.avatarUrl);
      res.json(await accounts.updateAvatar(user.id, avatarUrl));
    }),
  );

  app.get(
    "/me/favorites",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      res.json(await accounts.getFavorites(user.id));
    }),
  );

  app.put(
    "/me/favorites/:wineId",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      if (!isUuid(req.params.wineId)) throw badRequest("ID do vinho inválido.");
      if (!(await accounts.addFavorite(user.id, req.params.wineId))) throw notFound("Vinho não encontrado no catalog_wines.");
      res.json({ wineId: req.params.wineId, favorite: true });
    }),
  );

  app.delete(
    "/me/cellar/:wineId",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      requirePremium(user);
      if (!isUuid(req.params.wineId)) throw badRequest("ID do vinho inválido.");
      await accounts.deleteCellarWine(user.id, req.params.wineId);
      res.status(204).send();
    }),
  );

  app.delete(
    "/me/favorites/:wineId",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      if (!isUuid(req.params.wineId)) throw badRequest("ID do vinho inválido.");
      await accounts.removeFavorite(user.id, req.params.wineId);
      res.status(204).send();
    }),
  );

  app.delete(
    "/auth/session",
    asyncHandler(async (req, res) => {
      const { accounts, token } = await authenticated(req, dependencies);
      await accounts.logout(token);
      res.status(204).send();
    }),
  );

  app.get(
    "/me/cellar",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      requirePremium(user);
      res.json(await accounts.getCellar(user.id));
    }),
  );

  app.put(
    "/me/cellar/:wineId",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      requirePremium(user);
      if (!isUuid(req.params.wineId)) throw badRequest("ID do vinho inválido.");
      const quantity = Number(req.body?.quantity);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 9999) throw badRequest("Quantidade inválida.");
      const saved = await accounts.setCellarQuantity(user.id, req.params.wineId, quantity);
      if (saved === null) throw notFound("Vinho não encontrado no catalog_wines.");
      res.json({ wineId: req.params.wineId, quantity: saved });
    }),
  );

  app.get(
    "/me/history",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      res.json(await accounts.getHistory(user.id));
    }),
  );

  app.post(
    "/me/history",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      const status = req.body?.status;
      if (status !== "success" && status !== "error") throw badRequest("Status de scan inválido.");
      const wineId = req.body?.wineId;
      if (wineId && !isUuid(wineId)) throw badRequest("ID do vinho inválido.");
      res.status(201).json(await accounts.addHistory(user.id, {
        wineId, status, imageUri: asString(req.body?.imageUri), result: req.body?.result,
      }));
    }),
  );

  app.delete(
    "/me/history",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      await accounts.clearHistory(user.id);
      res.status(204).send();
    }),
  );

  app.get(
    "/news",
    asyncHandler(async (_req, res) => {
      res.json(await requireAccounts(dependencies).getNews());
    }),
  );

  app.get("/sommelier-selection", asyncHandler(async (_req, res) => {
    res.json(await requireAccounts(dependencies).getSommelierSelection());
  }));

  app.get("/admin/news", asyncHandler(async (req, res) => {
    const { accounts, user } = await authenticated(req, dependencies); requireAdministrator(user);
    res.json(await accounts.listEditorialNews());
  }));

  app.post("/admin/news", asyncHandler(async (req, res) => {
    const { accounts, user } = await authenticated(req, dependencies); requireAdministrator(user);
    res.status(201).json(await accounts.createNews({ title: requiredText(req.body?.title, "Título"), summary: requiredText(req.body?.summary, "Resumo"), imageUrl: asString(req.body?.imageUrl), linkUrl: asString(req.body?.linkUrl), published: req.body?.published }));
  }));

  app.patch("/admin/news/:id", asyncHandler(async (req, res) => {
    const { accounts, user } = await authenticated(req, dependencies); requireAdministrator(user);
    if (!isUuid(req.params.id)) throw badRequest("ID da notícia inválido.");
    const updated = await accounts.updateNews(req.params.id, { title: asString(req.body?.title), summary: asString(req.body?.summary), ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, "imageUrl") ? { imageUrl: asString(req.body?.imageUrl) ?? null } : {}), ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, "linkUrl") ? { linkUrl: asString(req.body?.linkUrl) ?? null } : {}), published: typeof req.body?.published === "boolean" ? req.body.published : undefined });
    if (!updated) throw notFound("Notícia não encontrada."); res.json(updated);
  }));

  app.post("/admin/sommelier-selection", asyncHandler(async (req, res) => {
    const { accounts, user } = await authenticated(req, dependencies); requireAdministrator(user);
    const wineId = asString(req.body?.wineId); if (wineId && !isUuid(wineId)) throw badRequest("ID do vinho inválido.");
    res.status(201).json(await accounts.upsertSommelierSelection({ wineId, eyebrow: asString(req.body?.eyebrow) ?? "SELEÇÃO DO SOMMELIER", title: requiredText(req.body?.title, "Título"), summary: requiredText(req.body?.summary, "Resumo"), imageUrl: asString(req.body?.imageUrl), ctaLabel: asString(req.body?.ctaLabel) ?? "Acessar Dossier", published: req.body?.published }));
  }));

  app.get(
    "/admin/users",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      requireAdministrator(user);
      res.json(await accounts.listUsers());
    }),
  );

  app.patch(
    "/admin/users/:userId/access",
    asyncHandler(async (req, res) => {
      const { accounts, user } = await authenticated(req, dependencies);
      requireAdministrator(user);
      if (!isUuid(req.params.userId)) throw badRequest("ID do usuário inválido.");
      const requestedStatus = req.body?.status;
      const plan = req.body?.plan;
      if (requestedStatus !== undefined && !["active", "blocked", "suspended", "banned"].includes(requestedStatus)) throw badRequest("Status inválido.");
      if (plan !== undefined && plan !== "free" && plan !== "premium") throw badRequest("Plano inválido.");
      if (requestedStatus === undefined && plan === undefined) throw badRequest("Informe status ou plano.");
      const status = requestedStatus === undefined ? undefined : requestedStatus === "active" ? "active" : "blocked";
      const updated = await accounts.updateAccess(req.params.userId, { status, plan });
      if (!updated) throw notFound("Usuário não encontrado.");
      res.json(updated);
    }),
  );

  app.get(
    "/admin/unlisted-wines",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requireAdministrator(user);
      if (!dependencies.wineRepository.listUnlistedScans) throw new HttpError(503, "Fila de cadastro indisponível.", "Service Unavailable");
      res.json(await dependencies.wineRepository.listUnlistedScans());
    }),
  );

  app.patch(
    "/admin/unlisted-wines/:code",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requireAdministrator(user);
      const status = req.body?.status;
      if (status !== "reviewing" && status !== "registered" && status !== "rejected") throw badRequest("Status de revisão inválido.");
      const wineId = asString(req.body?.registeredWineId);
      if (wineId && !isUuid(wineId)) throw badRequest("ID do vinho cadastrado inválido.");
      if (status === "registered" && !wineId) throw badRequest("Informe o vinho cadastrado.");
      if (!dependencies.wineRepository.reviewUnlistedScan) throw new HttpError(503, "Fila de cadastro indisponível.", "Service Unavailable");
      const updated = await dependencies.wineRepository.reviewUnlistedScan(req.params.code, status, wineId);
      if (!updated) throw notFound("Rótulo pendente não encontrado.");
      res.json(updated);
    }),
  );

  app.get(
    "/explore",
    asyncHandler(async (_req, res) => {
      res.json(await dependencies.wineRepository.explore());
    }),
  );

  app.get(
    "/wines/autocomplete",
    asyncHandler(async (req, res) => {
      const term = asString(req.query.term) ?? "";
      res.json(await dependencies.wineRepository.autocomplete(term));
    }),
  );

  app.get(
    "/wines/lwin/:lwin",
    asyncHandler(async (req, res) => {
      const wine = await dependencies.wineRepository.findByLwin(req.params.lwin);
      if (!wine) {
        throw notFound(`Vinho com LWIN "${req.params.lwin}" não encontrado.`);
      }
      res.json(wine);
    }),
  );

  app.get(
    "/wines/:id",
    asyncHandler(async (req, res) => {
      if (!isUuid(req.params.id)) {
        throw badRequest("Validation failed (uuid is expected)");
      }

      const wine = await dependencies.wineRepository.findById(req.params.id);
      if (!wine) {
        throw notFound(`Vinho com ID "${req.params.id}" não encontrado.`);
      }
      res.json(wine);
    }),
  );

  // Wine reviews: public list (with the viewer's own review when logged in),
  // one review per user, editable (previous versions kept in history).
  const reviews = () => {
    if (!dependencies.reviews) throw new HttpError(503, "Avaliações indisponíveis.", "Service Unavailable");
    return dependencies.reviews;
  };

  app.get(
    "/wines/:id/reviews",
    asyncHandler(async (req, res) => {
      if (!isUuid(req.params.id)) throw badRequest("Validation failed (uuid is expected)");
      const token = bearerToken(req);
      const viewer = token && dependencies.accountRepository ? await dependencies.accountRepository.getUser(token).catch(() => null) : null;
      res.json(await reviews().list(req.params.id, viewer?.id));
    }),
  );

  app.put(
    "/wines/:id/reviews/me",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      if (!isUuid(req.params.id)) throw badRequest("Validation failed (uuid is expected)");
      const rating = validRating(req.body?.rating);
      if (rating === null) throw badRequest("A nota deve ser de 1 a 5, em passos de meio ponto.");
      const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
      if (comment.length > 500) throw badRequest("O comentário pode ter no máximo 500 caracteres.");
      if (!(await dependencies.wineRepository.findById(req.params.id))) throw notFound("Vinho não encontrado.");
      res.json(await reviews().upsert(req.params.id, user.id, rating, comment || null));
    }),
  );

  // Where to buy: offers from approved stores only (see wine_merchants).
  app.get(
    "/wines/:id/offers",
    asyncHandler(async (req, res) => {
      if (!isUuid(req.params.id)) throw badRequest("Validation failed (uuid is expected)");
      if (!dependencies.offers) throw new HttpError(503, "Ofertas indisponíveis.", "Service Unavailable");
      res.json(await dependencies.offers.forWine(req.params.id));
    }),
  );

  // Sommelier VINATO: Premium-only chat agent.
  const sommelier = () => {
    if (!dependencies.sommelier) throw new HttpError(503, "Sommelier indisponível.", "Service Unavailable");
    return dependencies.sommelier;
  };

  app.get(
    "/sommelier/conversations",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requirePremium(user);
      res.json(await sommelier().listConversations(user.id));
    }),
  );

  app.get(
    "/sommelier/conversations/:id/messages",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requirePremium(user);
      res.json(await sommelier().getMessages(user.id, req.params.id));
    }),
  );

  app.delete(
    "/sommelier/conversations/:id",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requirePremium(user);
      await sommelier().deleteConversation(user.id, req.params.id);
      res.status(204).send();
    }),
  );

  app.post(
    "/sommelier/chat",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requirePremium(user);
      const message = typeof req.body?.message === "string" ? req.body.message : "";
      const conversationId = typeof req.body?.conversationId === "string" && req.body.conversationId ? req.body.conversationId : undefined;
      res.json(await sommelier().chat(user.id, { conversationId, message }));
    }),
  );

  // Admin "Financeiro" (vinato-web): OpenRouter usage and balance of the server keys.
  app.get(
    "/admin/finance/openrouter",
    asyncHandler(async (req, res) => {
      const header = req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const admin = token && dependencies.adminSessions ? await dependencies.adminSessions.adminFor(token) : null;
      if (!admin) throw new HttpError(401, "Sessão administrativa inválida.", "Unauthorized");
      res.set("Cache-Control", "private, no-store").json(await openRouterAccount());
    }),
  );

  // AI review for the admin curation screen (vinato-web "Revisar com IA"): the panel
  // forwards its admin session; the OpenRouter key never leaves this server.
  app.post(
    "/admin/ai/enrich",
    asyncHandler(async (req, res) => {
      const header = req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const admin = token && dependencies.adminSessions ? await dependencies.adminSessions.adminFor(token) : null;
      if (!admin) throw new HttpError(401, "Sessão administrativa inválida.", "Unauthorized");
      const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      if (!model || !prompt) throw badRequest("Informe o modelo e o prompt.");
      if (prompt.length > 20_000) throw badRequest("Prompt muito longo.");
      const reply = await requestJson(model, [{ type: "text", text: prompt }], { maxTokens: 6000, timeoutMs: 55_000, title: "Vinato curadoria", webSearch: req.body?.web === true });
      if (!reply.ok) {
        const message = reply.error === "answer_cut_by_token_limit"
          ? "A resposta do modelo foi cortada pelo limite de tokens (raciocínio longo). Tente outro modelo ou sem pesquisa na web."
          : reply.error === "invalid_json_answer" ? "O modelo não devolveu um JSON válido." : `OpenRouter respondeu ${reply.status}: ${reply.error.slice(0, 200)}`;
        res.status(502).json({ message, usage: reply.usage ?? null });
        return;
      }
      res.json({ answer: reply.json, usage: reply.usage });
    }),
  );

  const wineLists = () => {
    if (!dependencies.wineLists) throw new HttpError(503, "Verificação de carta indisponível.", "Service Unavailable");
    return dependencies.wineLists;
  };
  const dataUrl = (file: Express.Multer.File) => `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
  const optionalText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const optionalNumber = (value: unknown) => {
    const parsed = typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : typeof value === "number" ? value : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };

  /** Transcribes the wine list files sent (photos or one PDF) and saves it, also when it fails. */
  const transcribeList = async (req: express.Request, owner: { userId?: string; uploadedBy?: string }, restaurantId?: string | null) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('Envie as fotos da carta ou o PDF no campo "files".');
    const pdfs = files.filter((file) => file.mimetype === "application/pdf");
    if (pdfs.length && files.length > 1) throw badRequest("Envie um único PDF ou apenas fotos da carta.");
    const restaurant = {
      id: restaurantId ?? null,
      name: optionalText(req.body?.restaurantName), city: optionalText(req.body?.city), address: optionalText(req.body?.address),
      latitude: optionalNumber(req.body?.latitude), longitude: optionalNumber(req.body?.longitude),
    };
    const listFiles = files.map((file) => ({ mimetype: file.mimetype, dataUrl: dataUrl(file) }));
    const startedAt = Date.now();
    const { agent, repository } = wineLists();
    const source = pdfs.length ? "pdf" as const : "photo" as const;
    let transcription: Awaited<ReturnType<typeof agent.transcribe>>;
    try {
      transcription = await agent.transcribe(listFiles, { restaurantName: restaurant.name, city: restaurant.city }, { deadline: startedAt + TRANSCRIPTION_BUDGET_MS });
    } catch (error) {
      // Unexpected failures are logged too, so every attempt shows up in the admin.
      await repository.saveList({
        ...owner, restaurant, source, files: listFiles, items: [], status: "failed", model: null, attempts: [], usage: {},
        errorMessage: `erro interno: ${(error as Error).message}`, durationMs: Date.now() - startedAt,
      }).catch((saveError) => console.error("[wine-lists] could not log the failed transcription", saveError));
      throw error;
    }
    const failed = !transcription.items.length;
    const saved = await repository.saveList({
      ...owner,
      restaurant: { ...restaurant, name: restaurant.name ?? transcription.restaurant.name, city: restaurant.city ?? transcription.restaurant.city },
      source, files: listFiles, items: transcription.items,
      status: failed ? "failed" : "transcribed", model: transcription.model, attempts: transcription.attempts, usage: transcription.usage,
      errorMessage: transcriptionProblems(transcription), durationMs: Date.now() - startedAt,
    });
    if (failed) throw transcriptionFailure(transcription);
    return { ...saved, pages: transcription.pages, unreadPages: transcription.unreadPages };
  };

  const adminOf = async (req: express.Request) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const admin = token && dependencies.adminSessions ? await dependencies.adminSessions.adminFor(token) : null;
    if (!admin) throw new HttpError(401, "Sessão administrativa inválida.", "Unauthorized");
    return admin;
  };

  // Admin "Curadoria Carta de Vinhos" → "Transcrever novamente": reads again the files a
  // user already sent (e.g. a list that failed), updating the same list.
  app.post(
    "/admin/wine-lists/:id/retranscribe",
    asyncHandler(async (req, res) => {
      await adminOf(req);
      const listId = String(req.params.id);
      const { agent, repository } = wineLists();
      const source = isUuid(listId) ? await repository.retranscriptionSource(listId) : null;
      if (!source) throw notFound("Carta não encontrada.");
      if (!source.files.length) throw badRequest("Esta carta não tem fotos nem PDF salvos para transcrever.");
      // Checks point at the items a new transcription replaces: they would be lost.
      if (source.checks > 0) throw new HttpError(409, "Esta carta já tem verificações de garrafa feitas pelos clientes; transcrever de novo apagaria essas verificações.", "Conflict");
      const startedAt = Date.now();
      const transcription = await agent.transcribe(source.files, { restaurantName: source.restaurantName, city: source.city }, { deadline: startedAt + TRANSCRIPTION_BUDGET_MS });
      const failed = !transcription.items.length;
      const saved = await repository.replaceTranscription(listId, {
        items: transcription.items, status: failed ? "failed" : "transcribed", model: transcription.model, attempts: transcription.attempts,
        usage: addUsage(source.usage ?? {}, transcription.usage), errorMessage: transcriptionProblems(transcription), durationMs: Date.now() - startedAt,
      });
      if (failed) throw transcriptionFailure(transcription);
      res.json({ ...saved, pages: transcription.pages, unreadPages: transcription.unreadPages });
    }),
  );

  // Verificação de carta: the AI transcribes the wine list (photos or one PDF).
  app.post(
    "/wine-lists",
    uploadListFiles(),
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requirePremium(user);
      res.status(201).json(await transcribeList(req, { userId: user.id }));
    }),
  );

  // Admin "Curadoria Carta de Vinhos" (vinato-web): upload a list for a new restaurant
  // (restaurantName, city, address) or an existing one (restaurantId). The panel
  // forwards its admin session; the OpenRouter key never leaves this server.
  app.post(
    "/admin/wine-lists",
    uploadListFiles(),
    asyncHandler(async (req, res) => {
      const admin = await adminOf(req);
      const restaurantId = optionalText(req.body?.restaurantId);
      if (restaurantId && (!isUuid(restaurantId) || !await wineLists().repository.restaurantExists(restaurantId))) throw notFound("Restaurante não encontrado.");
      if (!restaurantId && !optionalText(req.body?.restaurantName)) throw badRequest("Escolha um restaurante ou informe o nome do novo restaurante.");
      res.status(201).json(await transcribeList(req, { uploadedBy: admin.userId }, restaurantId));
    }),
  );

  app.get(
    "/wine-lists",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      res.json(await wineLists().repository.listsOf(user.id));
    }),
  );

  app.get(
    "/wine-lists/:id",
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      const listId = String(req.params.id);
      const { repository } = wineLists();
      // Only the lists the user sent (or the admin uploaded) open for them.
      const list = isUuid(listId) && await repository.canUse(listId, user.id) ? await repository.findList(listId) : null;
      if (!list) throw notFound("Carta não encontrada.");
      res.json(list);
    }),
  );

  // The critical sommelier: is the bottle served the wine chosen on the list?
  app.post(
    "/wine-lists/:id/items/:itemId/check",
    uploadSingleImage(),
    asyncHandler(async (req, res) => {
      const { user } = await authenticated(req, dependencies);
      requirePremium(user);
      if (!req.file) throw badRequest('Envie a foto da garrafa no campo "image".');
      const { agent, repository } = wineLists();
      const listId = String(req.params.id);
      const item = isUuid(listId) && isUuid(String(req.params.itemId)) && await repository.canUse(listId, user.id)
        ? await repository.findItem(listId, String(req.params.itemId)) : null;
      if (!item) throw notFound("Vinho da carta não encontrado.");
      const startedAt = Date.now();
      const imageDataUrl = dataUrl(req.file);
      const check = (await agent.checkBottle(item, imageDataUrl, { deadline: startedAt + CHECK_BUDGET_MS }))!;
      const saved = await repository.saveCheck({
        listId: String(req.params.id), itemId: item.id, userId: user.id, imageDataUrl, check, durationMs: Date.now() - startedAt,
        errorMessage: check.model ? null : check.attempts.map((attempt) => `${attempt.model}: ${attempt.error ?? "falha"}`).join(" | "),
      });
      if (!check.model) throw new HttpError(502, "Não foi possível comparar a garrafa agora. Tente novamente.", "Bad Gateway");
      res.json({
        id: saved.id, createdAt: saved.createdAt, item, verdict: check.verdict, confidence: check.confidence,
        observed: check.observed, differences: check.differences, explanation: check.explanation,
      });
    }),
  );

  app.post(
    "/wine-scanner/scan",
    uploadSingleImage(),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw badRequest('Nenhum arquivo de imagem foi enviado. Use o campo "image".');
      }

      const file = req.file;
      const startedAt = Date.now();
      const trace = newScanTrace();
      const token = bearerToken(req);
      const user = token && dependencies.accountRepository ? await dependencies.accountRepository.getUser(token).catch(() => null) : null;
      // Every scan leaves one audit row (photo, model, catalog lookup, outcome).
      // Auditing is best effort: it never changes what the user receives.
      const audit = async (entry: Omit<ScanAuditEntry, "file" | "trace" | "durationMs" | "userId" | "platform" | "appVersion">) => {
        if (!dependencies.scanAudit) return;
        try {
          await dependencies.scanAudit.record({
            ...entry, file, trace, userId: user?.id, durationMs: Date.now() - startedAt,
            platform: req.header("x-vinato-platform") ?? undefined, appVersion: req.header("x-vinato-app-version") ?? undefined,
          });
        } catch (error) {
          console.error("[wine-scanner] could not write the scan audit log", error);
        }
      };

      let result: ScanWineLabelResult;
      try {
        result = await dependencies.wineScanner.scanWineLabel(file, trace);
      } catch (error) {
        await audit({ success: false, outcome: "recognition_failed", errorStage: "recognition", errorMessage: (error as Error).message });
        throw error;
      }
      const reading = result.data;
      try {
        if (dependencies.wineRepository.reconcileScan) {
          result.catalog = await dependencies.wineRepository.reconcileScan(result.data, file, user?.id, trace);
          if (result.catalog.status === "matched") {
            const catalogWine = await dependencies.wineRepository.findById(result.catalog.wineId);
            if (!catalogWine) {
              throw internalServerError("O vinho identificado não pôde ser carregado do catálogo.");
            }
            result.data = catalogWineToScanData(catalogWine, result.data);
          }
        }
      } catch (error) {
        await audit({ success: false, outcome: "catalog_failed", errorStage: "catalog", errorMessage: (error as Error).message, reading });
        throw error;
      }
      const catalog = result.catalog;
      await audit({
        success: true,
        outcome: catalog?.status === "needs_registration" ? "needs_registration" : catalog?.created ? "ai_created" : "matched",
        reading,
        catalogWineId: catalog?.status === "matched" ? catalog.wineId : undefined,
        matchScore: catalog?.status === "matched" ? catalog.matchScore : undefined,
        unlistedCode: catalog?.status === "needs_registration" ? catalog.code : undefined,
        imageAdded: catalog?.status === "matched" ? catalog.imageAdded : undefined,
      });
      res.json(result);
    }),
  );

  app.use((_req, _res, next) => {
    next(notFound("Cannot GET " + _req.path));
  });

  app.use(errorHandler);

  return app;
}

// Every fact comes from the catalog row. The only label facts kept are the ones
// that describe this physical bottle and that generic catalog rows lack
// (vintage, volume), plus how confident the reading was.
function catalogWineToScanData(wine: Wine, reading: ScannedWineData): ScannedWineData {
  return {
    displayName: wine.displayName,
    producerTitle: wine.producerTitle,
    producerName: wine.producerName,
    wine: wine.wine,
    country: wine.country,
    region: wine.region,
    subRegion: wine.subRegion,
    colour: wine.colour,
    type: wine.type,
    subType: wine.subType,
    designation: wine.designation,
    classification: wine.classification,
    vintage: wine.vintageYear?.toString() ?? reading.vintage ?? null,
    alcoholContent: wine.alcohol === null || wine.alcohol === undefined ? null : `${wine.alcohol}%`,
    grapes: wine.grapes,
    volume: reading.volume,
    confidence: reading.confidence,
    notes: wine.reference ?? "",
  };
}

function uploadSingleImage(): RequestHandler {
  return (req, res, next) => {
    upload.single("image")(req, res, (error) => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        next(badRequest("Arquivo excede o tamanho máximo permitido de 10MB."));
        return;
      }

      next(error);
    });
  };
}

function uploadListFiles(): RequestHandler {
  return (req, res, next) => {
    listUpload.array("files", 10)(req, res, (error) => {
      if (!error) { next(); return; }
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") { next(badRequest("Cada arquivo pode ter no máximo 10MB.")); return; }
      if (error instanceof multer.MulterError && (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")) { next(badRequest("Envie no máximo 10 fotos da carta.")); return; }
      next(error);
    });
  };
}

type TranscriptionOutcome = { items: unknown[]; attempts: ModelAttempt[]; unreadPages: number[] };

/** What went wrong, per page and model, for the log (null when every page was read). */
function transcriptionProblems(transcription: TranscriptionOutcome) {
  if (transcription.items.length && !transcription.unreadPages.length) return null;
  const problems = transcription.attempts.filter((attempt) => !attempt.ok)
    .map((attempt) => `${attempt.page ? `página ${attempt.page} · ` : ""}${attempt.model}: ${attempt.error ?? "nenhum vinho encontrado"}`);
  return problems.join(" | ") || "nenhum vinho encontrado";
}

function transcriptionFailure(transcription: TranscriptionOutcome) {
  const timedOut = transcription.attempts.some((attempt) => attempt.error === "request_timeout" || attempt.error === "no_time_left");
  return new HttpError(422, timedOut
    ? "A leitura da carta demorou demais. Envie menos páginas por vez (as que têm os vinhos que você quer escolher)."
    : "Não conseguimos ler os vinhos desta carta. Confira se as fotos mostram a lista de vinhos, uma página por foto.", "Unprocessable Entity");
}

/** Usage of every attempt of a list, earlier ones included. */
function addUsage(before: OpenRouterUsage, after: OpenRouterUsage): OpenRouterUsage {
  const sum = (key: keyof OpenRouterUsage) => before[key] === undefined && after[key] === undefined ? undefined : (before[key] ?? 0) + (after[key] ?? 0);
  return { promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), totalTokens: sum("totalTokens"), costUsd: sum("costUsd") };
}

function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function parseWineListQuery(query: Record<string, unknown>): WineListQuery {
  const page = parseIntegerQuery("page", query.page, 1, { min: 1 });
  const limit = parseIntegerQuery("limit", query.limit, 20, { min: 1, max: 100 });

  return {
    country: asString(query.country),
    colour: asString(query.colour),
    region: asString(query.region),
    grape: asString(query.grape),
    type: asString(query.type),
    search: asString(query.search),
    awarded: asString(query.awarded) === "true",
    page,
    limit,
  };
}

function parseIntegerQuery(
  name: string,
  rawValue: unknown,
  defaultValue: number,
  rules: { min?: number; max?: number },
) {
  const value = asString(rawValue);
  if (value === undefined || value === "") return defaultValue;

  const numberValue = Number(value);
  const messages: string[] = [];

  if (rules.max !== undefined && (!Number.isFinite(numberValue) || numberValue > rules.max)) {
    messages.push(`${name} must not be greater than ${rules.max}`);
  }

  if (rules.min !== undefined && (!Number.isFinite(numberValue) || numberValue < rules.min)) {
    messages.push(`${name} must not be less than ${rules.min}`);
  }

  if (!Number.isInteger(numberValue)) {
    messages.push(`${name} must be an integer number`);
  }

  if (messages.length) {
    throw badRequest(messages);
  }

  return numberValue;
}

function asString(value: unknown): string | undefined {
  if (Array.isArray(value)) return asString(value[0]);
  if (typeof value !== "string") return undefined;
  return value;
}

function requireAccounts(dependencies: AppDependencies) {
  if (!dependencies.accountRepository) throw new HttpError(503, "Módulo de contas indisponível.", "Service Unavailable");
  return dependencies.accountRepository;
}

async function authenticated(req: Parameters<RequestHandler>[0], dependencies: AppDependencies) {
  const accounts = requireAccounts(dependencies);
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Sessão não informada.", "Unauthorized");
  const user = await accounts.getUser(token);
  if (!user) throw new HttpError(401, "Sessão inválida ou expirada.", "Unauthorized");
  return { accounts, token, user };
}

function bearerToken(req: Parameters<RequestHandler>[0]) {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requiredText(value: unknown, field: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 2) throw badRequest(`${field} deve ter pelo menos 2 caracteres.`);
  return text;
}

function requiredEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Digite um e-mail válido.");
  return email;
}

function rejectDisposableEmail(email: string) {
  if (isDisposableEmailAddress(email)) throw new HttpError(400, DISPOSABLE_EMAIL_MESSAGE, "Bad Request");
}

function requiredPassword(value: unknown) {
  const password = typeof value === "string" ? value : "";
  if (password.length < 8) throw badRequest("A senha deve ter pelo menos 8 caracteres.");
  return password;
}

function requiredToken(value: unknown) {
  if (typeof value !== "string" || value.length < 20) throw badRequest("Token de identidade inválido.");
  return value;
}

function requirePremium(user: { plan: string }) {
  if (user.plan !== "premium") throw new HttpError(403, "Recurso exclusivo do VINATO Premium.", "Forbidden");
}

function requireAdministrator(user: { role: string }) {
  if (user.role !== "owner" && user.role !== "editor") throw new HttpError(403, "Acesso administrativo necessário.", "Forbidden");
}

function validateAvatar(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(value)) {
    throw badRequest("Foto de perfil inválida.");
  }
  if (value.length > 2_500_000) throw badRequest("A foto de perfil deve ter no máximo 2 MB.");
  return value;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json(error.toJSON());
    return;
  }

  if (error instanceof SyntaxError) {
    res.status(400).json(badRequest("Invalid JSON payload").toJSON());
    return;
  }

  const response = internalServerError("Erro interno do servidor.");
  res.status(response.statusCode).json(response.toJSON());
};
