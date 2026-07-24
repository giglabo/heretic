/**
 * TypeScript interfaces for every request/response the Mnemoria CLI exchanges
 * with the Mnemoria server over HTTP. Kept intentionally independent from the
 * server's Rust types — the shape here is what the CLI reads/writes.
 */

// ---------- Pagination ----------

export interface PageRequest {
  limit?: number;
  after?: string;
  before?: string;
}

export interface Page<T> {
  items: T[];
  total?: number;
  has_next: boolean;
  has_previous: boolean;
  next_cursor?: string | null;
  previous_cursor?: string | null;
}

// ---------- Health ----------

export interface HealthResponse {
  live: boolean;
  ready: boolean;
  version?: string;
  details?: Record<string, unknown>;
}

export interface WhoamiResponse {
  authenticated: boolean;
  user_id?: string;
  user_email?: string;
  tenant_id?: string;
  tenant_name?: string;
  roles?: string[];
  expires_at?: string;
}

// ---------- Palace ----------

export interface CreatePalaceRequest {
  name: string;
  language: string;
  description?: string;
  additional_languages?: string[];
  embedding_dimensions?: number;
}

export interface UpdatePalaceRequest {
  name?: string;
  description?: string;
  language?: string;
  additional_languages?: string[];
}

export interface PalaceResponse {
  id: string;
  name: string;
  language: string;
  description?: string;
  additional_languages?: string[];
  embedding_dimensions: number;
  drawer_count?: number;
  entity_count?: number;
  triple_count?: number;
  keyword_count?: number;
  created_at: string;
  updated_at?: string;
}

// ---------- Wing / Room ----------

export interface CreateWingRequest {
  name: string;
  description?: string;
  sort_order?: number;
}

export interface UpdateWingRequest {
  name?: string;
  description?: string;
  sort_order?: number;
}

export interface WingResponse {
  id: string;
  palace_id: string;
  name: string;
  description?: string;
  sort_order: number;
  room_count?: number;
  drawer_count?: number;
  created_at: string;
  updated_at?: string;
}

export interface CreateRoomRequest {
  name: string;
  description?: string;
  sort_order?: number;
}

export interface UpdateRoomRequest {
  name?: string;
  description?: string;
  sort_order?: number;
}

export interface RoomResponse {
  id: string;
  palace_id: string;
  wing_id: string;
  name: string;
  description?: string;
  sort_order: number;
  drawer_count?: number;
  created_at: string;
  updated_at?: string;
}

// ---------- Drawer ----------

export interface CreateDrawerRequest {
  content: string;
  wing?: string;
  room?: string;
  keyword?: string;
  tags?: string[];
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface DrawerResponse {
  id: string;
  palace_id: string;
  wing?: string;
  wing_id?: string;
  room?: string;
  room_id?: string;
  keyword?: string;
  content: string;
  tags?: string[];
  language?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface DrawerListQuery extends PageRequest {
  wing?: string;
  room?: string;
}

// ---------- Search ----------

export type SearchMode = "semantic" | "keyword" | "graph" | "hybrid";

export interface SearchRequest {
  query?: string;
  keyword?: string;
  entity?: string;
  entity_type?: string;
  wing?: string;
  room?: string;
  limit?: number;
  mode?: SearchMode;
}

export interface SearchResultItem {
  id: string;
  type: SearchMode;
  score: number;
  content: string;
  wing?: string;
  room?: string;
  keyword?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  items: SearchResultItem[];
  mode_counts?: Partial<Record<SearchMode, number>>;
  total: number;
}

// ---------- Knowledge graph ----------

export type EntityType =
  | "Person"
  | "Organization"
  | "Project"
  | "Technology"
  | "Concept"
  | "Location"
  | "Event"
  | "File"
  | "Module"
  | "Function"
  | "Other";

export interface CreateEntityRequest {
  name: string;
  entity_type: EntityType | string;
  description?: string;
}

export interface EntityResponse {
  id: string;
  palace_id: string;
  name: string;
  entity_type: EntityType | string;
  description?: string;
  triple_count?: number;
  created_at: string;
  updated_at?: string;
}

export interface EntityListQuery extends PageRequest {
  entity_type?: string;
}

export interface CreateTripleRequest {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  valid_from?: string;
  valid_until?: string;
  metadata?: Record<string, unknown>;
}

export interface TripleResponse {
  id: string;
  palace_id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  valid_from?: string;
  valid_until?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface TripleListQuery extends PageRequest {
  subject?: string;
  predicate?: string;
  object?: string;
}

export interface ShortestPathRequest {
  from: string;
  to: string;
  max_depth?: number;
}

export interface PathEdge {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface PathResponse {
  path: string[];
  edges: PathEdge[];
  distance: number;
}

export interface TimelineQuery {
  from?: string;
  to?: string;
  limit?: number;
}

export interface TimelineEvent {
  date: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface TimelineResponse {
  entity: string;
  events: TimelineEvent[];
}

export interface NeighborhoodResponse {
  entity: EntityResponse;
  depth: number;
  incoming: Array<{ entity: EntityResponse; predicate: string; confidence: number }>;
  outgoing: Array<{ entity: EntityResponse; predicate: string; confidence: number }>;
}

// ---------- Keywords ----------

export type KeywordTargetType = "Text" | "Drawer" | "Entity" | "File";
export type KeywordStatus = "active" | "expired" | "deleted";
export type KeywordTtlPreset = "ephemeral" | "sprint" | "quarter" | "year" | "permanent";

export interface AssignKeywordRequest {
  word: string;
  target_type: KeywordTargetType;
  content?: string;
  drawer_id?: string;
  entity_id?: string;
  file_key?: string;
  wing?: string;
  room?: string;
  ttl?: KeywordTtlPreset;
}

export interface KeywordResponse {
  word: string;
  assigned_word: string;
  palace_id: string;
  target_type: KeywordTargetType;
  status: KeywordStatus;
  ttl: KeywordTtlPreset;
  expires_at?: string;
  content?: string;
  drawer_id?: string;
  entity_id?: string;
  file_key?: string;
  wing?: string;
  room?: string;
  created_at: string;
}

// ---------- Files ----------

export interface UploadRequest {
  filename: string;
  content_type: string;
  size: number;
  keyword?: string;
}

export interface PresignedUploadResponse {
  key: string;
  upload_url: string;
  headers?: Record<string, string>;
  expires_at: string;
}

export interface DownloadRequest {
  key?: string;
  keyword?: string;
}

export interface PresignedDownloadResponse {
  key: string;
  download_url: string;
  filename: string;
  size: number;
  content_type: string;
  expires_at: string;
}

// ---------- Ingestion ----------

export type IngestSource = "filesystem" | "conversation";
export type IngestJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface IngestRequest {
  source: IngestSource;
  path: string;
  wing?: string;
  room?: string;
  language?: string;
  include?: string[];
  exclude?: string[];
  chunk_size?: number;
  min_chunk_size?: number;
  chunk_overlap?: number;
  extract_entities?: boolean;
  watch?: boolean;
  dry_run?: boolean;
}

export interface IngestJobResponse {
  job_id: string;
  palace_id: string;
  status: IngestJobStatus;
  source: IngestSource;
  files_processed: number;
  files_total?: number;
  chunks_created: number;
  entities_found: number;
  triples_created: number;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

// ---------- Error envelope (server-side) ----------

export interface ServerErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  message?: string;
  detail?: string;
}
