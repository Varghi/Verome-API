/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 * Dedicated Architecture: Independent YTMusic Resolver (Bypass Piped/Invidious)
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import type { YTMusic } from "../services/ytmusic.ts";

const kv = typeof (globalThis as any).Deno?.openKv === "function" 
  ? await (globalThis as any).Deno.openKv() 
  : null;

// Menggunakan YTMusic instance secara global untuk resolve streaming
let globalYtMusic: YTMusic | null = null;

export function injectYtMusic(ytmusicInstance: YTMusic) {
  globalYtMusic = ytmusicInstance;
}

export async function handleStream(searchParams: URLSearchParams): Promise<Response> {
  const id = searchParams.get("id");
  if (!id) return error("Missing id");

  const cacheKey = ["stream_cache", id];

  try {
    if (kv) {
      const cachedResult = await kv.get(cacheKey);
      if (cachedResult.value) {
        console.log(`⚡ [Cache Hit] Stream ID: ${id}`);
        return json(cachedResult.value);
      }
    }

    if (!globalYtMusic) {
      return error("YTMusic service not initialized in stream route", 500);
    }

    console.log(`🐢 [Direct Fetch] Mengambil manifest streaming dari YTMusic untuk ID: ${id}`);
    
    // Ambil detail format langsung dari core scraper backend lo
    const streamingData = await globalYtMusic.getStreamingData(id);
    
    if (streamingData && streamingData.adaptiveFormats) {
      const audioStreams = streamingData.adaptiveFormats.filter((f: any) => 
        f.mimeType?.includes("audio")
      );

      if (audioStreams.length) {
        const responseData = {
          success: true,
          service: "ytmusic_direct",
          streamingUrls: audioStreams.map((s: any) => ({
            url: s.url,
            quality: s.audioQuality || "medium",
            mimeType: s.mimeType,
            bitrate: s.bitrate,
          })),
          metadata: { id }
        };

        if (kv) {
          await kv.set(cacheKey, responseData, { expireIn: 7200000 });
        }
        return json(responseData);
      }
    }

  } catch (err) {
    console.error("❌ Stream Data Fetch Error:", err);
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
      "Referer": "https://music.youtube.com/",
      "Origin": "https://music.youtube.com",
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
      console.log("ℹ️ Proxy Stream di-abort:", err.message);
    });

    return new Response(readable, { status: response.status, headers: responseHeaders });
  } catch (err) {
    return new Response("Proxy error: " + String(err), { status: 502, headers: corsHeaders });
  }
}

export async function handleMusicFind(searchParams: URLSearchParams, ytmusic: YTMusic): Promise<Response> {
  // Pastikan globalYtMusic terisi saat endpoint ini dipanggil
  if (!globalYtMusic) globalYtMusic = ytmusic;

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
 * HANDLER STREAM RELAY (PIPING PROXY DENGAN YT MUSIC RESOLVER)
 */
export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  try {
    console.log(`🚀 [Relay Engine] Meminta direct stream untuk videoId: ${id}`);
    
    if (!globalYtMusic) {
      throw new Error("YTMusic instance belum terinisialisasi.");
    }

    const streamingData = await globalYtMusic.getStreamingData(id);
    if (!streamingData || !streamingData.adaptiveFormats) {
      throw new Error("Format adaptif tidak ditemukan pada manifest YouTube.");
    }

    const audioStreams = streamingData.adaptiveFormats.filter((f: any) => f.mimeType?.includes("audio"));
    if (!audioStreams.length) {
      throw new Error("Tidak ada stream audio yang tersedia.");
    }

    // Pilih stream audio dengan bitrate terbaik atau indeks pertama
    const upstreamUrl = audioStreams[0].url;

    const upstreamHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://music.youtube.com/",
      "Origin": "https://music.youtube.com",
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
      return new Response(`Upstream rejected: ${upstreamResp.status}`, { status: 502 });
    }

    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    
    const incomingContentType = upstreamResp.headers.get("Content-Type");
    responseHeaders.set(
      "Content-Type", 
      incomingContentType && incomingContentType.includes("audio") ? incomingContentType : "audio/mp4"
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