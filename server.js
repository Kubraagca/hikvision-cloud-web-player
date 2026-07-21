const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Ayarlar (Railway'de "Variables" sekmesinden ekleyeceksiniz) ---
const APP_KEY = process.env.HIK_APP_KEY;
const APP_SECRET = process.env.HIK_APP_SECRET;
const BRIDGE_BASE_URL = (process.env.HIK_BRIDGE_BASE_URL || "").replace(/\/+$/, "");

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

async function readJsonResponse(response) {
  const rawText = await response.text();
  try {
    return { parsed: JSON.parse(rawText), rawText };
  } catch (err) {
    return { parsed: null, rawText };
  }
}

function buildLivePayload({ resourceId, deviceSerial, protocol, quality, codeVariant }) {
  return {
    resourceId,
    deviceSerial,
    type: "1",
    protocol,
    quality,
    expireTime: 600,
    ...codeVariant,
  };
}

async function resolveLiveUrl({ accessToken, areaDomain, resourceId, deviceSerial, protocol, quality, code }) {
  const candidatePaths = [
    "/api/hccgw/video/v1/live/address/get",
    "/api/hccgw/video/v1/live/url/get",
    "/api/hccgw/video/v1/play/address/get",
    "/api/lapp/live/url/ezopen",
    "/api/lapp/live/url/hls",
  ];
  const codeVariants = code
    ? [
        { code },
        { verifyCode: code },
        { verificationCode: code },
        { encryptionKey: code },
        { secretKey: code },
      ]
    : [{}];

  const attempts = [];

  for (const candidatePath of candidatePaths) {
    for (const codeVariant of codeVariants) {
      const payload = buildLivePayload({
        resourceId,
        deviceSerial,
        protocol,
        quality,
        codeVariant,
      });

      const response = await fetch(`${areaDomain}${candidatePath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Token: accessToken,
        },
        body: JSON.stringify(payload),
      });

      const { parsed, rawText } = await readJsonResponse(response);

      if (!parsed) {
        attempts.push({
          path: candidatePath,
          codeField: Object.keys(codeVariant)[0] || null,
          status: response.status,
          rawText: rawText.slice(0, 300),
        });
        continue;
      }

      attempts.push({
        path: candidatePath,
        codeField: Object.keys(codeVariant)[0] || null,
        status: response.status,
        errorCode: parsed.errorCode,
        message: parsed.errorMsg || parsed.message || null,
      });

      if (response.ok && parsed.errorCode === "0" && parsed.data?.url) {
        return {
          ok: true,
          url: parsed.data.url,
          protocol,
          quality,
          expireTime: normalizeExpireTime(parsed.data.expireTime),
          resolvedPath: candidatePath,
          resolvedCodeField: Object.keys(codeVariant)[0] || null,
          raw: parsed.data,
          attempts,
        };
      }
    }
  }

  return {
    ok: false,
    attempts,
    requestPayload: {
      resourceId,
      deviceSerial,
      type: "1",
      protocol,
      quality,
      expireTime: 600,
      codeProvided: Boolean(code),
    },
    areaDomain,
  };
}

async function startBridgeStream({ sourceUrl, cameraName, resourceId, deviceSerial, quality }) {
  if (!BRIDGE_BASE_URL) {
    return {
      ok: false,
      error: "HIK_BRIDGE_BASE_URL tanimli degil.",
    };
  }

  const streamId = `${deviceSerial || "device"}-${quality || 1}-${resourceId.slice(0, 8)}`.toLowerCase();
  const response = await fetch(`${BRIDGE_BASE_URL}/api/ingest/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      streamId,
      sourceUrl,
      cameraName,
      resourceId,
      deviceSerial,
      quality,
    }),
  });

  const { parsed, rawText } = await readJsonResponse(response);

  if (!response.ok || !parsed?.playbackUrl) {
    return {
      ok: false,
      status: response.status,
      error: parsed?.error || "Bridge servisi oynatilabilir URL dondurmedi.",
      rawText: rawText.slice(0, 500),
    };
  }

  return {
    ok: true,
    streamId: parsed.streamId || streamId,
    playbackUrl: parsed.playbackUrl,
    playbackProtocol: parsed.protocol || "hls",
    raw: parsed,
  };
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
      bridgeConfigured: Boolean(BRIDGE_BASE_URL),
      bridgeBaseUrl: BRIDGE_BASE_URL || null,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      configured: true,
      initialServer: INITIAL_SERVER,
      error: err.message,
      sdkInstalled: isSdkInstalled(),
      bridgeConfigured: Boolean(BRIDGE_BASE_URL),
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
      bridgeConfigured: Boolean(BRIDGE_BASE_URL),
      bridgeBaseUrl: BRIDGE_BASE_URL || null,
      note: "JSDecoder SDK dosyalarini proje altindaki /sdk klasorune koyun.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/runtime", (req, res) => {
  res.json({
    ok: true,
    platform: process.platform,
    bridgeConfigured: Boolean(BRIDGE_BASE_URL),
    bridgeBaseUrl: BRIDGE_BASE_URL || null,
    sdkInstalled: isSdkInstalled(),
    note:
      "EZOPEN akislarini browser'da plugin'siz oynatmak icin ya resmi WASM kit ya da Windows bridge servisi gerekir.",
  });
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
  const cameraName = (req.query.cameraName || "").toString().trim();
  const target = (req.query.target || "").toString().trim().toLowerCase();
  const protocol = Number(req.query.protocol || 1); // 1: EZOPEN, 2: HLS, 3: RTMP
  const quality = Number(req.query.quality || 1); // 1: HD, 2: Fluent

  if (!resourceId || !deviceSerial) {
    return res
      .status(400)
      .json({ error: "resourceId ve deviceSerial parametreleri zorunlu." });
  }

  try {
    const { accessToken, areaDomain } = await getToken();
    const liveResult = await resolveLiveUrl({
      accessToken,
      areaDomain,
      resourceId,
      deviceSerial,
      protocol,
      quality,
      code,
    });

    if (!liveResult.ok) {
      return res.status(502).json({
        error: "Calisabilir bir canli yayin endpointi bulunamadi.",
        attempts: liveResult.attempts,
        requestPayload: liveResult.requestPayload,
        areaDomain,
      });
    }

    if (target === "bridge") {
      const bridgeResult = await startBridgeStream({
        sourceUrl: liveResult.url,
        cameraName,
        resourceId,
        deviceSerial,
        quality,
      });

      if (!bridgeResult.ok) {
        return res.status(502).json({
          error: "EZOPEN URL alindi ancak bridge servisi oynatilabilir akisa ceviremedi.",
          bridgeConfigured: Boolean(BRIDGE_BASE_URL),
          bridgeBaseUrl: BRIDGE_BASE_URL || null,
          bridge: bridgeResult,
          source: liveResult,
        });
      }

      return res.json({
        mode: "bridge",
        sourceProtocol: liveResult.protocol,
        sourceUrl: liveResult.url,
        url: bridgeResult.playbackUrl,
        protocol: bridgeResult.playbackProtocol,
        quality,
        expireTime: liveResult.expireTime,
        streamId: bridgeResult.streamId,
        resolvedPath: liveResult.resolvedPath,
        resolvedCodeField: liveResult.resolvedCodeField,
        raw: {
          bridge: bridgeResult.raw,
          source: liveResult.raw,
        },
      });
    }

    return res.json({
      mode: "source",
      bridgeConfigured: Boolean(BRIDGE_BASE_URL),
      url: liveResult.url,
      protocol,
      quality,
      expireTime: liveResult.expireTime,
      resolvedPath: liveResult.resolvedPath,
      resolvedCodeField: liveResult.resolvedCodeField,
      raw: liveResult.raw,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda calisiyor`);
});
