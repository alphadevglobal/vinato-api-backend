import type { RequestHandler } from "express";

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
  created_at: string | Date;
  updated_at: string | Date;
};

export type WineListQuery = {
  country?: string;
  colour?: string;
  region?: string;
  type?: string;
  search?: string;
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
  "id" | "lwin" | "displayName" | "country" | "colour"
>;

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
  confidence: number;
  notes: string;
};

export type ScanWineLabelResult = {
  data: ScannedWineData;
  success: true;
};

export type WineRepository = {
  findAll(query: WineListQuery): Promise<PaginatedWines>;
  autocomplete(term: string): Promise<AutocompleteWine[]>;
  findById(id: string): Promise<Wine | null>;
  findByLwin(lwin: string): Promise<Wine | null>;
};

export type WineScanner = {
  scanWineLabel(file: Express.Multer.File): Promise<ScanWineLabelResult>;
};

export type AppDependencies = {
  wineRepository: WineRepository;
  wineScanner: WineScanner;
};

export type AsyncRequestHandler = (
  ...args: Parameters<RequestHandler>
) => Promise<void>;
