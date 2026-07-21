const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.set("trust proxy", true);
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Ayarlar (Railway'de "Variables" sekmesinden ekleyeceksiniz) ---
const APP_KEY = process.env.HIK_APP_KEY;
const APP_SECRET = process.env.HIK_APP_SECRET;

// Ilk token istegi icin bolge sunucu adresi (Turkiye -> Europe).
// Diger bolgeler: Rusya https://hikcentralconnectru.com
//                 Singapur/Hindistan https://isgp.hikcentralconnect.com
//                 Guney Amerika https://isa.hikcentralconnect.com
//                 Kuzey Amerika https://ius.hikcentralconnect.com
const INITIAL_SERVER = process.env.HIK_INITIAL_SERVER || "https://ieu.hikcentralconnect.com";

// Token ve bolge adresi bellekte tutulur, suresi dolunca yenilenir
let tokenCache = {
  accessToken: null,
  areaDomain: null,
  expireTime: 0, // epoch saniye
};

const SDK_BASE_PATH = "/sdk";
const SDK_DIST_PATH = path.join(__dirname, "sdk", "dist");
const streamCache = new Map();

app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

app.use(express.static(__dirname));
app.use(SDK_BASE_PATH, express.static(path.join(__dirname, "sdk")));

function ensureCredentials(res) {
  if (!APP_KEY || !APP_SECRET) {
    res.status(500).json({
      error:
        "HIK_APP_KEY / HIK_APP_SECRET ortam degiskenleri tanimli degil. Railway > Variables kismindan ekleyin.",
    });
    return false;
  }
  return true;
}

function normalizeExpireTime(expireTime) {
  if (!expireTime) return null;
  const numeric = Number(expireTime);
  if (Number.isNaN(numeric)) return null;
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

function isSdkInstalled() {
  return fs.existsSync(path.join(SDK_DIST_PATH, "jsPlugin-3.0.0.min.js"));
}

function buildStreamCacheKey({ resourceId, deviceSerial, quality, protocol }) {
  return [resourceId, deviceSerial, quality, protocol].join(":");
}

function normalizeUrlExpireTime(expireTime) {
  const normalized = normalizeExpireTime(expireTime);
  if (normalized) return normalized;
  return Date.now() + 5 * 60 * 1000;
}

async function requestLiveAddress({
  accessToken,
  areaDomain,
  resourceId,
  deviceSerial,
  protocol,
  quality,
  code,
}) {
  const candidatePaths = [
    "/api/hccgw/video/v1/live/address/get",
    "/api/hccgw/video/v1/live/url/get",
    "/api/hccgw/video/v1/play/address/get",
  ];
  const attempts = [];

  for (const candidatePath of candidatePaths) {
    const payload = {
      resourceId,
      deviceSerial,
      type: "1",
      protocol,
      quality,
      expireTime: 600,
    };

    if (protocol === 1 && code) {
      payload.code = code;
    }

    const response = await fetch(`${areaDomain}${candidatePath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: accessToken,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let parsed = null;

    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      attempts.push({
        path: candidatePath,
        status: response.status,
        rawText: rawText.slice(0, 300),
      });
      continue;
    }

    attempts.push({
      path: candidatePath,
      status: response.status,
      errorCode: parsed.errorCode,
      message: parsed.errorMsg || parsed.message || null,
    });

    if (response.ok && parsed.errorCode === "0" && parsed.data?.url) {
      return {
        url: parsed.data.url,
        expireTime: normalizeUrlExpireTime(parsed.data.expireTime),
        resolvedPath: candidatePath,
        raw: parsed.data,
        attempts,
      };
    }
  }

  const lastAttempt = attempts[attempts.length - 1] || {};
  const err = new Error("Calisabilir bir canli yayin endpointi bulunamadi.");
  err.details = {
    error: err.message,
    attempts,
    requestPayload: {
      resourceId,
      deviceSerial,
      type: "1",
      protocol,
      quality,
      codeProvided: Boolean(code),
    },
    areaDomain,
  };

  if (protocol === 2) {
    const encryptionBlocked = attempts.some(
      (attempt) => attempt.errorCode === "EVZ60019"
    );

    if (encryptionBlocked) {
      err.details.error =
        "HLS adresi alinamadi. Kamera tarafinda stream encryption acik gorunuyor. Dokumana gore HLS/RTMP icin yayin sifrelemesi kapali olmali.";
    } else if (lastAttempt.errorCode) {
      err.details.error = `HLS adresi alinamadi. errorCode: ${lastAttempt.errorCode}`;
    }
  }

  throw err;
}

async function getCachedStreamSource({
  resourceId,
  deviceSerial,
  quality,
  protocol,
  code,
}) {
  const cacheKey = buildStreamCacheKey({
    resourceId,
    deviceSerial,
    quality,
    protocol,
  });
  const existing = streamCache.get(cacheKey);

  if (existing && existing.expireTime - Date.now() > 30 * 1000) {
    return existing;
  }

  const { accessToken, areaDomain } = await getToken();
  const result = await requestLiveAddress({
    accessToken,
    areaDomain,
    resourceId,
    deviceSerial,
    protocol,
    quality,
    code,
  });

  const cached = {
    ...result,
    resourceId,
    deviceSerial,
    quality,
    protocol,
    areaDomain,
  };

  streamCache.set(cacheKey, cached);
  return cached;
}

function buildLocalProxyBase(req, resourceId, deviceSerial, quality) {
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : req.protocol;
  const origin = `${protocol}://${req.get("host")}`;
  const params = new URLSearchParams({
    resourceId,
    deviceSerial,
    quality: String(quality),
  });
  return `${origin}/api/hls/manifest?${params.toString()}`;
}

function rewriteManifest(content, manifestUrl, req, resourceId, deviceSerial, quality) {
  const lines = content.split(/\r?\n/);

  return lines
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        if (trimmed.startsWith("#EXT-X-KEY") && trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/, (_, uri) => {
            const absolute = new URL(uri, manifestUrl).toString();
            const target = new URLSearchParams({
              target: absolute,
              resourceId,
              deviceSerial,
              quality: String(quality),
            });
            return `URI="/api/hls/chunk?${target.toString()}"`;
          });
        }

        return line;
      }

      const absolute = new URL(trimmed, manifestUrl).toString();
      const target = new URLSearchParams({
        target: absolute,
        resourceId,
        deviceSerial,
        quality: String(quality),
      });
      return `/api/hls/chunk?${target.toString()}`;
    })
    .join("\n");
}

// Token'i al (gerekirse yenile)
async function getToken() {
  const now = Math.floor(Date.now() / 1000);

  // Token halen gecerliyse (60 saniye pay birakarak) tekrar istek atma
  if (tokenCache.accessToken && tokenCache.expireTime - now > 60) {
    return tokenCache;
  }

  const response = await fetch(
    `${INITIAL_SERVER}/api/hccgw/platform/v1/token/get`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey: APP_KEY, secretKey: APP_SECRET }),
    }
  );

  const data = await response.json();

  if (data.errorCode !== "0") {
    throw new Error(
      `Token alinamadi. errorCode: ${data.errorCode}, cevap: ${JSON.stringify(
        data
      )}`
    );
  }

  tokenCache = {
    accessToken: data.data.accessToken,
    areaDomain: data.data.areaDomain, // ör: https://isgp.hikcentralconnect.com
    expireTime: data.data.expireTime,
  };

  return tokenCache;
}

app.get("/api/health", async (req, res) => {
  if (!APP_KEY || !APP_SECRET) {
    return res.status(200).json({
      ok: false,
      configured: false,
      initialServer: INITIAL_SERVER,
      sdkInstalled: isSdkInstalled(),
    });
  }

  try {
    const token = await getToken();
    res.json({
      ok: true,
      configured: true,
      initialServer: INITIAL_SERVER,
      areaDomain: token.areaDomain,
      expiresAt: normalizeExpireTime(token.expireTime),
      sdkMode: true,
      sdkBasePath: SDK_BASE_PATH,
      sdkInstalled: isSdkInstalled(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      configured: true,
      initialServer: INITIAL_SERVER,
      error: err.message,
      sdkInstalled: isSdkInstalled(),
    });
  }
});

app.get("/api/sdk-config", async (req, res) => {
  if (!ensureCredentials(res)) return;

  try {
    const token = await getToken();
    res.json({
      sdkBasePath: SDK_BASE_PATH,
      areaDomain: token.areaDomain,
      accessToken: token.accessToken,
      expiresAt: normalizeExpireTime(token.expireTime),
      sdkInstalled: isSdkInstalled(),
      note: "JSDecoder SDK dosyalarini proje altindaki /sdk klasorune koyun.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Kamera listesini getir
app.get("/api/cameras", async (req, res) => {
  if (!ensureCredentials(res)) return;

  try {
    const { accessToken, areaDomain } = await getToken();

    const response = await fetch(
      `${areaDomain}/api/hccgw/resource/v1/areas/cameras/get`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Token: accessToken,
        },
        body: JSON.stringify({
          pageIndex: "1",
          pageSize: "50",
          filter: { areaID: "-1", includeSubArea: "1" },
        }),
      }
    );

    const data = await response.json();

    if (data.errorCode !== "0") {
      return res.status(502).json({
        error: `Hikvision hata dondu. errorCode: ${data.errorCode}`,
        raw: data,
      });
    }

    // Frontend'in isine yarayacak sade bir liste dondur
    const cameras = (data.data.camera || []).map((cam) => ({
      name: cam.name,
      online: cam.online === "1",
      resourceId: cam.id,
      cameraIndexCode: cam.cameraIndexCode || null,
      deviceSerial: cam.device?.devInfo?.serialNo || null,
      channelNo: cam.device?.channelNo || cam.channelNo || null,
    }));

    res.json({ cameras });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Secilen kameranin canli yayin linkini getir
app.get("/api/stream", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const { resourceId, deviceSerial } = req.query;
  const code = (req.query.code || "").toString().trim();
  const protocol = Number(req.query.protocol || 2); // 1: EZOPEN, 2: HLS, 3: RTMP
  const quality = Number(req.query.quality || 1); // 1: HD, 2: Fluent

  if (!resourceId || !deviceSerial) {
    return res
      .status(400)
      .json({ error: "resourceId ve deviceSerial parametreleri zorunlu." });
  }

  try {
    const stream = await getCachedStreamSource({
      resourceId,
      deviceSerial,
      quality,
      protocol,
      code,
    });

    const proxiedUrl =
      protocol === 2
        ? buildLocalProxyBase(req, resourceId, deviceSerial, quality)
        : stream.url;

    return res.json({
      url: proxiedUrl,
      sourceUrl: stream.url,
      protocol,
      quality,
      expireTime: stream.expireTime,
      resolvedPath: stream.resolvedPath,
      raw: stream.raw,
    });
  } catch (err) {
    res.status(502).json(err.details || { error: err.message });
  }
});

app.get("/api/hls/manifest", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const { resourceId, deviceSerial } = req.query;
  const quality = Number(req.query.quality || 1);

  if (!resourceId || !deviceSerial) {
    return res
      .status(400)
      .json({ error: "resourceId ve deviceSerial parametreleri zorunlu." });
  }

  try {
    const stream = await getCachedStreamSource({
      resourceId,
      deviceSerial,
      quality,
      protocol: 2,
      code: "",
    });

    const upstreamResponse = await fetch(stream.url);
    const manifest = await upstreamResponse.text();

    if (!upstreamResponse.ok) {
      return res.status(502).json({
        error: "Upstream HLS manifest alinamadi.",
        status: upstreamResponse.status,
        rawText: manifest.slice(0, 300),
      });
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(
      rewriteManifest(
        manifest,
        stream.url,
        req,
        resourceId.toString(),
        deviceSerial.toString(),
        quality
      )
    );
  } catch (err) {
    res.status(502).json(err.details || { error: err.message });
  }
});

app.get("/api/hls/chunk", async (req, res) => {
  const target = req.query.target?.toString();

  if (!target) {
    return res.status(400).json({ error: "target parametresi zorunlu." });
  }

  try {
    const upstreamResponse = await fetch(target);
    if (!upstreamResponse.ok) {
      const rawText = await upstreamResponse.text();
      return res.status(502).json({
        error: "Upstream HLS parcasi alinamadi.",
        status: upstreamResponse.status,
        rawText: rawText.slice(0, 300),
      });
    }

    const contentType =
      upstreamResponse.headers.get("content-type") ||
      "application/octet-stream";
    const arrayBuffer = await upstreamResponse.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda calisiyor`);
});
