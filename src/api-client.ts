/**
 * API client for Cursor Cloud Agents API v1
 * @see https://cursor.com/docs/cloud-agent/api/endpoints
 */

import { logger } from "./logger.js";
import { ApiError, TimeoutError } from "./errors.js";

const API_BASE_URL = "https://api.cursor.com";
const DEFAULT_TIMEOUT_MS = 30000;
/** List repositories can take tens of seconds for large accounts. */
const REPOSITORIES_TIMEOUT_MS = 120000;

/**
 * Make an API request to the Cursor Cloud Agents API
 */
export async function apiRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY environment variable is required");
  }

  const url = `${API_BASE_URL}${path}`;
  const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const options: RequestInit = {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    logger.debug("Making API request", { method, path });

    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorText: string;
      try {
        errorText = await response.text();
      } catch {
        errorText = "Unable to read error response";
      }

      const error = new ApiError(
        `API error ${response.status}: ${errorText}`,
        response.status
      );
      logger.error("API request failed", error, {
        method,
        path,
        status: response.status,
      });
      throw error;
    }

    // Some endpoints (e.g. DELETE) may return empty bodies
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    const data = JSON.parse(text) as T;
    logger.debug("API request successful", { method, path });
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof ApiError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new TimeoutError(
        `Request timeout after ${timeoutMs}ms`,
        timeoutMs
      );
      logger.error("API request timeout", timeoutError, { method, path });
      throw timeoutError;
    }
    logger.error("API request error", error, { method, path });
    throw error;
  }
}

export function repositoriesTimeout(): number {
  return REPOSITORIES_TIMEOUT_MS;
}
