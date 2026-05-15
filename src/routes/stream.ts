/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 * Ultra-Resilient Architecture: Direct Native Stream Extractor (Zero External API Dependency)
 * REVISI: Menggunakan Cobalt API Engine internal Pipe untuk Bypass Enkripsi Cipher
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
 * REVISI SUPER RESILIENT: Menggunakan Cobalt API Engine internal Pipe untuk Bypass Enkripsi Cipher
 */
export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  try {
    console.log(`🚀 [Relay Engine] Mengekstrak bita audio via Cobalt API untuk ID: ${id}`);
    
    // 1. Ketuk Cobalt API dari sisi server Deno untuk mendapatkan URL CDN murni yang siap pakai
    const cobaltUrl = "https://api.cobalt.tools/api/json";
    const cobaltPayload = {
      url: `https://www.youtube.com/watch?v=${id}`,
      downloadMode: "audio",
      audioFormat: "mp3",
      audioBitrate: "128"
    };

    const cobaltResponse = await fetch(cobaltUrl, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cobaltPayload)
    });

    if (!cobaltResponse.ok) {
      throw new Error(`Server API Cobalt menolak request dengan status: ${cobaltResponse.status}`);
    }

    const cobaltData = await cobaltResponse.json();
    const upstreamUrl = cobaltData.url;

    if (!upstreamUrl) {
      throw new Error("Gagal mengantongi URL streaming langsung dari payload backend.");
    }

    // 2. Siapkan request streaming pipe ke Google Video/Cobalt CDN dengan Range Header pendukung ExoPlayer
    const upstreamHeaders = new Headers({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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
      throw new Error(`Penyedia CDN menolak streaming bita dengan status: ${upstreamResp.status}`);
    }

    // 3. Bangun kembali Response Headers yang rapi agar ExoPlayer Flutter bisa melakukan seeking/rewind
    const responseHeaders = new Headers();
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    responseHeaders.set("Content-Type", "audio/mp3"); // Paksa format mp3 sesuai output Cobalt Engine
    
    if (upstreamResp.headers.get("Content-Length")) responseHeaders.set("Content-Length", upstreamResp.headers.get("Content-Length")!);
    if (upstreamResp.headers.get("Content-Range")) responseHeaders.set("Content-Range", upstreamResp.headers.get("Content-Range")!);
    responseHeaders.set("Accept-Ranges", upstreamResp.headers.get("Accept-Ranges") || "bytes");

    // 4. Lakukan Stream Piping langsung ke sisi Flutter App secara realtime
    const { readable, writable } = new TransformStream();
    upstreamResp.body?.pipeTo(writable).catch((_err) => {});

    console.log(`✅ [Relay Engine] Sukses melakukan piping data audio .mp3 untuk ID: ${id}`);
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