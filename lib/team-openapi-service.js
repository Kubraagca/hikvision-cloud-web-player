"use strict";

function createTeamOpenApiService({
  appKey,
  appSecret,
  initialServer = "https://ieu.hikcentralconnect.com",
  fetchImpl = global.fetch,
  logger = console,
  now = () => Math.floor(Date.now() / 1000),
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation zorunlu.");
  }

  const tokenCache = {
    accessToken: null,
    areaDomain: null,
    expireTime: 0,
  };

  function sanitizeMessage(message) {
    let output = String(message || "Bilinmeyen hata");
    if (appKey) {
      output = output.replaceAll(appKey, "***");
    }
    if (appSecret) {
      output = output.replaceAll(appSecret, "***");
    }
    return output
      .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"***"')
      .replace(/"userName"\s*:\s*"[^"]*"/gi, '"userName":"***"')
      .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"***"')
      .replace(/"accessToken"\s*:\s*"[^"]+"/gi, '"accessToken":"***"')
      .replace(/Token:\s*[^\s,]+/gi, "Token: ***");
  }

  function logOpenApiFailure(context) {
    const entry = {
      scope: "hikvision-team-openapi",
      operation: context.operation,
      pathName: context.pathName || "",
      httpStatus: context.httpStatus ?? null,
      errorCode: context.errorCode || "",
      shortSerial: context.shortSerial || "",
      areaName: context.areaName || "",
      areaId: context.areaId || "",
      message: sanitizeMessage(context.message || ""),
    };

    if (typeof logger?.error === "function") {
      logger.error(entry);
    }
  }

  function normalizeExpireTime(rawExpireTime) {
    const numeric = Number(rawExpireTime || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric;
  }

  function extractTokenInfo(data) {
    return {
      accessToken: data.data?.accessToken || data.data?.token || null,
      areaDomain: data.data?.areaDomain || null,
      expireTime: normalizeExpireTime(data.data?.expireTime || data.data?.expire || 0),
    };
  }

  async function getToken(forceRefresh = false) {
    if (!appKey || !appSecret) {
      throw new Error("HIK_APP_KEY / HIK_APP_SECRET ortam degiskenleri tanimli degil.");
    }

    if (!forceRefresh && tokenCache.accessToken && tokenCache.expireTime - now() > 60) {
      return tokenCache;
    }

    const response = await fetchImpl(`${initialServer}/api/hccgw/platform/v1/token/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, secretKey: appSecret }),
    });

    const data = await response.json();
    const errorCode = String(data.errorCode || data.code || "");
    if (!response.ok || errorCode !== "0") {
      logOpenApiFailure({
        operation: "token.get",
        pathName: "/api/hccgw/platform/v1/token/get",
        httpStatus: response.status,
        errorCode,
        message: data.errorMsg || data.msg || "Token istegi basarisiz.",
      });

      throw new Error(
        `Token alinamadi. ${friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Token istegi basarisiz.")}`
      );
    }

    Object.assign(tokenCache, extractTokenInfo(data));
    return tokenCache;
  }

  async function postOpenApi(pathName, payload, options = {}) {
    const operation = options.operation || pathName;
    let token = await getToken(Boolean(options.forceRefresh));

    const call = async () => {
      const response = await fetchImpl(`${token.areaDomain}${pathName}`, {
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
    const firstErrorCode = String(data.errorCode || data.code || "");
    if (firstErrorCode === "OPEN000007" && !options.forceRefresh) {
      token = await getToken(true);
      ({ response, data } = await call());
    }

    if (!response.ok) {
      const errorCode = String(data.errorCode || data.code || "");
      logOpenApiFailure({
        operation,
        pathName,
        httpStatus: response.status,
        errorCode,
        shortSerial: options.shortSerial,
        areaName: options.areaName,
        areaId: options.areaId,
        message: data.errorMsg || data.msg || "OpenAPI istegi basarisiz.",
      });

      throw new Error(
        `OpenAPI istegi basarisiz. HTTP ${response.status}. ${friendlyOpenApiError(
          errorCode,
          data.errorMsg || data.msg || "Bilinmeyen hata"
        )}`
      );
    }

    return data;
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
      if (!node || typeof node !== "object") {
        continue;
      }

      const areaId =
        node.areaID != null && String(node.areaID).trim()
          ? String(node.areaID).trim()
          : node.id != null && String(node.id).trim()
            ? String(node.id).trim()
            : "";
      const areaName =
        typeof node.areaName === "string" && node.areaName.trim()
          ? node.areaName.trim()
          : typeof node.name === "string" && node.name.trim()
            ? node.name.trim()
            : "";

      if (
        areaId &&
        areaName
      ) {
        areas.push({ areaId, areaName });
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

  function isIgnorableAreaResourceError(errorCode) {
    return errorCode === "LAP000026";
  }

  async function getAreas() {
    const data = await postOpenApi(
      "/api/hccgw/resource/v1/areas/get",
      {
        pageIndex: "1",
        pageSize: "500",
        filter: {
          parentAreaID: "-1",
          includeSubArea: 1,
        },
      },
      { operation: "areas.get" }
    );
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

    const addData = await postOpenApi(
      "/api/hccgw/resource/v1/areas/add",
      {
        parentAreaID: "-1",
        areaName,
      },
      { operation: "areas.add", areaName }
    );

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
    const data = await postOpenApi(
      "/api/hccgw/resource/v1/devicedetail/get",
      { deviceSerialNo: shortSerial },
      { operation: "devicedetail.get", shortSerial }
    );

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
      exists: Boolean(extractDeviceId(data.data)) || Boolean(parseCameraChannels(data).length),
      errorCode: "0",
      errorMessage: "",
      deviceId: extractDeviceId(data.data),
      cameraChannels: parseCameraChannels(data),
    };
  }

  async function addDeviceAndImportChannels({ shortSerial, verificationCode, alias, areaId, areaName, userName, password }) {
    const existingDetail = await getDeviceDetail(shortSerial);
    let deviceAdded = false;
    let deviceId = existingDetail.deviceId;
    let deviceStatusMessage = "";

    if (!existingDetail.exists) {
      const data = await postOpenApi(
        "/api/hccgw/resource/v1/devices/add",
        {
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
        },
        { operation: "devices.add", shortSerial, areaId, areaName }
      );

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
      channelStatusMessage = "Cihaz importToArea enable=1 ile eklendi; portalda manuel import gerekmiyor.";
    } else {
      const missingChannels = channels.filter(
        (channel) => !channel.areaIds.some((item) => item.toLowerCase() === areaId.toLowerCase())
      );

      for (const channel of missingChannels) {
        const data = await postOpenApi(
          "/api/hccgw/resource/v1/areas/resources/add",
          {
            areaID: areaId,
            devChannel: [
              {
                resourceName: alias,
                resourceType: "camera",
                channelID: channel.id,
              },
            ],
          },
          { operation: "areas.resources.add", shortSerial, areaId, areaName }
        );

        const errorCode = String(data.errorCode || data.code || "");
        if (errorCode !== "0") {
          if (isIgnorableAreaResourceError(errorCode)) {
            continue;
          }
          throw new Error(friendlyOpenApiError(errorCode, data.errorMsg || data.msg || "Kanal alana aktarilamadi."));
        }

        const innerError = firstInnerErrorCode(data.data);
        if (innerError) {
          if (isIgnorableAreaResourceError(innerError)) {
            continue;
          }
          throw new Error(friendlyOpenApiError(innerError, "Kanal alana aktarimi ic hata dondu."));
        }

        importedChannelCount += 1;
      }

      channelStatusMessage =
        importedChannelCount > 0
          ? "Kanal alana aktarildi."
          : "Kanal aktarimi API tarafinda tekrar gerektirmedi veya kanal zaten alandaydi.";
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

  async function addDeviceToAreaWorkflow({ shortSerial, verificationCode, alias, areaName, areaId, userName, password }) {
    const normalizedShortSerial = String(shortSerial || "").trim();
    const normalizedVerificationCode = String(verificationCode || "").trim();
    const normalizedAlias = String(alias || "").trim() || `CAM-${normalizedShortSerial}`;
    const normalizedAreaName = String(areaName || "").trim() || normalizedAlias;
    const normalizedAreaId = String(areaId || "").trim();
    const normalizedUserName = String(userName || "").trim();
    const normalizedPassword = String(password || "");

    if (!normalizedShortSerial) {
      throw new Error("shortSerial zorunlu.");
    }

    if (!normalizedVerificationCode) {
      throw new Error("verificationCode zorunlu.");
    }

    let area;
    if (normalizedAreaId) {
      const areas = await getAreas();
      area = areas.find((item) => item.areaId.toLowerCase() === normalizedAreaId.toLowerCase());
      if (!area) {
        throw new Error(`Secilen alan bulunamadi. areaId=${normalizedAreaId}`);
      }
    } else {
      area = await ensureArea(normalizedAreaName);
    }

    const result = await addDeviceAndImportChannels({
      shortSerial: normalizedShortSerial,
      verificationCode: normalizedVerificationCode,
      alias: normalizedAlias,
      areaId: area.areaId,
      areaName: area.areaName,
      userName: normalizedUserName,
      password: normalizedPassword,
    });

    return {
      shortSerial: normalizedShortSerial,
      alias: normalizedAlias,
      areaId: area.areaId,
      areaName: area.areaName,
      ...result,
    };
  }

  return {
    sanitizeMessage,
    getToken,
    postOpenApi,
    getAreas,
    ensureArea,
    getDeviceDetail,
    addDeviceAndImportChannels,
    addDeviceToAreaWorkflow,
  };
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

module.exports = {
  createTeamOpenApiService,
  friendlyOpenApiError,
};
