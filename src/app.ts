import cors from "cors";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import helmet from "helmet";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import { badRequest, HttpError, internalServerError, notFound } from "./http-error.js";
import { openApiDocument } from "./openapi.js";
import type { AppDependencies, AsyncRequestHandler, WineListQuery } from "./types.js";

const acceptedMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

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
  app.use(express.json({ limit: "1mb" }));

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
  app.get("/api/docs", swaggerUi.setup(openApiDocument, swaggerUiOptions));
  app.use(
    "/api/docs",
    swaggerUi.serveFiles(openApiDocument, swaggerUiOptions),
    swaggerUi.setup(openApiDocument, swaggerUiOptions),
  );

  app.get(
    "/wines",
    asyncHandler(async (req, res) => {
      const query = parseWineListQuery(req.query);
      res.json(await dependencies.wineRepository.findAll(query));
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

  app.post(
    "/wine-scanner/scan",
    uploadSingleImage(),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw badRequest('Nenhum arquivo de imagem foi enviado. Use o campo "image".');
      }

      res.json(await dependencies.wineScanner.scanWineLabel(req.file));
    }),
  );

  app.use((_req, _res, next) => {
    next(notFound("Cannot GET " + _req.path));
  });

  app.use(errorHandler);

  return app;
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
    type: asString(query.type),
    search: asString(query.search),
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
