import { getLogger } from "../../logger";
import {
  MnemoniaAuthError,
  MnemoniaConflictError,
  MnemoniaConnectionError,
  MnemoniaForbiddenError,
  MnemoniaNotFoundError,
  MnemoniaRateLimitError,
  MnemoniaServerError,
  MnemoniaTimeoutError,
  MnemoniaValidationError,
} from "./errors";
import type {
  AssignKeywordRequest,
  CreateDrawerRequest,
  CreateEntityRequest,
  CreatePalaceRequest,
  CreateRoomRequest,
  CreateTripleRequest,
  CreateWingRequest,
  DrawerListQuery,
  DrawerResponse,
  DownloadRequest,
  EntityListQuery,
  EntityResponse,
  HealthResponse,
  IngestJobResponse,
  IngestRequest,
  KeywordResponse,
  NeighborhoodResponse,
  Page,
  PageRequest,
  PalaceResponse,
  PathResponse,
  PresignedDownloadResponse,
  PresignedUploadResponse,
  RoomResponse,
  SearchRequest,
  SearchResponse,
  ServerErrorBody,
  ShortestPathRequest,
  TimelineQuery,
  TimelineResponse,
  TripleListQuery,
  TripleResponse,
  UpdatePalaceRequest,
  UpdateRoomRequest,
  UpdateWingRequest,
  UploadRequest,
  WhoamiResponse,
  WingResponse,
} from "./types";

const logger = getLogger();

export interface MnemoniaClientConfig {
  baseUrl: string;
  timeout: number;
  retry: { attempts: number; delay: number };
  /**
   * Token provider. Called on every request so the caller can perform refresh
   * lazily. Return null when unauthenticated (server may allow or 401 later).
   */
  getToken: () => Promise<string | null>;
}

/**
 * Thin HTTP client for the Mnemoria server. Handles retry on 5xx/network,
 * maps status codes to typed errors, and injects bearer auth.
 *
 * All business logic lives on the server — this class is a typed function
 * library over `fetch`.
 */
export class MnemoniaClient {
  constructor(private readonly config: MnemoniaClientConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  // ---------- Low-level request ----------

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { skipAuth?: boolean; query?: Record<string, unknown> }
  ): Promise<T> {
    const url = this.buildUrl(path, init?.query);
    const maxAttempts = Math.max(1, this.config.retry.attempts + 1);
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = this.config.retry.delay * Math.pow(2, attempt - 2);
        logger.debug({ url, attempt, delay }, "Retrying request");
        await sleep(delay);
      }

      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";

        if (!init?.skipAuth) {
          const token = await this.config.getToken();
          if (token) headers["Authorization"] = `Bearer ${token}`;
        }

        logger.debug({ method, url, attempt }, "HTTP request");

        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.config.timeout),
        });

        // Retryable server errors
        if (response.status >= 500 && response.status < 600 && attempt < maxAttempts) {
          lastError = new Error(`Server returned ${response.status}`);
          continue;
        }

        if (!response.ok) {
          throw await this.mapHttpError(response);
        }

        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          throw new MnemoniaServerError(response.status, `Invalid JSON response: ${String(err)}`);
        }
      } catch (err) {
        if (
          err instanceof MnemoniaAuthError ||
          err instanceof MnemoniaForbiddenError ||
          err instanceof MnemoniaNotFoundError ||
          err instanceof MnemoniaConflictError ||
          err instanceof MnemoniaValidationError ||
          err instanceof MnemoniaRateLimitError
        ) {
          throw err;
        }
        if (isAbortError(err)) {
          throw new MnemoniaTimeoutError(url, this.config.timeout);
        }
        if (err instanceof MnemoniaServerError && attempt >= maxAttempts) {
          throw err;
        }
        if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
          lastError = err;
          if (attempt >= maxAttempts) {
            throw new MnemoniaConnectionError(url, err);
          }
          continue;
        }
        lastError = err as Error;
        if (attempt >= maxAttempts) break;
      }
    }

    throw new MnemoniaConnectionError(url, lastError);
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const base = this.baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${base}${normalizedPath}`;
    if (!query) return url;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, String(v));
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private async mapHttpError(response: Response): Promise<Error> {
    const detail = await this.extractErrorMessage(response);
    switch (response.status) {
      case 400:
      case 422:
        return new MnemoniaValidationError(detail);
      case 401:
        return new MnemoniaAuthError(detail);
      case 403:
        return new MnemoniaForbiddenError(detail);
      case 404:
        return new MnemoniaNotFoundError("Resource", detail);
      case 409:
        return new MnemoniaConflictError(detail);
      case 429: {
        const retryAfter = response.headers.get("retry-after");
        const secs = retryAfter ? parseInt(retryAfter, 10) : undefined;
        return new MnemoniaRateLimitError(Number.isFinite(secs!) ? secs : undefined);
      }
      default:
        return new MnemoniaServerError(response.status, detail);
    }
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    try {
      const text = await response.text();
      if (!text) return response.statusText || "unknown error";
      try {
        const json = JSON.parse(text) as ServerErrorBody;
        return json.error?.message || json.message || json.detail || text.substring(0, 500);
      } catch {
        return text.substring(0, 500);
      }
    } catch {
      return response.statusText || "unknown error";
    }
  }

  // ---------- Health / whoami ----------

  async healthCheck(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health/ready", undefined, { skipAuth: true });
  }

  async whoami(): Promise<WhoamiResponse> {
    return this.request<WhoamiResponse>("GET", "/api/v1/whoami");
  }

  // ---------- Palaces ----------

  async createPalace(req: CreatePalaceRequest): Promise<PalaceResponse> {
    return this.request("POST", "/api/v1/palaces", req);
  }

  async listPalaces(page?: PageRequest): Promise<Page<PalaceResponse>> {
    return this.request("GET", "/api/v1/palaces", undefined, {
      query: { limit: page?.limit, after: page?.after, before: page?.before },
    });
  }

  async getPalace(id: string): Promise<PalaceResponse> {
    return this.request("GET", `/api/v1/palaces/${encodeURIComponent(id)}`);
  }

  async updatePalace(id: string, req: UpdatePalaceRequest): Promise<PalaceResponse> {
    return this.request("PUT", `/api/v1/palaces/${encodeURIComponent(id)}`, req);
  }

  async deletePalace(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/v1/palaces/${encodeURIComponent(id)}`);
  }

  // ---------- Wings ----------

  async createWing(palaceId: string, req: CreateWingRequest): Promise<WingResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings`, req);
  }

  async listWings(palaceId: string, page?: PageRequest): Promise<Page<WingResponse>> {
    return this.request("GET", `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings`, undefined, {
      query: { limit: page?.limit, after: page?.after },
    });
  }

  async getWing(palaceId: string, id: string): Promise<WingResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(id)}`
    );
  }

  async updateWing(palaceId: string, id: string, req: UpdateWingRequest): Promise<WingResponse> {
    return this.request(
      "PUT",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(id)}`,
      req
    );
  }

  async deleteWing(palaceId: string, id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(id)}`
    );
  }

  // ---------- Rooms ----------

  async createRoom(
    palaceId: string,
    wingId: string,
    req: CreateRoomRequest
  ): Promise<RoomResponse> {
    return this.request(
      "POST",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(wingId)}/rooms`,
      req
    );
  }

  async listRooms(
    palaceId: string,
    wingId: string,
    page?: PageRequest
  ): Promise<Page<RoomResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(wingId)}/rooms`,
      undefined,
      { query: { limit: page?.limit, after: page?.after } }
    );
  }

  async getRoom(palaceId: string, wingId: string, id: string): Promise<RoomResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(
        wingId
      )}/rooms/${encodeURIComponent(id)}`
    );
  }

  async updateRoom(
    palaceId: string,
    wingId: string,
    id: string,
    req: UpdateRoomRequest
  ): Promise<RoomResponse> {
    return this.request(
      "PUT",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(
        wingId
      )}/rooms/${encodeURIComponent(id)}`,
      req
    );
  }

  async deleteRoom(palaceId: string, wingId: string, id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/wings/${encodeURIComponent(
        wingId
      )}/rooms/${encodeURIComponent(id)}`
    );
  }

  // ---------- Drawers ----------

  async createDrawer(palaceId: string, req: CreateDrawerRequest): Promise<DrawerResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/drawers`, req);
  }

  async listDrawers(palaceId: string, query?: DrawerListQuery): Promise<Page<DrawerResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/drawers`,
      undefined,
      {
        query: {
          wing: query?.wing,
          room: query?.room,
          limit: query?.limit,
          after: query?.after,
        },
      }
    );
  }

  async getDrawer(palaceId: string, id: string): Promise<DrawerResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/drawers/${encodeURIComponent(id)}`
    );
  }

  async deleteDrawer(palaceId: string, id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/drawers/${encodeURIComponent(id)}`
    );
  }

  // ---------- Search ----------

  async search(palaceId: string, req: SearchRequest): Promise<SearchResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/search`, req);
  }

  // ---------- Entities ----------

  async createEntity(palaceId: string, req: CreateEntityRequest): Promise<EntityResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/entities`, req);
  }

  async listEntities(palaceId: string, query?: EntityListQuery): Promise<Page<EntityResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/entities`,
      undefined,
      {
        query: {
          entity_type: query?.entity_type,
          limit: query?.limit,
          after: query?.after,
        },
      }
    );
  }

  async getEntity(palaceId: string, id: string): Promise<EntityResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/entities/${encodeURIComponent(id)}`
    );
  }

  async deleteEntity(palaceId: string, id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/entities/${encodeURIComponent(id)}`
    );
  }

  async getEntityTriples(palaceId: string, id: string): Promise<Page<TripleResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/entities/${encodeURIComponent(id)}/triples`
    );
  }

  async getEntityNeighborhood(
    palaceId: string,
    id: string,
    depth?: number
  ): Promise<NeighborhoodResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/entities/${encodeURIComponent(
        id
      )}/neighborhood`,
      undefined,
      { query: { depth } }
    );
  }

  // ---------- Triples ----------

  async createTriple(palaceId: string, req: CreateTripleRequest): Promise<TripleResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/triples`, req);
  }

  async listTriples(palaceId: string, query?: TripleListQuery): Promise<Page<TripleResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/triples`,
      undefined,
      {
        query: {
          subject: query?.subject,
          predicate: query?.predicate,
          object: query?.object,
          limit: query?.limit,
          after: query?.after,
        },
      }
    );
  }

  async deleteTriple(palaceId: string, id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/triples/${encodeURIComponent(id)}`
    );
  }

  // ---------- Graph traversal ----------

  async shortestPath(palaceId: string, req: ShortestPathRequest): Promise<PathResponse> {
    return this.request(
      "POST",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/graph/shortest-path`,
      req
    );
  }

  async timeline(
    palaceId: string,
    entity: string,
    query?: TimelineQuery
  ): Promise<TimelineResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/timeline/${encodeURIComponent(entity)}`,
      undefined,
      { query: { from: query?.from, to: query?.to, limit: query?.limit } }
    );
  }

  // ---------- Keywords ----------

  async assignKeyword(palaceId: string, req: AssignKeywordRequest): Promise<KeywordResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/keywords`, req);
  }

  async listKeywords(palaceId: string, page?: PageRequest): Promise<Page<KeywordResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/keywords`,
      undefined,
      { query: { limit: page?.limit, after: page?.after } }
    );
  }

  async resolveKeyword(palaceId: string, word: string): Promise<KeywordResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/keywords/${encodeURIComponent(word)}`
    );
  }

  async searchKeywords(
    palaceId: string,
    pattern: string,
    limit?: number
  ): Promise<Page<KeywordResponse>> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/keywords/search`, {
      pattern,
      limit,
    });
  }

  async deleteKeyword(palaceId: string, word: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/keywords/${encodeURIComponent(word)}`
    );
  }

  // ---------- Files ----------

  async presignUpload(palaceId: string, req: UploadRequest): Promise<PresignedUploadResponse> {
    return this.request(
      "POST",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/files/upload`,
      req
    );
  }

  async presignDownload(
    palaceId: string,
    req: DownloadRequest
  ): Promise<PresignedDownloadResponse> {
    return this.request(
      "POST",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/files/download`,
      req
    );
  }

  async deleteFile(palaceId: string, key: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/files/${encodeURIComponent(key)}`
    );
  }

  async uploadToPresigned(
    url: string,
    data: Uint8Array,
    contentType: string,
    extraHeaders?: Record<string, string>
  ): Promise<void> {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": contentType, ...(extraHeaders || {}) },
      body: data as unknown as BodyInit,
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (!response.ok) {
      throw new MnemoniaServerError(response.status, await response.text());
    }
  }

  async downloadFromPresigned(url: string): Promise<Uint8Array> {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (!response.ok) {
      throw new MnemoniaServerError(response.status, await response.text());
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  // ---------- Ingestion ----------

  async startIngest(palaceId: string, req: IngestRequest): Promise<IngestJobResponse> {
    return this.request("POST", `/api/v1/palaces/${encodeURIComponent(palaceId)}/ingest`, req);
  }

  async getIngestStatus(palaceId: string, jobId: string): Promise<IngestJobResponse> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/ingest/${encodeURIComponent(jobId)}`
    );
  }

  async listIngestJobs(palaceId: string, limit?: number): Promise<Page<IngestJobResponse>> {
    return this.request(
      "GET",
      `/api/v1/palaces/${encodeURIComponent(palaceId)}/ingest`,
      undefined,
      { query: { limit } }
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  return false;
}
