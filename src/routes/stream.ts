/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import { fetchFromPiped, fetchFromInvidious } from "../services/streaming.ts";
import type { YTMusic } from "../services/ytmusic.ts";

// 1. Inisialisasi Deno KV secara dinamis dengan safe check agar tidak crash jika flag '--unstable-kv' belum aktif
const kv = typeof (globalThis as any).Deno?.openKv === "function" 
  ? await (globalThis as any).Deno.openKv() 
  : null;

export async function handleStream(searchParams: URLSearchParams): Promise<Response> {
  const id = searchParams.get("id");
  if (!id) return error("Missing id");

  // Format Key di Deno KV: ["stream_cache", "ID_LAGU"]
  const cacheKey = ["stream_cache", id];

  try {
    // 2. Cek apakah data streaming ada di Cache Deno KV (Hanya dijalankan jika objek kv tersedia)
    if (kv) {
      const cachedResult = await kv.get(cacheKey);
      if (cachedResult.value) {
        console.log(`⚡ [Cache Hit] Memangkas latency! Mengembalikan data stream ID: ${id} dari Deno KV.`);
        return json(cachedResult.value);
      }
    }

    console.log(`🐢 [Cache Miss] Mencari data streaming eksternal untuk ID: ${id}...`);

    // 3. Jika tidak ada di cache, coba ambil dari Piped Service
    const piped = await fetchFromPiped(id);
    if (piped.success) {
      const responseData = {
        success: true, service: "piped", instance: piped.instance,
        streamingUrls: piped.streamingUrls, metadata: piped.metadata,
        requestedId: id, timestamp: new Date().toISOString(),
      };

      // Simpan ke Deno KV selama 2 jam jika objek kv aktif
      if (kv) {
        await kv.set(cacheKey, responseData, { expireIn: 7200000 });
        console.log(`💾 [Cache Stored] Data stream dari Piped berhasil disimpan ke Deno KV.`);
      }
      
      return json(responseData);
    }

    // 4. Jika Piped gagal, coba ambil dari Invidious Service
    const invidious = await fetchFromInvidious(id);
    if (invidious.success) {
      const responseData = {
        success: true, service: "invidious", instance: invidious.instance,
        streamingUrls: invidious.streamingUrls, metadata: invidious.metadata,
        requestedId: id, timestamp: new Date().toISOString(),
      };

      // Simpan ke Deno KV selama 2 jam jika objek kv aktif
      if (kv) {
        await kv.set(cacheKey, responseData, { expireIn: 7200000 });
        console.log(`💾 [Cache Stored] Data stream dari Invidious berhasil disimpan ke Deno KV.`);
      }
      
      return json(responseData);
    }

  } catch (err) {
    console.error("❌ Deno KV Cache Error:", err);
    // Jalankan fallback: Abaikan cache jika terjadi error internal, langsung tembak eksternal
  }

  return json({ success: false, error: "No streaming data found" }, 404);
}

export async function handleProxy(searchParams: URLSearchParams, req: Request): Promise<Response> {
  const audioUrl = searchParams.get("url");
  if (!audioUrl) return error("Missing url");

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

    // SOLUSI AMAN: Gunakan TransformStream untuk mem-pipe data secara asinkron.
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
 * ==========================================
 * TAMBAHAN REVISI: STREAM RELAY (ANTI-403)
 * ==========================================
 * Fungsi ini bertindak sebagai jembatan (pipe) yang menarik bytes data dari CDN
 * menggunakan IP Server Deno, sehingga melewati pembatasan IP-Lock perangkat HP.
 */
async function resolveUpstreamUrl(id: string): Promise<string> {
  // Coba ambil manifest dari cache Deno KV dulu lewat format extractor internal kamu
  if (kv) {
    const cached = await kv.get(["stream_cache", id]);
    if (cached.value && (cached.value as any).streamingUrls?.length) {
      return (cached.value as any).streamingUrls[0].url;
    }
  }

  // Jika cache miss, panggil Piped Service
  const piped = await fetchFromPiped(id);
  if (piped.success && piped.streamingUrls?.length) {
    return piped.streamingUrls[0].url;
  }

  // Fallback terakhir ke Invidious Service
  const invidious = await fetchFromInvidious(id);
  if (invidious.success && invidious.streamingUrls?.length) {
    return invidious.streamingUrls[0].url;
  }

  throw new Error("Tidak ada link streaming hulu yang tersedia");
}

export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  try {
    console.log(`🚀 [Relay] Menghubungkan pipe stream untuk videoId: ${id}`);
    
    // 1. Dapatkan link googlevideo asli yang fresh
    const upstreamUrl = await resolveUpstreamUrl(id);

    // 2. Salin header 'Range' dari Flutter jika ada (Penting untuk seek posisi lagu)
    const upstreamHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "*/*",
      "Referer": "https://www.youtube.com/",
      "Origin": "https://www.youtube.com",
    });
    
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      upstreamHeaders.set("Range", rangeHeader);
    }

    // 3. Pasang AbortController agar jika koneksi client mati, Deno tidak membazirkan bandwidth download ke hulu
    const upstreamController = new AbortController();
    const clientSignal = (req as any).signal;
    if (clientSignal) {
      clientSignal.addEventListener("abort", () => {
        upstreamController.abort();
      });
    }

    // 4. Request streaming bytes data ke target CDN
    const upstreamResp = await fetch(upstreamUrl, {
      method: "GET",
      headers: upstreamHeaders,
      signal: upstreamController.signal,
    });

    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      console.error(`❌ [Relay] Upstream menolak dengan status HTTP: ${upstreamResp.status}`);
      return new Response(`Upstream rejected: ${upstreamResp.status}`, { status: 502 });
    }

    // 5. Susun Header respons balik ke Flutter dengan mengizinkan CORS penuh
    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    responseHeaders.set("Content-Type", upstreamResp.headers.get("Content-Type") || "audio/webm");
    
    if (upstreamResp.headers.get("Content-Length")) responseHeaders.set("Content-Length", upstreamResp.headers.get("Content-Length")!);
    if (upstreamResp.headers.get("Content-Range")) responseHeaders.set("Content-Range", upstreamResp.headers.get("Content-Range")!);
    responseHeaders.set("Accept-Ranges", upstreamResp.headers.get("Accept-Ranges") || "bytes");

    // 6. Alirkan bita data (Piping Body) secara real-time via TransformStream agar aman dari unhandled exception
    const { readable, writable } = new TransformStream();
    upstreamResp.body?.pipeTo(writable).catch((err) => {
      console.log("ℹ️ [Relay] Stream diputus oleh media player di Flutter (Normal). Messsage:", err.message);
    });

    return new Response(readable, {
      status: upstreamResp.status, // Otomatis mengirim kode status 200 atau 206 dari upstream
      headers: responseHeaders,
    });

  } catch (err) {
    console.error(`❌ [Relay Fatal Error]: ${err}`);
    return new Response("Relay internal failure", { status: 502 });
  }
}