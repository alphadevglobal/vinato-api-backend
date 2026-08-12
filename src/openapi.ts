export const openApiDocument = {
  openapi: "3.0.0",
  paths: {
    "/": {
      get: {
        operationId: "AppController_getHello",
        parameters: [],
        responses: { "200": { description: "" } },
        tags: ["App"],
      },
    },
    "/wines": {
      get: {
        description:
          "Retorna uma lista paginada de vinhos com filtros opcionais por país, cor, região, tipo e nome.",
        operationId: "WineController_findAll",
        parameters: [
          queryParam("country", "Filtrar por país", "France"),
          queryParam("colour", "Filtrar por cor do vinho", "Red"),
          queryParam("region", "Filtrar por região", "Bordeaux"),
          queryParam("type", "Filtrar por tipo", "Still"),
          queryParam("search", "Termo de busca por nome", "Margaux"),
          {
            name: "page",
            required: false,
            in: "query",
            description: "Página atual (começa em 1)",
            schema: { default: 1, example: 1, type: "number" },
          },
          {
            name: "limit",
            required: false,
            in: "query",
            description: "Itens por página (máximo 100)",
            schema: { default: 20, example: 20, type: "number" },
          },
        ],
        responses: {
          "200": {
            description: "Lista paginada de vinhos.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaginatedWinesResponseDto" },
              },
            },
          },
        },
        summary: "Listar vinhos",
        tags: ["wines"],
      },
    },
    "/wines/autocomplete": {
      get: {
        description:
          "Busca vinhos cujo nome contenha o termo informado (case-insensitive). Retorna no máximo 10 resultados.",
        operationId: "WineController_autocomplete",
        parameters: [queryParam("term", "Termo de busca", "Margaux", true)],
        responses: {
          "200": {
            description: "Lista de sugestões de vinhos.",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/AutocompleteWineItemDto" },
                },
              },
            },
          },
        },
        summary: "Autocomplete de vinhos por nome",
        tags: ["wines"],
      },
    },
    "/wines/lwin/{lwin}": {
      get: {
        description:
          "Retorna os detalhes completos de um vinho pelo seu código LWIN único.",
        operationId: "WineController_findByLwin",
        parameters: [
          {
            name: "lwin",
            required: true,
            in: "path",
            description: "Código LWIN do vinho",
            schema: { example: "1001001", type: "string" },
          },
        ],
        responses: wineFoundResponses(false),
        summary: "Buscar vinho por LWIN",
        tags: ["wines"],
      },
    },
    "/wines/{id}": {
      get: {
        description: "Retorna os detalhes completos de um vinho pelo seu UUID.",
        operationId: "WineController_findById",
        parameters: [
          {
            name: "id",
            required: true,
            in: "path",
            description: "UUID do vinho",
            schema: {
              example: "550e8400-e29b-41d4-a716-446655440000",
              type: "string",
            },
          },
        ],
        responses: wineFoundResponses(true),
        summary: "Buscar vinho por ID",
        tags: ["wines"],
      },
    },
    "/wine-scanner/scan": {
      post: {
        description:
          "Recebe uma imagem de rótulo de vinho via `multipart/form-data` e utiliza IA para extrair dados estruturados como produtor, safra, região, cor, tipo, uvas e outros campos compatíveis com o schema Wine.",
        operationId: "WineScannerController_scan",
        parameters: [],
        requestBody: {
          required: true,
          description:
            "Imagem do rótulo do vinho (JPEG, PNG, WEBP, HEIC — máx. 10MB)",
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["image"],
                properties: {
                  image: {
                    type: "string",
                    format: "binary",
                    description: "Arquivo de imagem do rótulo",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Dados extraídos com sucesso.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ScanWineLabelResponseDto" },
              },
            },
          },
          "400": scannerErrorResponse(
            "Arquivo não enviado, tipo inválido ou tamanho excedido.",
          ),
          "500": scannerErrorResponse("Falha na comunicação com a API de IA."),
        },
        summary: "Escanear rótulo de vinho com IA",
        tags: ["wine-scanner"],
      },
    },
  },
  info: {
    title: "Wine API",
    description: "API para consulta e busca de vinhos do catálogo LWIN",
    version: "1.0",
    contact: {},
  },
  tags: [
    { name: "wines", description: "Endpoints do módulo de vinhos" },
    {
      name: "wine-scanner",
      description: "Extração de dados de rótulos de vinho via IA",
    },
  ],
  servers: [],
  components: {
    schemas: {
      WineResponseDto: wineResponseSchema(),
      PaginatedWinesResponseDto: {
        type: "object",
        properties: {
          data: {
            description: "Lista de vinhos",
            type: "array",
            items: { $ref: "#/components/schemas/WineResponseDto" },
          },
          total: {
            type: "number",
            description: "Total de registros encontrados",
            example: 1500,
          },
          page: { type: "number", description: "Página atual", example: 1 },
          limit: { type: "number", description: "Itens por página", example: 20 },
          totalPages: {
            type: "number",
            description: "Total de páginas",
            example: 75,
          },
        },
        required: ["data", "total", "page", "limit", "totalPages"],
      },
      AutocompleteWineItemDto: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "UUID do vinho",
            example: "550e8400-e29b-41d4-a716-446655440000",
          },
          lwin: {
            type: "string",
            description: "Código LWIN",
            example: "1001001",
          },
          displayName: {
            type: "string",
            description: "Nome de exibição do vinho",
            example: "Château Margaux",
          },
          country: {
            type: "object",
            description: "País de origem",
            example: "France",
            nullable: true,
          },
          colour: {
            type: "object",
            description: "Cor do vinho",
            example: "Red",
            nullable: true,
          },
          imageUrl: { type: "string", format: "uri", nullable: true, description: "Imagem autorizada do vinho, quando disponível" },
          rating: { type: "number", nullable: true, example: 4.3, description: "Avaliação média da fonte" },
          grapes: { type: "string", nullable: true, example: "Cabernet Sauvignon", description: "Composição de uvas" },
          reviewCount: { type: "number", example: 120, description: "Quantidade de avaliações importadas" },
        },
        required: ["id", "lwin", "displayName", "country", "colour"],
      },
      ScannedWineDataDto: scannedWineDataSchema(),
      ScanWineLabelResponseDto: {
        type: "object",
        properties: {
          data: {
            description: "Dados extraídos do rótulo do vinho",
            allOf: [{ $ref: "#/components/schemas/ScannedWineDataDto" }],
          },
          success: {
            type: "boolean",
            description: "Imagem foi processada com sucesso",
            example: true,
          },
        },
        required: ["data", "success"],
      },
      WineScannerErrorDto: {
        type: "object",
        properties: {
          success: {
            type: "boolean",
            description: "Operação falhou",
            example: false,
          },
          message: {
            type: "string",
            description: "Mensagem de erro",
            example: "Nenhuma imagem enviada.",
          },
        },
        required: ["success", "message"],
      },
    },
  },
} as const;

function queryParam(
  name: string,
  description: string,
  example: string,
  required = false,
) {
  return {
    name,
    required,
    in: "query",
    description,
    schema: { example, type: "string" },
  };
}

function wineFoundResponses(includeBadRequest: boolean) {
  return {
    "200": {
      description: "Dados do vinho encontrado.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/WineResponseDto" },
        },
      },
    },
    ...(includeBadRequest ? { "400": { description: "UUID inválido." } } : {}),
    "404": { description: "Vinho não encontrado." },
  };
}

function scannerErrorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/WineScannerErrorDto" },
      },
    },
  };
}

function wineResponseSchema() {
  const objectField = (description: string, example: string) => ({
    type: "object",
    description,
    example,
  });

  return {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "UUID do vinho",
        example: "550e8400-e29b-41d4-a716-446655440000",
      },
      lwin: {
        type: "string",
        description: "Código LWIN único do vinho",
        example: "1001001",
      },
      status: objectField("Status do vinho", "active"),
      displayName: {
        type: "string",
        description: "Nome de exibição do vinho",
        example: "Château Margaux",
      },
      producerTitle: objectField("Título do produtor", "Château"),
      producerName: objectField("Nome do produtor", "Margaux"),
      wine: objectField("Nome do vinho", "Margaux"),
      country: objectField("País de origem", "France"),
      region: objectField("Região", "Bordeaux"),
      subRegion: objectField("Sub-região", "Margaux"),
      site: objectField("Local/site", "Left Bank"),
      parcel: objectField("Parcela", "Grand Cru"),
      colour: objectField("Cor do vinho", "Red"),
      type: objectField("Tipo do vinho", "Still"),
      subType: objectField("Sub-tipo do vinho", "Dry"),
      designation: objectField("Designação", "Premier Cru Classé"),
      classification: objectField("Classificação", "First Growth"),
      vintageConfig: objectField("Configuração de vintage", "Vintage"),
      firstVintage: objectField("Primeiro vintage disponível", "1900"),
      finalVintage: objectField("Último vintage disponível", "2023"),
      dateAdded: objectField("Data de adição ao catálogo", "2024-01-15"),
      dateUpdated: objectField(
        "Data de última atualização no catálogo",
        "2024-06-01",
      ),
      reference: objectField("Referência externa", "REF-001"),
      createdAt: {
        format: "date-time",
        type: "string",
        description: "Data de criação do registro",
        example: "2024-01-15T10:30:00Z",
      },
      updatedAt: {
        format: "date-time",
        type: "string",
        description: "Data de última atualização do registro",
        example: "2024-06-01T08:00:00Z",
      },
    },
    required: ["id", "lwin", "displayName", "createdAt", "updatedAt"],
  };
}

function scannedWineDataSchema() {
  const field = (description: string, example: string) => ({
    type: "object",
    description,
    example,
  });

  return {
    type: "object",
    properties: {
      displayName: field(
        'Nome completo de exibição do vinho (ex: "Château Margaux 2015")',
        "Château Margaux",
      ),
      producerTitle: field(
        'Título do produtor (ex: "Château", "Domaine", "Quinta")',
        "Château",
      ),
      producerName: field("Nome do produtor / vinícola", "Margaux"),
      wine: field("Nome específico do vinho dentro da vinícola", "Grand Vin"),
      country: field("País de origem", "France"),
      region: field("Região vitivinícola", "Bordeaux"),
      subRegion: field("Sub-região vitivinícola", "Margaux"),
      colour: field("Cor do vinho (Red, White, Rosé, Orange, Sparkling)", "Red"),
      type: field("Tipo do vinho (Still, Sparkling, Fortified, Dessert)", "Still"),
      subType: field("Sub-tipo (Dry, Sweet, Off-Dry, Brut, etc.)", "Dry"),
      designation: field("Designação oficial (AOC, DOC, AVA, etc.)", "Margaux AOC"),
      classification: field(
        "Classificação (Premier Cru, Grand Cru, Reserva, etc.)",
        "Premier Grand Cru Classé",
      ),
      vintage: field("Ano da safra (vintage)", "2015"),
      alcoholContent: field("Teor alcoólico identificado no rótulo", "13.5%"),
      grapes: field("Castas/uvas identificadas no rótulo", "Cabernet Sauvignon, Merlot"),
      volume: field("Volume da garrafa", "750ml"),
      confidence: {
        type: "number",
        description: "Nível de confiança da extração (0.0 a 1.0)",
        example: 0.92,
      },
      notes: {
        type: "string",
        description: "Notas adicionais do modelo sobre o rótulo",
        example:
          "Rótulo claro com informações completas. Imagem levemente inclinada.",
      },
    },
    required: ["confidence", "notes"],
  };
}
