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
    .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"***"')
    .replace(/"accessToken"\s*:\s*"[^"]+"/gi, '"accessToken":"***"')
    .replace(/Token:\s*[^\s,]+/gi, "Token: ***");
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

  let isDetected = null;
  if (containsAnyText(combined, "nocar", "no card", "notexist", "not exist", "absent", "unplugged", "unmounted")) {
    isDetected = false;
  } else if (candidate && candidate !== decodedXml || capacityMb !== null || freeSpaceMb !== null || statusText) {
    isDetected = true;
  }

  let isFormatted = null;
  if (isDetected !== false) {
    if (containsAnyText(combined, "unformat", "notformat", "not format", "uninitialized", "needformat", "formatrequired")) {
      isFormatted = false;
    } else if (containsAnyText(combined, "normal", "ok", "ready", "mounted", "rw", "readwrite", "good")) {
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
    hasEntries:
      /<(?:\w+:)?(?:hdd|disk|storageMedium|storage|medium)\b/i.test(decodedXml) &&
      /<(?:\w+:)?(?:capacity|totalCapacity|capacityTotal|diskCapacity|totalSpace|size|freeSpace|free|remainSpace|residualSpace|unusedSpace|freeCapacity|status|storageStatus|hddStatus|state)\b/i.test(decodedXml),
  };
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

function inferRecordMode(recordTypeRaw) {
  const value = String(recordTypeRaw || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (["cmr", "continuous", "timing", "alltime", "always"].includes(value)) {
    return "continuous";
  }
  if (["motion", "vmd", "edr", "event", "alarmandmotion", "smart"].includes(value)) {
    return "motion";
  }
  return value;
}

function mapRecordModeLabel(mode) {
  switch (mode) {
    case "continuous":
      return "7/24";
    case "motion":
      return "Hareket";
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

function parseTrackInfo(trackXml, trackCapabilitiesXml = "") {
  const id = firstTagValue(trackXml, ["id", "trackID"]);
  const enabledRaw = firstTagValue(trackXml, ["enabled", "enable"]);
  const recordTypeRaw = firstTagValue(trackXml, ["recordType", "trackType", "recordingMode"]);
  const supportedModes = extractTagOptValues(trackCapabilitiesXml, ["recordType", "trackType", "recordingMode"]);
  const days = splitTrackDays(trackXml);
  const startTime = firstTagValue(trackXml, ["ScheduleActionStartTime", "scheduleActionStartTime", "startTime", "beginTime"]);
  const endTime = firstTagValue(trackXml, ["ScheduleActionEndTime", "scheduleActionEndTime", "endTime", "stopTime"]);
  const normalizedMode = inferRecordMode(recordTypeRaw);
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
    recordTypeRaw,
    recordMode: normalizedMode,
    recordModeLabel: mapRecordModeLabel(normalizedMode),
    supportedModes,
    days,
    startTime,
    endTime,
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
  const supported = Array.isArray(trackInfo?.supportedModes) ? trackInfo.supportedModes.map((item) => item.toLowerCase()) : [];
  const mapping = [
    ["cmr", "CMR"],
    ["continuous", "continuous"],
    ["timing", "timing"],
    ["alltime", "alltime"],
  ];
  for (const [candidate, output] of mapping) {
    if (supported.includes(candidate)) {
      return output;
    }
  }

  const current = String(trackInfo?.recordTypeRaw || "").trim();
  if (inferRecordMode(current) === "continuous") {
    return current;
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
    throw new Error("Track capability icinde dogrulanmis 7/24 record mode bulunamadi.");
  }

  if (
    !/(<(?:\w+:)?recordType\b|<(?:\w+:)?trackType\b|<(?:\w+:)?recordingMode\b)/i.test(updated)
  ) {
    throw new Error("Track XML icinde record type alani bulunamadi.");
  }

  updated = patchTrackEnabled(updated, true);
  updated = replaceXmlValue(updated, ["recordType", "trackType", "recordingMode"], continuousModeValue);

  const replacements = [
    ["ScheduleActionStartTime", "00:00:00"],
    ["scheduleActionStartTime", "00:00:00"],
    ["ScheduleActionEndTime", "24:00:00"],
    ["scheduleActionEndTime", "24:00:00"],
  ];

  let replacedAnyTime = false;
  for (const [tagName, value] of replacements) {
    const regex = new RegExp(`<(?:\\w+:)?${tagName}\\b`, "i");
    if (regex.test(updated)) {
      updated = replaceXmlValue(updated, [tagName], value);
      replacedAnyTime = true;
    }
  }

  if (!replacedAnyTime) {
    throw new Error("Track XML icinde 7/24 icin guncellenebilir zaman alanlari bulunamadi.");
  }

  return updated;
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
  const trackId = String(before.firstTrack?.id || "").trim();
  if (!trackId) {
    throw new Error("Yazilabilir record track bulunamadi.");
  }

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
  const after = await readRecordingIsapiState(deviceId);
  return {
    action,
    trackId,
    before,
    currentTrackInfo,
    appliedTrackXml: nextTrackXml,
    writeResult,
    after,
  };
}

async function tryFormatStorage(deviceId, diskId) {
  const normalizedDiskId = String(diskId || "").trim() || "1";
  const attempts = [
    {
      method: "PUT",
      url: `/ISAPI/ContentMgmt/Storage/hdd/${encodeURIComponent(normalizedDiskId)}/format`,
      contentType: "application/xml",
      body: "",
    },
    {
      method: "POST",
      url: `/ISAPI/ContentMgmt/Storage/hdd/${encodeURIComponent(normalizedDiskId)}/format`,
      contentType: "application/xml",
      body: "",
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await callIsapiProxyPass({ deviceId, ...attempt });
      return { result, attempt };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("SD kart bicimlendirme istegi basarisiz.");
}

async function searchCameraRecordings({
  cameraId,
  beginTime,
  endTime,
  pageIndex = 1,
  pageSize = 50,
  targetType = 0,
  timeType = 1,
}) {
  const data = await postOpenApi("/api/hccgw/video/v1/record/search", {
    pageSize,
    pageIndex,
    cameraId,
    filter: {
      timeType,
      beginTime,
      endTime,
      targetType,
    },
  });

  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw new Error(
      friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "Kayit arama basarisiz."
      )
    );
  }

  return {
    pageIndex: Number(data?.data?.pageIndex || pageIndex),
    pageSize: Number(data?.data?.pageSize || pageSize),
    recordList: Array.isArray(data?.data?.recordList) ? data.data.recordList : [],
  };
}

async function searchAllCameraRecordings({ cameraId, beginTime, endTime, targetType = 0, timeType = 1 }) {
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
    });
    segments.push(...page.recordList);
    if (page.recordList.length < pageSize) {
      break;
    }
  }

  return segments;
}

async function requestRecordingExport(cameraId, beginTime, endTime, voiceSwitch = 2) {
  const data = await postOpenApi("/api/hccgw/video/v1/video/save", {
    cameraId,
    beginTime,
    endTime,
    voiceSwitch,
  });

  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw new Error(
      friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "Kayit export istegi basarisiz."
      )
    );
  }

  const taskId = String(data?.data?.taskId || data.taskId || "").trim();
  if (!taskId) {
    throw new Error("video/save yanitinda taskId bulunamadi.");
  }

  return taskId;
}

async function getRecordingDownloadUrl(taskId) {
  const data = await postOpenApi("/api/hccgw/video/v1/video/download/url", { taskId });
  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode !== "0") {
    throw new Error(
      friendlyOpenApiError(
        errorCode,
        data.errorMsg || data.msg || "Kayit indirme URL bilgisi alinamadi."
      )
    );
  }

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
    lastResult = await getRecordingDownloadUrl(taskId);
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
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Kayit dosyasi indirilemedi. HTTP ${response.status}`);
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

        const recordList = await searchAllCameraRecordings({
          cameraId: camera.cameraId,
          beginTime,
          endTime,
          targetType: 0,
          timeType: 1,
        });

        const cameraResult = {
          cameraId: camera.cameraId,
          deviceId: camera.deviceId,
          deviceSerial: camera.deviceSerial,
          name: camera.name || "",
          beginTime,
          endTime,
          foundSegments: recordList.length,
          downloadedSegments: [],
          skippedSegments: [],
        };

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
            continue;
          }

          const taskId = await requestRecordingExport(
            camera.cameraId,
            segmentBeginTime,
            segmentEndTime
          );
          const downloadInfo = await waitForRecordingDownloadUrl(taskId);
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
            await downloadRecordingFile(downloadUrl, outputPath);
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

        result.cameras.push(cameraResult);
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
      mergeRecentRun(state, {
        runId,
        startedAt: result.startedAt,
        finishedAt: state.lastRunFinishedAt,
        status: "failed",
        reason: result.reason,
        error: state.lastError,
      });
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

function resolveSdkHelperCommand() {
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
        args: ["activate"],
        env: {},
        logDir: path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
      };
    }
  }

  return {
    file: "dotnet",
    args: [
      "run",
      "--project",
      path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "HikSdk.SadpConsole.csproj"),
      "-c",
      "Release",
      "--",
      "activate",
    ],
    env: {},
    logDir: path.join(LOCAL_SERVICE_ROOT, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
  };
}

async function activateCameraWithSdk(cameraIp, sdkPort, password) {
  const helper = resolveSdkHelperCommand();
  if (!fs.existsSync(helper.file) && helper.file !== "dotnet") {
    throw new Error(
      `HCNetSDK helper bulunamadi: ${helper.file}. Linux deploy icin native/hik_activation_helper_linux klasorunde 'make' calistirin.`
    );
  }

  const logDir = helper.logDir;

  const args = [
    ...helper.args,
    "--ip",
    cameraIp,
    "--port",
    String(sdkPort),
    "--logDir",
    logDir,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(helper.file, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        ...helper.env,
        HIKSDK_ACTIVATE_PASSWORD: password,
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

      if (!jsonLine) {
        reject(
          new Error(
            `HCNetSDK aktivasyon yardimcisi beklenen JSON yanitini vermedi. exitCode=${code}, stderr=${stderr.trim() || "-"}`
          )
        );
        return;
      }

      try {
        const payload = JSON.parse(jsonLine);
        resolve(payload);
      } catch (error) {
        reject(new Error(`HCNetSDK yardimci yaniti parse edilemedi. ${error.message}`));
      }
    });
  });
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

  const response = await fetch(`${INITIAL_SERVER}/api/hccgw/platform/v1/token/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: APP_KEY, secretKey: APP_SECRET }),
  });

  const data = await response.json();
  const errorCode = String(data.errorCode || data.code || "");
  if (!response.ok || errorCode !== "0") {
    throw new Error(
      `Token alinamadi. ${friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Token istegi basarisiz.")}`
    );
  }

  tokenCache = extractTokenInfo(data);
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

async function postOpenApi(pathName, payload, forceRefresh = false) {
  let token = await getToken(forceRefresh);

  const call = async () => {
    const response = await fetch(`${token.areaDomain}${pathName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: token.accessToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    return { response, data };
  };

  let { response, data } = await call();
  const errorCode = String(data.errorCode || data.code || "");
  if (errorCode === "OPEN000007" && !forceRefresh) {
    token = await getToken(true);
    ({ response, data } = await call());
  }

  if (!response.ok) {
    throw new Error(
      `OpenAPI istegi basarisiz. HTTP ${response.status}. ${data.errorMsg || data.msg || "Bilinmeyen hata"}`
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
    const { accessToken, areaDomain } = await getToken();
    const response = await fetch(`${areaDomain}/api/hccgw/resource/v1/areas/cameras/get`, {
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
    });

    const data = await response.json();
    if (String(data.errorCode || data.code || "") !== "0") {
      return res.status(502).json({
        error: `Hikvision hata dondu. ${friendlyOpenApiError(
          String(data.errorCode || data.code || ""),
          data.errorMsg || data.msg || "Kamera listesi alinamadi."
        )}`,
      });
    }

    const rawCameras = (data.data?.camera || []).map((cam) => ({
      name: cam.name,
      online: cam.online === "1",
      resourceId: cam.id,
      deviceId: cam.deviceId || cam.device?.id || cam.device?.deviceId || null,
      cameraIndexCode: cam.cameraIndexCode || null,
      deviceSerial: cam.device?.devInfo?.serialNo || null,
      channelNo: cam.device?.channelNo || cam.channelNo || null,
    }));

    const cameras = await Promise.all(
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

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }
  if (!confirmed) {
    return res.status(400).json({ error: "SD kart bicimlendirme icin onay gerekli." });
  }

  try {
    const before = await readStorageViaProxy(deviceId);
    const formatResult = await tryFormatStorage(deviceId, diskId || before.info.diskId);
    const after = await readStorageViaProxy(deviceId);

    return res.json({
      success: true,
      deviceId,
      diskId: diskId || before.info.diskId || "1",
      formatResult,
      before: before.info,
      after: after.info,
    });
  } catch (err) {
    return res.status(502).json({ error: sanitizeMessage(err.message) });
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

  if (!deviceId) {
    return res.status(400).json({ error: "deviceId zorunlu." });
  }
  if (!["enable", "disable", "continuous"].includes(action)) {
    return res.status(400).json({ error: "action enable|disable|continuous olmali." });
  }

  try {
    const operation = await applyLocalRecordOperation(deviceId, action);

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
    return res.status(502).json({ error: sanitizeMessage(error?.message || String(error)) });
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

ensureDirectory(RECORDING_SYNC_ROOT);
ensureDirectory(RECORDING_ARCHIVE_ROOT);
if (!fs.existsSync(RECORDING_SYNC_CONFIG_PATH)) {
  saveRecordingSyncConfig(buildDefaultRecordingSyncConfig());
}
if (!fs.existsSync(RECORDING_SYNC_STATE_PATH)) {
  saveRecordingSyncState(buildDefaultRecordingSyncState());
}
scheduleRecordingSyncLoop();

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda calisiyor`);
});
