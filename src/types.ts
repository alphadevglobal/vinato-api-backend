import type { RequestHandler } from "express";

/** Janela de uso: one phase of the wine's life, in years after the vintage ("plus": and beyond). */
export type DrinkingPhase = { from: number; to: number | null; plus?: boolean; note: string };

export type Wine = {
  id: string;
  lwin: string;
  status: string | null;
  displayName: string;
  producerTitle: string | null;
  producerName: string | null;
  wine: string | null;
  country: string | null;
  region: string | null;
  subRegion: string | null;
  site: string | null;
  parcel: string | null;
  colour: string | null;
  type: string | null;
  subType: string | null;
  designation: string | null;
  classification: string | null;
  vintageConfig: string | null;
  firstVintage: string | null;
  finalVintage: string | null;
  dateAdded: string | null;
  dateUpdated: string | null;
  reference: string | null;
  source?: string;
  sourceId?: string | null;
  vintageYear?: number | null;
  alcohol?: number | null;
  /** Tempo de guarda (catalog_wines.aging_potential): shown to Premium members. */
  agingPotential?: string | null;
  /** Janela de uso: phases after the vintage ({ from, to, plus?, note }), shown to Premium members. */
  drinkingWindow?: DrinkingPhase[];
  priceUsd?: number | null;
  rating?: number | null;
  grapes?: string | null;
  imagePath?: string | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  reviewCount?: number;
  awardsCount?: number;
  latestAwardYear?: number | null;
  awardSymbol?: string | null;
  /** "catalog" (imported base), "ai_scan" (created from a scan) or "admin". */
  dataSource?: string;
  /** "approved", "pending" (awaiting curation) or "rejected". */
  curationStatus?: string;
  backImageUrl?: string | null;
  pairings?: string[];
  createdAt: string;
  updatedAt: string;
};

export type WineRow = {
  id: string;
  lwin: string;
  status: string | null;
  display_name: string;
  producer_title: string | null;
  producer_name: string | null;
  wine: string | null;
  country: string | null;
  region: string | null;
  sub_region: string | null;
  site: string | null;
  parcel: string | null;
  colour: string | null;
  type: string | null;
  sub_type: string | null;
  designation: string | null;
  classification: string | null;
  vintage_config: string | null;
  first_vintage: string | null;
  final_vintage: string | null;
  date_added: string | null;
  date_updated: string | null;
  reference: string | null;
  source: string;
  source_id: string | null;
  vintage_year: number | null;
  alcohol: string | number | null;
  aging_potential?: string | null;
  drinking_window?: unknown;
  price_usd: string | number | null;
  rating: string | number | null;
  grapes: string | null;
  image_path: string | null;
  image_url: string | null;
  source_url: string | null;
  review_count: number;
  awards_count: number;
  latest_award_year: number | null;
  award_symbol: string | null;
  data_source?: string | null;
  curation_status?: string | null;
  back_image_url?: string | null;
  pairings?: string[] | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type WineListQuery = {
  country?: string;
  colour?: string;
  region?: string;
  grape?: string;
  type?: string;
  search?: string;
  awarded?: boolean;
  page: number;
  limit: number;
};

export type PaginatedWines = {
  data: Wine[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type AutocompleteWine = Pick<
  Wine,
  "id" | "lwin" | "displayName" | "country" | "colour" | "imageUrl" | "rating" | "grapes" | "reviewCount"
>;

export type ExploreFacet = { name: string; count: number; country?: string | null; imageUrl?: string | null };
export type ExploreCatalog = {
  countries: ExploreFacet[];
  regions: ExploreFacet[];
  grapes: ExploreFacet[];
  styles: ExploreFacet[];
  awarded: { ready: boolean; count: number };
};

export type ScannedWineData = {
  displayName?: string | null;
  producerTitle?: string | null;
  producerName?: string | null;
  wine?: string | null;
  country?: string | null;
  region?: string | null;
  subRegion?: string | null;
  colour?: string | null;
  type?: string | null;
  subType?: string | null;
  designation?: string | null;
  classification?: string | null;
  vintage?: string | null;
  alcoholContent?: string | null;
  grapes?: string | null;
  volume?: string | null;
  /** 2–3 sentences about the wine's style, from wine knowledge consistent with the label. */
  description?: string | null;
  /** Dishes that pair with the wine. */
  foodPairings?: string[] | null;
  /** Tempo de guarda as the label states it ("Guardar até 2032", "8 a 10 anos"). */
  agingPotential?: string | null;
  confidence: number;
  notes: string;
};

export type CatalogAlternative = { wineId: string; displayName: string };

export type ScanResolution = "barcode" | "text" | "ai";

export type ScanWineLabelResult = {
  data: ScannedWineData;
  success: true;
  catalog?:
    // created: the catalog had no safe match, so the wine was created from the AI reading (pending curation).
    // resolvedBy: how the wine was found. barcode/text: on the phone's reading, without AI tokens.
    | { status: "matched"; wineId: string; imageAdded: boolean; matchScore?: number; created?: boolean; alternatives?: CatalogAlternative[]; resolvedBy?: ScanResolution }
    | { status: "needs_registration"; code: string; alternatives?: CatalogAlternative[] };
};

export type WineRepository = {
  findAll(query: WineListQuery): Promise<PaginatedWines>;
  autocomplete(term: string): Promise<AutocompleteWine[]>;
  findById(id: string): Promise<Wine | null>;
  findByLwin(lwin: string): Promise<Wine | null>;
  explore(): Promise<ExploreCatalog>;
  reconcileScan?(data: ScannedWineData, file: Express.Multer.File, userId?: string, trace?: import("./scan-audit.repository.js").ScanTrace): Promise<NonNullable<ScanWineLabelResult["catalog"]>>;
  // Scan without AI (label-text-match): barcode links and the catalog search by label text.
  findCandidatesByTerms?(terms: string[]): Promise<import("./catalog-matcher.js").CatalogCandidate[]>;
  findWineByBarcode?(barcode: string): Promise<{ wineId: string; vintage: number | null } | null>;
  rememberBarcode?(barcode: string, wineId: string, source: "scan_ai" | "scan_text", userId?: string, replace?: boolean): Promise<void>;
  attachDeviceScan?(wineId: string, file: Express.Multer.File, userId?: string): Promise<boolean>;
  logUnlistedScan?(file: Express.Multer.File, userId?: string, extractedData?: Record<string, unknown>): Promise<NonNullable<ScanWineLabelResult["catalog"]>>;
  listUnlistedScans?(): Promise<unknown[]>;
  reviewUnlistedScan?(code: string, status: "reviewing" | "registered" | "rejected", registeredWineId?: string): Promise<unknown | null>;
};

export type WineScanner = {
  scanWineLabel(file: Express.Multer.File, trace?: import("./scan-audit.repository.js").ScanTrace): Promise<ScanWineLabelResult>;
};

export type AppDependencies = {
  wineRepository: WineRepository;
  wineScanner: WineScanner;
  accountRepository?: import("./account.repository.js").AccountRepository;
  scanAudit?: import("./scan-audit.repository.js").ScanAuditLog;
  sommelier?: import("./sommelier.service.js").SommelierAgent;
  reviews?: import("./reviews.repository.js").ReviewRepository;
  offers?: import("./offers.repository.js").OfferRepository;
  adminSessions?: Pick<import("./admin-session.js").AdminSessions, "adminFor">;
  wineLists?: {
    agent: Pick<import("./wine-list.service.js").OpenRouterWineListAgent, "transcribe" | "checkBottle">;
    repository: Pick<import("./wine-lists.repository.js").WineListRepository, "saveList" | "findList" | "listsOf" | "findItem" | "saveCheck" | "canUse" | "restaurantExists" | "retranscriptionSource" | "replaceTranscription" | "restaurantsWithLists">;
  };
  /** "Cardápios": restaurant menus uploaded in the admin (migration 026). */
  menus?: {
    agent: Pick<import("./menu.service.js").OpenRouterMenuAgent, "transcribe">;
    repository: Pick<import("./menus.repository.js").MenuRepository, "saveMenu" | "retranscriptionSource" | "replaceTranscription">;
  };
};

export type AsyncRequestHandler = (
  ...args: Parameters<RequestHandler>
) => Promise<void>;
