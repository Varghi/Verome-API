/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 * Fully Optimized with HTTP 307 Client Proxy Redirect (Anti-502/403)
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import { fetchFromPiped, fetchFromInvidious } from "../services/streaming.ts";
import type { YTMusic } from "../services/ytmusic.ts";

// 1. Inisialisasi Deno KV secara dinamis dengan safe check
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
        console.log(`⚡ [Cache Hit] Mengembalikan data stream ID: ${id} dari Deno KV.`);
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
        console.log(`💾 [Cache Stored] Data stream dari Piped disimpan ke Deno KV.`);
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
        console.log(`💾 [Cache Stored] Data stream dari Invidious disimpan ke Deno KV.`);
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Referer": "https://www.youtube.com/",
      "Origin": "https://www.youtube.com",
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
      console.log("ℹ️ Stream di-abort oleh Flutter (Normal pada Range Request):", err.message);
    });

    return new Response(readable, { 
      status: response.status, 
      headers: responseHeaders 
    });

  } catch (err) {
    return new Response("Proxy error: " + String(err), { status: 502, headers: corsHeaders });
  }
}

export async function handleMusicFind(searchParams: URLSearchParams, ytmusic: YTMusic): Promise<Response> {
  const name = searchParams.get("name"), artist = searchParams.get("artist");
  if (!name || !artist) return error("Missing name and artist");

  const searchResults = await ytmusic.search(`${name} ${artist}`, "songs");
  if (!searchResults.results?.length) return json({ success: false, error: "Song not found" }, 404);

  const normalize = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const nName = normalize(name);
  const artistsList = artist.split(",").map(a => normalize(a));

  const match = searchResults.results.find((song: any) => {
    const nSongName = normalize(song.title || "");
    const songArtists = (song.artists || []).map((a: any) => normalize(a.name || ""));
    return (nSongName.includes(nName) || nName.includes(nSongName)) &&
      artistsList.some(a => songArtists.some((sa: string) => sa.includes(a) || a.includes(sa)));
  });

  return match ? json({ success: true, data: match }) : json({ success: false, error: "Song not found" }, 404);
}

/**
 * ========================================================
 * UTILITY: EKSTRAKSI MANIFEST STREAM DENGAN RESILIENT FALLBACK
 * ========================================================
 */
async function resolveUpstreamUrl(id: string): Promise<string> {
  // 1. Ambil manifes streaming lewat Piped Service
  try {
    const piped = await fetchFromPiped(id);
    if (piped.success && piped.streamingUrls?.length) {
      const audioStreams = piped.streamingUrls.filter((s: any) => s.type === "audio" || s.format === "M4A" || !s.quality);
      if (audioStreams.length > 0) return audioStreams[0].url;
      return piped.streamingUrls[0].url;
    }
  } catch (_err) {}

  // 2. Fallback jika Piped gagal, gunakan Invidious
  try {
    const invidious = await fetchFromInvidious(id);
    if (invidious.success && invidious.streamingUrls?.length) {
      return invidious.streamingUrls[0].url;
    }
  } catch (_err) {}

  throw new Error("Gagal mengamankan link streaming hulu dari seluruh instance.");
}

/**
 * ========================================================
 * FIX UTAMA: HANDLER STREAM RELAY VIA HTTP 307 REDIRECT
 * ========================================================
 * Alih-alih mendownload bita dari cloud Deno Deploy yang rawan diblokir IP-nya,
 * rute ini mengalihkan request ExoPlayer ke endpoint /api/proxy lokal dengan aman.
 */
export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  try {
    console.log(`🚀 [Relay Router] Menyusun rute proxy aman untuk videoId: ${id}`);
    
    // 1. Dapatkan tautan langsung googlevideo asli yang fresh
    const upstreamUrl = await resolveUpstreamUrl(id);
    
    // 2. Bangun URL redirect mengarah ke endpoint /api/proxy server Deno kamu sendiri
    const requestUrl = new URL(req.url);
    const proxyUrl = `${requestUrl.origin}/api/proxy?url=${encodeURIComponent(upstreamUrl)}`;

    console.log(`🎯 [Relay Redirect] Mengalihkan ExoPlayer menuju client proxy: ${proxyUrl.substring(0, 75)}...`);

    // 3. Kembalikan instruksi HTTP 307 Temporary Redirect.
    // Cara ini memaksa media player Flutter untuk melakukan streaming bita langsung lewat proxy 
    // menggunakan koneksi IP HP kamu yang bersih dari blokir YouTube CDN.
    return new Response(null, {
      status: 307,
      headers: {
        "Location": proxyUrl,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      }
    });

  } catch (err) {
    console.error(`❌ [Relay Fatal Error]: ${err.message}`);
    return new Response(`Relay internal failure: ${err.message}`, { 
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
}