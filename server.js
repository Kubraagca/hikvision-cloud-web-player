const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

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
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      configured: true,
      initialServer: INITIAL_SERVER,
      error: err.message,
    });
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
  const protocol = Number(req.query.protocol || 2); // 2: HLS, 3: FLV (platforma gore degisebilir)
  const quality = Number(req.query.quality || 1); // 1: HD, 2: Fluent

  if (!resourceId || !deviceSerial) {
    return res
      .status(400)
      .json({ error: "resourceId ve deviceSerial parametreleri zorunlu." });
  }

  try {
    const { accessToken, areaDomain } = await getToken();
    const payload = {
      resourceId,
      deviceSerial,
      type: "1",
      protocol,
      quality,
      expireTime: 600,
    };
    if (code) {
      payload.code = code;
    }

    const candidatePaths = [
      "/api/hccgw/video/v1/live/address/get",
      "/api/hccgw/video/v1/live/url/get",
      "/api/hccgw/video/v1/play/address/get",
      "/api/lapp/live/url/ezopen",
      "/api/lapp/live/url/hls",
    ];

    const attempts = [];

    for (const candidatePath of candidatePaths) {
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
        return res.json({
          url: parsed.data.url,
          protocol,
          quality,
          expireTime: normalizeExpireTime(parsed.data.expireTime),
          resolvedPath: candidatePath,
          raw: parsed.data,
        });
      }
    }

    return res.status(502).json({
      error: "Calisabilir bir canli yayin endpointi bulunamadi.",
      attempts,
      requestPayload: payload,
      areaDomain,
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
