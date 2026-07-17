const KOIOS_BASE = "https://api.koios.rest/api/v1";
const BODY_LIMIT = 32_768;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

export function requireMethod(request, method) {
  if (request.method !== method) {
    throw new ApiError(405, `Method ${request.method || "UNKNOWN"} is not allowed.`);
  }
}

export async function readJsonBody(request) {
  const declaredLength = Number(request.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) {
    throw new ApiError(413, `Request body exceeds ${BODY_LIMIT} bytes.`);
  }

  if (request.body !== undefined) {
    const serialized = typeof request.body === "string" || Buffer.isBuffer(request.body)
      ? request.body.toString()
      : JSON.stringify(request.body);
    if (Buffer.byteLength(serialized) > BODY_LIMIT) throw new ApiError(413, `Request body exceeds ${BODY_LIMIT} bytes.`);
    try {
      return typeof request.body === "object" && !Buffer.isBuffer(request.body)
        ? request.body
        : JSON.parse(serialized);
    } catch (_error) {
      throw new ApiError(400, "Request body is not valid JSON.");
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ApiError(413, `Request body exceeds ${BODY_LIMIT} bytes.`);
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError(400, "Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    throw new ApiError(400, "Request body is not valid JSON.");
  }
}

export async function koiosJson(path, { body, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`${KOIOS_BASE}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "multi-proposal-voter/1.0",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Koios returned HTTP ${response.status}.`);
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const detail = error?.name === "AbortError" ? "request timed out" : error?.message || "request failed";
    throw new ApiError(502, `Koios query failed: ${detail}.`);
  } finally {
    clearTimeout(timeout);
  }
}

export function handleError(response, error) {
  const status = error instanceof ApiError ? error.status : 500;
  const message = error instanceof ApiError ? error.message : "Internal server error.";
  sendJson(response, status, { error: message });
}
