const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createTeamOpenApiService } = require("./lib/team-openapi-service");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.HIK_APP_KEY;
const APP_SECRET = process.env.HIK_APP_SECRET;
const INITIAL_SERVER =
  process.env.HIK_INITIAL_SERVER || "https://ieu.hikcentralconnect.com";

const SDK_BASE_PATH = "/sdk";
const SDK_DIST_PATH = path.join(__dirname, "sdk", "dist");
const streamCache = new Map();
const provisioningTasks = new Map();

let tokenCache = {
  accessToken: null,
  areaDomain: null,
  expireTime: 0,
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

app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

app.use(express.static(__dirname));
app.use(SDK_BASE_PATH, express.static(path.join(__dirname, "sdk")));

const LOCAL_AGENT_ZIP_PATH = path.join(
  __dirname,
  "src",
  "HikDiscovery",
  "HikProvisioning.Web",
  "wwwroot",
  "downloads",
  "local-agent",
  "HikProvisioning.Agent-win-x64.zip"
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
  return findInterfaceBlocks(xml)
    .map((block) => ({
      id:
        getXmlValue(block, ["id", "interfaceId", "name", "portNo"]) || "-",
      ipAddress:
        getXmlValue(block, ["ipAddress", "ipv4Address", "IPAddress"]) || "-",
      subnetMask:
        getXmlValue(block, ["subnetMask", "ipv4SubnetMask"]) || "-",
      gateway:
        getXmlValue(block, ["DefaultGateway", "defaultGateway", "ipv4DefaultGateway"]) || "-",
      primaryDns:
        getXmlValue(block, ["PrimaryDNS", "primaryDNS", "dnsServer1IpAddr", "DNS1"]) || "-",
      secondaryDns:
        getXmlValue(block, ["SecondaryDNS", "secondaryDNS", "dnsServer2IpAddr", "DNS2"]) || "-",
      dhcpMode:
        getXmlValue(block, ["addressingType", "ipAddressingType", "dhcp", "DHCP"]) || "-",
      rawXml: block,
    }))
    .filter((item) => item.id !== "-" || item.ipAddress !== "-");
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

function createVerificationCode(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let output = "";
  for (const value of bytes) {
    output += alphabet[value % alphabet.length];
  }
  return output;
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
      __dirname,
      "native",
      "hik_activation_helper_linux",
      "build",
      "hik_activation_helper"
    );
    const linuxSdkLibDir = path.join(
      __dirname,
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
      logDir: path.join(__dirname, "native", "hik_activation_helper_linux", "logs"),
    };
  }

  const exeCandidates = [
    path.join(
      __dirname,
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
      __dirname,
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
        logDir: path.join(__dirname, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
      };
    }
  }

  return {
    file: "dotnet",
    args: [
      "run",
      "--project",
      path.join(__dirname, "src", "HikDiscovery", "HikSdk.SadpConsole", "HikSdk.SadpConsole.csproj"),
      "-c",
      "Release",
      "--",
      "activate",
    ],
    env: {},
    logDir: path.join(__dirname, "src", "HikDiscovery", "HikSdk.SadpConsole", "bin", "sdk-logs"),
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

async function addDeviceAndImportChannels({ shortSerial, verificationCode, alias, areaId }) {
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
        userName: "",
        password: "",
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
    const succeeded = Number(data.data?.succeeded || 0);
    const failed = Number(data.data?.failed || 0);
    deviceId = extractDeviceId(data.data);

    if (errorCode !== "0" || failed !== 0 || succeeded !== 1 || !deviceId) {
      const effectiveErrorCode = firstInnerErrorCode(data.data) || errorCode;
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

  updateTaskStage(task, "Hik-Connect Ayari", "Calisiyor", "EZVIZ/Hik-Connect ayari yapiliyor.");
  const verificationCode = createVerificationCode(12);
  const enableEzvizXml = `<?xml version="1.0" encoding="UTF-8"?>
<EZVIZ version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <enabled>true</enabled>
  <verificationCode>${escapeXml(verificationCode)}</verificationCode>
</EZVIZ>`;
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
      error: sanitizeMessage(err.message),
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
      expiresAt: normalizeExpireTime(token.expireTime),
      sdkInstalled: isSdkInstalled(),
      note: "Hikvision token frontend'e gonderilmez. JSDecoder benzeri entegrasyonlar backend proxy veya yerel SDK katmani uzerinden ilerlemelidir.",
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeMessage(err.message) });
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

    const cameras = (data.data?.camera || []).map((cam) => ({
      name: cam.name,
      online: cam.online === "1",
      resourceId: cam.id,
      cameraIndexCode: cam.cameraIndexCode || null,
      deviceSerial: cam.device?.devInfo?.serialNo || null,
      channelNo: cam.device?.channelNo || cam.channelNo || null,
    }));

    res.json({ cameras });
  } catch (err) {
    res.status(500).json({ error: sanitizeMessage(err.message) });
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

app.post("/api/team-devices/add", async (req, res) => {
  if (!ensureCredentials(res)) return;

  const input = {
    shortSerial: String(req.body.shortSerial || "").trim(),
    verificationCode: String(req.body.verificationCode || "").trim(),
    alias: String(req.body.alias || "").trim(),
    areaName: String(req.body.areaName || "").trim(),
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

app.get("/camera-setup", (req, res) => {
  res.sendFile(path.join(__dirname, "provisioning.html"));
});

app.get("/camera-browser-test", (req, res) => {
  res.sendFile(path.join(__dirname, "browser-network-test.html"));
});

app.get("/team-device-add", (req, res) => {
  res.sendFile(path.join(__dirname, "team-device-add.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda calisiyor`);
});
