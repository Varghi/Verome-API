/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 * Ultra-Resilient Architecture: Direct Native Stream Extractor (Zero External API Dependency)
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import type { YTMusic } from "../services/ytmusic.ts";

export async function handleStream(searchParams: URLSearchParams): Promise<Response> {
  const id = searchParams.get("id");
  if (!id) return error("Missing id");
  return json({ success: true, message: "Use direct /play/:id route for streaming" });
}

export async function handleProxy(searchParams: URLSearchParams, req: Request): Promise<Response> {
  const audioUrl = searchParams.get("url");
  if (!audioUrl) return error("Missing url");
  return new Response("Redirected to native relay", { status: 302, headers: { "Location": audioUrl, ...corsHeaders } });
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
 * REVISI MANDIRI: Mengambil Manifes Audio Langsung Dari Innertube Tanpa Piped/Invidious
 */
export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  try {
    console.log(`🚀 [Relay Engine] Mengekstrak langsung manifest stream YouTube ID: ${id}`);
    
    // Hit langsung ke Innertube Android Client untuk mengekstrak manifes audio murni
    const innertubeUrl = "https://www.youtube.com/youtubei/v1/player";
    const payload = {
      videoId: id,
      context: {
        client: {
          clientName: "ANDROID_MUSIC",
          clientVersion: "6.41.51",
          hl: "en",
          gl: "US",
          utcOffsetMinutes: 0
        }
      }
    };

    const ytResponse = await fetch(innertubeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!ytResponse.ok) {
      throw new Error(`YouTube Innertube melempar eror HTTP status: ${ytResponse.status}`);
    }

    const playerData = await ytResponse.json();
    const streamingData = playerData.streamingData;
    
    if (!streamingData || !streamingData.adaptiveFormats) {
      throw new Error("Gagal mengekstrak streamingData atau formats dari YouTube.");
    }

    // Filter format audio saja (M4A / OPUS)
    const audioFormats = streamingData.adaptiveFormats.filter((f: any) => 
      f.mimeType && f.mimeType.includes("audio")
    );

    if (!audioFormats.length) {
      throw new Error("Tidak ada format audio adaptif yang tersedia untuk lagu ini.");
    }

    // Ambil format pertama (biasanya bitrate terbaik yang stabil)
    const targetStream = audioFormats[0];
    const upstreamUrl = targetStream.url;

    if (!upstreamUrl) {
      throw new Error("URL bita hulu kosong atau terenkripsi signature cipher.");
    }

    // Siapkan request streaming pipe ke Google Video CDN dengan header resmi mobile player
    const upstreamHeaders = new Headers({
      "User-Agent": "com.google.android.youtube/19.05.36 (Linux; U; Android 10; g-build) gzip",
      "Accept": "*/*",
      "Connection": "keep-alive"
    });
    
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      upstreamHeaders.set("Range", rangeHeader);
    }

    const upstreamResp = await fetch(upstreamUrl, {
      method: "GET",
      headers: upstreamHeaders
    });

    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      throw new Error(`Google Video CDN menolak streaming bita dengan status: ${upstreamResp.status}`);
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

  } catch (err: any) {
    console.error(`❌ [Relay Fatal Error]: ${err.message}`);
    return new Response(`Relay internal failure: ${err.message}`, { 
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
}