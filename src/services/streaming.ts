/**
 * Streaming Service
 * Fetches audio stream URLs from Piped and Invidious instances
 * Fully Optimized for Deno Relay, Anti-403 & Fast Fallback (Anti-Timeout)
 */

let instancesCache: any = null;
let instancesCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000;

// List instance Piped pilihan yang terkenal berkecepatan tinggi
const PIPED_INSTANCES = [
  "https://pipedapi.lunar.icu",
  "https://api.piped.privacydev.net",
  "https://pipedapi.tokyo.privacydev.net",
  "https://api.piped.private.coffee",
  "https://pipedapi.darkness.services",
  "https://pipedapi.r4fo.com",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.leptons.xyz",
];

// List instance Invidious cadangan yang responsif
const INVIDIOUS_INSTANCES = [
  "https://invidious.nerdvpn.de",
  "https://invidious.flokinet.to",
  "https://inv.tux.digital",
  "https://yt.artemislena.eu",
  "https://y.com.sb",
];

async function getDynamicInstances() {
  const now = Date.now();
  if (instancesCache && (now - instancesCacheTime) < CACHE_DURATION) {
    return instancesCache;
  }

  try {
    const response = await fetch("https://raw.githubusercontent.com/n-ce/Uma/main/dynamic_instances.json", {
      signal: AbortSignal.timeout(3000) // Batasi fetch github max 3 detik
    });
    const data = await response.json();
    
    data.piped = [...new Set([...PIPED_INSTANCES, ...(data.piped || [])])];
    data.invidious = [...new Set([...INVIDIOUS_INSTANCES, ...(data.invidious || [])])];
    
    instancesCache = data;
    instancesCacheTime = now;
    return instancesCache;
  } catch {
    return {
      piped: PIPED_INSTANCES,
      invidious: INVIDIOUS_INSTANCES,
    };
  }
}

export async function fetchFromPiped(videoId: string) {
  const instances = await getDynamicInstances();
  const pipedInstances = instances.piped || PIPED_INSTANCES;

  for (const instance of pipedInstances) {
    try {
      // PERBAIKAN VITAL: Jika server tidak membalas dalam 2.5 detik, auto skip ke server berikutnya!
      const response = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" 
        },
        signal: AbortSignal.timeout(2500) 
      });
      
      if (!response.ok) continue;
      const data = await response.json();

      if (data?.error) continue;

      let audioStreams = data?.audioStreams || [];
      if (!audioStreams.length && data?.adaptiveFormats?.length) {
        audioStreams = data.adaptiveFormats.filter((f: any) => f.mimeType?.includes("audio"));
      }

      if (audioStreams.length) {
        const instanceUrl = new URL(instance);
        const proxyHost = instanceUrl.host.replace("pipedapi", "pipedproxy").replace("api.", "proxy.");

        console.log(`✅ [Service Piped Match] Berhasil memeras bita audio dari instance: ${instance}`);

        return {
          success: true,
          instance,
          streamingUrls: audioStreams.map((s: any) => ({
            url: s.url,
            quality: s.quality || "medium",
            mimeType: s.mimeType,
            bitrate: s.bitrate,
            proxyHost,
          })),
          metadata: {
            id: videoId,
            title: data.title || "Unknown Title",
            uploader: data.uploader || "Unknown Artist",
            thumbnail: data.thumbnailUrl || "",
            duration: data.duration || 0,
            views: data.views || 0,
          },
          hlsUrl: data.hls,
        };
      }
    } catch (_err) {
      // Timeout atau network error langsung ditangkap di sini dan loop berlanjut dengan cepat
      continue;
    }
  }

  return { success: false, error: "No working Piped instances found" };
}

export async function fetchFromInvidious(videoId: string) {
  const instances = await getDynamicInstances();
  const invidiousInstances = instances.invidious || INVIDIOUS_INSTANCES;

  for (const instance of invidiousInstances) {
    try {
      // PERBAIKAN VITAL: Beri timeout juga pada Invidious agar tidak memicu bottleneck waktu
      const response = await fetch(`${instance}/api/v1/videos/${videoId}?fields=title,author,adaptiveFormats,videoThumbnails,lengthSeconds,viewCount`, {
        signal: AbortSignal.timeout(2500)
      });
      if (!response.ok) continue;
      const data = await response.json();

      if (data && data.adaptiveFormats) {
        const audioFormats = data.adaptiveFormats.filter((f: any) =>
          f.type?.includes("audio") || f.mimeType?.includes("audio")
        );

        if (audioFormats.length) {
          console.log(`ℹ️ [Service Invidious Match] Memakai direct URL hulu dari instance: ${instance}`);
          
          return {
            success: true,
            instance,
            streamingUrls: audioFormats.map((f: any) => ({
              url: f.url, 
              directUrl: f.url,
              bitrate: f.bitrate,
              type: f.type || f.mimeType,
              audioQuality: f.audioQuality,
              itag: f.itag,
            })),
            metadata: {
              id: videoId,
              title: data.title,
              author: data.author,
              thumbnail: data.videoThumbnails?.[0]?.url || "",
              lengthSeconds: data.lengthSeconds,
              viewCount: data.viewCount,
            },
          };
        }
      }
    } catch (_err) {
      continue;
    }
  }

  return { success: false, error: "No working Invidious instances found" };
}