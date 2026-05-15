/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 * Hardened Architecture: Pure Streaming Piping via Resilient Fallback
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import { fetchFromPiped, fetchFromInvidious } from "../services/streaming.ts";
import type { YTMusic } from "../services/ytmusic.ts";

const kv = typeof (globalThis as any).Deno?.openKv === "function" 
  ? await (globalThis as any).Deno.openKv() 
  : null;

export async function handleStream(searchParams: URLSearchParams): Promise<Response> {
  const id = searchParams.get("id");
  if (!id) return error("Missing id");

  const cacheKey = ["stream_cache", id];

  try {
    if (kv) {
      const cachedResult = await kv.get(cacheKey);
      if (cachedResult.value) {
        console.log(`⚡ [Cache Hit] Memangkas latency stream ID: ${id}`);
        return json(cachedResult.value);
      }
    }

    console.log(`🐢 [Cache Miss] Mencari data streaming eksternal untuk ID: ${id}...`);

    const piped = await fetchFromPiped(id);
    if (piped.success) {
      const responseData = {
        success: true, service: "piped", instance: piped.instance,
        streamingUrls: piped.streamingUrls, metadata: piped.metadata,
        requestedId: id, timestamp: new Date().toISOString(),
      };

      if (kv) {
        await kv.set(cacheKey, responseData, { expireIn: 7200000 });
      }
      return json(responseData);
    }

    const invidious = await fetchFromInvidious(id);
    if (invidious.success) {
      const responseData = {
        success: true, service: "invidious", instance: invidious.instance,
        streamingUrls: invidious.streamingUrls, metadata: invidious.metadata,
        requestedId: id, timestamp: new Date().toISOString(),
      };

      if (kv) {
        await kv.set(cacheKey, responseData, { expireIn: 7200000 });
      }
      return json(responseData);
    }

  } catch (err) {
    console.error("❌ Deno KV Cache Error:", err);
  }

  return json({ success: false, error: "No streaming data found" }, 404);
}

export async function handleProxy(searchParams: URLSearchParams, req: Request): Promise<Response> {
  const audioUrl = searchParams.get("url");
  if (!audioUrl) return error("Missing url");

  try {
    const headers: Record<string, string> = {
      "User-Agent": "com.google.android.youtube/19.05.36 (Linux; U; Android 10; g-build) gzip",
      "Accept": "*/*",
      "Connection": "keep-alive",
    };
    
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) headers["Range"] = rangeHeader;

    const response = await fetch(audioUrl, { headers });
    if (!response.ok && response.status !== 206) {
      return new Response(`Failed: ${response.status}`, { status: 502, headers: corsHeaders });
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    responseHeaders.set("Cache-Control", "public, max-age=3600");
    responseHeaders.set("Content-Type", response.headers.get("Content-Type") || "audio/mp4");
    
    if (response.headers.get("Content-Length")) responseHeaders.set("Content-Length", response.headers.get("Content-Length")!);
    if (response.headers.get("Content-Range")) responseHeaders.set("Content-Range", response.headers.get("Content-Range")!);
    responseHeaders.set("Accept-Ranges", response.headers.get("Accept-Ranges") || "bytes");

    const { readable, writable } = new TransformStream();
    response.body?.pipeTo(writable).catch((err) => {
      console.log("ℹ " + err.message);
    });

    return new Response(readable, { status: response.status, headers: responseHeaders });
  } catch (err) {
    return new Response("Proxy error: " + String(err), { status: 502, headers: corsHeaders });
  }
}

async function resolveUpstreamUrl(id: string): Promise<string> {
  try {
    const piped = await fetchFromPiped(id);
    if (piped.success && piped.streamingUrls?.length) {
      const audioStreams = piped.streamingUrls.filter((s: any) => s.type === "audio" || s.format === "M4A" || !s.quality);
      if (audioStreams.length > 0) return audioStreams[0].url;
      return piped.streamingUrls[0].url;
    }
  } catch (_err) {}

  try {
    const invidious = await fetchFromInvidious(id);
    if (invidious.success && invidious.streamingUrls?.length) {
      return invidious.streamingUrls[0].url;
    }
  } catch (_err) {}

  throw new Error("Seluruh public instance (Piped/Invidious) gagal merespons.");
}

/**
 * REVISI FINAL: SPOOFING GOOGLE VIDEO CDN VIA ANDROID MOBILE CLIENT AGAR BYPASS 403
 */
export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  try {
    console.log(`🚀 [Relay] Menghubungkan bita stream untuk videoId: ${id}`);
    const upstreamUrl = await resolveUpstreamUrl(id);

    // KUNCI BYPASS: Menyamar murni menjadi paket aplikasi YouTube Android resmi
    const upstreamHeaders = new Headers({
      "User-Agent": "com.google.android.youtube/19.05.36 (Linux; U; Android 10; g-build) gzip",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": "19.05.36"
    });
    
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      upstreamHeaders.set("Range", rangeHeader);
    }

    const upstreamController = new AbortController();
    if ((req as any).signal) {
      (req as any).signal.addEventListener("abort", () => {
        upstreamController.abort();
      });
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method: "GET",
      headers: upstreamHeaders,
      signal: upstreamController.signal,
    });

    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      throw new Error(`CDN hulu menolak dengan status HTTP: ${upstreamResp.status}`);
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    
    const incomingContentType = upstreamResp.headers.get("Content-Type");
    responseHeaders.set(
      "Content-Type", 
      incomingContentType && incomingContentType.includes("audio") ? incomingContentType : "audio/mpeg"
    );
    
    if (upstreamResp.headers.get("Content-Length")) responseHeaders.set("Content-Length", upstreamResp.headers.get("Content-Length")!);
    if (upstreamResp.headers.get("Content-Range")) responseHeaders.set("Content-Range", upstreamResp.headers.get("Content-Range")!);
    responseHeaders.set("Accept-Ranges", upstreamResp.headers.get("Accept-Ranges") || "bytes");

    const { readable, writable } = new TransformStream();
    upstreamResp.body?.pipeTo(writable).catch((_err) => {});

    return new Response(readable, {
      status: upstreamResp.status,
      headers: responseHeaders,
    });

  } catch (err) {
    console.error(`❌ [Relay Fatal Error]: ${err.message}`);
    return new Response(`Relay internal failure: ${err.message}`, { 
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
}