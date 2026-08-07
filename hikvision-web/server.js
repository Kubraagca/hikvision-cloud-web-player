const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const net = require("node:net");
const path = require("path");
const { spawn } = require("child_process");
const { XMLParser } = require("fast-xml-parser");
const { createAlprServiceBridge } = require("../plaka-tanima/lib/alpr-service");
const { createTeamOpenApiService } = require("./lib/team-openapi-service");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.HIK_APP_KEY;
const APP_SECRET = process.env.HIK_APP_SECRET;
const INITIAL_SERVER =
  process.env.HIK_INITIAL_SERVER || "https://ieu.hikcentralconnect.com";
const LOCAL_SERVICE_ROOT = path.resolve(__dirname, "..", "hikvision-yerel-servis");
const ALPR_ROOT = path.resolve(__dirname, "..", "plaka-tanima");
const DATA_ROOT = path.join(__dirname, "data");
const RECORDING_SYNC_ROOT = path.join(DATA_ROOT, "recording-sync");
const RECORDING_ARCHIVE_ROOT = path.join(RECORDING_SYNC_ROOT, "archive");
const RECORDING_SYNC_STATE_PATH = path.join(RECORDING_SYNC_ROOT, "state.json");
const RECORDING_SYNC_CONFIG_PATH = path.join(RECORDING_SYNC_ROOT, "config.json");

const SDK_BASE_PATH = "/sdk";
const SDK_DIST_PATH = path.join(__dirname, "sdk", "dist");
const streamCache = new Map();
const provisioningTasks = new Map();
let recordingSyncPromise = null;
let recordingSyncTimer = null;

let tokenCache = {
  accessToken: null,
  areaDomain: null,
  expireTime: 0,
};
let openApiAuditState = {
  lastByOperation: {},
  mp4DownloadHosts: [],
  tokenHost: "",
  lastAreaDomainHost: "",
  devicesAddHost: "",
};
let streamTokenCache = {
  appToken: null,
  appKey: null,
  streamAreaDomain: null,
  areaDomain: null,
  fetchedAt: 0,
};

const teamOpenApiService = createTeamOpenApiService({
  appKey: APP_KEY,
  appSecret: APP_SECRET,
  initialServer: INITIAL_SERVER,
  logger: {
    error(entry) {
      console.error(JSON.stringify(entry));
    },
  },
});
const alprService = createAlprServiceBridge({
  rootDir: ALPR_ROOT,
  logger: console,
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  preserveOrder: false,
  alwaysCreateTextNode: false,
});

app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

const staticOptions = {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (
      ext === ".html" ||
      ext === ".js" ||
      ext === ".css" ||
      ext === ".json" ||
      ext === ".wasm"
    ) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
};

app.use(express.static(__dirname, staticOptions));
app.use(SDK_BASE_PATH, express.static(path.join(__dirname, "sdk"), staticOptions));
app.use(
  `${SDK_BASE_PATH}/playctrl`,
  express.static(path.join(__dirname, "sdk", "dist", "playctrl"), staticOptions)
);
app.use(
  `${SDK_BASE_PATH}/audioMixer`,
  express.static(path.join(__dirname, "sdk", "dist", "audioMixer"), staticOptions)
);
app.use(
  `${SDK_BASE_PATH}/talkW`,
  express.static(path.join(__dirname, "sdk", "dist", "talkW"), staticOptions)
);
app.use(
  `${SDK_BASE_PATH}/talkEzui`,
  express.static(path.join(__dirname, "sdk", "dist", "talkEzui"), staticOptions)
);
app.use(
  `${SDK_BASE_PATH}/transform`,
  express.static(path.join(__dirname, "sdk", "dist", "transform"), staticOptions)
);

const LOCAL_AGENT_ZIP_PATH = path.join(
  LOCAL_SERVICE_ROOT,
  "src",
  "HikDiscovery",
  "HikProvisioning.Web",
  "wwwroot",
  "downloads",
  "local-agent",
  "HikProvisioning.Agent-win-x64.zip"
);
const LOCAL_AGENT_SETUP_EXE_PATH = path.join(
  LOCAL_SERVICE_ROOT,
  "src",
  "HikDiscovery",
  "HikProvisioning.Web",
  "wwwroot",
  "downloads",
  "local-agent",
  "HikProvisioning.Agent-win-x64-Setup.exe"
);

function ensureCredentials(res) {
  if (!APP_KEY || !APP_SECRET) {
    res.status(500).json({
      error:
        "HIK_APP_KEY / HIK_APP_SECRET ortam degiskenleri tanimli degil. Backend bunlari environment variable olarak okumali.",
    });
    return false;
  }
  return true;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFileSafe(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallbackValue;
  }
}

function writeJsonFileSafe(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  fs.renameSync(tempPath, filePath);
}

function buildDefaultRecordingSyncConfig() {
  return {
    enabled: false,
    dailyTime: "02:00",
    lookbackMinutes: 1440,
    cameras: [],
  };
}

function buildDefaultRecordingSyncState() {
  return {
    lastRunStartedAt: "",
    lastRunFinishedAt: "",
    lastRunStatus: "idle",
    lastRunReason: "",
    lastError: "",
    lastDiagnostic: null,
    activeRun: null,
    lastScheduledRunKey: "",
    lastSuccessByCameraId: {},
    downloadedSegments: {},
    recentRuns: [],
  };
}

function loadRecordingSyncConfig() {
  const raw = readJsonFileSafe(RECORDING_SYNC_CONFIG_PATH, buildDefaultRecordingSyncConfig());
  return {
    ...buildDefaultRecordingSyncConfig(),
    ...raw,
    cameras: Array.isArray(raw?.cameras) ? raw.cameras : [],
  };
}

function saveRecordingSyncConfig(config) {
  writeJsonFileSafe(RECORDING_SYNC_CONFIG_PATH, config);
}

function loadRecordingSyncState() {
  const raw = readJsonFileSafe(RECORDING_SYNC_STATE_PATH, buildDefaultRecordingSyncState());
  return {
    ...buildDefaultRecordingSyncState(),
    ...raw,
    lastDiagnostic: raw?.lastDiagnostic && typeof raw.lastDiagnostic === "object" ? raw.lastDiagnostic : null,
    lastSuccessByCameraId:
      raw && typeof raw.lastSuccessByCameraId === "object" && raw.lastSuccessByCameraId
        ? raw.lastSuccessByCameraId
        : {},
    downloadedSegments:
      raw && typeof raw.downloadedSegments === "object" && raw.downloadedSegments
        ? raw.downloadedSegments
        : {},
    recentRuns: Array.isArray(raw?.recentRuns) ? raw.recentRuns : [],
  };
}

function saveRecordingSyncState(state) {
  writeJsonFileSafe(RECORDING_SYNC_STATE_PATH, state);
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function formatIsoOffset(date) {
  const year = date.getFullYear();
  const month = padNumber(date.getMonth() + 1);
  const day = padNumber(date.getDate());
  const hour = padNumber(date.getHours());
  const minute = padNumber(date.getMinutes());
  const second = padNumber(date.getSeconds());
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHour = padNumber(Math.floor(absoluteOffsetMinutes / 60));
  const offsetMinute = padNumber(absoluteOffsetMinutes % 60);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offsetSign}${offsetHour}:${offsetMinute}`;
}

function parseTimeValue(timeValue) {
  const normalized = String(timeValue || "").trim();
  const match = /^(\d{2}):(\d{2})$/.exec(normalized);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute, normalized };
}

function sanitizeFileName(fileName) {
  return String(fileName || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 180);
}

function createSegmentFingerprint(cameraId, beginTime, endTime, targetType) {
  return crypto
    .createHash("sha1")
    .update(`${cameraId}|${beginTime}|${endTime}|${targetType}`)
    .digest("hex");
}

function buildArchiveDirectory(camera) {
  const serial = sanitizeFileName(camera.deviceSerial || camera.cameraId || "camera");
  return path.join(RECORDING_ARCHIVE_ROOT, serial);
}

function buildSegmentBaseName(camera, segment) {
  const serial = sanitizeFileName(camera.deviceSerial || camera.cameraId || "camera");
  const begin = sanitizeFileName(String(segment.beginTime || "").replace(/[:+]/g, "-"));
  const end = sanitizeFileName(String(segment.endTime || "").replace(/[:+]/g, "-"));
  return `${serial}_${begin}_${end}`;
}

function mergeRecentRun(state, entry) {
  state.recentRuns = [entry, ...(Array.isArray(state.recentRuns) ? state.recentRuns : [])].slice(0, 20);
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

function createProvisioningTask(input) {
  const taskId = crypto.randomUUID();
  const task = {
    taskId,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: {
      cameraIp: input.cameraIp,
      userName: input.userName,
      areaName: input.areaName || "",
      enableDhcp: Boolean(input.enableDhcp),
      gatewayOverride: input.gatewayOverride || "",
    },
    stages: [
      createStage("Erisim"),
      createStage("Aktivasyon"),
      createStage("Cihaz Bilgileri"),
      createStage("Ag Ayarlari"),
      createStage("Hik-Connect Ayari"),
      createStage("Team Hesabina Ekleme"),
      createStage("Kanal Aktarimi"),
      createStage("Tamamlandi"),
    ],
    result: null,
    error: null,
  };

  provisioningTasks.set(taskId, task);
  return task;
}

function createActivationTask(input) {
  const taskId = crypto.randomUUID();
  const task = {
    taskId,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: {
      cameraIp: input.cameraIp,
      userName: input.userName,
    },
    stages: [
      createStage("Erisim"),
      createStage("Aktivasyon"),
      createStage("Cihaz Bilgileri"),
      createStage("Tamamlandi"),
    ],
    result: null,
    error: null,
  };

  provisioningTasks.set(taskId, task);
  return task;
}

function createStage(name) {
  return { name, status: "Bekliyor", detail: "" };
}

function updateTaskStage(task, name, status, detail) {
  const stage = task.stages.find((item) => item.name === name);
  if (!stage) {
    return;
  }

  stage.status = status;
  stage.detail = detail;
  task.updatedAt = new Date().toISOString();
}

function markTaskFailed(task, error) {
  task.status = "failed";
  task.error = sanitizeMessage(error?.message || String(error));
  task.updatedAt = new Date().toISOString();
}

function markTaskSucceeded(task, result) {
  task.status = "completed";
  task.result = result;
  task.updatedAt = new Date().toISOString();
}

function sanitizeMessage(message) {
  if (!message) return "Bilinmeyen hata";
  let output = String(message);
  if (APP_KEY) {
    output = output.replaceAll(APP_KEY, "***");
  }
  if (APP_SECRET) {
    output = output.replaceAll(APP_SECRET, "***");
  }
  return output
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"')
    .replace(/"userName"\s*:\s*"[^"]*"/gi, '"userName":"***"')
    .replace(/"appKey"\s*:\s*"[^"]*"/gi, '"appKey":"***"')
    .replace(/"secretKey"\s*:\s*"[^"]*"/gi, '"secretKey":"***"')
    .replace(/"verificationCode"\s*:\s*"[^"]*"/gi, '"verificationCode":"***"')
    .replace(/"ezvizVerifyCode"\s*:\s*"[^"]*"/gi, '"ezvizVerifyCode":"***"')
    .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"***"')
    .replace(/"accessToken"\s*:\s*"[^"]+"/gi, '"accessToken":"***"')
    .replace(/([?&](?:token|accessToken|appKey|secretKey|verificationCode|ezvizVerifyCode|AK|SK|ak|sk)=)[^&]+/gi, "$1***")
    .replace(/Token:\s*[^\s,]+/gi, "Token: ***");
}

function safeJsonParse(rawText) {
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    return null;
  }
}

const CAMERA_CAPTURE_TIMEOUT_MS = Number(process.env.CAMERA_CAPTURE_TIMEOUT_MS || 15_000);
const CAMERA_CAPTURE_MAX_BYTES = Number(process.env.CAMERA_CAPTURE_MAX_BYTES || 10 * 1024 * 1024);

function createTimeoutSignal(timeoutMs, parentSignal = null) {
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort(new Error(`Istek zaman asimina ugradi (${timeoutMs} ms).`));
  }, timeoutMs);

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason || new Error("Istek iptal edildi."));
    } else {
      parentSignal.addEventListener(
        "abort",
        () => controller.abort(parentSignal.reason || new Error("Istek iptal edildi.")),
        { once: true }
      );
    }
  }

  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timerId);
    },
  };
}

function normalizeCameraChannelNo(value) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

function deriveRegistrableDomain(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }
  return parts.slice(-2).join(".");
}

function buildTrustedHikCaptureHostSuffixes(areaDomain) {
  const suffixes = new Set([
    "ezvizlife.com",
    "hikcentralconnect.com",
    "ezviz.com",
    "ys7.com",
    "hik-connect.com",
  ]);
  for (const candidate of [areaDomain, INITIAL_SERVER]) {
    try {
      const parsed = new URL(String(candidate || ""));
      const registrable = deriveRegistrableDomain(parsed.hostname);
      if (registrable) {
        suffixes.add(registrable);
      }
      if (parsed.hostname) {
        suffixes.add(parsed.hostname.toLowerCase());
      }
    } catch {
    }
  }
  return [...suffixes].filter(Boolean);
}

function isLikelyTrustedHikCaptureHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("ezviz") ||
    normalized.includes("hik") ||
    normalized.includes("ys7")
  );
}

function normalizeHikCaptureUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }

  try {
    const parsed = new URL(rawValue);
    const pathValue = `${parsed.pathname || ""}${parsed.search || ""}${parsed.hash || ""}`;
    const nestedMatch = pathValue.match(/\/(https?:\/\/.+)$/i);
    if (nestedMatch?.[1]) {
      return decodeURIComponent(nestedMatch[1]);
    }
    return parsed.toString();
  } catch {
    return rawValue;
  }
}

function isTrustedHikCaptureUrl(captureUrl, areaDomain) {
  try {
    const parsed = new URL(normalizeHikCaptureUrl(captureUrl));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "127.0.0.1"
    ) {
      return false;
    }

    return (
      buildTrustedHikCaptureHostSuffixes(areaDomain).some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
      ) ||
      isLikelyTrustedHikCaptureHostname(hostname) ||
      hostname.includes(".")
    );
  } catch {
    return false;
  }
}

function isSupportedImageContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  return (
    normalized.startsWith("image/jpeg") ||
    normalized.startsWith("image/jpg") ||
    normalized.startsWith("image/png") ||
    normalized.startsWith("image/webp") ||
    normalized.startsWith("image/gif") ||
    normalized.startsWith("image/bmp")
  );
}

function isCameraOnline(camera) {
  return camera?.online === true || camera?.online === "1" || camera?.online === 1;
}

function sniffImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return "";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return "image/gif";
    }
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }
  return "";
}

function extractUrlHost(value) {
  try {
    return new URL(normalizeHikCaptureUrl(value)).host;
  } catch {
    return "";
  }
}

function analyzeHikConnectBaseUrl(baseDomain, pathName) {
  const base = String(baseDomain || "").trim();
  const pathValue = String(pathName || "").trim();
  const actualUrl = `${base}${pathValue}`;
  const normalizedPath = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const report = {
    baseDomain: sanitizeMessage(base),
    pathName: normalizedPath,
    actualUrl: sanitizeMessage(actualUrl),
    host: "",
    hasDoubleApi: false,
    missingRegionalDomain: false,
    wrongPath: false,
    issues: [],
  };

  try {
    const parsed = new URL(actualUrl);
    report.host = parsed.host;
    report.hasDoubleApi = /\/api\/api(?:\/|$)/i.test(parsed.pathname);
    report.missingRegionalDomain = !/^(?:ieu|ius|isa|iindia|isgp)(?:-team)?\./i.test(parsed.hostname);
    report.wrongPath =
      !parsed.pathname.endsWith(normalizedPath) &&
      !parsed.pathname.endsWith(normalizedPath.replace(/^\//, ""));
  } catch {
    report.issues.push("invalid-url");
    return report;
  }

  if (report.hasDoubleApi) {
    report.issues.push("double-/api");
  }
  if (report.missingRegionalDomain) {
    report.issues.push("missing-or-unexpected-regional-domain");
  }
  if (report.wrongPath) {
    report.issues.push("wrong-path");
  }

  return report;
}

function recordOpenApiAudit(entry) {
  if (!entry || typeof entry !== "object") {
    return;
  }

  const normalized = {
    ...entry,
    url: sanitizeMessage(entry.url || ""),
    responseBody: sanitizeMessage(entry.responseBody || ""),
    areaDomain: sanitizeMessage(entry.areaDomain || ""),
  };

  if (normalized.operation) {
    openApiAuditState.lastByOperation[normalized.operation] = normalized;
  }
  if (normalized.operation === "token.get") {
    openApiAuditState.tokenHost = normalized.host || extractUrlHost(INITIAL_SERVER);
  }
  if (normalized.areaDomainHost) {
    openApiAuditState.lastAreaDomainHost = normalized.areaDomainHost;
  }
  if (normalized.operation === "devices.add") {
    openApiAuditState.devicesAddHost = normalized.host || "";
  }
}

function buildRecordingHostComparison() {
  const downloadUrlEntry =
    openApiAuditState.lastByOperation["video.download.url"] ||
    openApiAuditState.lastByOperation["video.save"] ||
    openApiAuditState.lastByOperation["record.search"] ||
    null;
  const downloadOpenApiHost = downloadUrlEntry?.host || "";
  const mp4DownloadHosts = Array.isArray(openApiAuditState.mp4DownloadHosts)
    ? [...new Set(openApiAuditState.mp4DownloadHosts.filter(Boolean))]
    : [];

  return {
    tokenHost: openApiAuditState.tokenHost || extractUrlHost(INITIAL_SERVER),
    devicesAddHost: openApiAuditState.devicesAddHost || openApiAuditState.lastAreaDomainHost || "",
    downloadOpenApiHost,
    mp4DownloadHosts,
  };
}

function attachDiagnostic(error, diagnostic) {
  if (error && diagnostic) {
    error.diagnostic = diagnostic;
  }
  return error;
}

function buildEndpointUnavailableMessage(pathName, statusCode) {
  const code = Number(statusCode || 0);
  if (code !== 404) {
    return "";
  }

  if (
    pathName === "/api/hccgw/video/v1/video/save" ||
    pathName === "/api/hccgw/video/v1/video/download/url"
  ) {
    return "Bu OpenAPI hesabinda/bolgesinde video indirme endpointi mevcut veya etkin degil.";
  }

  if (pathName === "/api/hccgw/video/v1/record/element/search") {
    return "Bu OpenAPI hesabinda/bolgesinde kayit sorgu endpointi mevcut veya etkin degil.";
  }

  return "";
}

function logRecordingSyncStep(runId, cameraId, stage, payload = {}) {
  console.log(
    JSON.stringify({
      scope: "recording-sync",
      runId,
      cameraId,
      stage,
      ...payload,
    })
  );
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function parseDigestChallenge(headerValue) {
  if (!headerValue || !/^Digest /i.test(headerValue)) {
    return null;
  }

  const challenge = {};
  const input = headerValue.replace(/^Digest\s+/i, "");
  const regex = /(\w+)=("([^"]*)"|([^,]+))/g;
  let match;
  while ((match = regex.exec(input)) !== null) {
    challenge[match[1]] = match[3] || match[4];
  }

  return challenge;
}

function buildDigestAuthorization({ challenge, method, uri, userName, password }) {
  const realm = challenge.realm;
  const nonce = challenge.nonce;
  const qop = (challenge.qop || "auth").split(",").map((item) => item.trim())[0];
  const opaque = challenge.opaque;
  const algorithm = challenge.algorithm || "MD5";

  if (!realm || !nonce || algorithm.toUpperCase() !== "MD5") {
    throw new Error("Kamera Digest challenge yaniti desteklenmeyen formatta.");
  }

  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${userName}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${userName}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=MD5`,
  ];

  if (opaque) {
    parts.push(`opaque="${opaque}"`);
  }

  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }

  return `Digest ${parts.join(", ")}`;
}

async function fetchWithDigest({
  cameraIp,
  pathName,
  method = "GET",
  userName,
  password,
  body = null,
  contentType = "application/xml",
  accept = "application/xml",
}) {
  const url = `http://${cameraIp}${pathName}`;
  const headers = { Accept: accept };

  if (body !== null) {
    headers["Content-Type"] = contentType;
  }

  let response = await fetch(url, { method, headers, body });
  if (response.status === 401) {
    const challenge = parseDigestChallenge(response.headers.get("www-authenticate"));
    if (!challenge) {
      const text = await response.text();
      return { ok: false, status: response.status, body: text, headers: response.headers };
    }

    const uri = new URL(url).pathname + new URL(url).search;
    const authorization = buildDigestAuthorization({
      challenge,
      method,
      uri,
      userName,
      password,
    });

    response = await fetch(url, {
      method,
      headers: {
        ...headers,
        Authorization: authorization,
      },
      body,
    });
  }

  const text = await response.text();
  return { ok: response.ok, status: response.status, body: text, headers: response.headers };
}

function getXmlValue(xml, names) {
  for (const name of names) {
    const match = new RegExp(
      `<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,
      "i"
    ).exec(xml);
    if (match && match[1] != null) {
      return decodeXml(match[1].trim());
    }
  }

  return "";
}

function replaceXmlValue(xml, names, value) {
  let updated = xml;

  for (const name of names) {
    const regex = new RegExp(
      `(<(?:\\w+:)?${name}\\b[^>]*>)([\\s\\S]*?)(<\\/(?:\\w+:)?${name}>)`,
      "gi"
    );

    if (regex.test(updated)) {
      updated = updated.replace(regex, `$1${escapeXml(value)}$3`);
    }
  }

  return updated;
}

function getXmlBlock(xml, name) {
  const match = new RegExp(
    `<(?:\\w+:)?${name}\\b[^>]*>[\\s\\S]*?<\\/(?:\\w+:)?${name}>`,
    "i"
  ).exec(xml);
  return match ? match[0].trim() : "";
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extractSubStatusCode(xml) {
  return getXmlValue(xml, ["subStatusCode"]);
}

function extractStatusCode(xml) {
  return getXmlValue(xml, ["statusCode"]);
}

function scalar(value, fieldName) {
  if (value === null || value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "";
    }

    return scalar(value[0], fieldName);
  }

  if (typeof value === "object") {
    if (value["#text"] !== undefined) {
      return scalar(value["#text"], fieldName);
    }

    if (value._text !== undefined) {
      return scalar(value._text, fieldName);
    }

    if (value.text !== undefined) {
      return scalar(value.text, fieldName);
    }

    throw new Error(
      `${fieldName} alanı çözümlenemedi: ${JSON.stringify(value)}`
    );
  }

  return String(value).trim();
}

function validateScalarIp(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(
      `${fieldName} string değil: ${JSON.stringify(value)}`
    );
  }

  if (net.isIP(value) !== 4) {
    throw new Error(
      `${fieldName} geçerli IPv4 değil: ${value}`
    );
  }
}

function parseResponseStatus(xml) {
  return {
    statusCode: extractStatusCode(xml),
    subStatusCode: extractSubStatusCode(xml),
    statusString: getXmlValue(xml, ["statusString"]),
    description: getXmlValue(xml, ["description"]),
  };
}

function parseNetworkConfig(xml) {
  const parsed = xmlParser.parse(xml);

  let networkInterface =
    parsed?.NetworkInterfaceList?.NetworkInterface;

  if (Array.isArray(networkInterface)) {
    networkInterface =
      networkInterface.find(
        (item) => scalar(item?.id, "interfaceId") === "1"
      ) || networkInterface[0];
  }

  if (!networkInterface) {
    throw new Error("NetworkInterface bulunamadı.");
  }

  const ipConfig = networkInterface.IPAddress;

  if (!ipConfig) {
    throw new Error("IPAddress alanı bulunamadı.");
  }

  const result = {
    interfaceId: Number(
      scalar(networkInterface.id, "interfaceId")
    ),

    ipVersion: scalar(
      ipConfig.ipVersion,
      "ipVersion"
    ),

    addressingType: scalar(
      ipConfig.addressingType,
      "addressingType"
    ),

    ipAddress: scalar(
      ipConfig.ipAddress,
      "ipAddress"
    ),

    subnetMask: scalar(
      ipConfig.subnetMask,
      "subnetMask"
    ),

    gateway: scalar(
      ipConfig.DefaultGateway?.ipAddress,
      "gateway"
    ),

    primaryDns: scalar(
      ipConfig.PrimaryDNS?.ipAddress,
      "primaryDns"
    ),

    secondaryDns: scalar(
      ipConfig.SecondaryDNS?.ipAddress,
      "secondaryDns"
    ),

    macAddress: scalar(
      networkInterface.Link?.MACAddress,
      "macAddress"
    )
  };

  console.log("Parse edilen ağ bilgileri:", result);

  return result;
}

function buildNetworkInterfaceXml({
  interfaceId = "1",
  ipVersion = "dual",
  addressingType = "static",
  ipAddress,
  subnetMask,
  gateway,
  primaryDns,
  secondaryDns = "",
  ipv6Address = "::",
  ipv6BitMask = "0",
  ipv6AddressingType = "ra",
}) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<NetworkInterface version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">` +
    `<id>${escapeXml(interfaceId)}</id>` +
    `<IPAddress version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">` +
    `<ipVersion>${escapeXml(ipVersion)}</ipVersion>` +
    `<addressingType>${escapeXml(addressingType)}</addressingType>` +
    `<ipAddress>${escapeXml(ipAddress)}</ipAddress>` +
    `<subnetMask>${escapeXml(subnetMask)}</subnetMask>` +
    `<ipv6Address>${escapeXml(ipv6Address)}</ipv6Address>` +
    `<bitMask>${escapeXml(ipv6BitMask)}</bitMask>` +
    `<DefaultGateway><ipAddress>${escapeXml(gateway)}</ipAddress></DefaultGateway>` +
    `<PrimaryDNS><ipAddress>${escapeXml(primaryDns)}</ipAddress></PrimaryDNS>` +
    `<SecondaryDNS><ipAddress>${escapeXml(secondaryDns)}</ipAddress></SecondaryDNS>` +
    `<Ipv6Mode>` +
    `<ipV6AddressingType>${escapeXml(ipv6AddressingType)}</ipV6AddressingType>` +
    `<ipv6AddressList>` +
    `<v6Address>` +
    `<id>1</id>` +
    `<type>manual</type>` +
    `<address>::</address>` +
    `<bitMask>0</bitMask>` +
    `</v6Address>` +
    `</ipv6AddressList>` +
    `</Ipv6Mode>` +
    `</IPAddress>` +
    `</NetworkInterface>`
  );
}

function parseActivateStatus(xml) {
  const activateStatus = getXmlValue(xml, ["activateStatus"]).toLowerCase();
  const subStatusCode = extractSubStatusCode(xml);
  return {
    isActive: ["active", "activated", "1", "true"].includes(activateStatus),
    isInactive: ["inactive", "notactivated", "not_activated", "0", "false"].includes(activateStatus),
    subStatusCode,
  };
}

function normalizeMac(mac) {
  return String(mac || "")
    .replaceAll(":", "-")
    .trim()
    .toUpperCase();
}

function parseDeviceInfo(xml) {
  const serialNumber = getXmlValue(xml, ["serialNumber"]);
  const subSerialNumber = getXmlValue(xml, ["subSerialNumber"]);
  const shortSerial = subSerialNumber || serialNumber;
  return {
    model: getXmlValue(xml, ["model"]),
    serialNumber,
    shortSerial,
    subSerialNumber,
    firmwareVersion: getXmlValue(xml, ["firmwareVersion"]),
    macAddress: normalizeMac(getXmlValue(xml, ["macAddress"])),
    rawXml: xml,
  };
}

function findInterfaceBlocks(xml) {
  const blocks = [];
  const regex = /<(?:\w+:)?(?:NetworkInterface|Interface)\b[^>]*>[\s\S]*?<\/(?:\w+:)?(?:NetworkInterface|Interface)>/gi;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }

  if (blocks.length === 0) {
    blocks.push(xml);
  }

  return blocks;
}

function parseNetworkInterfaces(xml) {
  const item = parseNetworkConfig(xml);
  return [{
    id: String(item.interfaceId || ""),
    ipVersion: item.ipVersion,
    ipAddress: item.ipAddress,
    subnetMask: item.subnetMask,
    gateway: item.gateway,
    primaryDns: item.primaryDns,
    secondaryDns: item.secondaryDns,
    dhcpMode: item.addressingType,
    macAddress: item.macAddress,
    rawXml: xml,
  }];
}

function getSubnetPrefix(ipAddress) {
  const parts = String(ipAddress || "")
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : null;
}

function inferGateway(ipAddress, currentGateway, overrideGateway) {
  if (overrideGateway && overrideGateway.trim()) {
    return overrideGateway.trim();
  }

  if (currentGateway && currentGateway !== "-") {
    return currentGateway;
  }

  const prefix = getSubnetPrefix(ipAddress);
  return prefix ? `${prefix}.1` : currentGateway || "";
}

function updateNetworkXml(rawXml, { gatewayOverride, dns1, dns2, enableDhcp }) {
  const blocks = findInterfaceBlocks(rawXml);
  let updated = rawXml;

  for (const block of blocks) {
    const ipAddress = getXmlValue(block, ["ipAddress", "ipv4Address", "IPAddress"]);
    const currentGateway = getXmlValue(block, ["DefaultGateway", "defaultGateway", "ipv4DefaultGateway"]);
    const nextGateway = inferGateway(ipAddress, currentGateway, gatewayOverride);

    let nextBlock = block;
    nextBlock = replaceXmlValue(nextBlock, ["DefaultGateway", "defaultGateway", "ipv4DefaultGateway"], nextGateway);
    nextBlock = replaceXmlValue(nextBlock, ["PrimaryDNS", "primaryDNS", "dnsServer1IpAddr", "DNS1"], dns1);
    nextBlock = replaceXmlValue(nextBlock, ["SecondaryDNS", "secondaryDNS", "dnsServer2IpAddr", "DNS2"], dns2);

    if (enableDhcp) {
      nextBlock = replaceXmlValue(nextBlock, ["ipAddressingType", "addressingType"], "dynamic");
      nextBlock = replaceXmlValue(nextBlock, ["DHCP", "dhcp"], "true");
    }

    updated = updated.replace(block, nextBlock);
  }

  return updated;
}

function parseEzvizStatus(xml) {
  const enabledRaw = getXmlValue(xml, ["enabled"]).toLowerCase();
  const registerRaw = getXmlValue(xml, ["registerStatus"]).toLowerCase();
  return {
    enabled: ["true", "1"].includes(enabledRaw) ? true : ["false", "0"].includes(enabledRaw) ? false : null,
    registerStatus:
      ["true", "1"].includes(registerRaw) ? true : ["false", "0"].includes(registerRaw) ? false : null,
  };
}

function parseDeviceTimeConfig(xml) {
  const localTime =
    getXmlValue(xml, ["localTime", "LocalTime", "deviceTime"]) ||
    getXmlValue(xml, ["time", "Time"]);
  const timeZone = getXmlValue(xml, ["timeZone", "TimeZone", "timeZoneInfo"]);
  const timeMode = getXmlValue(xml, ["timeMode", "TimeMode", "timeModeType"]).toLowerCase();
  const ntpEnabledRaw = getXmlValue(xml, ["enabled", "ntpEnabled", "autoSync"]);
  const ntpServer = getXmlValue(xml, ["hostName", "serverAddress", "ntpServer", "ipAddress"]);

  return {
    localTime,
    timeZone,
    timeMode: timeMode || "",
    ntpEnabled:
      ntpEnabledRaw === ""
        ? null
        : ["true", "1", "yes", "enabled"].includes(String(ntpEnabledRaw).toLowerCase()),
    ntpServer,
  };
}

function normalizeDeviceDateTimeInput(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!match) {
    return "";
  }

  return `${match[1]}T${match[2]}:${match[3]}:${match[4] || "00"}`;
}

function buildDeviceTimeValue(dateTimeLocal, timeZone = "") {
  const normalizedDateTime = normalizeDeviceDateTimeInput(dateTimeLocal);
  if (!normalizedDateTime) {
    return "";
  }

  const normalizedTimeZone = String(timeZone || "").trim();
  const offsetMatch = /([+-])(\d{1,2}):?(\d{2})(?::?(\d{2}))?/.exec(normalizedTimeZone);
  if (!offsetMatch) {
    return normalizedDateTime;
  }

  const [, sign, hourText, minuteText, secondText] = offsetMatch;
  const hour = String(hourText).padStart(2, "0");
  const minute = String(minuteText || "00").padStart(2, "0");
  const second = String(secondText || "00").padStart(2, "0");
  return `${normalizedDateTime}${sign}${hour}:${minute}:${second}`;
}

function updateDeviceTimeXml(xml, { dateTimeLocal, timeZone, timeMode = "manual" }) {
  let updated = xml;
  const normalizedDateTime = normalizeDeviceDateTimeInput(dateTimeLocal);
  if (!normalizedDateTime) {
    throw new Error("Gecerli tarih/saat gerekli.");
  }

  const nextTimeZone = String(timeZone || "").trim();
  const nextLocalTime = buildDeviceTimeValue(normalizedDateTime, nextTimeZone);

  updated = replaceXmlValue(updated, ["localTime", "LocalTime", "deviceTime"], nextLocalTime || normalizedDateTime);
  updated = replaceXmlValue(updated, ["timeMode", "TimeMode", "timeModeType"], timeMode);

  if (nextTimeZone) {
    updated = replaceXmlValue(updated, ["timeZone", "TimeZone", "timeZoneInfo"], nextTimeZone);
  }

  return updated;
}

function hasXmlTag(xml, names) {
  return names.some((name) => new RegExp(`<(?:\\w+:)?${name}\\b`, "i").test(String(xml || "")));
}

function findExistingXmlTagName(xml, names) {
  for (const name of names) {
    if (new RegExp(`<(?:\\w+:)?${name}\\b`, "i").test(String(xml || ""))) {
      return name;
    }
  }
  return "";
}

function updateEzvizXml(xml, verificationCode) {
  const namespaceMatch = /<EZVIZ\b[^>]*xmlns="([^"]+)"/i.exec(xml);
  const namespace = namespaceMatch?.[1] || "http://www.hikvision.com/ver20/XMLSchema";
  const versionMatch = /<EZVIZ\b[^>]*version="([^"]+)"/i.exec(xml);
  const version = versionMatch?.[1] || "2.0";
  const redirectRaw = getXmlValue(xml, ["redirect"]).toLowerCase();
  const redirectValue = ["true", "1"].includes(redirectRaw) ? "true" : "false";
  const serverAddressBlock = getXmlBlock(xml, "serverAddress");

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<EZVIZ version="${escapeXml(version)}" xmlns="${escapeXml(namespace)}">`,
    `  <enabled>true</enabled>`,
    `  <redirect>${redirectValue}</redirect>`,
  ];

  if (serverAddressBlock) {
    lines.push(
      serverAddressBlock
        .split(/\r?\n/)
        .map((line) => `  ${line.trim()}`)
        .join("\n")
    );
  }

  lines.push(`  <verificationCode>${escapeXml(verificationCode)}</verificationCode>`);
  lines.push(`  <streamEncrypteEnabled>false</streamEncrypteEnabled>`);
  lines.push(`  <convergenceCloudEnabled>false</convergenceCloudEnabled>`);
  lines.push(`</EZVIZ>`);

  return lines.join("\n");
}

function createVerificationCode(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let output = "";
  for (const value of bytes) {
    output += alphabet[value % alphabet.length];
  }
  return output;
}

function firstTagValue(xml, names) {
  for (const name of names) {
    const value = getXmlValue(xml, [name]);
    if (value) {
      return value;
    }
  }
  return "";
}

function containsAnyText(value, ...needles) {
  const normalized = String(value || "").toLowerCase();
  return needles.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

function parseSpaceToMb(value) {
  const input = String(value || "").trim();
  if (!input) {
    return null;
  }

  const numeric = Number(input.replace(",", "."));
  if (Number.isFinite(numeric)) {
    return numeric > 1024 * 1024 ? Math.round(numeric / 1024 / 1024) : Math.round(numeric);
  }

  const match = /(-?\d+(?:[.,]\d+)?)\s*([kmgt]?b)?/i.exec(input);
  if (!match) {
    return null;
  }

  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = String(match[2] || "mb").toLowerCase();
  switch (unit) {
    case "kb":
      return Math.round(amount / 1024);
    case "gb":
      return Math.round(amount * 1024);
    case "tb":
      return Math.round(amount * 1024 * 1024);
    case "b":
      return Math.round(amount / 1024 / 1024);
    default:
      return Math.round(amount);
  }
}

function getStorageBlocks(xml) {
  const regex =
    /<(?:\w+:)?(?:hdd|disk|storageMedium|storage|medium)\b[\s\S]*?<\/(?:\w+:)?(?:hdd|disk|storageMedium|storage|medium)>/gi;
  const blocks = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }
  return blocks.length > 0 ? blocks : [xml];
}

function scoreStorageBlock(xml) {
  let score = 0;
  if (containsAnyText(xml, "microsd", "micro sd", "sdcard", "sd card", "tfcard", "tf card", "mmc")) {
    score += 100;
  }
  if (containsAnyText(xml, "emmc")) {
    score += 25;
  }
  if (/<(?:\w+:)?hdd\b/i.test(xml)) {
    score += 20;
  }
  if (firstTagValue(xml, ["capacity", "totalCapacity", "capacityTotal", "diskCapacity", "totalSpace", "size"])) {
    score += 10;
  }
  if (firstTagValue(xml, ["status", "storageStatus", "hddStatus", "state", "statusDescription"])) {
    score += 10;
  }
  return score;
}

function buildStorageStatusText(statusText, formatText, detected, formatted) {
  if (detected === false) {
    return "SD kart algilanmadi";
  }
  if (formatted === false) {
    return "SD kart bicimlendirilmemis";
  }
  const combined = [statusText, formatText].filter(Boolean).join(" / ");
  if (combined) {
    return combined;
  }
  if (detected === true) {
    return "Hazir";
  }
  return "Bilinmiyor";
}

function parseStorageInfo(xml, source = "ISAPI", requestUri = "") {
  const decodedXml = decodeXml(String(xml || ""));
  const blocks = getStorageBlocks(decodedXml);
  const candidate = blocks
    .map((block) => ({ block, score: scoreStorageBlock(block) }))
    .sort((left, right) => right.score - left.score)[0]?.block || decodedXml;
  const hasStorageBlock = blocks.length > 0 && blocks[0] !== decodedXml;

  const statusText = firstTagValue(candidate, [
    "status",
    "storageStatus",
    "hddStatus",
    "state",
    "statusDescription",
    "formatStatus",
    "fileSystemStatus",
    "fileSystemState",
  ]);
  const formatText = firstTagValue(candidate, [
    "formatStatus",
    "fileSystemStatus",
    "fileSystemState",
    "initializeStatus",
    "initializationState",
  ]);
  const rawStatus = [statusText, formatText].filter(Boolean).join(" | ");
  const capacityMb = parseSpaceToMb(
    firstTagValue(candidate, ["capacity", "totalCapacity", "capacityTotal", "diskCapacity", "totalSpace", "size"])
  );
  const freeSpaceMb = parseSpaceToMb(
    firstTagValue(candidate, ["freeSpace", "free", "remainSpace", "residualSpace", "unusedSpace", "freeCapacity"])
  );
  const combined = `${statusText} ${formatText} ${candidate}`.toLowerCase();
  const statusCombined = `${statusText} ${formatText}`.toLowerCase();
  const hasStorageSignals =
    hasStorageBlock ||
    capacityMb !== null ||
    freeSpaceMb !== null ||
    Boolean(statusText) ||
    Boolean(formatText) ||
    /<(?:\w+:)?(?:capacity|totalCapacity|capacityTotal|diskCapacity|totalSpace|size|freeSpace|free|remainSpace|residualSpace|unusedSpace|freeCapacity|status|storageStatus|hddStatus|state|formatStatus|fileSystemStatus|fileSystemState)\b/i.test(
      candidate
    );

  let isDetected = null;
  if (containsAnyText(combined, "nocar", "no card", "notexist", "not exist", "absent", "unplugged", "unmounted")) {
    isDetected = false;
  } else if (hasStorageSignals) {
    isDetected = true;
  }

  let isFormatted = null;
  if (isDetected !== false && hasStorageSignals) {
    if (
      containsAnyText(
        statusCombined,
        "unformat",
        "notformat",
        "not format",
        "uninitialized",
        "needformat",
        "formatrequired",
        "unformatted"
      )
    ) {
      isFormatted = false;
    } else if (containsAnyText(statusCombined, "normal", "ok", "ready", "mounted", "rw", "readwrite", "good")) {
      isFormatted = true;
    } else if (capacityMb !== null && freeSpaceMb !== null && freeSpaceMb <= capacityMb) {
      isFormatted = true;
    }
  }

  const warning =
    isDetected === false
      ? "SD kart algilanmadi"
      : isFormatted === false
        ? "SD kart bicimlendirilmemis"
        : null;

  return {
    source,
    requestUri,
    status: buildStorageStatusText(statusText, formatText, isDetected, isFormatted),
    capacityMb,
    freeSpaceMb,
    isDetected,
    isFormatted,
    warning,
    rawStatus: rawStatus || `Yanitta SD kart bilgisi ayristirilamadi. URI=${requestUri || "-"}`,
    rawXml: decodedXml,
    diskId: firstTagValue(candidate, ["id", "diskID", "diskId", "hddID", "hddNo", "no"]),
    loopEnable: firstTagValue(candidate, ["loopEnable", "recycle", "overwrite"]),
    hasEntries: hasStorageSignals,
  };
}

function extractStorageDiskIds(xml) {
  const blocks = getStorageBlocks(decodeXml(String(xml || "")));
  const ids = [];

  for (const block of blocks) {
    const diskId = firstTagValue(block, ["id", "diskID", "diskId", "hddID", "hddNo", "no"]);
    if (diskId) {
      ids.push(String(diskId).trim());
    }
  }

  return uniqueValues(ids);
}

function buildStorageFormatDiskCandidates(preferredDiskId, storageInfo) {
  const preferred = String(preferredDiskId || "").trim();
  const parsedDiskId = String(storageInfo?.diskId || "").trim();
  const discovered = extractStorageDiskIds(storageInfo?.rawXml || "");
  const candidates = uniqueValues([preferred, parsedDiskId, ...discovered, "1"]);
  return candidates.filter(Boolean);
}

function parseFormatOperationStatus(result) {
  const responseXml = decodeXml(String(result?.data || ""));
  if (!responseXml) {
    return {
      responseXml,
      responseStatus: null,
      accepted: true,
    };
  }

  const responseStatus = parseResponseStatus(responseXml);
  const statusCode = String(responseStatus.statusCode || "").trim();
  const subStatusCode = String(responseStatus.subStatusCode || "").trim().toLowerCase();
  const statusString = String(responseStatus.statusString || "").trim().toLowerCase();
  const description = String(responseStatus.description || "").trim().toLowerCase();
  const accepted =
    !statusCode ||
    statusCode === "1" ||
    (statusCode === "7" && ["rebootrequired", "ok", "success"].includes(subStatusCode)) ||
    containsAnyText(statusString, "ok", "success") ||
    containsAnyText(description, "ok", "success");

  return {
    responseXml,
    responseStatus,
    accepted,
  };
}

function isStorageFormatUnsupportedError(error, attempts = []) {
  const message = sanitizeMessage(error?.message || String(error || ""));
  if (/methodnotallowed|invalid operation/i.test(message)) {
    return true;
  }

  return (Array.isArray(attempts) ? attempts : []).some((attempt) =>
    /methodnotallowed|invalid operation/i.test(
      `${attempt?.error || ""} ${attempt?.responseStatus?.subStatusCode || ""} ${attempt?.responseStatus?.statusString || ""} ${
        attempt?.responseStatus?.description || ""
      }`
    )
  );
}

function isMeaningfulStorageInfo(info) {
  if (!info || typeof info !== "object") {
    return false;
  }

  if (info.isDetected === false || info.isFormatted === false) {
    return true;
  }

  if (info.capacityMb !== null || info.freeSpaceMb !== null) {
    return true;
  }

  if (info.diskId || info.loopEnable) {
    return true;
  }

  if (info.hasEntries) {
    return true;
  }

  return false;
}

async function readStorageViaProxy(deviceId) {
  const requestUris = [
    "/ISAPI/ContentMgmt/Storage/hdd",
    "/ISAPI/ContentMgmt/Storage",
    "/ISAPI/System/Storage",
  ];
  const attempts = [];

  for (const requestUri of requestUris) {
    try {
      const result = await callIsapiProxyPass({
        deviceId,
        method: "GET",
        url: requestUri,
        contentType: "application/xml",
        body: "",
      });
      const xml = decodeXml(String(result.data || ""));
      const responseStatus = parseResponseStatus(xml);
      if (responseStatus.subStatusCode && responseStatus.subStatusCode.toLowerCase() === "notsupport") {
        attempts.push({ requestUri, unsupported: true, responseStatus });
        continue;
      }
      const info = parseStorageInfo(xml, "ISAPI", requestUri);
      attempts.push({
        requestUri,
        unsupported: false,
        meaningful: isMeaningfulStorageInfo(info),
        rawStatus: info.rawStatus,
      });
      if (!isMeaningfulStorageInfo(info)) {
        continue;
      }
      return { info, attempts };
    } catch (error) {
      const message = sanitizeMessage(error?.message || String(error));
      const unsupported =
        /OPEN000550|OPEN000555|notSupport|not support|not found|method not allowed/i.test(message);
      attempts.push({ requestUri, unsupported, message });
      if (!unsupported) {
        throw error;
      }
    }
  }

  return {
    info: {
      source: "ISAPI",
      requestUri: "",
      status: "Bilinmiyor",
      capacityMb: null,
      freeSpaceMb: null,
      isDetected: null,
      isFormatted: null,
      warning: null,
      rawStatus: "Storage endpoint desteklenmiyor veya yanit ayristirilamadi.",
      rawXml: "",
      diskId: "",
      loopEnable: "",
    },
    attempts,
  };
}

function summarizeRecordSetting(recordSetting) {
  const localStorage = recordSetting?.localStorage || {};
  return {
    cameraId: String(recordSetting?.cameraID || ""),
    enableLocalStorage: Number(recordSetting?.enableLocalStorage ?? -1),
    enableCloudStorage: Number(recordSetting?.enableCloudStorage ?? -1),
    scheduleTemplateId: String(localStorage?.scheduleTemplateId || ""),
    recordingStreamType: Number(localStorage?.recordingStreamType ?? -1),
    preRecord: Number(localStorage?.preRecord ?? -1),
    postRecordTime: Number(localStorage?.postRecordTime ?? -1),
    anr: Number(localStorage?.anr ?? -1),
    storageTime: Number(localStorage?.storageTime ?? -1),
  };
}

function getTrackBlocks(xml) {
  const regex = /<(?:\w+:)?Track\b[\s\S]*?<\/(?:\w+:)?Track>/gi;
  const blocks = [];
  let match;
  while ((match = regex.exec(String(xml || ""))) !== null) {
    blocks.push(match[0]);
  }
  return blocks;
}

function extractTagOptValues(xml, names) {
  for (const name of names) {
    const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*\\bopt="([^"]+)"`, "i").exec(xml);
    if (match && match[1]) {
      return match[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function splitTrackDays(trackXml) {
  const matches = [...String(trackXml || "").matchAll(/<(?:\w+:)?DayOfWeek\b[^>]*>([\s\S]*?)<\/(?:\w+:)?DayOfWeek>/gi)];
  return matches.map((item) => decodeXml(String(item[1] || "").trim())).filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function parseBooleanText(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return null;
}

function inferStreamTypeFromSrcUrl(url) {
  const normalized = String(url || "").trim();
  if (!normalized) {
    return "";
  }
  const match = /\/channels\/(\d+)/i.exec(normalized);
  if (!match) {
    return "";
  }
  const channelNumber = Number(match[1]);
  if (!Number.isFinite(channelNumber)) {
    return "";
  }
  const suffix = channelNumber % 100;
  if (suffix === 1) {
    return "1";
  }
  if (suffix === 2) {
    return "2";
  }
  return "";
}

function extractScheduleBoundaryTime(trackXml, boundaryTagNames) {
  for (const tagName of boundaryTagNames) {
    const match = new RegExp(
      `<(?:\\w+:)?${tagName}\\b[^>]*>[\\s\\S]*?<TimeOfDay>([\\s\\S]*?)<\\/(?:\\w+:)?TimeOfDay>[\\s\\S]*?<\\/(?:\\w+:)?${tagName}>`,
      "i"
    ).exec(String(trackXml || ""));
    if (match && match[1] != null) {
      return decodeXml(String(match[1] || "").trim());
    }
  }
  return "";
}

function replaceScheduleBoundaryTime(trackXml, boundaryTagNames, nextTime) {
  let updated = String(trackXml || "");
  let replacedAny = false;

  for (const tagName of boundaryTagNames) {
    const regex = new RegExp(
      `(<(?:\\w+:)?${tagName}\\b[^>]*>[\\s\\S]*?<TimeOfDay>)([\\s\\S]*?)(<\\/(?:\\w+:)?TimeOfDay>[\\s\\S]*?<\\/(?:\\w+:)?${tagName}>)`,
      "gi"
    );
    if (regex.test(updated)) {
      updated = updated.replace(regex, `$1${escapeXml(nextTime)}$3`);
      replacedAny = true;
    }
  }

  return {
    updated,
    replacedAny,
  };
}

function getScheduleActionBlocks(trackXml) {
  const matches = [...String(trackXml || "").matchAll(/<(?:\w+:)?ScheduleAction\b[\s\S]*?<\/(?:\w+:)?ScheduleAction>/gi)];
  return matches.map((item) => item[0]);
}

function parseTrackScheduleActions(trackXml) {
  return getScheduleActionBlocks(trackXml)
    .map((blockXml) => {
      const slotId = firstTagValue(blockXml, ["id"]);
      const dayOfWeek = firstTagValue(blockXml, ["DayOfWeek"]);
      const startTime =
        extractScheduleBoundaryTime(blockXml, ["ScheduleActionStartTime", "scheduleActionStartTime"]) || "00:00:00";
      const endTime =
        extractScheduleBoundaryTime(blockXml, ["ScheduleActionEndTime", "scheduleActionEndTime"]) || "00:00:00";
      const recordRaw = firstTagValue(blockXml, ["Record"]);
      const recordEnabled = parseBooleanText(recordRaw);
      const recordModeRaw = firstTagValue(blockXml, ["ActionRecordingMode", "recordingMode", "recordType"]);
      const recordMode = inferRecordMode(recordModeRaw);
      const active =
        recordEnabled !== false &&
        Boolean(dayOfWeek) &&
        !(normalizeTimeOfDayValue(startTime, "00:00:00") === "00:00:00" && normalizeTimeOfDayValue(endTime, "00:00:00") === "00:00:00");

      return {
        id: slotId,
        dayOfWeek,
        startTime,
        endTime,
        recordEnabled: recordEnabled !== false,
        recordModeRaw,
        recordMode,
        recordModeLabel: mapRecordModeLabel(recordMode),
        active,
      };
    })
    .filter((item) => item.id && item.dayOfWeek);
}

function normalizeScheduleActionsInput(scheduleActions) {
  if (!Array.isArray(scheduleActions)) {
    return [];
  }

  return scheduleActions
    .map((item) => {
      const dayOfWeek = String(item?.dayOfWeek || "").trim();
      const id = String(item?.id || "").trim();
      const enabled = item?.enabled === undefined ? true : Boolean(item.enabled);
      return {
        id,
        dayOfWeek,
        enabled,
        recordMode: String(item?.recordMode || "").trim().toLowerCase(),
        startTime: enabled ? normalizeTimeOfDayValue(item?.startTime || "00:00:00") : "00:00:00",
        endTime: enabled ? normalizeTimeOfDayValue(item?.endTime || "00:00:00") : "00:00:00",
      };
    })
    .filter((item) => item.id && item.dayOfWeek);
}

function patchTrackScheduleActions(trackXml, trackInfo, scheduleActionsInput) {
  const normalizedActions = normalizeScheduleActionsInput(scheduleActionsInput);
  if (!normalizedActions.length) {
    return {
      updated: String(trackXml || ""),
      unsupportedFields: [],
    };
  }

  const actionMap = new Map(normalizedActions.map((item) => [`${item.dayOfWeek}#${item.id}`, item]));
  const supportedModes = new Map();
  let updated = String(trackXml || "");
  let replacedAny = false;
  const unsupportedFields = [];

  updated = updated.replace(/<(?:\w+:)?ScheduleAction\b[\s\S]*?<\/(?:\w+:)?ScheduleAction>/gi, (blockXml) => {
    const slotId = firstTagValue(blockXml, ["id"]);
    const dayOfWeek = firstTagValue(blockXml, ["DayOfWeek"]);
    const key = `${dayOfWeek}#${slotId}`;
    const nextAction = actionMap.get(key);
    if (!nextAction) {
      return blockXml;
    }

    let nextBlock = String(blockXml);
    const normalizedModeValue =
      nextAction.recordMode && nextAction.enabled ? chooseTrackModeValue(trackInfo, nextAction.recordMode) : "";
    if (nextAction.recordMode && nextAction.enabled && !normalizedModeValue) {
      unsupportedFields.push(`schedule:${key}:recordMode`);
    } else if (normalizedModeValue && hasXmlTag(nextBlock, ["ActionRecordingMode", "recordingMode", "recordType"])) {
      nextBlock = replaceXmlValue(nextBlock, ["ActionRecordingMode", "recordingMode", "recordType"], normalizedModeValue);
      supportedModes.set(key, true);
    }

    const startResult = replaceScheduleBoundaryTime(nextBlock, ["ScheduleActionStartTime", "scheduleActionStartTime"], nextAction.startTime);
    nextBlock = startResult.updated;
    const endResult = replaceScheduleBoundaryTime(nextBlock, ["ScheduleActionEndTime", "scheduleActionEndTime"], nextAction.endTime);
    nextBlock = endResult.updated;

    if (hasXmlTag(nextBlock, ["Record"])) {
      nextBlock = replaceXmlValue(nextBlock, ["Record"], nextAction.enabled ? "true" : "false");
    } else {
      unsupportedFields.push(`schedule:${key}:record`);
    }

    replacedAny = true;
    return nextBlock;
  });

  if (!replacedAny) {
    unsupportedFields.push("scheduleActions");
  }

  return {
    updated,
    unsupportedFields: uniqueValues(unsupportedFields),
  };
}

function inferRecordMode(recordTypeRaw) {
  const value = String(recordTypeRaw || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (["cmr", "continuous", "timing", "alltime", "always"].includes(value)) {
    return "continuous";
  }
  if (["motion", "vmd", "edr", "event", "smart"].includes(value)) {
    return "motion";
  }
  if (["alarm"].includes(value)) {
    return "alarm";
  }
  if (["alarmandmotion"].includes(value)) {
    return "alarmandmotion";
  }
  return value;
}

function mapRecordModeLabel(mode) {
  switch (mode) {
    case "continuous":
      return "7/24";
    case "motion":
      return "Hareket";
    case "alarm":
      return "Alarm";
    case "alarmandmotion":
      return "Hareket + Alarm";
    default:
      return "-";
  }
}

function mapStreamTypeLabel(value) {
  const numeric = Number(value);
  if (numeric === 1) {
    return "Ana akis";
  }
  if (numeric === 2) {
    return "Alt akis";
  }
  return "-";
}

function normalizeTimeOfDayValue(value, fallback = "") {
  const normalized = String(value || fallback || "").trim();
  if (!normalized) {
    throw new Error("Saat alani bos birakilamaz.");
  }

  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!match) {
    throw new Error(`Gecersiz saat formati: ${normalized}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || "00");
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 24 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(`Gecersiz saat degeri: ${normalized}`);
  }
  if (hour === 24 && (minute !== 0 || second !== 0)) {
    throw new Error(`24:00 yalnizca 24:00:00 olarak kullanilabilir: ${normalized}`);
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function parseTrackInfo(trackXml, trackCapabilitiesXml = "") {
  const id = firstTagValue(trackXml, ["id", "trackID"]);
  const enabledRaw = firstTagValue(trackXml, ["enabled", "enable"]);
  const defaultRecordingModeRaw = firstTagValue(trackXml, ["DefaultRecordingMode"]);
  const recordTypeRaw = firstTagValue(trackXml, [
    "ActionRecordingMode",
    "DefaultRecordingMode",
    "recordType",
    "trackType",
    "recordingMode",
  ]);
  const supportedModes = uniqueValues([
    ...extractTagOptValues(trackCapabilitiesXml, ["DefaultRecordingMode"]),
    ...extractTagOptValues(trackCapabilitiesXml, ["ActionRecordingMode"]),
    ...extractTagOptValues(trackCapabilitiesXml, ["recordType", "trackType", "recordingMode"]),
  ]);
  const days = uniqueValues(splitTrackDays(trackXml));
  const startTime =
    extractScheduleBoundaryTime(trackXml, ["ScheduleActionStartTime", "scheduleActionStartTime"]) ||
    firstTagValue(trackXml, ["startTime", "beginTime"]);
  const endTime =
    extractScheduleBoundaryTime(trackXml, ["ScheduleActionEndTime", "scheduleActionEndTime"]) ||
    firstTagValue(trackXml, ["endTime", "stopTime"]);
  const streamTypeRaw = firstTagValue(trackXml, ["StreamType", "streamType", "recordingStreamType", "srcStreamType"]);
  const preRecordRaw = firstTagValue(trackXml, ["PreRecordTimeSeconds", "preRecordTimeSeconds", "PreRecordDuration", "preRecordDuration", "preRecordTime", "preRecord"]);
  const postRecordRaw = firstTagValue(trackXml, ["PostRecordTimeSeconds", "postRecordTimeSeconds", "PostRecordDuration", "postRecordDuration", "postRecordTime", "postRecord"]);
  const loopEnableRaw = firstTagValue(trackXml, ["LoopEnable", "loopEnable", "overwrite", "recycle"]);
  const enableScheduleRaw = firstTagValue(trackXml, ["enableSchedule"]);
  const srcUrl = firstTagValue(trackXml, ["SrcUrl", "srcUrl"]);
  const srcUrlOptions = extractTagOptValues(trackCapabilitiesXml, ["SrcUrl", "srcUrl"]);
  const inferredStreamType = streamTypeRaw || inferStreamTypeFromSrcUrl(srcUrl);
  const normalizedMode = inferRecordMode(recordTypeRaw);
  const scheduleActions = parseTrackScheduleActions(trackXml);
  return {
    id,
    enabledRaw,
    enabled:
      enabledRaw === ""
        ? null
        : ["true", "1", "yes", "on", "enabled"].includes(enabledRaw.toLowerCase())
          ? true
          : ["false", "0", "no", "off", "disabled"].includes(enabledRaw.toLowerCase())
            ? false
            : null,
    defaultRecordingModeRaw,
    recordTypeRaw,
    recordMode: normalizedMode,
    recordModeLabel: mapRecordModeLabel(normalizedMode),
    supportedModes,
    days,
    startTime,
    endTime,
    streamTypeRaw: inferredStreamType,
    streamTypeLabel: mapStreamTypeLabel(inferredStreamType),
    sourceUrl: srcUrl,
    sourceUrlOptions: srcUrlOptions,
    preRecordRaw,
    postRecordRaw,
    loopEnableRaw,
    loopEnable: parseBooleanText(loopEnableRaw),
    enableScheduleRaw,
    enableSchedule: parseBooleanText(enableScheduleRaw),
    scheduleActions,
    rawXml: decodeXml(String(trackXml || "")),
  };
}

function parseTrackListInfo(trackListXml, capabilityXmlMap = {}) {
  const tracks = getTrackBlocks(trackListXml).map((trackXml) =>
    parseTrackInfo(trackXml, capabilityXmlMap[firstTagValue(trackXml, ["id", "trackID"])] || "")
  );
  return {
    tracks,
    firstTrack: tracks[0] || null,
  };
}

async function readContentMgmtCapabilities(deviceId) {
  return callIsapiProxyPass({
    deviceId,
    method: "GET",
    url: "/ISAPI/ContentMgmt/capabilities",
    contentType: "application/xml",
    body: "",
  });
}

async function readRecordTracks(deviceId) {
  return callIsapiProxyPass({
    deviceId,
    method: "GET",
    url: "/ISAPI/ContentMgmt/record/tracks",
    contentType: "application/xml",
    body: "",
  });
}

async function readRecordTrackCapabilities(deviceId, trackId) {
  return callIsapiProxyPass({
    deviceId,
    method: "GET",
    url: `/ISAPI/ContentMgmt/record/tracks/${encodeURIComponent(trackId)}/capabilities`,
    contentType: "application/xml",
    body: "",
  });
}

async function readRecordTrack(deviceId, trackId) {
  return callIsapiProxyPass({
    deviceId,
    method: "GET",
    url: `/ISAPI/ContentMgmt/record/tracks/${encodeURIComponent(trackId)}`,
    contentType: "application/xml",
    body: "",
  });
}

async function writeRecordTrack(deviceId, trackId, xml) {
  return callIsapiProxyPass({
    deviceId,
    method: "PUT",
    url: `/ISAPI/ContentMgmt/record/tracks/${encodeURIComponent(trackId)}`,
    contentType: "application/xml",
    body: xml,
  });
}

function chooseContinuousModeValue(trackInfo) {
  return chooseSupportedTrackModeValue(trackInfo, "continuous");
}

function chooseMotionModeValue(trackInfo) {
  return chooseSupportedTrackModeValue(trackInfo, "motion");
}

function chooseAlarmModeValue(trackInfo) {
  return chooseSupportedTrackModeValue(trackInfo, "alarm");
}

function chooseAlarmAndMotionModeValue(trackInfo) {
  return chooseSupportedTrackModeValue(trackInfo, "alarmandmotion");
}

function chooseSupportedTrackModeValue(trackInfo, requestedMode) {
  const supported = Array.isArray(trackInfo?.supportedModes) ? trackInfo.supportedModes : [];
  const exactSupportedMatch = supported.find((item) => inferRecordMode(item) === requestedMode);
  if (exactSupportedMatch) {
    return String(exactSupportedMatch).trim();
  }

  const currentCandidates = [
    trackInfo?.recordTypeRaw,
    trackInfo?.defaultRecordingModeRaw,
  ];
  for (const candidate of currentCandidates) {
    const normalizedCandidate = String(candidate || "").trim();
    if (normalizedCandidate && inferRecordMode(normalizedCandidate) === requestedMode) {
      return normalizedCandidate;
    }
  }

  return "";
}

function chooseTrackModeValue(trackInfo, requestedMode) {
  if (requestedMode === "continuous") {
    return chooseContinuousModeValue(trackInfo);
  }
  if (requestedMode === "motion") {
    return chooseMotionModeValue(trackInfo);
  }
  if (requestedMode === "alarm") {
    return chooseAlarmModeValue(trackInfo);
  }
  if (requestedMode === "alarmandmotion") {
    return chooseAlarmAndMotionModeValue(trackInfo);
  }
  return "";
}

function patchTrackEnabled(trackXml, enabled) {
  let updated = String(trackXml || "");
  const enabledTagPresent =
    /<(?:\w+:)?enabled\b/i.test(updated) || /<(?:\w+:)?enable\b/i.test(updated);
  if (!enabledTagPresent) {
    throw new Error("Track XML icinde enabled/enable alani bulunamadi.");
  }

  updated = replaceXmlValue(updated, ["enabled", "enable"], enabled ? "true" : "false");
  return updated;
}

function patchTrackContinuous(trackXml, trackInfo) {
  let updated = String(trackXml || "");
  const continuousModeValue = chooseContinuousModeValue(trackInfo);
  if (!continuousModeValue) {
    updated = patchTrackEnabled(updated, true);
    return updated;
  }

  if (
    !/(<(?:\w+:)?recordType\b|<(?:\w+:)?trackType\b|<(?:\w+:)?recordingMode\b)/i.test(updated)
  ) {
    throw new Error("Track XML icinde record type alani bulunamadi.");
  }

  updated = patchTrackEnabled(updated, true);
  updated = replaceXmlValue(
    updated,
    ["ActionRecordingMode", "DefaultRecordingMode", "recordType", "trackType", "recordingMode"],
    continuousModeValue
  );

  const startResult = replaceScheduleBoundaryTime(updated, ["ScheduleActionStartTime", "scheduleActionStartTime"], "00:00:00");
  updated = startResult.updated;
  const endResult = replaceScheduleBoundaryTime(updated, ["ScheduleActionEndTime", "scheduleActionEndTime"], "24:00:00");
  updated = endResult.updated;
  const replacedAnyTime = startResult.replacedAny || endResult.replacedAny;

  if (!replacedAnyTime) {
    throw new Error("Track XML icinde 7/24 icin guncellenebilir zaman alanlari bulunamadi.");
  }

  return updated;
}

function patchTrackScheduleTimes(trackXml, startTime, endTime) {
  let updated = String(trackXml || "");
  const startResult = replaceScheduleBoundaryTime(updated, ["ScheduleActionStartTime", "scheduleActionStartTime"], startTime);
  updated = startResult.updated;
  const endResult = replaceScheduleBoundaryTime(updated, ["ScheduleActionEndTime", "scheduleActionEndTime"], endTime);
  updated = endResult.updated;
  let replacedAny = startResult.replacedAny || endResult.replacedAny;

  if (!replacedAny) {
    const replacements = [
      ["startTime", startTime],
      ["beginTime", startTime],
      ["endTime", endTime],
      ["stopTime", endTime],
    ];

    for (const [tagName, value] of replacements) {
      if (hasXmlTag(updated, [tagName])) {
        updated = replaceXmlValue(updated, [tagName], value);
        replacedAny = true;
      }
    }
  }

  if (!replacedAny) {
    throw new Error("Track XML icinde guncellenebilir zaman alanlari bulunamadi.");
  }

  return updated;
}

function patchTrackConfiguration(trackXml, trackInfo, input) {
  let updated = String(trackXml || "");
  const unsupportedFields = [];

  if (typeof input.enabled === "boolean") {
    updated = patchTrackEnabled(updated, input.enabled);
  }

  if (input.recordMode) {
    const modeValue = chooseTrackModeValue(trackInfo, input.recordMode);
    if (
      !modeValue ||
      !hasXmlTag(updated, ["ActionRecordingMode", "DefaultRecordingMode", "recordType", "trackType", "recordingMode"])
    ) {
      unsupportedFields.push("recordMode");
    } else {
      updated = replaceXmlValue(
        updated,
        ["ActionRecordingMode", "DefaultRecordingMode", "recordType", "trackType", "recordingMode"],
        modeValue
      );
    }
  }

  if (input.overwriteEnabled !== undefined && input.overwriteEnabled !== null) {
    if (!hasXmlTag(updated, ["LoopEnable", "loopEnable", "overwrite", "recycle"])) {
      unsupportedFields.push("overwriteEnabled");
    } else {
      updated = replaceXmlValue(
        updated,
        ["LoopEnable", "loopEnable", "overwrite", "recycle"],
        input.overwriteEnabled ? "true" : "false"
      );
    }
  }

  if (input.enableSchedule !== undefined && input.enableSchedule !== null) {
    if (!hasXmlTag(updated, ["enableSchedule"])) {
      unsupportedFields.push("enableSchedule");
    } else {
      updated = replaceXmlValue(updated, ["enableSchedule"], input.enableSchedule ? "true" : "false");
    }
  }

  const nextStartTime = input.startTime ? normalizeTimeOfDayValue(input.startTime, trackInfo?.startTime) : "";
  const nextEndTime = input.endTime ? normalizeTimeOfDayValue(input.endTime, trackInfo?.endTime) : "";
  if (nextStartTime || nextEndTime) {
    if (
      hasXmlTag(updated, ["ScheduleActionStartTime", "scheduleActionStartTime", "startTime", "beginTime"]) ||
      hasXmlTag(updated, ["ScheduleActionEndTime", "scheduleActionEndTime", "endTime", "stopTime"])
    ) {
      updated = patchTrackScheduleTimes(
        updated,
        nextStartTime || normalizeTimeOfDayValue(trackInfo?.startTime || "00:00:00"),
        nextEndTime || normalizeTimeOfDayValue(trackInfo?.endTime || "24:00:00")
      );
    } else {
      unsupportedFields.push("scheduleTime");
    }
  }

  if (input.streamType !== undefined && input.streamType !== null && input.streamType !== "") {
    const desiredStreamType = String(input.streamType).trim();
    const currentSrcUrl = firstTagValue(updated, ["SrcUrl", "srcUrl"]);
    const supportedSrcUrls = uniqueValues(trackInfo?.sourceUrlOptions || []);
    const matchingSrcUrl = supportedSrcUrls.find((url) => inferStreamTypeFromSrcUrl(url) === desiredStreamType);
    if (matchingSrcUrl && hasXmlTag(updated, ["SrcUrl", "srcUrl"])) {
      updated = replaceXmlValue(updated, ["SrcUrl", "srcUrl"], matchingSrcUrl);
    } else if (!hasXmlTag(updated, ["StreamType", "streamType", "recordingStreamType", "srcStreamType"])) {
      unsupportedFields.push("streamType");
    } else {
      updated = replaceXmlValue(
        updated,
        ["StreamType", "streamType", "recordingStreamType", "srcStreamType"],
        desiredStreamType
      );
    }
  }

  if (input.preRecordSeconds !== undefined && input.preRecordSeconds !== null && input.preRecordSeconds !== "") {
    const normalizedPreRecord = Number(input.preRecordSeconds);
    if (!Number.isFinite(normalizedPreRecord) || normalizedPreRecord < 0) {
      throw new Error("Pre-record saniye degeri 0 veya daha buyuk bir sayi olmali.");
    }
    if (
      !hasXmlTag(updated, [
        "PreRecordTimeSeconds",
        "preRecordTimeSeconds",
        "PreRecordDuration",
        "preRecordDuration",
        "preRecordTime",
        "preRecord",
      ])
    ) {
      unsupportedFields.push("preRecordSeconds");
    } else {
      updated = replaceXmlValue(
        updated,
        ["PreRecordTimeSeconds", "preRecordTimeSeconds", "PreRecordDuration", "preRecordDuration", "preRecordTime", "preRecord"],
        String(Math.round(normalizedPreRecord))
      );
    }
  }

  if (input.postRecordSeconds !== undefined && input.postRecordSeconds !== null && input.postRecordSeconds !== "") {
    const normalizedPostRecord = Number(input.postRecordSeconds);
    if (!Number.isFinite(normalizedPostRecord) || normalizedPostRecord < 0) {
      throw new Error("Post-record saniye degeri 0 veya daha buyuk bir sayi olmali.");
    }
    if (
      !hasXmlTag(updated, [
        "PostRecordTimeSeconds",
        "postRecordTimeSeconds",
        "PostRecordDuration",
        "postRecordDuration",
        "postRecordTime",
        "postRecord",
      ])
    ) {
      unsupportedFields.push("postRecordSeconds");
    } else {
      updated = replaceXmlValue(
        updated,
        ["PostRecordTimeSeconds", "postRecordTimeSeconds", "PostRecordDuration", "postRecordDuration", "postRecordTime", "postRecord"],
        String(Math.round(normalizedPostRecord))
      );
    }
  }

  if (Array.isArray(input.scheduleActions) && input.scheduleActions.length) {
    const schedulePatch = patchTrackScheduleActions(updated, trackInfo, input.scheduleActions);
    updated = schedulePatch.updated;
    unsupportedFields.push(...schedulePatch.unsupportedFields);
  }

  return {
    updated,
    unsupportedFields: uniqueValues(unsupportedFields),
  };
}

function listWritableRecordTracks(recordingState) {
  return Array.isArray(recordingState?.trackList)
    ? recordingState.trackList.filter((track) => String(track?.id || "").trim())
    : [];
}

function buildTrackStateMap(recordingState) {
  const map = new Map();
  for (const track of Array.isArray(recordingState?.trackList) ? recordingState.trackList : []) {
    const trackId = String(track?.id || "").trim();
    if (!trackId) {
      continue;
    }
    map.set(trackId, track);
  }
  return map;
}

function buildLocalRecordChangeSummary(input, before, after, targetTrackIds) {
  const beforeMap = buildTrackStateMap(before);
  const afterMap = buildTrackStateMap(after);
  const requestedFields = [];
  const unchangedFields = [];

  const trackIds = Array.isArray(targetTrackIds) ? targetTrackIds.map((item) => String(item || "").trim()).filter(Boolean) : [];

  const everyTrackMatches = (predicate) =>
    trackIds.length > 0 &&
    trackIds.every((trackId) => {
      const afterTrack = afterMap.get(trackId);
      return afterTrack ? predicate(afterTrack, beforeMap.get(trackId) || null) : false;
    });

  if (typeof input.enabled === "boolean") {
    requestedFields.push("enabled");
    if (!everyTrackMatches((afterTrack) => afterTrack.enabled === input.enabled)) {
      unchangedFields.push("enabled");
    }
  }

  if (input.recordMode) {
    requestedFields.push("recordMode");
    if (!everyTrackMatches((afterTrack) => afterTrack.recordMode === input.recordMode)) {
      unchangedFields.push("recordMode");
    }
  }

  if (input.streamType !== undefined && input.streamType !== null && input.streamType !== "") {
    requestedFields.push("streamType");
    if (!everyTrackMatches((afterTrack) => String(afterTrack.streamTypeRaw || "") === String(input.streamType))) {
      unchangedFields.push("streamType");
    }
  }

  if (input.overwriteEnabled !== undefined && input.overwriteEnabled !== null) {
    requestedFields.push("overwriteEnabled");
    if (!everyTrackMatches((afterTrack) => afterTrack.loopEnable === Boolean(input.overwriteEnabled))) {
      unchangedFields.push("overwriteEnabled");
    }
  }

  if (input.enableSchedule !== undefined && input.enableSchedule !== null) {
    requestedFields.push("enableSchedule");
    if (!everyTrackMatches((afterTrack) => afterTrack.enableSchedule === Boolean(input.enableSchedule))) {
      unchangedFields.push("enableSchedule");
    }
  }

  if (input.startTime) {
    requestedFields.push("startTime");
    const expected = normalizeTimeOfDayValue(input.startTime);
    if (!everyTrackMatches((afterTrack) => normalizeTimeOfDayValue(afterTrack.startTime || "00:00:00") === expected)) {
      unchangedFields.push("startTime");
    }
  }

  if (input.endTime) {
    requestedFields.push("endTime");
    const expected = normalizeTimeOfDayValue(input.endTime);
    if (!everyTrackMatches((afterTrack) => normalizeTimeOfDayValue(afterTrack.endTime || "00:00:00") === expected)) {
      unchangedFields.push("endTime");
    }
  }

  if (input.preRecordSeconds !== undefined && input.preRecordSeconds !== null && input.preRecordSeconds !== "") {
    requestedFields.push("preRecordSeconds");
    if (
      !everyTrackMatches(
        (afterTrack) => Number(afterTrack.preRecordRaw || NaN) === Number(input.preRecordSeconds)
      )
    ) {
      unchangedFields.push("preRecordSeconds");
    }
  }

  if (input.postRecordSeconds !== undefined && input.postRecordSeconds !== null && input.postRecordSeconds !== "") {
    requestedFields.push("postRecordSeconds");
    if (
      !everyTrackMatches(
        (afterTrack) => Number(afterTrack.postRecordRaw || NaN) === Number(input.postRecordSeconds)
      )
    ) {
      unchangedFields.push("postRecordSeconds");
    }
  }

  if (Array.isArray(input.scheduleActions) && input.scheduleActions.length) {
    requestedFields.push("scheduleActions");
    const beforeActionsByTrack = trackIds.map((trackId) => beforeMap.get(trackId)?.scheduleActions || []);
    const afterActionsByTrack = trackIds.map((trackId) => afterMap.get(trackId)?.scheduleActions || []);
    const expectedActiveCount = input.scheduleActions.filter((item) => item && item.enabled).length;
    const anyTrackAppliedSchedule = afterActionsByTrack.some((actions, index) => {
      const beforeActions = beforeActionsByTrack[index] || [];
      const afterEnabledCount = actions.filter((item) => item && item.active).length;
      return afterEnabledCount === expectedActiveCount && JSON.stringify(beforeActions) !== JSON.stringify(actions);
    });
    if (!anyTrackAppliedSchedule) {
      unchangedFields.push("scheduleActions");
    }
  }

  return {
    requestedFields,
    unchangedFields: uniqueValues(unchangedFields),
    allApplied: requestedFields.length > 0 && uniqueValues(unchangedFields).length === 0,
  };
}

async function readRecordingIsapiState(deviceId) {
  const contentMgmtCapabilitiesResult = await readContentMgmtCapabilities(deviceId);
  const contentMgmtCapabilitiesXml = decodeXml(String(contentMgmtCapabilitiesResult.data || ""));
  const tracksResult = await readRecordTracks(deviceId);
  const trackListXml = decodeXml(String(tracksResult.data || ""));
  const trackBlocks = getTrackBlocks(trackListXml);
  const capabilityXmlMap = {};

  for (const trackXml of trackBlocks) {
    const trackId = firstTagValue(trackXml, ["id", "trackID"]);
    if (!trackId) {
      continue;
    }

    try {
      const capabilityResult = await readRecordTrackCapabilities(deviceId, trackId);
      capabilityXmlMap[trackId] = decodeXml(String(capabilityResult.data || ""));
    } catch (error) {
      capabilityXmlMap[trackId] = `ERROR: ${sanitizeMessage(error?.message || String(error))}`;
    }
  }

  const parsedTrackList = parseTrackListInfo(trackListXml, capabilityXmlMap);
  const firstTrack = parsedTrackList.firstTrack;
  return {
    contentMgmtCapabilitiesXml,
    trackListXml,
    trackCapabilitiesXmlMap: capabilityXmlMap,
    trackList: parsedTrackList.tracks,
    firstTrack,
    supportsTrackManagement:
      /record\/tracks/i.test(contentMgmtCapabilitiesXml) || parsedTrackList.tracks.length > 0,
  };
}

async function applyLocalRecordOperation(deviceId, action) {
  const before = await readRecordingIsapiState(deviceId);
  const targetTracks = listWritableRecordTracks(before);
  if (!targetTracks.length) {
    throw new Error("Yazilabilir record track bulunamadi.");
  }
  const operations = [];

  for (const targetTrack of targetTracks) {
    const trackId = String(targetTrack.id || "").trim();
    const currentTrackResult = await readRecordTrack(deviceId, trackId);
    const currentTrackXml = decodeXml(String(currentTrackResult.data || ""));
    const currentTrackInfo = parseTrackInfo(currentTrackXml, before.trackCapabilitiesXmlMap[trackId] || "");

    let nextTrackXml = currentTrackXml;
    if (action === "enable") {
      nextTrackXml = patchTrackEnabled(currentTrackXml, true);
    } else if (action === "disable") {
      nextTrackXml = patchTrackEnabled(currentTrackXml, false);
    } else if (action === "continuous") {
      nextTrackXml = patchTrackContinuous(currentTrackXml, currentTrackInfo);
    } else {
      throw new Error(`Desteklenmeyen local record action: ${action}`);
    }

    const writeResult = await writeRecordTrack(deviceId, trackId, nextTrackXml);
    operations.push({
      trackId,
      currentTrackInfo,
      appliedTrackXml: nextTrackXml,
      writeResult,
    });
  }
  const after = await readRecordingIsapiState(deviceId);
  return {
    action,
    targetTrackIds: targetTracks.map((track) => track.id),
    before,
    operations,
    after,
  };
}

async function applyLocalRecordSettings(deviceId, input) {
  const before = await readRecordingIsapiState(deviceId);
  const targetTracks = listWritableRecordTracks(before);
  if (!targetTracks.length) {
    throw new Error("Yazilabilir record track bulunamadi.");
  }
  const operations = [];
  const allUnsupportedFields = [];

  for (const targetTrack of targetTracks) {
    const trackId = String(targetTrack.id || "").trim();
    const currentTrackResult = await readRecordTrack(deviceId, trackId);
    const currentTrackXml = decodeXml(String(currentTrackResult.data || ""));
    const currentTrackInfo = parseTrackInfo(currentTrackXml, before.trackCapabilitiesXmlMap[trackId] || "");
    const patched = patchTrackConfiguration(currentTrackXml, currentTrackInfo, input || {});
    const writeResult = await writeRecordTrack(deviceId, trackId, patched.updated);

    operations.push({
      trackId,
      currentTrackInfo,
      appliedTrackXml: patched.updated,
      unsupportedFields: patched.unsupportedFields,
      writeResult,
    });
    allUnsupportedFields.push(...patched.unsupportedFields);
  }

  const after = await readRecordingIsapiState(deviceId);
  const changeSummary = buildLocalRecordChangeSummary(input || {}, before, after, targetTracks.map((track) => track.id));
  return {
    targetTrackIds: targetTracks.map((track) => track.id),
    before,
    operations,
    unsupportedFields: uniqueValues(allUnsupportedFields),
    changeSummary,
    after,
  };
}

async function tryFormatStorage(deviceId, diskIds) {
  const normalizedDiskIds = uniqueValues(
    (Array.isArray(diskIds) ? diskIds : [diskIds])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
  const candidateDiskIds = normalizedDiskIds.length ? normalizedDiskIds : ["1"];
  const allAttempts = [];
  let lastError = null;

  for (const normalizedDiskId of candidateDiskIds) {
    const attempts = [
      {
        diskId: normalizedDiskId,
        method: "PUT",
        url: `/ISAPI/ContentMgmt/Storage/hdd/${encodeURIComponent(normalizedDiskId)}/format`,
        contentType: "application/xml",
        body: "",
      },
      {
        diskId: normalizedDiskId,
        method: "POST",
        url: `/ISAPI/ContentMgmt/Storage/hdd/${encodeURIComponent(normalizedDiskId)}/format`,
        contentType: "application/xml",
        body: "",
      },
    ];

    for (const attempt of attempts) {
      try {
        const result = await callIsapiProxyPass({ deviceId, ...attempt });
        const operation = parseFormatOperationStatus(result);
        const summary = {
          diskId: attempt.diskId,
          method: attempt.method,
          url: attempt.url,
          responseStatus: operation.responseStatus,
          accepted: operation.accepted,
        };
        allAttempts.push(summary);
        if (!operation.accepted) {
          throw new Error(
            `SD kart bicimlendirme cihaza ulasti ancak kabul edilmedi. statusCode=${
              operation.responseStatus?.statusCode || "-"
            }, subStatusCode=${operation.responseStatus?.subStatusCode || "-"}, statusString=${
              operation.responseStatus?.statusString || "-"
            }, description=${operation.responseStatus?.description || "-"}`
          );
        }
        return {
          diskId: attempt.diskId,
          result,
          attempt: summary,
          attempts: allAttempts,
          responseXml: operation.responseXml,
        };
      } catch (error) {
        lastError = error;
        allAttempts.push({
          diskId: attempt.diskId,
          method: attempt.method,
          url: attempt.url,
          error: sanitizeMessage(error?.message || String(error)),
        });
      }
    }
  }

  const fallbackError = lastError || new Error("SD kart bicimlendirme istegi basarisiz.");
  fallbackError.formatAttempts = allAttempts;
  throw fallbackError;
}

async function searchCameraRecordings({
  cameraId,
  beginTime,
  endTime,
  pageIndex = 1,
  pageSize = 50,
  targetType = 0,
  timeType = 1,
  onTrace = null,
}) {
  onTrace?.({
    stage: "record.search.request",
    pageIndex,
    pageSize,
    beginTime,
    endTime,
    targetType,
    timeType,
  });

  const data = await postOpenApi("/api/hccgw/video/v1/record/element/search", {
    pageSize,
    pageIndex,
    cameraId,
    filter: {
      timeType,
      beginTime,
      endTime,
      targetType,
    },
  }, { operation: "record.search" });

  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw attachDiagnostic(
      new Error(
        friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "Kayit arama basarisiz."
        )
      ),
      data.__diagnostic
    );
  }

  onTrace?.({
    stage: "record.search.response",
    pageIndex: Number(data?.data?.pageIndex || pageIndex),
    pageSize: Number(data?.data?.pageSize || pageSize),
    recordCount: Array.isArray(data?.data?.recordList) ? data.data.recordList.length : 0,
  });

  return {
    pageIndex: Number(data?.data?.pageIndex || pageIndex),
    pageSize: Number(data?.data?.pageSize || pageSize),
    recordList: Array.isArray(data?.data?.recordList) ? data.data.recordList : [],
  };
}

async function searchAllCameraRecordings({
  cameraId,
  beginTime,
  endTime,
  targetType = 0,
  timeType = 1,
  onTrace = null,
}) {
  const pageSize = 50;
  const segments = [];

  for (let pageIndex = 1; pageIndex <= 20; pageIndex += 1) {
    const page = await searchCameraRecordings({
      cameraId,
      beginTime,
      endTime,
      pageIndex,
      pageSize,
      targetType,
      timeType,
      onTrace,
    });
    segments.push(...page.recordList);
    if (page.recordList.length < pageSize) {
      break;
    }
  }

  return segments;
}

async function searchRecordingCandidates({
  cameraId,
  beginTime,
  endTime,
  onTrace = null,
  targetTypes = [0, 1],
}) {
  const searches = [];

  for (const targetType of targetTypes) {
    onTrace?.({
      stage: "record.search.target.begin",
      targetType,
      beginTime,
      endTime,
    });

    const recordList = await searchAllCameraRecordings({
      cameraId,
      beginTime,
      endTime,
      targetType,
      timeType: 1,
      onTrace,
    });

    const searchResult = {
      targetType,
      targetLabel: targetType === 0 ? "local-device" : "cloud-storage",
      foundSegments: recordList.length,
      recordList,
    };
    searches.push(searchResult);

    onTrace?.({
      stage: "record.search.target.complete",
      targetType,
      foundSegments: recordList.length,
    });

    if (recordList.length > 0) {
      return {
        selectedTargetType: targetType,
        selectedTargetLabel: searchResult.targetLabel,
        recordList,
        searches,
      };
    }
  }

  return {
    selectedTargetType: null,
    selectedTargetLabel: "",
    recordList: [],
    searches,
  };
}

async function requestRecordingExport(cameraId, beginTime, endTime, voiceSwitch = 2, onTrace = null) {
  onTrace?.({
    stage: "video.save.request",
    beginTime,
    endTime,
    voiceSwitch,
  });

  const data = await postOpenApi("/api/hccgw/video/v1/video/save", {
    cameraId,
    beginTime,
    endTime,
    voiceSwitch,
  }, { operation: "video.save" });

  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw attachDiagnostic(
      new Error(
        friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "Kayit export istegi basarisiz."
        )
      ),
      data.__diagnostic
    );
  }

  const taskId = String(data?.data?.taskId || data.taskId || "").trim();
  if (!taskId) {
    throw new Error("video/save yanitinda taskId bulunamadi.");
  }

  onTrace?.({
    stage: "video.save.response",
    taskId,
  });

  return taskId;
}

async function getRecordingDownloadUrl(taskId, onTrace = null) {
  onTrace?.({
    stage: "video.download.url.request",
    taskId,
  });

  const data = await postOpenApi("/api/hccgw/video/v1/video/download/url", { taskId }, { operation: "video.download.url" });
  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw attachDiagnostic(
      new Error(
        friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "Kayit indirme URL bilgisi alinamadi."
        )
      ),
      data.__diagnostic
    );
  }

  onTrace?.({
    stage: "video.download.url.response",
    taskId,
    status: Number(data?.data?.status ?? -1),
    urlCount: Array.isArray(data?.data?.urls) ? data.data.urls.length : 0,
    expireTime: Number(data?.data?.expireTime || 0),
  });

  return {
    status: Number(data?.data?.status ?? -1),
    expireTime: Number(data?.data?.expireTime || 0),
    urls: Array.isArray(data?.data?.urls) ? data.data.urls : [],
  };
}

async function waitForRecordingDownloadUrl(taskId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 180000);
  const pollIntervalMs = Number(options.pollIntervalMs || 3000);
  const startedAt = Date.now();
  let lastResult = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastResult = await getRecordingDownloadUrl(taskId, options.onTrace);
    if (lastResult.status === 0 && lastResult.urls.length > 0) {
      return lastResult;
    }

    if ([2, 3, 4].includes(lastResult.status)) {
      throw new Error(`Kayit dosyasi hazirlanamadi. status=${lastResult.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Kayit indirme URL bekleme zamani doldu. taskId=${taskId}, sonDurum=${JSON.stringify(lastResult)}`
  );
}

async function downloadRecordingFile(downloadUrl, outputPath) {
  const maskedUrl = sanitizeMessage(downloadUrl);
  openApiAuditState.mp4DownloadHosts = [
    ...new Set([...(openApiAuditState.mp4DownloadHosts || []), extractUrlHost(downloadUrl)].filter(Boolean)),
  ].slice(-10);
  recordOpenApiAudit({
    operation: "mp4.download",
    method: "GET",
    url: downloadUrl,
    host: extractUrlHost(downloadUrl),
    responseBody: "",
  });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    const rawBody = await response.text();
    throw attachDiagnostic(
      new Error(`Kayit dosyasi indirilemedi. HTTP ${response.status}`),
      {
        operation: "mp4.download",
        method: "GET",
        url: maskedUrl,
        host: extractUrlHost(downloadUrl),
        statusCode: response.status,
        responseBody: sanitizeMessage(rawBody),
      }
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  ensureDirectory(path.dirname(outputPath));
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

function buildRecordingSyncStatus(cameraId = "") {
  const config = loadRecordingSyncConfig();
  const state = loadRecordingSyncState();
  const camera = String(cameraId || "").trim();
  const matchedCamera = camera ? config.cameras.find((item) => item.cameraId === camera) || null : null;

  return {
    archiveRoot: RECORDING_ARCHIVE_ROOT,
    runInProgress: Boolean(recordingSyncPromise),
    config: {
      enabled: Boolean(config.enabled),
      dailyTime: config.dailyTime,
      lookbackMinutes: Number(config.lookbackMinutes || 0),
      camera: matchedCamera,
    },
    state: {
      lastRunStartedAt: state.lastRunStartedAt,
      lastRunFinishedAt: state.lastRunFinishedAt,
      lastRunStatus: state.lastRunStatus,
      lastRunReason: state.lastRunReason,
      lastError: state.lastError,
      lastDiagnostic: state.lastDiagnostic,
      hostComparison: buildRecordingHostComparison(),
      lastSuccessAt: camera ? state.lastSuccessByCameraId?.[camera] || "" : "",
      recentRuns: state.recentRuns,
    },
  };
}

function normalizeRecordingSyncConfigInput(body) {
  const cameraId = String(body.cameraId || "").trim();
  const deviceId = String(body.deviceId || "").trim();
  const deviceSerial = String(body.deviceSerial || "").trim();
  const name = String(body.name || "").trim();
  const dailyTime = String(body.dailyTime || "").trim();
  const timeParts = parseTimeValue(dailyTime);
  if (!cameraId) {
    throw new Error("cameraId zorunlu.");
  }
  if (!deviceId) {
    throw new Error("deviceId zorunlu.");
  }
  if (!timeParts) {
    throw new Error("dailyTime HH:MM formatinda olmali.");
  }

  const lookbackMinutes = Number(body.lookbackMinutes || 1440);
  if (!Number.isFinite(lookbackMinutes) || lookbackMinutes < 10 || lookbackMinutes > 10080) {
    throw new Error("lookbackMinutes 10 ile 10080 arasinda olmali.");
  }

  return {
    cameraId,
    deviceId,
    deviceSerial,
    name,
    enabled: Boolean(body.enabled),
    dailyTime: timeParts.normalized,
    lookbackMinutes: Math.round(lookbackMinutes),
  };
}

async function runRecordingSync(options = {}) {
  if (recordingSyncPromise) {
    return recordingSyncPromise;
  }

  recordingSyncPromise = (async () => {
    ensureDirectory(RECORDING_ARCHIVE_ROOT);

    const state = loadRecordingSyncState();
    const config = loadRecordingSyncConfig();
    const startedAt = new Date();
    const runId = crypto.randomUUID();
    const requestedCameraId = String(options.cameraId || "").trim();
    const beginTimeOverride = String(options.beginTime || "").trim();
    const endTimeOverride = String(options.endTime || "").trim();
    const fallbackCameras = Array.isArray(options.cameras) ? options.cameras : [];
    const selectedCameras = config.cameras.filter(
      (camera) => camera && camera.cameraId && (!requestedCameraId || camera.cameraId === requestedCameraId)
    );
    if (selectedCameras.length === 0 && fallbackCameras.length > 0) {
      selectedCameras.push(
        ...fallbackCameras.filter(
          (camera) => camera && camera.cameraId && (!requestedCameraId || camera.cameraId === requestedCameraId)
        )
      );
    }

    if (selectedCameras.length === 0) {
      throw new Error("Kayit senkronu icin kayitli kamera bulunamadi.");
    }

    state.activeRun = {
      runId,
      startedAt: startedAt.toISOString(),
      reason: String(options.reason || "manual"),
      cameraIds: selectedCameras.map((camera) => camera.cameraId),
    };
    state.lastRunStartedAt = startedAt.toISOString();
    state.lastRunFinishedAt = "";
    state.lastRunStatus = "running";
    state.lastRunReason = String(options.reason || "manual");
    state.lastError = "";
    state.lastDiagnostic = null;
    saveRecordingSyncState(state);

    const result = {
      runId,
      startedAt: startedAt.toISOString(),
      reason: state.lastRunReason,
      cameras: [],
    };

    try {
      for (const camera of selectedCameras) {
        const lastSuccess = state.lastSuccessByCameraId?.[camera.cameraId] || "";
        const now = new Date();
        const defaultBeginTime = new Date(now.getTime() - Number(config.lookbackMinutes || 1440) * 60 * 1000);
        const beginTime = beginTimeOverride || lastSuccess || formatIsoOffset(defaultBeginTime);
        const endTime = endTimeOverride || formatIsoOffset(now);
        const cameraResult = {
          cameraId: camera.cameraId,
          deviceId: camera.deviceId,
          deviceSerial: camera.deviceSerial,
          name: camera.name || "",
          beginTime,
          endTime,
          foundSegments: 0,
          selectedTargetType: null,
          selectedTargetLabel: "",
          noRecordsFound: false,
          searchSummary: [],
          downloadedSegments: [],
          skippedSegments: [],
          trace: [],
        };
        const traceCameraStep = (entry) => {
          const normalizedEntry = {
            at: new Date().toISOString(),
            ...entry,
          };
          cameraResult.trace.push(normalizedEntry);
          logRecordingSyncStep(runId, camera.cameraId, normalizedEntry.stage || "unknown", normalizedEntry);
        };
        result.cameras.push(cameraResult);

        const searchResult = await searchRecordingCandidates({
          cameraId: camera.cameraId,
          beginTime,
          endTime,
          onTrace: traceCameraStep,
        });
        const recordList = searchResult.recordList;
        cameraResult.foundSegments = recordList.length;
        cameraResult.selectedTargetType = searchResult.selectedTargetType;
        cameraResult.selectedTargetLabel = searchResult.selectedTargetLabel;
        cameraResult.searchSummary = searchResult.searches.map((entry) => ({
          targetType: entry.targetType,
          targetLabel: entry.targetLabel,
          foundSegments: entry.foundSegments,
        }));
        traceCameraStep({
          stage: "record.search.complete",
          foundSegments: recordList.length,
          selectedTargetType: searchResult.selectedTargetType,
          beginTime,
          endTime,
        });

        if (recordList.length === 0) {
          cameraResult.noRecordsFound = true;
          cameraResult.warning =
            "Belirtilen zaman araliginda ne local device ne de cloud storage kaydi bulundu. Bu nedenle video/save ve MP4 indirme asamalarina gecilmedi.";
          continue;
        }

        for (const segment of recordList) {
          const segmentBeginTime = String(segment.beginTime || "").trim();
          const segmentEndTime = String(segment.endTime || "").trim();
          const targetType = Number(segment.targetType || 0);
          if (!segmentBeginTime || !segmentEndTime) {
            continue;
          }

          const fingerprint = createSegmentFingerprint(
            camera.cameraId,
            segmentBeginTime,
            segmentEndTime,
            targetType
          );
          if (state.downloadedSegments[fingerprint]) {
            cameraResult.skippedSegments.push({
              beginTime: segmentBeginTime,
              endTime: segmentEndTime,
              reason: "already-downloaded",
            });
            traceCameraStep({
              stage: "segment.skip",
              beginTime: segmentBeginTime,
              endTime: segmentEndTime,
              reason: "already-downloaded",
            });
            continue;
          }

          const taskId = await requestRecordingExport(
            camera.cameraId,
            segmentBeginTime,
            segmentEndTime,
            2,
            traceCameraStep
          );
          const downloadInfo = await waitForRecordingDownloadUrl(taskId, {
            onTrace: traceCameraStep,
          });
          const outputDir = buildArchiveDirectory(camera);
          const baseName = buildSegmentBaseName(camera, segment);
          const downloadedFiles = [];

          for (const [index, downloadUrl] of downloadInfo.urls.entries()) {
            const extension = path.extname(new URL(downloadUrl).pathname) || ".mp4";
            const fileName =
              downloadInfo.urls.length > 1
                ? `${baseName}_${index + 1}${extension}`
                : `${baseName}${extension}`;
            const outputPath = path.join(outputDir, fileName);
            traceCameraStep({
              stage: "mp4.download.request",
              url: sanitizeMessage(downloadUrl),
              outputPath,
            });
            await downloadRecordingFile(downloadUrl, outputPath);
            traceCameraStep({
              stage: "mp4.download.response",
              url: sanitizeMessage(downloadUrl),
              outputPath,
            });
            downloadedFiles.push(outputPath);
          }

          state.downloadedSegments[fingerprint] = {
            cameraId: camera.cameraId,
            beginTime: segmentBeginTime,
            endTime: segmentEndTime,
            targetType,
            downloadedAt: new Date().toISOString(),
            files: downloadedFiles,
          };
          state.lastSuccessByCameraId[camera.cameraId] = segmentEndTime;
          saveRecordingSyncState(state);

          cameraResult.downloadedSegments.push({
            beginTime: segmentBeginTime,
            endTime: segmentEndTime,
            taskId,
            files: downloadedFiles,
          });
        }
      }

      state.lastRunStatus = "completed";
      state.lastRunFinishedAt = new Date().toISOString();
      state.activeRun = null;
      if (options.scheduleKey) {
        state.lastScheduledRunKey = String(options.scheduleKey);
      }
      mergeRecentRun(state, {
        runId,
        startedAt: result.startedAt,
        finishedAt: state.lastRunFinishedAt,
        status: "completed",
        reason: result.reason,
        cameraCount: result.cameras.length,
      });
      saveRecordingSyncState(state);
      result.finishedAt = state.lastRunFinishedAt;
      result.status = "completed";
      return result;
    } catch (error) {
      state.lastRunStatus = "failed";
      state.lastRunFinishedAt = new Date().toISOString();
      state.activeRun = null;
      state.lastError = sanitizeMessage(error?.message || String(error));
      state.lastDiagnostic = error?.diagnostic
        ? {
            ...error.diagnostic,
            hostComparison: buildRecordingHostComparison(),
          }
        : null;
      mergeRecentRun(state, {
        runId,
        startedAt: result.startedAt,
        finishedAt: state.lastRunFinishedAt,
        status: "failed",
        reason: result.reason,
        error: state.lastError,
      });
      if (state.lastDiagnostic) {
        console.error(
          JSON.stringify({
            scope: "recording-sync-failure",
            runId,
            diagnostic: state.lastDiagnostic,
          })
        );
      }
      saveRecordingSyncState(state);
      throw error;
    }
  })();

  try {
    return await recordingSyncPromise;
  } finally {
    recordingSyncPromise = null;
  }
}

function scheduleRecordingSyncLoop() {
  if (recordingSyncTimer) {
    clearInterval(recordingSyncTimer);
  }

  recordingSyncTimer = setInterval(async () => {
    const config = loadRecordingSyncConfig();
    if (!config.enabled || recordingSyncPromise) {
      return;
    }

    const parsedTime = parseTimeValue(config.dailyTime);
    if (!parsedTime) {
      return;
    }

    const now = new Date();
    const scheduled = new Date(now);
    scheduled.setHours(parsedTime.hour, parsedTime.minute, 0, 0);
    const scheduleKey = `${scheduled.getFullYear()}-${padNumber(scheduled.getMonth() + 1)}-${padNumber(
      scheduled.getDate()
    )}@${parsedTime.normalized}`;
    const state = loadRecordingSyncState();
    if (now < scheduled || state.lastScheduledRunKey === scheduleKey) {
      return;
    }

    try {
      await runRecordingSync({
        reason: "scheduled",
        scheduleKey,
      });
    } catch (error) {
      console.error("Kayit senkronu zamanlanmis calismada hata:", sanitizeMessage(error?.message || String(error)));
    }
  }, 30000);
}

async function requestIsapiXml(cameraIp, pathName, userName, password) {
  const response = await fetchWithDigest({
    cameraIp,
    pathName,
    method: "GET",
    userName,
    password,
  });

  if (!response.ok) {
    const error = new Error(
      `GET ${pathName} basarisiz. HTTP ${response.status}. ${compactResponseText(response.body)}`
    );
    error.status = response.status;
    error.body = response.body;
    error.subStatusCode = extractSubStatusCode(response.body);
    throw error;
  }

  return response.body;
}

async function putIsapiXml(cameraIp, pathName, userName, password, body) {
  const response = await fetchWithDigest({
    cameraIp,
    pathName,
    method: "PUT",
    userName,
    password,
    body,
  });

  if (!response.ok) {
    const error = new Error(
      `PUT ${pathName} basarisiz. HTTP ${response.status}. ${compactResponseText(response.body)}`
    );
    error.status = response.status;
    error.body = response.body;
    error.subStatusCode = extractSubStatusCode(response.body);
    throw error;
  }
}

function compactResponseText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function looksLikeAlreadyActiveActivateStatusFailure(status, body) {
  const normalizedBody = String(body || "").toLowerCase();

  if (status === 401) {
    return normalizedBody.includes("unauthorized") || normalizedBody.includes("authentication error");
  }

  if (status === 404) {
    return normalizedBody.includes("not found") || normalizedBody.includes("can't find process for service");
  }

  if (status === 403) {
    return (
      !normalizedBody.includes("notactivated") &&
      (normalizedBody.includes("invalid operation") || normalizedBody.includes("invalidoperation"))
    );
  }

  return false;
}

async function waitForDeviceInfo(cameraIp, userName, password, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const xml = await requestIsapiXml(cameraIp, "/ISAPI/System/deviceInfo", userName, password);
      return parseDeviceInfo(xml);
    } catch (error) {
      lastError = error;
      await delay(3000);
    }
  }

  throw new Error(
    `Aktivasyon sonrasi 90 saniye boyunca /ISAPI/System/deviceInfo okunamadi. ${lastError ? sanitizeMessage(lastError.message) : ""}`.trim()
  );
}

async function readActivateStatus(cameraIp) {
  const response = await fetch(`http://${cameraIp}/ISAPI/System/activateStatus`, {
    method: "GET",
    headers: { Accept: "application/xml" },
  });
  const body = await response.text();
  return { status: response.status, body };
}

function resolveSdkHelperCommand(command = "activate") {
  if (process.platform === "linux") {
    const linuxHelper = path.join(
      LOCAL_SERVICE_ROOT,
      "native",
      "hik_activation_helper_linux",
      "build",
      "hik_activation_helper"
    );
    const linuxSdkLibDir = path.join(
      LOCAL_SERVICE_ROOT,
      "third_party",
      "hcnetsdk_linux64",
      "EN-HCNetSDKV6.1.9.48_build20230410_linux64",
      "lib"
    );

    return {
      file: linuxHelper,
      args: [],
      env: {
        LD_LIBRARY_PATH: linuxSdkLibDir,
      },
      logDir: path.join(LOCAL_SERVICE_ROOT, "native", "hik_activation_helper_linux", "logs"),
    };
  }

  const dllCandidates = [
    path.join(
      LOCAL_SERVICE_ROOT,
      "src",
      "HikDiscovery",
      "HikSdk.SadpConsole",
      "bin",
      "Release",
      "net9.0-windows",
      "win-x64",
      "HikSdk.SadpConsole.dll"
    ),
    path.join(
      LOCAL_SERVICE_ROOT,
      "src",
      "HikDiscovery",
      "HikSdk.SadpConsole",
      "bin",
      "Release",
      "net8.0-windows",
      "win-x64",
      "HikSdk.SadpConsole.dll"
    ),
  ];

  for (const candidate of dllCandidates) {
    if (fs.existsSync(candidate)) {
      return {
        file: "dotnet",
        args: [candidate, command],
        env: {},
        logDir: path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
      };
    }
  }

  const exeCandidates = [
    path.join(
      LOCAL_SERVICE_ROOT,
      "src",
      "HikDiscovery",
      "HikSdk.SadpConsole",
      "bin",
      "Release",
      "net8.0-windows",
      "win-x64",
      "publish",
      "HikSdk.SadpConsole.exe"
    ),
    path.join(
      LOCAL_SERVICE_ROOT,
      "src",
      "HikDiscovery",
      "HikSdk.SadpConsole",
      "bin",
      "Release",
      "net8.0-windows",
      "win-x64",
      "HikSdk.SadpConsole.exe"
    ),
    path.join(
      LOCAL_SERVICE_ROOT,
      "src",
      "HikDiscovery",
      "HikSdk.SadpConsole",
      "bin",
      "x64",
      "Release",
      "net8.0-windows",
      "win-x64",
      "HikSdk.SadpConsole.exe"
    ),
  ];

  for (const candidate of exeCandidates) {
    if (fs.existsSync(candidate)) {
      return {
        file: candidate,
        args: [command],
        env: {},
        logDir: path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
      };
    }
  }

  return {
    file: "dotnet",
    args: [
      "run",
      "--no-restore",
      "--project",
      path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "HikSdk.SadpConsole.csproj"),
      "-c",
      "Release",
      "--",
      command,
    ],
    env: {},
    logDir: path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
  };
}

async function runSdkHelper(command, namedArgs, secretEnv = {}) {
  const helper = resolveSdkHelperCommand(command);
  if (!fs.existsSync(helper.file) && helper.file !== "dotnet") {
    throw new Error(
      `HCNetSDK helper bulunamadi: ${helper.file}. Linux deploy icin native/hik_activation_helper_linux klasorunde 'make' calistirin.`
    );
  }

  const logDir = helper.logDir;
  const args = [...helper.args];
  for (const [key, value] of Object.entries(namedArgs || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    args.push(`--${key}`, String(value));
  }
  args.push("--logDir", logDir);

  return new Promise((resolve, reject) => {
    const child = spawn(helper.file, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        ...helper.env,
        ...secretEnv,
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const lines = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const jsonLine = lines.reverse().find((item) => item.startsWith("{") && item.endsWith("}"));
      const firstBraceIndex = stdout.indexOf("{");
      const lastBraceIndex = stdout.lastIndexOf("}");
      const jsonPayload =
        jsonLine ||
        (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex
          ? stdout.slice(firstBraceIndex, lastBraceIndex + 1).trim()
          : "");

      if (!jsonPayload) {
        reject(
          new Error(
            `HCNetSDK aktivasyon yardimcisi beklenen JSON yanitini vermedi. exitCode=${code}, stderr=${stderr.trim() || "-"}, stdout=${stdout.trim() || "-"}`
          )
        );
        return;
      }

      try {
        const payload = JSON.parse(jsonPayload);
        resolve(payload);
      } catch (error) {
        reject(
          new Error(
            `HCNetSDK yardimci yaniti parse edilemedi. stderr=${stderr.trim() || "-"}, stdout=${stdout.trim() || "-"}, error=${error.message}`
          )
        );
      }
    });
  });
}

async function activateCameraWithSdk(cameraIp, sdkPort, password) {
  return runSdkHelper(
    "activate",
    {
      ip: cameraIp,
      port: String(sdkPort),
    },
    {
      HIKSDK_ACTIVATE_PASSWORD: password,
    }
  );
}

async function formatStorageWithSdk({ ipAddress, sdkPort, userName, password, diskNumber }) {
  return runSdkHelper(
    "format-disk",
    {
      ip: ipAddress,
      port: String(sdkPort || 8000),
      userName: userName || "admin",
      diskNumber: String(diskNumber || 1),
    },
    {
      HIKSDK_DEVICE_PASSWORD: password,
    }
  );
}

async function limitedSubnetScan({
  originalIpAddress,
  userName,
  password,
  expectedShortSerial,
  expectedMacAddress,
}) {
  const prefix = getSubnetPrefix(originalIpAddress);
  if (!prefix) {
    return null;
  }

  const concurrency = 16;
  let index = 1;
  let found = null;

  async function worker() {
    while (!found && index <= 254) {
      const host = index++;
      const candidateIp = `${prefix}.${host}`;

      try {
        const xml = await requestIsapiXml(candidateIp, "/ISAPI/System/deviceInfo", userName, password);
        const info = parseDeviceInfo(xml);
        if (
          info.shortSerial &&
          info.shortSerial.toLowerCase() === String(expectedShortSerial || "").toLowerCase()
        ) {
          found = candidateIp;
          return;
        }

        if (
          info.macAddress &&
          normalizeMac(info.macAddress) === normalizeMac(expectedMacAddress)
        ) {
          found = candidateIp;
          return;
        }
      } catch {
        // subnet probe failures are expected
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return found;
}

function extractTokenInfo(data) {
  const rawExpireTime = Number(data.data?.expireTime || data.data?.expire || 0);
  const expireTime = Number.isFinite(rawExpireTime)
    ? rawExpireTime > 10_000_000_000
      ? Math.floor(rawExpireTime / 1000)
      : rawExpireTime
    : 0;

  return {
    accessToken: data.data?.accessToken || data.data?.token || null,
    areaDomain: data.data?.areaDomain || null,
    expireTime,
  };
}

async function getToken(forceRefresh = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && tokenCache.accessToken && tokenCache.expireTime - now > 60) {
    return tokenCache;
  }

  const requestUrl = `${INITIAL_SERVER}/api/hccgw/platform/v1/token/get`;
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: APP_KEY, secretKey: APP_SECRET }),
  });

  const rawText = await response.text();
  const data = safeJsonParse(rawText) || {};
  const errorCode = String(data.errorCode || data.code || "");
  recordOpenApiAudit({
    operation: "token.get",
    method: "POST",
    url: requestUrl,
    host: extractUrlHost(requestUrl),
    httpStatus: response.status,
    errorCode,
    responseBody: rawText,
  });
  if (!response.ok || errorCode !== "0") {
    const diagnostic = {
      operation: "token.get",
      method: "POST",
      url: sanitizeMessage(requestUrl),
      host: extractUrlHost(requestUrl),
      statusCode: response.status,
      responseBody: sanitizeMessage(rawText),
    };
    throw attachDiagnostic(
      new Error(
      `Token alinamadi. ${friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Token istegi basarisiz.")}`
      ),
      diagnostic
    );
  }

  tokenCache = extractTokenInfo(data);
  if (tokenCache.areaDomain) {
    openApiAuditState.lastAreaDomainHost = extractUrlHost(tokenCache.areaDomain);
  }
  return tokenCache;
}

function extractStreamTokenInfo(data, fallbackAreaDomain) {
  return {
    appToken: data.data?.appToken || data.data?.accessToken || data.data?.token || null,
    appKey: data.data?.appKey || null,
    streamAreaDomain:
      data.data?.streamAreaDomain ||
      data.data?.ezvizAreaDomain ||
      data.data?.ezvizDomain ||
      data.data?.areaDomain ||
      null,
    areaDomain: data.data?.areaDomain || fallbackAreaDomain || null,
    fetchedAt: Date.now(),
  };
}

async function getStreamToken(forceRefresh = false) {
  const nowMs = Date.now();
  if (
    !forceRefresh &&
    streamTokenCache.appToken &&
    streamTokenCache.streamAreaDomain &&
    nowMs - streamTokenCache.fetchedAt < 10 * 60 * 1000
  ) {
    return streamTokenCache;
  }

  let token = await getToken(forceRefresh);
  const call = async () => {
    const response = await fetch(`${token.areaDomain}/api/hccgw/platform/v1/streamtoken/get`, {
      method: "GET",
      headers: {
        Token: token.accessToken,
      },
    });

    const rawText = await response.text();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error(`streamtoken/get JSON donmedi: ${rawText.slice(0, 300)}`);
    }
    return { response, data };
  };

  let { response, data } = await call();
  let errorCode = String(data.errorCode || data.code || "");
  if (errorCode === "OPEN000007" && !forceRefresh) {
    token = await getToken(true);
    ({ response, data } = await call());
    errorCode = String(data.errorCode || data.code || "");
  }

  if (!response.ok || errorCode !== "0") {
    throw new Error(
      `streamtoken alinamadi. ${friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "JSDecoder stream token istegi basarisiz."
      )}`
    );
  }

  const parsed = extractStreamTokenInfo(data, token.areaDomain);
  if (!parsed.appToken || !parsed.streamAreaDomain) {
    throw new Error("streamtoken yanitinda appToken veya streamAreaDomain eksik.");
  }

  streamTokenCache = parsed;
  return streamTokenCache;
}

function normalizeOpenApiCallOptions(forceRefreshOrOptions) {
  if (typeof forceRefreshOrOptions === "boolean") {
    return { forceRefresh: forceRefreshOrOptions };
  }
  if (forceRefreshOrOptions && typeof forceRefreshOrOptions === "object") {
    return {
      forceRefresh: Boolean(forceRefreshOrOptions.forceRefresh),
      operation: String(forceRefreshOrOptions.operation || "").trim(),
    };
  }
  return { forceRefresh: false };
}

async function postOpenApi(pathName, payload, forceRefreshOrOptions = false) {
  const options = normalizeOpenApiCallOptions(forceRefreshOrOptions);
  const operation = options.operation || pathName;
  let token = await getToken(Boolean(options.forceRefresh));

  const call = async () => {
    const requestUrl = `${token.areaDomain}${pathName}`;
    const baseUrlCheck = analyzeHikConnectBaseUrl(token.areaDomain, pathName);
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: token.accessToken,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    const data = safeJsonParse(rawText) || {};
    const diagnostic = {
      operation,
      method: "POST",
      pathName,
      url: sanitizeMessage(requestUrl),
      host: extractUrlHost(requestUrl),
      areaDomain: sanitizeMessage(token.areaDomain || ""),
      areaDomainHost: extractUrlHost(token.areaDomain),
      statusCode: response.status,
      errorCode: String(data.errorCode || data.code || ""),
      responseBody: sanitizeMessage(rawText),
      baseUrlCheck,
    };

    recordOpenApiAudit({
      operation,
      method: "POST",
      url: requestUrl,
      host: diagnostic.host,
      areaDomain: token.areaDomain,
      areaDomainHost: diagnostic.areaDomainHost,
      httpStatus: response.status,
      errorCode: diagnostic.errorCode,
      responseBody: rawText,
    });

    return { response, data, diagnostic };
  };

  let { response, data, diagnostic } = await call();
  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode === "OPEN000007" && !options.forceRefresh) {
    token = await getToken(true);
    ({ response, data, diagnostic } = await call());
  }

  data.__diagnostic = diagnostic;

  if (!response.ok) {
    const endpointUnavailableMessage =
      diagnostic.baseUrlCheck.issues.length === 0
        ? buildEndpointUnavailableMessage(pathName, response.status)
        : "";
    const baseUrlMessage = diagnostic.baseUrlCheck.issues.length
      ? `Base URL sorunu: ${diagnostic.baseUrlCheck.issues.join(", ")}`
      : "";
    const detailMessage = endpointUnavailableMessage || baseUrlMessage || data.errorMsg || data.msg || "Bilinmeyen hata";
    throw attachDiagnostic(
      new Error(`OpenAPI istegi basarisiz. HTTP ${response.status}. ${detailMessage}`),
      diagnostic
    );
  }

  return data;
}

function toPhysicalResourceDomain(areaDomain) {
  const url = new URL(areaDomain);
  if (url.hostname.includes("hikcentralconnect.com") && !url.hostname.includes("-team.")) {
    url.hostname = url.hostname.replace(/^([^.]+)/, "$1-team");
  }
  return url.origin;
}

async function callIsapiProxyPass({
  deviceId,
  method = "GET",
  url,
  contentType = "application/xml",
  body = "",
}) {
  if (!deviceId) {
    throw new Error("ISAPI proxypass icin deviceId zorunlu.");
  }
  if (!url) {
    throw new Error("ISAPI proxypass icin url zorunlu.");
  }

  const endpoint = "https://isgp-team.hikcentralconnect.com/api/hccgw/proxy/v1/isapi/proxypass";
  const tokenResult = await getToken(false);
  const token =
    typeof tokenResult === "string"
      ? tokenResult
      : tokenResult?.accessToken ??
        tokenResult?.token ??
        tokenResult?.data?.accessToken ??
        tokenResult?.data?.token;

  if (!token || typeof token !== "string") {
    throw new Error(
      `Hikvision token bulunamadi. Token response: ${JSON.stringify(tokenResult)}`
    );
  }

  const cleanToken = token.trim();
  const payload = {
    method: String(method).toUpperCase(),
    url,
    id: String(deviceId),
    contentType,
    body,
  };

  console.log("ISAPI Proxy istegi:", {
    endpoint,
    tokenLength: cleanToken.length,
    payload,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Token: cleanToken,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  console.log("Hikvision HTTP status:", response.status);
  console.log("Hikvision ham cevap:", rawText);

  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(
      `Hikvision JSON olmayan cevap dondurdu. HTTP ${response.status}: ${rawText}`
    );
  }

  const errorCode = String(data.errorCode || data.code || "");
  if (!response.ok || (errorCode && errorCode !== "0")) {
    throw new Error(
      `ISAPI proxypass basarisiz. HTTP=${response.status}, errorCode=${errorCode}, message=${
        data.message || data.msg || data.errorMsg || "Aciklama yok"
      }, data=${data.data || "Data yok"}`
    );
  }

  return data;
}

async function continuousPtzControl({ cameraId, proxyId = "", channelNo = 1, pan = 0, tilt = 0, zoom = 0 }) {
  const effectiveId = String(proxyId || cameraId || "").trim();
  if (!effectiveId) {
    throw new Error("PTZ control icin cameraId veya proxyId zorunlu.");
  }

  const proxyPayload = {
    method: "PUT",
    url: `/ISAPI/PTZCtrl/channels/${Number(channelNo) || 1}/continuous`,
    contentType: "application/xml",
    body:
      `<PTZData version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">` +
      `<pan>${Number(pan) || 0}</pan>` +
      `<tilt>${Number(tilt) || 0}</tilt>` +
      `<zoom>${Number(zoom) || 0}</zoom>` +
      `</PTZData>`,
  };
  try {
    return await callIsapiProxyPass({
      deviceId: effectiveId,
      method: proxyPayload.method,
      url: proxyPayload.url,
      contentType: proxyPayload.contentType,
      body: proxyPayload.body,
    });
  } catch (error) {
    const detail = {
      cameraId: String(cameraId),
      proxyId: String(proxyId || ""),
      effectiveId,
      channelNo: Number(channelNo) || 1,
      pan: Number(pan) || 0,
      tilt: Number(tilt) || 0,
      zoom: Number(zoom) || 0,
    };
    throw new Error(`PTZ control basarisiz. ${error.message} ${JSON.stringify(detail)}`);
  }
}

function toEzvizEnvDomain(areaDomain) {
  if (!areaDomain) {
    return null;
  }

  const hostname = new URL(areaDomain).hostname.toLowerCase();
  if (hostname.startsWith("isgp.")) return "https://isgpopen.ezvizlife.com";
  if (hostname.startsWith("ieu.")) return "https://ieuopen.ezvizlife.com";
  if (hostname.startsWith("iindia.")) return "https://iindiaopen.ezvizlife.com";
  if (hostname.startsWith("ius.")) return "https://iusopen.ezvizlife.com";
  if (hostname.startsWith("isa.")) return "https://isaopen.ezvizlife.com";
  return null;
}

async function disableStreamEncryption({ deviceId, alias }) {
  if (!deviceId) {
    throw new Error("Stream encryption kapatmak icin deviceId bulunamadi.");
  }

  const token = await getToken(false);
  const physicalResourceDomain = toPhysicalResourceDomain(token.areaDomain);
  const payload = {
    singleDevicePutRequest: {
      baseInfo: {
        userName: "",
        alias,
        encryptEnable: 0,
      },
      eventReportConfig: {
        subscribeType: [3],
        enableAppPush: 1,
      },
      timeZoneInfo: {
        ID: 26,
        autoApply: 1,
      },
    },
  };

  const response = await fetch(
    `${physicalResourceDomain}/hcc/resource/v1/physicalresource/devices/${encodeURIComponent(deviceId)}/modify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: token.accessToken,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await response.json();
  const errorCode = String(data.errorCode || data.code || "");
  if (!response.ok || (errorCode && errorCode !== "0")) {
    throw new Error(
      `Stream encryption kapatma istegi basarisiz. ${friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "physicalresource/devices/modify basarisiz."
      )}`
    );
  }

  return data;
}

function isIgnorableStreamEncryptionError(error) {
  const text = String(error?.message || "");
  return text.includes("errorCode=VMS002004");
}

function friendlyOpenApiError(errorCode, fallback) {
  switch (errorCode) {
    case "OPEN000007":
      return "Token hatasi olustu. Backend tokeni bir kez yenileyip tekrar denedi; sorun devam ederse AK/SK ve area domain ayarlarini kontrol edin.";
    case "LAP000001":
      return "Giris parametresi hatasi var.";
    case "EVZ20007":
      return "Cihaz Hik-Connect tarafinda cevrimdisi gorunuyor. Gateway ve DNS ayarlarini kontrol edin.";
    case "EVZ20010":
      return "Verification code hatali.";
    case "EVZ20013":
      return "Cihaz baska bir Hik-Connect hesabina eklenmis.";
    default:
      return `${fallback} (errorCode=${errorCode || "yok"})`;
  }
}

function* enumerateJsonNodes(node) {
  if (node == null) {
    return;
  }

  yield node;

  if (Array.isArray(node)) {
    for (const item of node) {
      yield* enumerateJsonNodes(item);
    }
    return;
  }

  if (typeof node === "object") {
    for (const value of Object.values(node)) {
      yield* enumerateJsonNodes(value);
    }
  }
}

function firstInnerErrorCode(data) {
  for (const node of enumerateJsonNodes(data)) {
    if (node && typeof node === "object" && typeof node.errorCode === "string" && node.errorCode && node.errorCode !== "0") {
      return node.errorCode;
    }
  }

  return "";
}

function extractDeviceId(data) {
  for (const node of enumerateJsonNodes(data)) {
    if (node && typeof node === "object" && typeof node.deviceId === "string" && node.deviceId.trim()) {
      return node.deviceId.trim();
    }
  }

  return "";
}

function parseAreas(data) {
  const areas = [];
  for (const node of enumerateJsonNodes(data.data)) {
    if (
      node &&
      typeof node === "object" &&
      node.areaID != null &&
      node.areaName != null &&
      String(node.areaID).trim() &&
      node.areaName
    ) {
      areas.push({ areaId: String(node.areaID), areaName: String(node.areaName) });
    }
  }

  return areas;
}

function parseCameraChannels(data) {
  const channels = [];
  for (const node of enumerateJsonNodes(data.data)) {
    if (Array.isArray(node)) {
      continue;
    }

    if (node && typeof node === "object" && Array.isArray(node.cameraChannel)) {
      for (const channel of node.cameraChannel) {
        if (!channel || typeof channel !== "object") {
          continue;
        }

        const id = channel.id || channel.channelID || channel.channelId;
        if (!id) {
          continue;
        }

        const areaIds = [];
        for (const child of enumerateJsonNodes(channel)) {
          if (!child || typeof child !== "object") {
            continue;
          }

          if (typeof child.areaID === "string" && child.areaID) {
            areaIds.push(child.areaID);
          }

          if (child.areaID != null && child.areaID !== "") {
            areaIds.push(String(child.areaID));
          }

          if (child.areaId != null && child.areaId !== "") {
            areaIds.push(String(child.areaId));
          }
        }

        channels.push({
          id: String(id),
          areaIds: [...new Set(areaIds)],
        });
      }
    }
  }

  return channels;
}

async function getAreas() {
  const data = await postOpenApi("/api/hccgw/resource/v1/areas/get", {
    pageIndex: 1,
    pageSize: 500,
    filter: {
      parentAreaID: "-1",
      includeSubArea: 1,
    },
  });
  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw new Error(friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Alan listesi alinamadi."));
  }
  const innerError = firstInnerErrorCode(data.data);
  if (innerError) {
    throw new Error(friendlyOpenApiError(innerError, "Alan listesi ic hata dondu."));
  }
  return parseAreas(data);
}

async function ensureArea(areaName) {
  let areas = await getAreas();
  const existing = areas.find((item) => item.areaName.toLowerCase() === areaName.toLowerCase());
  if (existing) {
    return existing;
  }

  const addData = await postOpenApi("/api/hccgw/resource/v1/areas/add", {
    parentAreaID: "-1",
    areaName,
  });

  const addErrorCode = String(addData.errorCode || addData.code || "");
  if (addErrorCode !== "0") {
    throw new Error(friendlyOpenApiError(addErrorCode, addData.errorMsg || addData.msg || "Alan olusturulamadi."));
  }

  const createdArea = parseAreas(addData)[0];
  if (createdArea) {
    return createdArea;
  }

  const createdAreaId =
    addData?.data?.areaID != null && String(addData.data.areaID).trim()
      ? String(addData.data.areaID).trim()
      : addData?.data?.id != null && String(addData.data.id).trim()
        ? String(addData.data.id).trim()
        : "";
  if (createdAreaId) {
    return { areaId: createdAreaId, areaName };
  }

  areas = await getAreas();
  const created = areas.find((item) => item.areaName.toLowerCase() === areaName.toLowerCase());
  if (!created) {
    throw new Error(`Alan olusturuldu ancak tekrar okunamadi. areaName=${areaName}`);
  }

  return created;
}

async function getDeviceDetail(shortSerial) {
  const data = await postOpenApi("/api/hccgw/resource/v1/devicedetail/get", {
    deviceSerialNo: shortSerial,
  });

  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    return {
      exists: false,
      errorCode,
      errorMessage: friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Cihaz detayi alinamadi."),
      deviceId: "",
      cameraChannels: [],
    };
  }

  return {
    exists:
      Boolean(extractDeviceId(data.data)) ||
      Boolean(parseCameraChannels(data).length),
    errorCode: "0",
    errorMessage: "",
    deviceId: extractDeviceId(data.data),
    cameraChannels: parseCameraChannels(data),
  };
}

async function findDeviceIdBySerial(shortSerial) {
  if (!shortSerial) {
    return "";
  }

  const data = await postOpenApi("/api/hccgw/resource/v1/devices/get", {
    pageIndex: 1,
    pageSize: 10,
    deviceCategory: "encodingDevice",
    filter: {
      matchKey: shortSerial,
    },
  });

  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    return "";
  }

  const devices = Array.isArray(data.data?.device) ? data.data.device : [];
  const normalizedSerial = String(shortSerial).trim().toUpperCase();
  const exact = devices.find(
    (item) => String(item?.serialNo || "").trim().toUpperCase() === normalizedSerial
  );

  if (exact?.id) {
    return String(exact.id).trim();
  }

  const first = devices.find((item) => item?.id);
  return first?.id ? String(first.id).trim() : "";
}

async function addDeviceAndImportChannels({ shortSerial, verificationCode, alias, areaId, userName, password }) {
  const existingDetail = await getDeviceDetail(shortSerial);
  let deviceAdded = false;
  let deviceId = existingDetail.deviceId;
  let deviceStatusMessage = "";

  if (!existingDetail.exists) {
    const data = await postOpenApi("/api/hccgw/resource/v1/devices/add", {
      deviceCategory: "encodingDevice",
        deviceInfo: {
          name: alias,
          ezvizSerialNo: shortSerial,
          ezvizVerifyCode: verificationCode,
          userName: String(userName || "").trim(),
          password: String(password || ""),
          streamSecretKey: "",
        },
      importToArea: {
        areaID: areaId,
        enable: "1",
      },
      timeZone: {
        id: "26",
        applyToDevice: "1",
      },
    });

    const errorCode = String(data.errorCode || data.code || "");
    const addDeviceResponse = data.data?.addDeviceResponse || data.data || {};
    const succeeded = Number(addDeviceResponse.succeeded || 0);
    const failed = Number(addDeviceResponse.failed || 0);
    deviceId = extractDeviceId(addDeviceResponse);

    if (errorCode !== "0" || failed !== 0 || succeeded !== 1 || !deviceId) {
      const effectiveErrorCode = firstInnerErrorCode(addDeviceResponse) || errorCode;
      throw new Error(friendlyOpenApiError(effectiveErrorCode, data.errorMsg || data.msg || "Cihaz Team hesabina eklenemedi."));
    }

    deviceAdded = true;
    deviceStatusMessage = "Cihaz eklendi.";
  } else {
    deviceStatusMessage = "Cihaz zaten Team hesabinda vardi; tekrar eklenmedi.";
  }

  const detail = deviceAdded ? await getDeviceDetail(shortSerial) : existingDetail;
  const channels = detail.cameraChannels || [];
  if (channels.length === 0) {
    throw new Error("devicedetail/get yanitinda cameraChannel listesi bulunamadi.");
  }

  let importedChannelCount = 0;
  let channelStatusMessage = "";

  if (deviceAdded) {
    channelStatusMessage =
      "Cihaz importToArea enable=1 ile eklendi; portalda manuel Import Now gerekmiyor.";
  } else {
    const missingChannels = channels.filter(
      (channel) => !channel.areaIds.some((item) => item.toLowerCase() === areaId.toLowerCase())
    );

    for (const channel of missingChannels) {
      const data = await postOpenApi("/api/hccgw/resource/v1/areas/resources/add", {
        areaID: areaId,
        devChannel: [
          {
            resourceName: alias,
            resourceType: "camera",
            channelID: channel.id,
          },
        ],
      });

      const errorCode = String(data.errorCode || data.code || "");
      if (errorCode !== "0") {
        throw new Error(friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Kanal alana aktarilamadi."));
      }

      const innerError = firstInnerErrorCode(data.data);
      if (innerError) {
        throw new Error(friendlyOpenApiError(innerError, "Kanal alana aktarimi ic hata dondu."));
      }

      importedChannelCount += 1;
    }

    channelStatusMessage =
      importedChannelCount > 0
        ? "Kanal alana aktarildi."
        : "Tum kamera kanallari secili alandaydi; tekrar import yapilmadi.";
  }

  return {
    deviceId: deviceId || detail.deviceId || "",
    deviceAdded,
    importedChannelCount,
    totalChannelCount: channels.length,
    deviceStatusMessage,
    channelStatusMessage,
  };
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
    } catch {
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
    const encryptionBlocked = attempts.some((attempt) => attempt.errorCode === "EVZ60019");
    if (encryptionBlocked) {
      err.details.error =
        "HLS adresi alinamadi. Kamera tarafinda stream encryption acik gorunuyor. Dokumana gore HLS/RTMP icin yayin sifrelemesi kapali olmali.";
    } else if (lastAttempt.errorCode) {
      err.details.error = `HLS adresi alinamadi. errorCode: ${lastAttempt.errorCode}`;
    }
  }

  throw err;
}

function normalizePlaybackDateTimeInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized)) {
    return normalized;
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = padNumber(parsed.getMonth() + 1);
    const day = padNumber(parsed.getDate());
    const hour = padNumber(parsed.getHours());
    const minute = padNumber(parsed.getMinutes());
    const second = padNumber(parsed.getSeconds());
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }
  return "";
}

function normalizePlaybackDateTimeToIsoOffset(value) {
  const normalized = normalizePlaybackDateTimeInput(value);
  if (!normalized) {
    return "";
  }

  const parsed = new Date(normalized.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return formatIsoOffset(parsed);
}

function buildDayRangeIsoOffset(dateValue) {
  const trimmed = String(dateValue || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const start = new Date(`${trimmed}T00:00:00`);
  const end = new Date(`${trimmed}T23:59:59`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return {
    beginTime: formatIsoOffset(start),
    endTime: formatIsoOffset(end),
  };
}

async function fetchCameraCatalog(cameraIds = []) {
  const { accessToken, areaDomain } = await getToken();
  const payload = {
    pageIndex: 1,
    pageSize: Math.max(50, Array.isArray(cameraIds) && cameraIds.length ? cameraIds.length : 50),
    filter: {
      areaID: Array.isArray(cameraIds) && cameraIds.length ? "" : "-1",
      includeSubArea: Array.isArray(cameraIds) && cameraIds.length ? "0" : "1",
      cameraID: Array.isArray(cameraIds) && cameraIds.length ? cameraIds : [],
    },
  };

  const response = await fetch(`${areaDomain}/api/hccgw/resource/v1/areas/cameras/get`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: accessToken,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  const errorCode = String(data.errorCode || data.code || "");
  if (!response.ok || errorCode !== "0") {
    throw new Error(
      `Kamera listesi alinamadi. ${friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "areas/cameras/get basarisiz.")}`
    );
  }

  const rawCameras = (data.data?.camera || []).map((cam) => ({
    name: cam.name,
    online: cam.online === "1",
    resourceId: cam.id,
    deviceId: cam.deviceId || cam.device?.id || cam.device?.deviceId || cam.device?.devInfo?.id || null,
    cameraIndexCode: cam.cameraIndexCode || null,
    deviceSerial: cam.device?.devInfo?.serialNo || null,
    streamSecretKey: cam.device?.devInfo?.streamSecretKey || cam.streamSecretKey || null,
    channelNo: cam.device?.channelInfo?.no || cam.device?.channelNo || cam.channelNo || null,
  }));

  return Promise.all(
    rawCameras.map(async (cam) => {
      if (cam.deviceId || !cam.deviceSerial) {
        return cam;
      }

      try {
        const searchedDeviceId = await findDeviceIdBySerial(cam.deviceSerial);
        if (searchedDeviceId) {
          return {
            ...cam,
            deviceId: searchedDeviceId,
          };
        }

        const detail = await getDeviceDetail(cam.deviceSerial);
        return {
          ...cam,
          deviceId: detail.deviceId || cam.deviceId || null,
        };
      } catch {
        return cam;
      }
    })
  );
}

async function requestCameraCapture({
  accessToken,
  areaDomain,
  deviceSerial,
  channelNo,
}) {
  const normalizedChannelNo = normalizeCameraChannelNo(channelNo);
  if (!deviceSerial) {
    throw new Error("Fotograf cekmek icin deviceSerial gerekli.");
  }
  if (!normalizedChannelNo) {
    throw new Error("Fotograf cekmek icin gecerli channelNo gerekli.");
  }

  const payload = {
    deviceSerial: String(deviceSerial),
    channelNo: normalizedChannelNo,
  };

  const response = await fetch(`${areaDomain}/api/hccgw/resource/v1/device/capturePic`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: accessToken,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  const data = safeJsonParse(rawText) || {};
  const errorCode = String(data.errorCode || data.code || "");
  recordOpenApiAudit({
    operation: "camera.capturePic",
    method: "POST",
    url: `${areaDomain}/api/hccgw/resource/v1/device/capturePic`,
    host: extractUrlHost(areaDomain),
    areaDomain,
    httpStatus: response.status,
    errorCode,
    responseBody: rawText,
  });

  const diagnostic = {
    operation: "camera.capturePic",
    method: "POST",
    url: sanitizeMessage(`${areaDomain}/api/hccgw/resource/v1/device/capturePic`),
    host: extractUrlHost(areaDomain),
    statusCode: response.status,
    errorCode,
    responseBody: sanitizeMessage(rawText),
  };

  if (!response.ok || errorCode !== "0") {
    throw attachDiagnostic(
      new Error(
        `Anlik fotograf istegi basarisiz. ${friendlyOpenApiError(
          errorCode,
          data.errorMsg || data.msg || "device/capturePic basarisiz."
        )}`
      ),
      diagnostic
    );
  }

  const captureUrl = String(data.data?.captureUrl || "").trim();
  if (!captureUrl) {
    throw attachDiagnostic(new Error("Anlik fotograf URL'i bos dondu."), diagnostic);
  }
  if (!isTrustedHikCaptureUrl(captureUrl, areaDomain)) {
    throw attachDiagnostic(new Error("Anlik fotograf URL'i guvenilir Hik-Connect alanindan donmedi."), diagnostic);
  }
  if (Number(data.data?.isEncrypted ?? 0) === 1) {
    throw attachDiagnostic(
      new Error("Sifreli fotograf cozme destegi bulunmuyor."),
      diagnostic
    );
  }

  return {
    captureUrl,
    isEncrypted: Number(data.data?.isEncrypted ?? 0),
  };
}

async function requestCameraThumbnail({
  accessToken,
  areaDomain,
  cameraId,
  refresh = 1,
}) {
  if (!cameraId) {
    throw new Error("Thumbnail almak icin cameraId gerekli.");
  }

  const payload = {
    cameraID: String(cameraId),
    refresh: Number(refresh) === 0 ? 0 : 1,
  };

  const response = await fetch(`${areaDomain}/api/hccgw/resource/v1/areas/cameras/thumbnail/get`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: accessToken,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  const data = safeJsonParse(rawText) || {};
  const errorCode = String(data.errorCode || data.code || "");
  recordOpenApiAudit({
    operation: "camera.thumbnail.get",
    method: "POST",
    url: `${areaDomain}/api/hccgw/resource/v1/areas/cameras/thumbnail/get`,
    host: extractUrlHost(areaDomain),
    areaDomain,
    httpStatus: response.status,
    errorCode,
    responseBody: rawText,
  });

  const diagnostic = {
    operation: "camera.thumbnail.get",
    method: "POST",
    url: sanitizeMessage(`${areaDomain}/api/hccgw/resource/v1/areas/cameras/thumbnail/get`),
    host: extractUrlHost(areaDomain),
    statusCode: response.status,
    errorCode,
    responseBody: sanitizeMessage(rawText),
  };

  if (!response.ok || errorCode !== "0") {
    throw attachDiagnostic(
      new Error(
        `Kamera kucuk resmi alinamadi. ${friendlyOpenApiError(
          errorCode,
          data.errorMsg || data.msg || "areas/cameras/thumbnail/get basarisiz."
        )}`
      ),
      diagnostic
    );
  }

  const pictureUrl = String(data.data?.pictureURL || data.data?.pictureUrl || "").trim();
  if (!pictureUrl) {
    throw attachDiagnostic(new Error("Kamera kucuk resim URL'i bos dondu."), diagnostic);
  }
  if (!isTrustedHikCaptureUrl(pictureUrl, areaDomain)) {
    throw attachDiagnostic(new Error("Kamera kucuk resim URL'i guvenilir alandan donmedi."), diagnostic);
  }
  if (Number(data.data?.isEncrypted ?? 0) === 1) {
    throw attachDiagnostic(
      new Error("Sifreli fotograf cozme destegi bulunmuyor."),
      diagnostic
    );
  }

  return {
    captureUrl: pictureUrl,
    isEncrypted: Number(data.data?.isEncrypted ?? 0),
  };
}

async function downloadCameraCaptureBinary(captureUrl, options = {}) {
  const timeoutMs = Number(options.timeoutMs || CAMERA_CAPTURE_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes || CAMERA_CAPTURE_MAX_BYTES);
  const timeoutHandle = createTimeoutSignal(timeoutMs, options.signal || null);
  const normalizedCaptureUrl = normalizeHikCaptureUrl(captureUrl);

  try {
    recordOpenApiAudit({
      operation: "camera.capture.download",
      method: "GET",
      url: normalizedCaptureUrl,
      host: extractUrlHost(normalizedCaptureUrl),
      responseBody: "",
    });

    const response = await fetch(normalizedCaptureUrl, {
      method: "GET",
      signal: timeoutHandle.signal,
    });

    const contentType = String(response.headers.get("content-type") || "").trim();
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!response.ok) {
      const rawBody = await response.text();
      throw attachDiagnostic(new Error(`Anlik fotograf indirilemedi. HTTP ${response.status}`), {
        operation: "camera.capture.download",
        method: "GET",
        url: sanitizeMessage(normalizedCaptureUrl),
        host: extractUrlHost(normalizedCaptureUrl),
        statusCode: response.status,
        responseBody: sanitizeMessage(rawBody),
      });
    }

    if (contentLength > 0 && contentLength > maxBytes) {
      throw new Error(`Anlik fotograf boyutu limiti asiyor. contentLength=${contentLength}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) {
      throw new Error("Anlik fotograf cevabi bos dondu.");
    }
    if (buffer.length > maxBytes) {
      throw new Error(`Anlik fotograf boyutu limiti asiyor. bytes=${buffer.length}`);
    }

    const detectedContentType = sniffImageContentType(buffer);
    if (!detectedContentType) {
      const rawBody = buffer.toString("utf8", 0, Math.min(buffer.length, 512));
      throw attachDiagnostic(new Error("Anlik fotograf istegi gecerli bir resim donmedi."), {
        operation: "camera.capture.download",
        method: "GET",
        url: sanitizeMessage(normalizedCaptureUrl),
        host: extractUrlHost(normalizedCaptureUrl),
        statusCode: response.status,
        responseBody: sanitizeMessage(rawBody),
      });
    }

    if (contentType && !isSupportedImageContentType(contentType)) {
      recordOpenApiAudit({
        operation: "camera.capture.download.contentType.override",
        method: "GET",
        url: normalizedCaptureUrl,
        host: extractUrlHost(normalizedCaptureUrl),
        responseBody: `declared=${contentType}; detected=${detectedContentType}`,
      });
    }

    return {
      contentType: detectedContentType,
      buffer,
      size: buffer.length,
    };
  } finally {
    timeoutHandle.cancel();
  }
}

async function captureCameraSnapshot(camera, options = {}) {
  if (!camera) {
    throw new Error("Kamera bulunamadi.");
  }
  if (!isCameraOnline(camera)) {
    throw new Error("Kamera cevrimdisi.");
  }
  if (!camera.deviceSerial) {
    throw new Error("Kamera deviceSerial bilgisi eksik.");
  }

  const channelNo = normalizeCameraChannelNo(camera.channelNo);
  if (!channelNo) {
    throw new Error("Kamera channelNo bilgisi eksik.");
  }

  const { accessToken, areaDomain } = await getToken(Boolean(options.forceRefresh));
  let capture;
  try {
    capture = await requestCameraCapture({
      accessToken,
      areaDomain,
      deviceSerial: camera.deviceSerial,
      channelNo,
    });
  } catch (error) {
    if (!String(error?.message || "").includes("Sifreli fotograf cozme destegi bulunmuyor")) {
      throw error;
    }

    capture = await requestCameraThumbnail({
      accessToken,
      areaDomain,
      cameraId: camera.resourceId,
      refresh: 1,
    });
  }

  return downloadCameraCaptureBinary(capture.captureUrl, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  });
}

async function requestPlaybackAddress({
  accessToken,
  areaDomain,
  resourceId,
  deviceSerial,
  quality,
  code,
  beginTime,
  endTime,
  preferredTarget = "auto",
}) {
  const candidateTypes =
    preferredTarget === "local"
      ? ["2"]
      : preferredTarget === "cloud"
        ? ["3"]
        : ["2", "3"];
  const candidatePath = "/api/hccgw/video/v1/live/address/get";
  const attempts = [];

  for (const type of candidateTypes) {
    const payload = {
      resourceId,
      deviceSerial,
      type,
      protocol: 1,
      quality,
      expireTime: 600,
      startTime: beginTime,
      stopTime: endTime,
    };

    if (code) {
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
    const parsed = safeJsonParse(rawText);
    attempts.push({
      type,
      targetLabel: type === "2" ? "local-device-playback" : "cloud-storage-playback",
      status: response.status,
      errorCode: parsed?.errorCode || "",
      message: parsed?.errorMsg || parsed?.message || "",
      rawText: parsed ? "" : rawText.slice(0, 300),
    });

    if (response.ok && parsed?.errorCode === "0" && parsed?.data?.url) {
      return {
        url: parsed.data.url,
        expireTime: normalizeUrlExpireTime(parsed.data.expireTime),
        resolvedPath: candidatePath,
        raw: parsed.data,
        attempts,
        selectedType: type,
        selectedTargetLabel: type === "2" ? "local-device-playback" : "cloud-storage-playback",
      };
    }
  }

  const err = new Error("Calisabilir bir playback adresi bulunamadi.");
  err.details = {
    error: err.message,
    attempts,
    requestPayload: {
      resourceId,
      deviceSerial,
      protocol: 1,
      quality,
      codeProvided: Boolean(code),
      startTime: beginTime,
      stopTime: endTime,
      preferredTarget,
    },
    areaDomain,
  };
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

function rewriteManifest(content, manifestUrl, resourceId, deviceSerial, quality) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProvisioningTask(task, input) {
  const normalizedUser = (input.userName || "admin").trim() || "admin";
  const normalizedIp = input.cameraIp.trim();
  const sdkPort = Number(input.sdkPort || 8000);
  const enableDhcp = Boolean(input.enableDhcp);
  const areaName = (input.areaName || "").trim();

  let activeCameraIp = normalizedIp;

  updateTaskStage(task, "Erisim", "Calisiyor", "Kameraya erisim ve aktivasyon durumu kontrol ediliyor.");
  const activateStatusResponse = await readActivateStatus(normalizedIp);
  let isInactive = false;

  if (activateStatusResponse.status === 403) {
    const subStatusCode = extractSubStatusCode(activateStatusResponse.body);
    if (subStatusCode.toLowerCase() === "notactivated") {
      isInactive = true;
      updateTaskStage(task, "Erisim", "Tamam", "Kamera inactive olarak algilandi.");
    } else if (
      looksLikeAlreadyActiveActivateStatusFailure(
        activateStatusResponse.status,
        activateStatusResponse.body
      )
    ) {
      isInactive = false;
      updateTaskStage(
        task,
        "Erisim",
        "Tamam",
        "activateStatus dogrudan okunamadi, cihaz aktif varsayilarak deviceInfo ve Hik-Connect ayarina geciliyor."
      );
    } else {
      throw new Error(
        `Kamera erisimi basarisiz. HTTP 403. subStatusCode=${subStatusCode || "-"}`
      );
    }
  } else if (activateStatusResponse.status >= 200 && activateStatusResponse.status < 300) {
    const activateStatus = parseActivateStatus(activateStatusResponse.body);
    isInactive = activateStatus.isInactive;
    updateTaskStage(
      task,
      "Erisim",
      "Tamam",
      isInactive ? "Kamera inactive olarak algilandi." : "Kamera aktif."
    );
  } else if (
    looksLikeAlreadyActiveActivateStatusFailure(
      activateStatusResponse.status,
      activateStatusResponse.body
    )
  ) {
    isInactive = false;
    updateTaskStage(
      task,
      "Erisim",
      "Tamam",
      `activateStatus HTTP ${activateStatusResponse.status} dondu; cihaz aktif varsayilarak kurulum ve Hik-Connect etkinlestirme adimina devam ediliyor.`
    );
  } else {
    throw new Error(
      `Kamera erisimi basarisiz. HTTP ${activateStatusResponse.status}. ${compactResponseText(
        activateStatusResponse.body
      )}`
    );
  }

  if (isInactive) {
    updateTaskStage(task, "Aktivasyon", "Calisiyor", "HCNetSDK ile kamera aktive ediliyor.");
    const activationResult = await activateCameraWithSdk(normalizedIp, sdkPort, input.password);
    if (!activationResult.success) {
      throw new Error(
        `NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError=${activationResult.errorCode}, Message=${activationResult.errorMessage || "-"}`
      );
    }

    updateTaskStage(task, "Aktivasyon", "Tamam", "Kamera aktive edildi.");
  } else {
    updateTaskStage(task, "Aktivasyon", "Atlandi", "Kamera zaten aktif.");
  }

  updateTaskStage(task, "Cihaz Bilgileri", "Calisiyor", "DeviceInfo, ag bilgileri ve EZVIZ durumu okunuyor.");
  const deviceInfo = isInactive
    ? await waitForDeviceInfo(activeCameraIp, normalizedUser, input.password, 90_000)
    : parseDeviceInfo(await requestIsapiXml(activeCameraIp, "/ISAPI/System/deviceInfo", normalizedUser, input.password));

  const networkXml = await requestIsapiXml(
    activeCameraIp,
    "/ISAPI/System/Network/interfaces",
    normalizedUser,
    input.password
  );
  const ezvizXml = await requestIsapiXml(
    activeCameraIp,
    "/ISAPI/System/Network/EZVIZ",
    normalizedUser,
    input.password
  );
  let networkInterfaces = parseNetworkInterfaces(networkXml);
  const initialEzvizStatus = parseEzvizStatus(ezvizXml);
  updateTaskStage(task, "Cihaz Bilgileri", "Tamam", `Model=${deviceInfo.model || "-"}, Seri=${deviceInfo.shortSerial || "-"}`);

  updateTaskStage(task, "Ag Ayarlari", "Calisiyor", "Gateway ve DNS ayarlari guncelleniyor.");
  const updatedNetworkXml = updateNetworkXml(networkXml, {
    gatewayOverride: input.gatewayOverride || "",
    dns1: "8.8.8.8",
    dns2: "1.1.1.1",
    enableDhcp,
  });
  await putIsapiXml(
    activeCameraIp,
    "/ISAPI/System/Network/interfaces",
    normalizedUser,
    input.password,
    updatedNetworkXml
  );

  if (enableDhcp) {
    const foundIp = await limitedSubnetScan({
      originalIpAddress: activeCameraIp,
      userName: normalizedUser,
      password: input.password,
      expectedShortSerial: deviceInfo.shortSerial,
      expectedMacAddress: deviceInfo.macAddress,
    });

    if (foundIp) {
      activeCameraIp = foundIp;
    }
  }

  const refreshedNetworkXml = await requestIsapiXml(
    activeCameraIp,
    "/ISAPI/System/Network/interfaces",
    normalizedUser,
    input.password
  );
  networkInterfaces = parseNetworkInterfaces(refreshedNetworkXml);
  updateTaskStage(task, "Ag Ayarlari", "Tamam", `Guncel IP=${activeCameraIp}`);

  updateTaskStage(task, "Hik-Connect Ayari", "Calisiyor", "EZVIZ/Hik-Connect servisi etkinlestiriliyor ve registerStatus=true bekleniyor.");
  const verificationCode = createVerificationCode(12);
  const enableEzvizXml = updateEzvizXml(ezvizXml, verificationCode);
  await putIsapiXml(
    activeCameraIp,
    "/ISAPI/System/Network/EZVIZ",
    normalizedUser,
    input.password,
    enableEzvizXml
  );

  const ezvizDeadline = Date.now() + 120_000;
  let finalEzvizStatus = initialEzvizStatus;
  while (Date.now() < ezvizDeadline) {
    await delay(5000);
    const currentXml = await requestIsapiXml(
      activeCameraIp,
      "/ISAPI/System/Network/EZVIZ",
      normalizedUser,
      input.password
    );
    finalEzvizStatus = parseEzvizStatus(currentXml);
    if (finalEzvizStatus.registerStatus === true) {
      break;
    }
  }

  if (finalEzvizStatus.registerStatus !== true) {
    throw new Error(
      "registerStatus iki dakika icinde true olmadi. Gateway ve DNS baglantisini kontrol edin."
    );
  }
  updateTaskStage(task, "Hik-Connect Ayari", "Tamam", "registerStatus=true oldu.");

  updateTaskStage(task, "Team Hesabina Ekleme", "Calisiyor", "Alan bulunuyor/olusturuluyor ve cihaz Team hesabina ekleniyor.");
  const effectiveAreaName = areaName || `CAM-${deviceInfo.shortSerial}`;
  const area = await ensureArea(effectiveAreaName);
  const alias = `CAM-${deviceInfo.shortSerial}`;
  const teamResult = await addDeviceAndImportChannels({
    shortSerial: deviceInfo.shortSerial,
    verificationCode,
    alias,
    areaId: area.areaId,
    userName: normalizedUser,
    password: input.password,
  });
  updateTaskStage(task, "Team Hesabina Ekleme", "Tamam", teamResult.deviceStatusMessage);
  updateTaskStage(task, "Kanal Aktarimi", "Tamam", teamResult.channelStatusMessage);

  updateTaskStage(task, "Tamamlandi", "Tamam", "Kurulum tamamlandi.");
  markTaskSucceeded(task, {
    cameraIp: activeCameraIp,
    model: deviceInfo.model,
    macAddress: deviceInfo.macAddress,
    serialNumber: deviceInfo.serialNumber,
    shortSerial: deviceInfo.shortSerial,
    subSerialNumber: deviceInfo.subSerialNumber,
    firmwareVersion: deviceInfo.firmwareVersion,
    areaId: area.areaId,
    areaName: area.areaName,
    deviceId: teamResult.deviceId,
    alias,
    ezvizEnabled: true,
    registerStatus: true,
    deviceAdded: teamResult.deviceAdded,
    importedChannelCount: teamResult.importedChannelCount,
    totalChannelCount: teamResult.totalChannelCount,
    networkInterfaces,
  });
}

async function runActivationTask(task, input) {
  const normalizedUser = (input.userName || "admin").trim() || "admin";
  const normalizedIp = input.cameraIp.trim();
  const sdkPort = Number(input.sdkPort || 8000);

  updateTaskStage(task, "Erisim", "Calisiyor", "Kameraya erisim ve aktivasyon durumu kontrol ediliyor.");
  const activateStatusResponse = await readActivateStatus(normalizedIp);
  let isInactive = false;

  if (activateStatusResponse.status === 403) {
    const subStatusCode = extractSubStatusCode(activateStatusResponse.body);
    if (subStatusCode.toLowerCase() === "notactivated") {
      isInactive = true;
      updateTaskStage(task, "Erisim", "Tamam", "Kamera inactive olarak algilandi.");
    } else if (
      looksLikeAlreadyActiveActivateStatusFailure(
        activateStatusResponse.status,
        activateStatusResponse.body
      )
    ) {
      isInactive = false;
      updateTaskStage(task, "Erisim", "Tamam", "activateStatus dogrudan okunamadi, cihaz aktif varsayildi.");
    } else {
      throw new Error(
        `Kamera erisimi basarisiz. HTTP 403. subStatusCode=${subStatusCode || "-"}`
      );
    }
  } else if (activateStatusResponse.status >= 200 && activateStatusResponse.status < 300) {
    const activateStatus = parseActivateStatus(activateStatusResponse.body);
    isInactive = activateStatus.isInactive;
    updateTaskStage(
      task,
      "Erisim",
      "Tamam",
      isInactive ? "Kamera inactive olarak algilandi." : "Kamera aktif."
    );
  } else if (
    looksLikeAlreadyActiveActivateStatusFailure(
      activateStatusResponse.status,
      activateStatusResponse.body
    )
  ) {
    isInactive = false;
    updateTaskStage(
      task,
      "Erisim",
      "Tamam",
      `activateStatus HTTP ${activateStatusResponse.status} dondu; cihaz aktif varsayildi.`
    );
  } else {
    throw new Error(
      `Kamera erisimi basarisiz. HTTP ${activateStatusResponse.status}. ${compactResponseText(
        activateStatusResponse.body
      )}`
    );
  }

  if (isInactive) {
    updateTaskStage(task, "Aktivasyon", "Calisiyor", "HCNetSDK ile kamera aktive ediliyor.");
    const activationResult = await activateCameraWithSdk(normalizedIp, sdkPort, input.password);
    if (!activationResult.success) {
      throw new Error(
        `NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError=${activationResult.errorCode}, Message=${activationResult.errorMessage || "-"}`
      );
    }

    updateTaskStage(task, "Aktivasyon", "Tamam", "Kamera aktive edildi.");
  } else {
    updateTaskStage(task, "Aktivasyon", "Atlandi", "Kamera zaten aktif.");
  }

  updateTaskStage(task, "Cihaz Bilgileri", "Calisiyor", "DeviceInfo okunuyor.");
  const deviceInfo = isInactive
    ? await waitForDeviceInfo(normalizedIp, normalizedUser, input.password, 90_000)
    : parseDeviceInfo(
        await requestIsapiXml(normalizedIp, "/ISAPI/System/deviceInfo", normalizedUser, input.password)
      );
  updateTaskStage(task, "Cihaz Bilgileri", "Tamam", `Model=${deviceInfo.model || "-"}, Seri=${deviceInfo.shortSerial || "-"}`);

  updateTaskStage(task, "Tamamlandi", "Tamam", "Aktivasyon tamamlandi.");
  markTaskSucceeded(task, {
    cameraIp: normalizedIp,
    model: deviceInfo.model,
    macAddress: deviceInfo.macAddress,
    serialNumber: deviceInfo.serialNumber,
    shortSerial: deviceInfo.shortSerial,
    subSerialNumber: deviceInfo.subSerialNumber,
    firmwareVersion: deviceInfo.firmwareVersion,
    activated: true,
  });
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
      ezvizEnvDomain: toEzvizEnvDomain(token.areaDomain),
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
      error: sanitizeMessage(err.message),
      sdkInstalled: isSdkInstalled(),
    });
  }
});

app.get("/api/alpr/health", async (req, res) => {
  try {
    const health = await alprService.health({
      autoStart: String(req.query.autostart || "").trim() === "1",
    });
    return res.status(200).json(health);
  } catch (err) {
    return res.status(err.status || 503).json({
      error: sanitizeMessage(err.message),
    });
  }
});

app.post("/api/alpr/stop", async (req, res) => {
  try {
    const result = await alprService.stop();
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({
      error: sanitizeMessage(err.message),
    });
  }
});

async function handleAlprRecognize(req, res) {
  const payload = {
    imageBase64: typeof req.body.imageBase64 === "string" ? req.body.imageBase64 : undefined,
    imagePath: typeof req.body.imagePath === "string" ? req.body.imagePath : undefined,
    frameIndex: Number.isInteger(req.body.frameIndex) ? req.body.frameIndex : undefined,
    processEveryNFrames: Number.isInteger(req.body.processEveryNFrames)
      ? req.body.processEveryNFrames
      : undefined,
    minDetectionConfidence:
      typeof req.body.minDetectionConfidence === "number"
        ? req.body.minDetectionConfidence
        : undefined,
    minOcrConfidence:
      typeof req.body.minOcrConfidence === "number" ? req.body.minOcrConfidence : undefined,
    turkeyOnly: Boolean(req.body.turkeyOnly),
    source: typeof req.body.source === "string" ? req.body.source : undefined,
  };

  if (!payload.imageBase64 && !payload.imagePath) {
    return res.status(400).json({
      error: "imageBase64 veya imagePath zorunlu.",
    });
  }

  try {
    const result = await alprService.recognize(payload, 20000);
    return res.status(200).json(result);
  } catch (err) {
    const status =
      err.status ||
      (String(err.message || "").toLowerCase().includes("healthy") ? 503 : 502);
    return res.status(status).json({
      error: sanitizeMessage(err.message),
    });
  }
}

app.post("/api/alpr/recognize", handleAlprRecognize);
app.post("/api/alpr/recognize-frame", handleAlprRecognize);

app.get("/api/sdk-config", async (req, res) => {
  if (!ensureCredentials(res)) return;

  try {
    const token = await getToken();
    const streamToken = await getStreamToken();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json({
      sdkBasePath: SDK_BASE_PATH,
      areaDomain: token.areaDomain,
      ezvizEnvDomain:
        streamToken.streamAreaDomain || toEzvizEnvDomain(token.areaDomain),
      accessToken: streamToken.appToken,
      streamAppKey: streamToken.appKey,
      apiAccessToken: token.accessToken,
      expiresAt: normalizeExpireTime(token.expireTime),
      sdkInstalled: isSdkInstalled(),
      note: "Bu accessToken JSDecoder/EZOPEN icin streamtoken/get endpointinden gelen appToken'dir.",
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeMessage(err.message) });
  }
});

app.get("/api/sdk-live-input", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const resourceId = String(req.query.resourceId || "").trim();
  const deviceSerial = String(req.query.deviceSerial || "").trim();
  const code = String(req.query.code || "").trim();
  const quality = Number(req.query.quality || 1);
  const channelNo = Number(req.query.channelNo || 1);

  if (!resourceId || !deviceSerial) {
    return res.status(400).json({
      error: "resourceId ve deviceSerial parametreleri zorunlu.",
    });
  }

  try {
    const [streamToken, stream] = await Promise.all([
      getStreamToken(),
      getCachedStreamSource({
        resourceId,
        deviceSerial,
        quality,
        protocol: 1,
        code,
      }),
    ]);

    return res.json({
      accessToken: streamToken.appToken,
      appKey: streamToken.appKey,
      domain: streamToken.streamAreaDomain,
      sourceUrl: stream.url,
      deviceSerial,
      channelNo,
      quality,
      expireTime: stream.expireTime,
      raw: stream.raw,
    });
  } catch (err) {
    return res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
  }
});

app.get("/api/team-areas", async (req, res) => {
  if (!ensureCredentials(res)) return;

  try {
    const areas = await teamOpenApiService.getAreas();
    return res.status(200).json({ success: true, areas });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: sanitizeMessage(err.message),
    });
  }
});

app.get("/api/team-devices/detail", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const shortSerial = String(req.query.shortSerial || "").trim();
  const includeRaw = String(req.query.includeRaw || "0").trim() === "1";
  if (!shortSerial) {
    return res.status(400).json({ error: "shortSerial zorunlu." });
  }

  try {
    const detail = await teamOpenApiService.getDeviceDetail(shortSerial);
    const responsePayload = {
      success: true,
      exists: detail.exists,
      errorCode: detail.errorCode,
      errorMessage: detail.errorMessage,
      deviceId: detail.deviceId,
      cameraChannels: detail.cameraChannels,
      detailSummary: detail.detailSummary,
    };

    if (includeRaw) {
      responsePayload.rawData = detail.rawData;
    }

    return res.status(200).json({
      ...responsePayload,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: sanitizeMessage(err.message),
    });
  }
});

app.post("/api/team-devices/disable-encryption", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const shortSerial = String(req.body.shortSerial || "").trim();
  const alias = String(req.body.alias || "").trim();
  const deviceId = String(req.body.deviceId || "").trim();

  if (!shortSerial && !deviceId) {
    return res.status(400).json({ error: "shortSerial veya deviceId zorunlu." });
  }

  try {
    let effectiveDeviceId = deviceId;
    let effectiveAlias = alias;

    if (!effectiveDeviceId) {
      const detail = await teamOpenApiService.getDeviceDetail(shortSerial);
      effectiveDeviceId = detail.deviceId;
      if (!effectiveAlias) {
        const firstChannelName = detail.cameraChannels?.[0]?.name || "";
        effectiveAlias = firstChannelName || `CAM-${shortSerial}`;
      }
    }

    if (!effectiveDeviceId) {
      return res.status(404).json({
        success: false,
        error: "Device ID bulunamadi.",
      });
    }

    await teamOpenApiService.disableStreamEncryption({
      deviceId: effectiveDeviceId,
      alias: effectiveAlias || `CAM-${shortSerial || effectiveDeviceId}`,
    });

    const refreshed = shortSerial
      ? await teamOpenApiService.getDeviceDetail(shortSerial)
      : null;

    return res.status(200).json({
      success: true,
      message: "Encryption kapatma istegi gonderildi.",
      deviceId: effectiveDeviceId,
      alias: effectiveAlias || "",
      detail: refreshed,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: sanitizeMessage(err.message),
    });
  }
});

app.get("/api/cameras", async (req, res) => {
  if (!ensureCredentials(res)) return;

  try {
    const cameras = await fetchCameraCatalog();
    res.json({ cameras });
  } catch (err) {
    res.status(500).json({ error: sanitizeMessage(err.message) });
  }
});

app.post("/api/ptz/continuous", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.body.cameraId || req.body.resourceId || "").trim();
  const proxyId = String(req.body.proxyId || "").trim();
  const channelNo = Number(req.body.channelNo || 1);
  const pan = Number(req.body.pan || 0);
  const tilt = Number(req.body.tilt || 0);
  const zoom = Number(req.body.zoom || 0);

  if (!cameraId && !proxyId) {
    return res.status(400).json({ error: "cameraId/resourceId veya proxyId zorunlu." });
  }

  try {
    const result = await continuousPtzControl({ cameraId, proxyId, channelNo, pan, tilt, zoom });
    return res.status(200).json({
      success: true,
      cameraId,
      proxyId,
      channelNo,
      pan,
      tilt,
      zoom,
      result,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.get("/api/device-config/network", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.query.deviceId || "").trim();
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }

  try {
    const result = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/Network/interfaces",
      contentType: "application/xml",
      body: "",
    });
    const xml = decodeXml(String(result.data || ""));
    return res.json({
      success: true,
      deviceId,
      xml,
      interfaces: parseNetworkInterfaces(xml),
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.get("/api/device-config/ezviz", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.query.deviceId || "").trim();
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }

  try {
    const result = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/Network/EZVIZ",
      contentType: "application/xml",
      body: "",
    });
    const xml = decodeXml(String(result.data || ""));
    const status = parseEzvizStatus(xml);
    const verificationCode = getXmlValue(xml, ["verificationCode"]);
    return res.json({
      success: true,
      deviceId,
      xml,
      enabled: status.enabled,
      registerStatus: status.registerStatus,
      verificationCode,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.get("/api/device-config/time", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.query.deviceId || "").trim();
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }

  try {
    const result = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/time",
      contentType: "application/xml",
      body: "",
    });
    const xml = decodeXml(String(result.data || ""));
    const time = parseDeviceTimeConfig(xml);
    return res.json({
      success: true,
      deviceId,
      xml,
      time,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.put("/api/device-config/time", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.body.deviceId || "").trim();
  const dateTimeLocal = String(req.body.dateTimeLocal || "").trim();
  const requestedTimeZone = String(req.body.timeZone || "").trim();

  if (!deviceId || !dateTimeLocal) {
    return res.status(400).json({ error: "deviceId ve dateTimeLocal zorunlu." });
  }

  try {
    const current = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/time",
      contentType: "application/xml",
      body: "",
    });
    const currentXml = decodeXml(String(current.data || ""));
    const currentConfig = parseDeviceTimeConfig(currentXml);
    const appliedXml = updateDeviceTimeXml(currentXml, {
      dateTimeLocal,
      timeZone: requestedTimeZone || currentConfig.timeZone || "",
      timeMode: "manual",
    });

    const result = await callIsapiProxyPass({
      deviceId,
      method: "PUT",
      url: "/ISAPI/System/time",
      contentType: "application/xml",
      body: appliedXml,
    });

    const refreshed = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/time",
      contentType: "application/xml",
      body: "",
    });
    const refreshedXml = decodeXml(String(refreshed.data || ""));

    return res.json({
      success: true,
      deviceId,
      appliedXml,
      result,
      time: parseDeviceTimeConfig(refreshedXml),
      xml: refreshedXml,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.get("/api/sdk-playback-input", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const resourceId = String(req.query.resourceId || "").trim();
  const deviceSerial = String(req.query.deviceSerial || "").trim();
  const code = String(req.query.code || "").trim();
  const quality = Number(req.query.quality || 1);
  const channelNo = Number(req.query.channelNo || 1);
  const beginTime = normalizePlaybackDateTimeInput(req.query.beginTime);
  const endTime = normalizePlaybackDateTimeInput(req.query.endTime);
  const preferredTarget = String(req.query.preferredTarget || "auto").trim().toLowerCase();

  if (!resourceId || !deviceSerial) {
    return res.status(400).json({
      error: "resourceId ve deviceSerial parametreleri zorunlu.",
    });
  }

  if (!beginTime || !endTime) {
    return res.status(400).json({
      error: "beginTime ve endTime gecerli tarih/saat olmali.",
    });
  }

  try {
    const [streamToken, playback] = await Promise.all([
      getStreamToken(),
      (async () => {
        const { accessToken, areaDomain } = await getToken();
        let resolvedPreferredTarget = preferredTarget;

        // In auto mode, first ask the recording search API where segments actually exist.
        // This avoids opening an empty local playback session when today's recordings only exist in cloud storage.
        if (preferredTarget === "auto") {
          const searchResult = await searchRecordingCandidates({
            cameraId: resourceId,
            beginTime: normalizePlaybackDateTimeToIsoOffset(beginTime),
            endTime: normalizePlaybackDateTimeToIsoOffset(endTime),
            targetTypes: [0, 1],
          });
          if (searchResult.selectedTargetType === 0) {
            resolvedPreferredTarget = "local";
          } else if (searchResult.selectedTargetType === 1) {
            resolvedPreferredTarget = "cloud";
          }
        }

        return requestPlaybackAddress({
          accessToken,
          areaDomain,
          resourceId,
          deviceSerial,
          quality,
          code,
          beginTime,
          endTime,
          preferredTarget: resolvedPreferredTarget,
        });
      })(),
    ]);

    return res.json({
      accessToken: streamToken.appToken,
      appKey: streamToken.appKey,
      domain: streamToken.streamAreaDomain,
      sourceUrl: playback.url,
      deviceSerial,
      channelNo,
      quality,
      beginTime,
      endTime,
      expireTime: playback.expireTime,
      selectedPlaybackType: playback.selectedType,
      selectedTargetLabel: playback.selectedTargetLabel,
      raw: playback.raw,
      attempts: playback.attempts,
    });
  } catch (err) {
    return res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
  }
});

app.get("/api/playback-segments", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.query.cameraId || req.query.resourceId || "").trim();
  const beginTime = normalizePlaybackDateTimeToIsoOffset(req.query.beginTime);
  const endTime = normalizePlaybackDateTimeToIsoOffset(req.query.endTime);
  const preferredTarget = String(req.query.preferredTarget || "auto").trim().toLowerCase();
  const targetTypes =
    preferredTarget === "local" ? [0] : preferredTarget === "cloud" ? [1] : [0, 1];

  if (!cameraId) {
    return res.status(400).json({ error: "cameraId veya resourceId zorunlu." });
  }

  if (!beginTime || !endTime) {
    return res.status(400).json({ error: "beginTime ve endTime gecerli tarih/saat olmali." });
  }

  try {
    const result = await searchRecordingCandidates({
      cameraId,
      beginTime,
      endTime,
      targetTypes,
    });

    return res.json({
      success: true,
      cameraId,
      beginTime,
      endTime,
      selectedTargetType: result.selectedTargetType,
      selectedTargetLabel: result.selectedTargetLabel,
      recordList: result.recordList,
      searches: result.searches,
    });
  } catch (err) {
    return res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
  }
});

app.get("/api/cameras/:cameraId/recordings", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.params.cameraId || "").trim();
  const date = String(req.query.date || "").trim();
  const targetType = Number(req.query.targetType ?? 0);
  const rangeFromDate = date ? buildDayRangeIsoOffset(date) : null;
  const beginTime = rangeFromDate?.beginTime || normalizePlaybackDateTimeToIsoOffset(req.query.beginTime);
  const endTime = rangeFromDate?.endTime || normalizePlaybackDateTimeToIsoOffset(req.query.endTime);

  if (!cameraId) {
    return res.status(400).json({ error: "cameraId zorunlu." });
  }

  if (!beginTime || !endTime) {
    return res.status(400).json({ error: "date veya beginTime/endTime gecerli olmali." });
  }

  if (![0, 1].includes(targetType)) {
    return res.status(400).json({ error: "targetType 0 veya 1 olmali." });
  }

  try {
    const recordList = await searchAllCameraRecordings({
      cameraId,
      beginTime,
      endTime,
      targetType,
      timeType: 1,
    });

    let recordSetting = null;
    try {
      const settings = await teamOpenApiService.getRecordSettings([cameraId]);
      recordSetting = settings.length > 0 ? summarizeRecordSetting(settings[0]) : null;
    } catch {
      recordSetting = null;
    }

    return res.json({
      success: true,
      cameraId,
      date: date || null,
      beginTime,
      endTime,
      targetType,
      recordSetting,
      recordList,
    });
  } catch (err) {
    return res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
  }
});

app.post("/api/cameras/:cameraId/playback", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.params.cameraId || "").trim();
  const beginTimeInput = req.body?.beginTime;
  const endTimeInput = req.body?.endTime;
  const targetType = Number(req.body?.targetType ?? 0);
  const quality = Number(req.body?.quality ?? 1);
  const verificationCode = String(req.body?.verificationCode || req.body?.code || "").trim();
  const beginTime = normalizePlaybackDateTimeInput(beginTimeInput);
  const endTime = normalizePlaybackDateTimeInput(endTimeInput);

  if (!cameraId) {
    return res.status(400).json({ error: "cameraId zorunlu." });
  }

  if (!beginTime || !endTime) {
    return res.status(400).json({ error: "beginTime ve endTime gecerli tarih/saat olmali." });
  }

  if (![0, 1].includes(targetType)) {
    return res.status(400).json({ error: "targetType 0 veya 1 olmali." });
  }

  try {
    const cameras = await fetchCameraCatalog([cameraId]);
    const camera = cameras.find((item) => String(item.resourceId || "") === cameraId);
    if (!camera) {
      return res.status(404).json({ error: "Kamera bulunamadi." });
    }
    if (!camera.deviceSerial) {
      return res.status(400).json({ error: "Kamera deviceSerial bilgisi eksik." });
    }

    const [streamToken, token] = await Promise.all([
      getStreamToken(),
      getToken(),
    ]);

    const playback = await requestPlaybackAddress({
      accessToken: token.accessToken,
      areaDomain: token.areaDomain,
      resourceId: camera.resourceId,
      deviceSerial: camera.deviceSerial,
      quality,
      code: verificationCode || camera.streamSecretKey || "",
      beginTime,
      endTime,
      preferredTarget: targetType === 0 ? "local" : "cloud",
    });

    return res.json({
      success: true,
      cameraId: camera.resourceId,
      resourceId: camera.resourceId,
      deviceId: camera.deviceId,
      deviceSerial: camera.deviceSerial,
      channelNo: Number(camera.channelNo || 1),
      quality,
      targetType,
      verificationCodeRequired: !verificationCode && !camera.streamSecretKey,
      playback: {
        sourceUrl: playback.url,
        expireTime: playback.expireTime,
        selectedPlaybackType: playback.selectedType,
        selectedTargetLabel: playback.selectedTargetLabel,
      },
      streamToken: {
        appKey: streamToken.appKey,
        appToken: streamToken.appToken,
        areaDomain: streamToken.streamAreaDomain,
      },
      playerInput: {
        appKey: streamToken.appKey,
        accessToken: streamToken.appToken,
        domain: streamToken.streamAreaDomain,
        sourceUrl: playback.url,
        code: verificationCode || camera.streamSecretKey || "",
        beginTime,
        endTime,
      },
    });
  } catch (err) {
    return res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
  }
});

app.post("/api/cameras/:cameraId/capture", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.params.cameraId || "").trim();
  if (!cameraId) {
    return res.status(400).json({ error: "cameraId zorunlu." });
  }

  const requestController = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) {
      requestController.abort(new Error("Istek istemci tarafindan kapatildi."));
    }
  });

  try {
    const cameras = await fetchCameraCatalog([cameraId]);
    const camera = cameras.find((item) => String(item.resourceId || "") === cameraId);
    if (!camera) {
      return res.status(404).json({ error: "Kamera bulunamadi." });
    }
    if (!isCameraOnline(camera)) {
      return res.status(409).json({ error: "Kamera cevrimdisi." });
    }

    const capture = await captureCameraSnapshot(camera, {
      signal: requestController.signal,
    });

    res.setHeader("Content-Type", capture.contentType);
    res.setHeader("Content-Length", String(capture.size));
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${sanitizeFileName(`${camera.name || camera.resourceId}-capture-${Date.now()}.jpg`)}"`
    );
    return res.send(capture.buffer);
  } catch (err) {
    const message = sanitizeMessage(err?.message || String(err));
    if (message.includes("Sifreli fotograf cozme destegi bulunmuyor")) {
      return res.status(501).json({ error: message });
    }
    if (message.includes("cevrimdisi")) {
      return res.status(409).json({ error: message });
    }
    if (message.includes("bulunamadi")) {
      return res.status(404).json({ error: message });
    }
    return res.status(502).json(err.details || { error: message });
  }
});

app.get("/api/device-config/storage", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.query.deviceId || "").trim();
  const cameraId = String(req.query.cameraId || "").trim();
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }

  try {
    const { info, attempts } = await readStorageViaProxy(deviceId);
    let recordSetting = null;
    let recordingIsapi = null;

    if (cameraId) {
      try {
        const settings = await teamOpenApiService.getRecordSettings([cameraId]);
        recordSetting = settings.length > 0 ? summarizeRecordSetting(settings[0]) : null;
      } catch (error) {
        recordSetting = {
          error: sanitizeMessage(error.message),
        };
      }
    }

    try {
      recordingIsapi = await readRecordingIsapiState(deviceId);
    } catch (error) {
      recordingIsapi = {
        error: sanitizeMessage(error?.message || String(error)),
      };
    }

    return res.json({
      success: true,
      deviceId,
      cameraId,
      storage: info,
      recordSetting,
      recordingIsapi,
      attempts,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.post("/api/device-config/storage/format", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.body.deviceId || "").trim();
  const confirmed = Boolean(req.body.confirmed);
  const diskId = String(req.body.diskId || "").trim();
  const ipAddress = String(req.body.ipAddress || "").trim();
  const userName = String(req.body.userName || "").trim() || "admin";
  const password = String(req.body.password || "");
  const sdkPort = Number.parseInt(String(req.body.sdkPort || "8000"), 10) || 8000;

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }
  if (!confirmed) {
    return res.status(400).json({ error: "SD kart bicimlendirme icin onay gerekli." });
  }

  try {
    const before = await readStorageViaProxy(deviceId);
    const candidateDiskIds = buildStorageFormatDiskCandidates(diskId, before.info);
    const normalizedDiskId = candidateDiskIds.find(Boolean) || "1";
    let formatResult = null;
    const formatAttempts = [];
    let sdkAttemptFailedMessage = "";

    if (ipAddress && password) {
      try {
        const sdkResult = await formatStorageWithSdk({
          ipAddress,
          sdkPort,
          userName,
          password,
          diskNumber: Number.parseInt(String(normalizedDiskId), 10) || 1,
        });
        formatAttempts.push({
          path: "HCNetSDK:NET_DVR_FormatDisk",
          status: sdkResult?.success ? 200 : 502,
          errorCode: sdkResult?.errorCode ?? null,
          message: sdkResult?.errorMessage || null,
          stage: sdkResult?.stage || "format-disk",
        });

        if (!sdkResult?.success) {
          throw new Error(
            sdkResult?.errorMessage ||
              `HCNetSDK SD kart bicimlendirme basarisiz. errorCode=${sdkResult?.errorCode ?? "-"}`
          );
        }

        formatResult = {
          path: "HCNetSDK:NET_DVR_FormatDisk",
          diskId: String(sdkResult.diskNumber || normalizedDiskId),
          method: "SDK",
          responseText: JSON.stringify(sdkResult),
          sdk: true,
        };
      } catch (sdkError) {
        sdkAttemptFailedMessage = sanitizeMessage(sdkError?.message || String(sdkError));
        formatAttempts.push({
          path: "HCNetSDK:NET_DVR_FormatDisk",
          status: 502,
          errorCode: null,
          message: sdkAttemptFailedMessage,
          stage: "format-disk",
        });
      }
    }

    if (!formatResult) {
      try {
        formatResult = await tryFormatStorage(deviceId, candidateDiskIds);
      } catch (proxyError) {
        if (sdkAttemptFailedMessage) {
          proxyError.message = `HCNetSDK format denemesi de basarisiz oldu: ${sdkAttemptFailedMessage}`;
        }
        proxyError.formatAttempts = [
          ...formatAttempts,
          ...(Array.isArray(proxyError?.formatAttempts) ? proxyError.formatAttempts : []),
        ];
        throw proxyError;
      }
    }

    let after = null;
    for (let attemptIndex = 0; attemptIndex < 5; attemptIndex += 1) {
      if (attemptIndex > 0) {
        await delay(2000);
      }
      after = await readStorageViaProxy(deviceId);
      if (after?.info?.isDetected !== false) {
        break;
      }
    }

    return res.json({
      success: true,
      deviceId,
      diskId: formatResult.diskId || diskId || before.info.diskId || "1",
      candidateDiskIds,
      formatResult,
      formatAttempts,
      before: before.info,
      after: after?.info || null,
      afterAttempts: after?.attempts || [],
    });
  } catch (err) {
    const attempts = Array.isArray(err?.formatAttempts) ? err.formatAttempts : [];
    const unsupported = isStorageFormatUnsupportedError(err, attempts);
    return res.status(502).json({
      error: err?.message && /HCNetSDK format denemesi de basarisiz oldu:/i.test(String(err.message))
        ? sanitizeMessage(err.message)
        : unsupported
        ? "Bu cihazda veya Hik-Connect ISAPI proxy akisinda SD kart bicimlendirme komutu desteklenmiyor."
        : sanitizeMessage(err.message),
      unsupported,
      attempts,
    });
  }
});

app.get("/api/device-config/record-settings", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.query.cameraId || "").trim();
  if (!cameraId) {
    return res.status(400).json({ error: "cameraId zorunlu." });
  }

  try {
    const settings = await teamOpenApiService.getRecordSettings([cameraId]);
    return res.json({
      success: true,
      cameraId,
      recordSetting: settings.length > 0 ? summarizeRecordSetting(settings[0]) : null,
      raw: settings[0] || null,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.post("/api/device-config/record-settings/continuous", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const cameraId = String(req.body.cameraId || "").trim();
  const deviceId = String(req.body.deviceId || "").trim();

  if (!cameraId || !deviceId) {
    return res.status(400).json({ error: "cameraId ve deviceId zorunlu." });
  }

  try {
    const settings = await teamOpenApiService.getRecordSettings([cameraId]);
    const current = settings.length > 0 ? summarizeRecordSetting(settings[0]) : null;

    if (current?.enableLocalStorage === 1 && current?.scheduleTemplateId === "1") {
      return res.json({
        success: true,
        cameraId,
        deviceId,
        alreadyContinuous: true,
        recordSetting: current,
      });
    }

    return res.status(501).json({
      error:
        "Bu tenant/model icin kayit yazma endpoint'i resmi Team OpenAPI dokumaninda dogrulanmadi. recordsettings/get okunuyor, yazma icin modelin ISAPI kayit semasi netlestirilmeli.",
      cameraId,
      deviceId,
      recordSetting: current,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.post("/api/device-config/local-record", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.body.deviceId || "").trim();
  const cameraId = String(req.body.cameraId || "").trim();
  const action = String(req.body.action || "").trim().toLowerCase();
  const settingsPayloadPresent =
    req.body.recordMode !== undefined ||
    req.body.startTime !== undefined ||
    req.body.endTime !== undefined ||
    req.body.streamType !== undefined ||
    req.body.overwriteEnabled !== undefined ||
    req.body.enableSchedule !== undefined ||
    req.body.scheduleActions !== undefined ||
    req.body.preRecordSeconds !== undefined ||
    req.body.postRecordSeconds !== undefined ||
    req.body.enabled !== undefined;
  const mode = String(req.body.mode || (settingsPayloadPresent ? "settings" : "action"))
    .trim()
    .toLowerCase();

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }

  try {
    let operation;
    if (mode === "settings") {
      operation = await applyLocalRecordSettings(deviceId, {
        enabled:
          typeof req.body.enabled === "boolean"
            ? req.body.enabled
            : req.body.enabled === null || req.body.enabled === undefined
              ? undefined
              : String(req.body.enabled).trim().toLowerCase() === "true",
        overwriteEnabled:
          typeof req.body.overwriteEnabled === "boolean"
            ? req.body.overwriteEnabled
            : req.body.overwriteEnabled === null || req.body.overwriteEnabled === undefined
              ? undefined
              : String(req.body.overwriteEnabled).trim().toLowerCase() === "true",
        enableSchedule:
          typeof req.body.enableSchedule === "boolean"
            ? req.body.enableSchedule
            : req.body.enableSchedule === null || req.body.enableSchedule === undefined
              ? undefined
              : String(req.body.enableSchedule).trim().toLowerCase() === "true",
        scheduleActions: Array.isArray(req.body.scheduleActions) ? req.body.scheduleActions : [],
        recordMode: req.body.recordMode ? String(req.body.recordMode).trim().toLowerCase() : "",
        startTime: req.body.startTime ? String(req.body.startTime).trim() : "",
        endTime: req.body.endTime ? String(req.body.endTime).trim() : "",
        streamType:
          req.body.streamType === "" || req.body.streamType === null || req.body.streamType === undefined
            ? undefined
            : Number(req.body.streamType),
        preRecordSeconds:
          req.body.preRecordSeconds === "" ||
          req.body.preRecordSeconds === null ||
          req.body.preRecordSeconds === undefined
            ? undefined
            : Number(req.body.preRecordSeconds),
        postRecordSeconds:
          req.body.postRecordSeconds === "" ||
          req.body.postRecordSeconds === null ||
          req.body.postRecordSeconds === undefined
            ? undefined
            : Number(req.body.postRecordSeconds),
      });
    } else {
      if (!["enable", "disable", "continuous"].includes(action)) {
        return res.status(400).json({ error: "action enable|disable|continuous olmali." });
      }
      operation = await applyLocalRecordOperation(deviceId, action);
    }

    let verifiedRecordSetting = null;
    if (cameraId) {
      try {
        const settings = await teamOpenApiService.getRecordSettings([cameraId]);
        verifiedRecordSetting = settings.length > 0 ? summarizeRecordSetting(settings[0]) : null;
      } catch (error) {
        verifiedRecordSetting = {
          error: sanitizeMessage(error?.message || String(error)),
        };
      }
    }

    return res.status(200).json({
      success: true,
      deviceId,
      cameraId,
      mode,
      action,
      verifiedRecordSetting,
      operation,
    });
  } catch (error) {
    return res.status(502).json({ error: sanitizeMessage(error?.message || String(error)) });
  }
});

app.get("/api/recording-sync/status", (req, res) => {
  const cameraId = String(req.query.cameraId || "").trim();
  return res.json({
    success: true,
    ...buildRecordingSyncStatus(cameraId),
  });
});

app.post("/api/recording-sync/config", (req, res) => {
  try {
    const input = normalizeRecordingSyncConfigInput(req.body || {});
    const config = loadRecordingSyncConfig();
    config.enabled = input.enabled;
    config.dailyTime = input.dailyTime;
    config.lookbackMinutes = input.lookbackMinutes;

    const nextCamera = {
      cameraId: input.cameraId,
      deviceId: input.deviceId,
      deviceSerial: input.deviceSerial,
      name: input.name,
      enabled: true,
      updatedAt: new Date().toISOString(),
    };

    const existingIndex = config.cameras.findIndex((item) => item.cameraId === input.cameraId);
    if (existingIndex >= 0) {
      config.cameras[existingIndex] = {
        ...config.cameras[existingIndex],
        ...nextCamera,
      };
    } else {
      config.cameras.push(nextCamera);
    }

    saveRecordingSyncConfig(config);
    return res.status(200).json({
      success: true,
      message: "Kayit senkron konfigurasyonu kaydedildi.",
      ...buildRecordingSyncStatus(input.cameraId),
    });
  } catch (error) {
    return res.status(400).json({ error: sanitizeMessage(error?.message || String(error)) });
  }
});

app.post("/api/recording-sync/run-once", async (req, res) => {
  if (!ensureCredentials(res)) return;

  try {
    const cameraId = String(req.body.cameraId || "").trim();
    if (!cameraId) {
      return res.status(400).json({ error: "cameraId zorunlu." });
    }

    const result = await runRecordingSync({
      reason: "manual",
      cameraId,
      beginTime: req.body.beginTime,
      endTime: req.body.endTime,
      cameras: [
        {
          cameraId,
          deviceId: String(req.body.deviceId || "").trim(),
          deviceSerial: String(req.body.deviceSerial || "").trim(),
          name: String(req.body.name || "").trim(),
        },
      ],
    });

    return res.status(200).json({
      success: true,
      message: "Kayit senkronu tamamlandi.",
      result,
      ...buildRecordingSyncStatus(cameraId),
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: sanitizeMessage(error?.message || String(error)),
      diagnostic: error?.diagnostic
        ? {
            ...error.diagnostic,
            hostComparison: buildRecordingHostComparison(),
          }
        : null,
      ...buildRecordingSyncStatus(String(req.body.cameraId || "").trim()),
    });
  }
});

app.put("/api/device-config/ezviz", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.body.deviceId || "").trim();
  const verificationCode = String(req.body.verificationCode || "").trim();

  if (!deviceId || !verificationCode) {
    return res.status(400).json({ error: "deviceId ve verificationCode zorunlu." });
  }

  try {
    const current = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/Network/EZVIZ",
      contentType: "application/xml",
      body: "",
    });
    const currentXml = decodeXml(String(current.data || ""));
    const updatedXml = updateEzvizXml(currentXml, verificationCode);

    const result = await callIsapiProxyPass({
      deviceId,
      method: "PUT",
      url: "/ISAPI/System/Network/EZVIZ",
      contentType: "application/xml",
      body: updatedXml,
    });

    return res.json({
      success: true,
      deviceId,
      verificationCode,
      appliedXml: updatedXml,
      result,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.put("/api/device-config/network", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.body.deviceId || "").trim();
  const interfaceId = String(req.body.interfaceId || "1").trim();
  const ipAddress = String(req.body.ipAddress || "").trim();
  const subnetMask = String(req.body.subnetMask || "").trim();
  const gateway = String(req.body.gateway || "").trim();
  const primaryDns = String(req.body.primaryDns || "").trim();
  const secondaryDns = String(req.body.secondaryDns || "").trim();

  if (!deviceId || !ipAddress || !subnetMask || !gateway || !primaryDns) {
    return res.status(400).json({
      error: "deviceId, ipAddress, subnetMask, gateway ve primaryDns zorunlu.",
    });
  }

  try {
    const current = await callIsapiProxyPass({
      deviceId,
      method: "GET",
      url: "/ISAPI/System/Network/interfaces",
      contentType: "application/xml",
      body: "",
    });

    const currentXml = decodeXml(String(current.data || ""));
    const currentConfig = parseNetworkConfig(currentXml);

    validateScalarIp(currentConfig.ipAddress, "ipAddress");
    validateScalarIp(currentConfig.gateway, "gateway");
    validateScalarIp(currentConfig.primaryDns, "primaryDns");
    validateScalarIp(currentConfig.secondaryDns, "secondaryDns");

    validateScalarIp(ipAddress, "ipAddress");
    validateScalarIp(gateway, "gateway");
    validateScalarIp(primaryDns, "primaryDns");
    validateScalarIp(secondaryDns, "secondaryDns");

    const updatedXml = buildNetworkInterfaceXml({
      interfaceId,
      ipVersion: currentConfig.ipVersion || "dual",
      addressingType: "static",
      ipAddress,
      subnetMask,
      gateway,
      primaryDns,
      secondaryDns,
      ipv6Address: "::",
      ipv6BitMask: "0",
      ipv6AddressingType: "ra",
    });

    console.log("Network XML build:", {
      deviceId,
      interfaceId,
      updatedXml,
      containsEncodedIpVersion: updatedXml.includes("&lt;ipVersion&gt;"),
      containsEncodedIpAddress: updatedXml.includes("&lt;ipAddress&gt;"),
      containsNestedXmlInIpAddress: /<ipAddress>\s*</i.test(updatedXml),
    });

    const applyResult = await callIsapiProxyPass({
      deviceId,
      method: "PUT",
      url: `/ISAPI/System/Network/interfaces/${encodeURIComponent(interfaceId)}`,
      contentType: "application/xml",
      body: updatedXml,
    });

    const responseXml = decodeXml(String(applyResult.data || ""));
    const responseStatus = parseResponseStatus(responseXml);
    const rebootRequired =
      responseStatus.statusCode === "7" &&
      responseStatus.subStatusCode.toLowerCase() === "rebootrequired";

    return res.json({
      success: true,
      deviceId,
      interfaceId,
      appliedXml: updatedXml,
      result: applyResult,
      responseStatus,
      rebootRequired,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.post("/api/device-config/reboot", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const deviceId = String(req.body.deviceId || "").trim();
  const waitForReconnect = String(req.body.waitForReconnect || "1").trim() !== "0";
  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }

  try {
    let result;
    try {
      result = await callIsapiProxyPass({
        deviceId,
        method: "PUT",
        url: "/ISAPI/System/reboot",
        contentType: "application/xml",
        body: "",
      });
    } catch (err) {
      const errorText = String(err?.message || "");
      const rebootTimeout =
        errorText.includes("OPEN000555") && errorText.includes("OPEN000019");
      if (!rebootTimeout) {
        throw err;
      }
      result = {
        errorCode: "0",
        data: "",
        warning: "Reboot sirasinda cihaz response timeout verdi; gecici kabul edildi.",
      };
    }

    let reconnected = false;
    let reconnectAttempts = 0;

    if (waitForReconnect) {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        reconnectAttempts = attempt;
        await new Promise((resolve) => setTimeout(resolve, 15000));
        try {
          const ping = await callIsapiProxyPass({
            deviceId,
            method: "GET",
            url: "/ISAPI/System/Network/interfaces",
            contentType: "application/xml",
            body: "",
          });
          const pingXml = decodeXml(String(ping.data || ""));
          if (pingXml.includes("<NetworkInterface")) {
            reconnected = true;
            break;
          }
        } catch {
          // reboot sonrasi cloud'a geri donus bekleniyor
        }
      }
    }

    return res.json({ success: true, deviceId, result, reconnected, reconnectAttempts });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.get("/api/stream", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const { resourceId, deviceSerial } = req.query;
  const code = (req.query.code || "").toString().trim();
  const protocol = Number(req.query.protocol || 2);
  const quality = Number(req.query.quality || 1);

  if (!resourceId || !deviceSerial) {
    return res.status(400).json({
      error: "resourceId ve deviceSerial parametreleri zorunlu.",
    });
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
    res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
  }
});

app.get("/api/hls/manifest", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const { resourceId, deviceSerial } = req.query;
  const quality = Number(req.query.quality || 1);

  if (!resourceId || !deviceSerial) {
    return res.status(400).json({
      error: "resourceId ve deviceSerial parametreleri zorunlu.",
    });
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
        resourceId.toString(),
        deviceSerial.toString(),
        quality
      )
    );
  } catch (err) {
    res.status(502).json(err.details || { error: sanitizeMessage(err.message) });
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
      upstreamResponse.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await upstreamResponse.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({ error: sanitizeMessage(err.message) });
  }
});

app.post("/api/provision/start", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const input = {
    cameraIp: String(req.body.cameraIp || "").trim(),
    userName: String(req.body.userName || "admin").trim() || "admin",
    password: String(req.body.password || ""),
    areaName: String(req.body.areaName || "").trim(),
    gatewayOverride: String(req.body.gatewayOverride || "").trim(),
    sdkPort: Number(req.body.sdkPort || 8000),
    enableDhcp: Boolean(req.body.enableDhcp),
  };

  if (!input.cameraIp) {
    return res.status(400).json({ error: "cameraIp zorunlu." });
  }

  if (!input.password) {
    return res.status(400).json({ error: "password zorunlu." });
  }

  const task = createProvisioningTask(input);
  runProvisioningTask(task, input).catch((error) => {
    markTaskFailed(task, error);
  });

  res.status(202).json({ taskId: task.taskId });
});

app.post("/api/provision/activate", async (req, res) => {
  const input = {
    cameraIp: String(req.body.cameraIp || "").trim(),
    userName: String(req.body.userName || "admin").trim() || "admin",
    password: String(req.body.password || ""),
    sdkPort: Number(req.body.sdkPort || 8000),
  };

  if (!input.cameraIp) {
    return res.status(400).json({ error: "cameraIp zorunlu." });
  }

  if (!input.password) {
    return res.status(400).json({ error: "password zorunlu." });
  }

  const task = createActivationTask(input);
  runActivationTask(task, input).catch((error) => {
    markTaskFailed(task, error);
  });

  res.status(202).json({ taskId: task.taskId });
});

app.post("/api/team-devices/add", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const input = {
    shortSerial: String(req.body.shortSerial || "").trim(),
    verificationCode: String(req.body.verificationCode || "").trim(),
    alias: String(req.body.alias || "").trim(),
    areaName: String(req.body.areaName || "").trim(),
    areaId: String(req.body.areaId || "").trim(),
    userName: String(req.body.userName || "").trim(),
    password: String(req.body.password || ""),
  };

  if (!input.shortSerial) {
    return res.status(400).json({ error: "shortSerial zorunlu." });
  }

  if (!input.verificationCode) {
    return res.status(400).json({ error: "verificationCode zorunlu." });
  }

  try {
    const result = await teamOpenApiService.addDeviceToAreaWorkflow(input);
    return res.status(200).json({
      message: result.deviceAdded
        ? "Cihaz Team hesabina eklendi ve kanal import akisi tamamlandi."
        : "Cihaz zaten vardi; eksik area/kanal iliskileri kontrol edildi.",
      result: {
        success: true,
        ...result,
      },
    });
  } catch (err) {
    return res.status(502).json({
      error: sanitizeMessage(err.message),
    });
  }
});

app.post("/api/provisioning/team-register", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const input = {
    shortSerial: String(req.body.shortSerial || "").trim(),
    verificationCode: String(req.body.verificationCode || "").trim(),
    alias: String(req.body.alias || "").trim(),
    areaName: String(req.body.areaName || "").trim(),
    areaId: String(req.body.areaId || "").trim(),
    userName: String(req.body.userName || "").trim(),
    password: String(req.body.password || ""),
    model: String(req.body.model || "").trim(),
    serialNumber: String(req.body.serialNumber || "").trim(),
    subSerialNumber: String(req.body.subSerialNumber || "").trim(),
    firmwareVersion: String(req.body.firmwareVersion || "").trim(),
    macAddress: String(req.body.macAddress || "").trim(),
    currentIpAddress: String(req.body.currentIpAddress || "").trim(),
  };

  if (!input.shortSerial) {
    return res.status(400).json({ error: "shortSerial zorunlu." });
  }

  if (!input.verificationCode) {
    return res.status(400).json({ error: "verificationCode zorunlu." });
  }

  try {
    const result = await teamOpenApiService.addDeviceToAreaWorkflow({
      shortSerial: input.shortSerial,
      verificationCode: input.verificationCode,
      alias: input.alias,
      areaName: input.areaName,
      areaId: input.areaId,
      userName: input.userName,
      password: input.password,
    });

    return res.status(200).json({
      message: result.deviceAdded
        ? "Provisioning verisi alindi; cihaz Team hesabina eklendi."
        : "Provisioning verisi alindi; cihaz zaten vardi ve area/kanal iliskisi kontrol edildi.",
      result: {
        success: true,
        ...result,
        model: input.model,
        serialNumber: input.serialNumber,
        subSerialNumber: input.subSerialNumber,
        firmwareVersion: input.firmwareVersion,
        macAddress: input.macAddress,
        currentIpAddress: input.currentIpAddress,
      },
    });
  } catch (err) {
    return res.status(502).json({
      error: sanitizeMessage(err.message),
    });
  }
});

app.get("/api/provision/tasks/:taskId", (req, res) => {
  const task = provisioningTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task bulunamadi." });
  }

  res.json({
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    stages: task.stages,
    result: task.result,
    error: task.error,
  });
});

app.get("/downloads/local-agent/HikProvisioning.Agent-win-x64.zip", (req, res) => {
  if (!fs.existsSync(LOCAL_AGENT_ZIP_PATH)) {
    return res.status(404).send("Yerel servis paketi henuz uretilmedi.");
  }

  res.download(LOCAL_AGENT_ZIP_PATH, "HikProvisioning.Agent-win-x64.zip");
});

app.get("/downloads/local-agent/HikProvisioning.Agent-win-x64-Setup.exe", (req, res) => {
  if (!fs.existsSync(LOCAL_AGENT_SETUP_EXE_PATH)) {
    return res.status(404).send("Windows kurulum dosyasi henuz uretilmedi.");
  }

  res.download(LOCAL_AGENT_SETUP_EXE_PATH, "HikProvisioning.Agent-win-x64-Setup.exe");
});

app.get("/camera-setup", (req, res) => {
  res.sendFile(path.join(__dirname, "provisioning.html"));
});

app.get("/camera-browser-test", (req, res) => {
  res.sendFile(path.join(__dirname, "browser-network-test.html"));
});

app.get("/team-device-add", (req, res) => {
  res.sendFile(path.join(__dirname, "team-device-add.html"));
});

app.get("/device-detail", (req, res) => {
  res.sendFile(path.join(__dirname, "device-detail.html"));
});

app.get("/alpr-monitor", (req, res) => {
  res.sendFile(path.join(__dirname, "alpr-monitor.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

function initializeApp() {
  ensureDirectory(RECORDING_SYNC_ROOT);
  ensureDirectory(RECORDING_ARCHIVE_ROOT);
  if (!fs.existsSync(RECORDING_SYNC_CONFIG_PATH)) {
    saveRecordingSyncConfig(buildDefaultRecordingSyncConfig());
  }
  if (!fs.existsSync(RECORDING_SYNC_STATE_PATH)) {
    saveRecordingSyncState(buildDefaultRecordingSyncState());
  }
  scheduleRecordingSyncLoop();
}

if (require.main === module) {
  initializeApp();
  app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda calisiyor`);
  });
}

module.exports = {
  app,
  initializeApp,
  sanitizeMessage,
  normalizeCameraChannelNo,
  buildTrustedHikCaptureHostSuffixes,
  isTrustedHikCaptureUrl,
  isSupportedImageContentType,
  sniffImageContentType,
  normalizeHikCaptureUrl,
  requestCameraCapture,
  requestCameraThumbnail,
  downloadCameraCaptureBinary,
  captureCameraSnapshot,
};
