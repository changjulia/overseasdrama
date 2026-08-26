const DEFAULT_BASE_URL = "http://121.41.8.142:3000/api/open/v1";
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [2000, 4000, 8000];

export type ExternalApiEnvelope<T> = {
  code: number;
  message: string;
  data: T | null;
};

export type MonthlyRankingItem = {
  ranking: number;
  playletId: number;
  playletName: string;
  coverOss: string;
  materialCnt: number;
  releaseDay: number;
  isNewPlaylet: boolean;
  isUnifiedPlaylet: boolean;
  playletTags: string[];
  countryDis: Array<Record<string, unknown>>;
  productDis: Array<Record<string, unknown>>;
  childRelateList: Array<Record<string, unknown>>;
};

export type MonthlyRankingData = {
  month: string;
  data_source: "dataeye_realtime";
  queried_at: string;
  items: MonthlyRankingItem[];
};

export type PlaybackData = {
  query_name: string;
  expires_in: number;
  expires_at: string;
  items: Array<{
    platform: string;
    source_id: string;
    name: string;
    total_episodes: number;
    episodes: Array<{ episode: number; url: string; type: "mp4" }>;
  }>;
};

export type MaterialQuery = {
  drama_name: string;
  country_id?: 1 | 13 | 24;
  start_date?: string;
  end_date?: string;
  page?: number;
  page_size?: number;
};

export type MaterialQueryData = {
  query: { drama_name: string; country_id: number | null };
  queried_at: string;
  upstream: {
    statusCode: number;
    msg: string;
    page: { pageId: number; pageSize: number; totalRecords: number };
    content: {
      creativeNum: number;
      duplicationNum: number;
      totalRecord: number;
      searchList: Array<Record<string, unknown>>;
    };
  };
};

export class ExternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number,
    readonly data: unknown,
    readonly requestId: string,
  ) {
    super(message);
    this.name = "ExternalApiError";
  }
}

function configuration() {
  const apiKey = process.env.EXTERNAL_OPEN_API_KEY?.trim();
  if (!apiKey) {
    throw new ExternalApiError(
      "服务端未配置 EXTERNAL_OPEN_API_KEY",
      503,
      5002,
      null,
      crypto.randomUUID(),
    );
  }
  return {
    apiKey,
    baseUrl: (process.env.EXTERNAL_OPEN_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  requestId: string = crypto.randomUUID(),
): Promise<ExternalApiEnvelope<T>> {
  const { apiKey, baseUrl } = configuration();

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(70_000),
        headers: {
          Accept: "application/json",
          "X-API-Key": apiKey,
          "X-Request-Id": requestId,
          ...init.headers,
        },
      });
    } catch (error) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new ExternalApiError(
        error instanceof Error ? `外部数据接口连接失败：${error.message}` : "外部数据接口连接失败",
        504,
        3002,
        null,
        requestId,
      );
    }

    let payload: ExternalApiEnvelope<T>;
    try {
      payload = (await response.json()) as ExternalApiEnvelope<T>;
    } catch {
      throw new ExternalApiError("外部数据接口返回了无效 JSON", 502, 3001, null, requestId);
    }

    if (response.ok && payload.code === 0) return payload;
    if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new ExternalApiError(
      payload.message || `外部数据接口请求失败（HTTP ${response.status}）`,
      response.status,
      Number.isInteger(payload.code) ? payload.code : 3001,
      payload.data,
      requestId,
    );
  }
}

export function getMonthlyRankings(month?: string, requestId?: string) {
  const query = month ? `?month=${encodeURIComponent(month)}` : "";
  return request<MonthlyRankingData>(`/rankings/dramas/monthly${query}`, {}, requestId);
}

export function getDramaPlayback(name: string, requestId?: string) {
  return request<PlaybackData>(`/dramas/playback?name=${encodeURIComponent(name)}`, {}, requestId);
}

export function queryAdxMaterials(query: MaterialQuery, requestId?: string) {
  return request<MaterialQueryData>(
    "/adx/materials/query",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(query),
    },
    requestId,
  );
}

export function externalApiErrorResponse(error: unknown) {
  if (error instanceof ExternalApiError) {
    return Response.json(
      { code: error.code, message: error.message, data: error.data, request_id: error.requestId },
      { status: error.status, headers: { "Cache-Control": "no-store", "X-Request-Id": error.requestId } },
    );
  }
  const requestId = crypto.randomUUID();
  return Response.json(
    { code: 5002, message: "外部数据服务暂不可用", data: null, request_id: requestId },
    { status: 503, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
  );
}

export function successResponse<T>(payload: ExternalApiEnvelope<T>, requestId: string) {
  return Response.json(payload, {
    status: 200,
    headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
  });
}
