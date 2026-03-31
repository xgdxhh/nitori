import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { Buffer } from "node:buffer";

const DEFAULT_TIMEOUT_SECONDS = 20;
const DEFAULT_MAX_RESULTS = 8;
const MAX_WEBFETCH_BYTES = 1 * 1024 * 1024;
const JINA_READER_URL = "https://r.jina.ai/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function createWebSearchTool(_ctx: ToolContext): Tool {
  return tool({
    title: "websearch",
    description: "Search the web using DuckDuckGo HTML endpoint.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      maxResults: z.number().optional().describe("Max results").default(DEFAULT_MAX_RESULTS),
      timeoutSeconds: z.number().optional().describe("Timeout in seconds").default(DEFAULT_TIMEOUT_SECONDS),
    }),
    execute: async ({ query, maxResults = DEFAULT_MAX_RESULTS, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }) => {
      if (!query?.trim()) return { error: "query is required" };

      try {
        const url = `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query }).toString()}`;
        const response = await fetchWithTimeout(
          url,
          { headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "text/html,application/xhtml+xml" } },
          timeoutSeconds,
        );

        if (!response.ok) {
          return { error: `websearch failed with HTTP ${response.status}` };
        }

        const html = await response.text();
        const results = parseDuckDuckGoHtml(html).slice(0, maxResults);
        const lines = results.length
          ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n")
          : "No results found.";

        return { query, count: results.length, results: lines };
      } catch (err) {
        return { error: `websearch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

export function createWebFetchTool(_ctx: ToolContext): Tool {
  return tool({
    title: "webfetch",
    description: "Fetch URL content through Jina Reader as markdown.",
    inputSchema: z.object({
      url: z.string().describe("URL to fetch"),
      timeoutSeconds: z.number().optional().describe("Timeout in seconds").default(DEFAULT_TIMEOUT_SECONDS),
    }),
    execute: async ({ url, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }) => {
      if (!url?.trim()) return { error: "url is required" };

      try {
        const normalizedUrl = normalizeUrl(url);
        const readerUrl = `${JINA_READER_URL}${normalizedUrl}`;
        const requestInit: RequestInit = {
          headers: {
            "x-respond-with": "markdown",
            "x-timeout": String(timeoutSeconds),
          },
        };

        const response = await fetchWithTimeout(readerUrl, requestInit, timeoutSeconds);

        if (!response.ok) {
          return { error: `webfetch failed with HTTP ${response.status}`, url: normalizedUrl };
        }

        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!isTextLikeContentType(contentType)) {
          return { error: `webfetch refused non-text content-type: ${contentType || "unknown"}`, url: normalizedUrl };
        }

        const contentLength = Number(response.headers.get("content-length") || 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_WEBFETCH_BYTES) {
          return { error: `webfetch refused oversized response: ${contentLength} bytes (limit is ${MAX_WEBFETCH_BYTES})`, url: normalizedUrl };
        }

        let body = await response.text();
        if (Buffer.byteLength(body, "utf-8") > MAX_WEBFETCH_BYTES) {
          body = body.slice(0, Math.floor(MAX_WEBFETCH_BYTES / 2)) + "\n...[truncated due to size]...";
        }

        return { url: normalizedUrl, readerUrl, status: response.status, content: body };
      } catch (err) {
        return { error: `webfetch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutSeconds: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timeout);
  }
}

function parseDuckDuckGoHtml(html: string): Array<{ title: string; url: string; snippet?: string }> {
  const titleMatches = Array.from(html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi));
  const snippets = Array.from(
    html.matchAll(/<(?:a|div)[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi),
  ).map((m) => normalizeWhitespace(decodeHtml(stripTags(m[1] || ""))));

  return titleMatches.map((m, i) => {
    const rawHref = decodeHtml(m[1] || "");
    const title = normalizeWhitespace(decodeHtml(stripTags(m[2] || "")));
    const snippet = snippets[i] || "";
    return {
      title: title || "(untitled)",
      url: unwrapDuckDuckGoHref(rawHref),
      snippet: snippet || undefined,
    };
  });
}

function unwrapDuckDuckGoHref(href: string): string {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return url.toString();
  } catch {
    return href;
  }
}

function normalizeUrl(raw: string): string {
  return new URL(raw).toString();
}

function isTextLikeContentType(contentType: string): boolean {
  if (!contentType) return true;
  return contentType.includes("text/")
    || contentType.includes("json")
    || contentType.includes("xml")
    || contentType.includes("javascript")
    || contentType.includes("x-www-form-urlencoded");
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, "");
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function normalizeWhitespace(value: string, keepNewlines = false): string {
  const normalized = value.replace(/\r/g, "");
  if (!keepNewlines) return normalized.replace(/\s+/g, " ").trim();
  return normalized
    .replace(/\t+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
