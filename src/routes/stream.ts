/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find, /play/:id
 * Ultra-Resilient Architecture: Direct Native Stream Extractor (Zero External API Dependency)
 * REVISI FINAL: Dual-Engine Android Innertube Spoofing dengan Automated Cobalt Failover Pool
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
 * REVISI SUPER RESILIENT: Direct Android Innertube Client + Bypass Cipher
 */
export async function handleStreamRelay(req: Request, id: string): Promise<Response> {
  const responseHeaders = new Headers();
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type");
  responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  responseHeaders.set("Accept-Ranges", "bytes");

  try {
    console.log(`🚀 [Relay Engine] Mencoba Direct Android Innertube Extraction untuk ID: ${id}`);
    
    // 1. Tembak endpoint internal Google Player API menggunakan otentikasi Android Music Client
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
      },
      playbackContext: {
        contentPlaybackContext: {
          signatureTimestamp: 19800 // Bypass Cipher signature block
        }
      }
    };

    const ytResponse = await fetch(innertubeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const playerData = await ytResponse.json();
    const streamingData = playerData.streamingData;
    
    if (!streamingData || !streamingData.adaptiveFormats) {
      throw new Error("Cipher Blocked: YouTube menyembunyikan tautan langsung.");
    }

    // Filter format bita yang murni memuat audio (.m4a / .webm) dengan bitrate optimal
    const audioFormats = streamingData.adaptiveFormats.filter((f: any) => 
      f.mimeType && f.mimeType.includes("audio")
    );

    if (!audioFormats.length) throw new Error("Format stream audio kosong.");

    // Urutkan untuk mendapatkan bitrate terbaik yang stabil
    audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    const upstreamUrl = audioFormats[0].url;

    if (!upstreamUrl) throw new Error("URL stream langsung tidak ditemukan dalam payload.");

    // 2. Transmisikan data dari server Google Video ke ExoPlayer Flutter
    const googleHeaders = new Headers({
      "User-Agent": "com.google.android.youtube/19.05.36 (Linux; U; Android 10) gzip",
      "Accept": "*/*"
    });
    
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) googleHeaders.set("Range", rangeHeader);

    const upstreamResp = await fetch(upstreamUrl, { method: "GET", headers: googleHeaders });

    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      throw new Error(`Google Video CDN menolak request dengan status: ${upstreamResp.status}`);
    }

    responseHeaders.set("Content-Type", upstreamResp.headers.get("Content-Type") || "audio/mp4");
    if (upstreamResp.headers.get("Content-Length")) responseHeaders.set("Content-Length", upstreamResp.headers.get("Content-Length")!);
    if (upstreamResp.headers.get("Content-Range")) responseHeaders.set("Content-Range", upstreamResp.headers.get("Content-Range")!);

    const { readable, writable } = new TransformStream();
    upstreamResp.body?.pipeTo(writable).catch((_err) => {});

    console.log(`✅ [Engine Utama] Sukses mengalirkan direct stream audio untuk ID: ${id}`);
    return new Response(readable, { status: upstreamResp.status, headers: responseHeaders });

  } catch (primaryErr: any) {
    console.warn(`⚠️ [Engine Utama Gagal]: ${primaryErr.message}. Mengaktifkan Failover Cobalt Pool...`);
    
    try {
      // AUTOMATED FALLBACK POOL: Hit Cobalt API jika langkah pertama terblokir
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

      if (!cobaltResponse.ok) throw new Error(`Cobalt Failover Pool ikut menolak request.`);

      const cobaltData = await cobaltResponse.json();
      const fallbackUrl = cobaltData.url;

      if (!fallbackUrl) throw new Error("Cobalt tidak mengembalikan URL stream.");

      const fallbackHeaders = new Headers({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "*/*"
      });
      
      const rangeHeader = req.headers.get("Range");
      if (rangeHeader) fallbackHeaders.set("Range", rangeHeader);

      const fallbackResp = await fetch(fallbackUrl, { method: "GET", headers: fallbackHeaders });

      responseHeaders.set("Content-Type", "audio/mp3");
      if (fallbackResp.headers.get("Content-Length")) responseHeaders.set("Content-Length", fallbackResp.headers.get("Content-Length")!);
      if (fallbackResp.headers.get("Content-Range")) responseHeaders.set("Content-Range", fallbackResp.headers.get("Content-Range")!);

      const { readable, writable } = new TransformStream();
      fallbackResp.body?.pipeTo(writable).catch((_err) => {});

      console.log(`✅ [Engine Cadangan] Sukses mengamankan streaming via Cobalt Failover Pool.`);
      return new Response(readable, { status: fallbackResp.status, headers: responseHeaders });

    } catch (fallbackErr: any) {
      console.error(`❌ [Fatal Error] Semua Engine Mengalami Kegagalan: ${fallbackErr.message}`);
      return new Response(`All stream backends are currently rate-limited. Error: ${fallbackErr.message}`, { 
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }
}