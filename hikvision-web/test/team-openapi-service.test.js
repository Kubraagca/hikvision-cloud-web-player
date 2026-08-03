"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTeamOpenApiService } = require("../lib/team-openapi-service");

function createFetchMock(handler) {
  return async (url, options = {}) => handler(url, options);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("token yenilenir ve cihaz ekleme akisi tamamlanir", async () => {
  let tokenCount = 0;
  let deviceDetailCount = 0;
  const fetchImpl = createFetchMock((url) => {
    if (String(url).endsWith("/api/hccgw/platform/v1/token/get")) {
      tokenCount += 1;
      return jsonResponse(200, {
        errorCode: "0",
        data: {
          token: tokenCount === 1 ? "token-1" : "token-2",
          areaDomain: tokenCount === 1 ? "https://area-1" : "https://area-2",
          expire: 600,
        },
      });
    }

    if (String(url).includes("/api/hccgw/resource/v1/areas/get")) {
      return jsonResponse(200, { errorCode: "0", data: [{ areaID: "A1", areaName: "Musteri A" }] });
    }

    if (String(url).includes("/api/hccgw/resource/v1/devicedetail/get")) {
      deviceDetailCount += 1;
      if (deviceDetailCount === 1) {
        return jsonResponse(200, { errorCode: "OPEN000007", errorMsg: "token expired" });
      }

      if (deviceDetailCount === 2) {
        return jsonResponse(200, { errorCode: "0", data: { deviceSerialNo: "ABC123" } });
      }

      return jsonResponse(200, { errorCode: "0", data: { deviceId: "DEV-1", cameraChannel: [{ id: "CH-1", areaID: "A1" }] } });
    }

    if (String(url).includes("/api/hccgw/resource/v1/devices/add")) {
      return jsonResponse(200, { errorCode: "0", data: { succeeded: 1, failed: 0, deviceId: "DEV-1" } });
    }

    throw new Error(`Beklenmeyen fetch cagrisi: ${url}`);
  });

  const service = createTeamOpenApiService({
    appKey: "app-key",
    appSecret: "app-secret",
    fetchImpl,
    logger: { error() {} },
    now: () => 1000,
  });

  const result = await service.addDeviceToAreaWorkflow({
    shortSerial: "ABC123",
    verificationCode: "VERIFY123456",
    alias: "CAM-ABC123",
    areaName: "Musteri A",
  });

  assert.equal(result.deviceId, "DEV-1");
  assert.equal(result.deviceAdded, true);
  assert.equal(result.areaId, "A1");
  assert.equal(result.importedChannelCount, 0);
});

test("area yoksa olusturur ve mevcut cihazin eksik kanalini import eder", async () => {
  let areasGetCount = 0;
  const fetchImpl = createFetchMock((url) => {
    if (String(url).endsWith("/api/hccgw/platform/v1/token/get")) {
      return jsonResponse(200, { errorCode: "0", data: { token: "token-1", areaDomain: "https://area-1", expire: 600 } });
    }

    if (String(url).includes("/api/hccgw/resource/v1/areas/get")) {
      areasGetCount += 1;
      return jsonResponse(200, {
        errorCode: "0",
        data: areasGetCount === 1 ? [] : [{ areaID: "A2", areaName: "Musteri B" }],
      });
    }

    if (String(url).includes("/api/hccgw/resource/v1/areas/add")) {
      return jsonResponse(200, { errorCode: "0", data: { areaID: "A2" } });
    }

    if (String(url).includes("/api/hccgw/resource/v1/devicedetail/get")) {
      return jsonResponse(200, { errorCode: "0", data: { deviceId: "DEV-2", cameraChannel: [{ id: "CH-2", areaID: "OLD" }] } });
    }

    if (String(url).includes("/api/hccgw/resource/v1/areas/resources/add")) {
      return jsonResponse(200, { errorCode: "0", data: {} });
    }

    throw new Error(`Beklenmeyen fetch cagrisi: ${url}`);
  });

  const service = createTeamOpenApiService({
    appKey: "app-key",
    appSecret: "app-secret",
    fetchImpl,
    logger: { error() {} },
    now: () => 1000,
  });

  const result = await service.addDeviceToAreaWorkflow({
    shortSerial: "XYZ987",
    verificationCode: "VERIFY987654",
    alias: "CAM-XYZ987",
    areaName: "Musteri B",
  });

  assert.equal(result.deviceAdded, false);
  assert.equal(result.areaId, "A2");
  assert.equal(result.importedChannelCount, 1);
  assert.equal(result.totalChannelCount, 1);
});

test("Hikvision hatasi guvenli mesajla doner", async () => {
  const errors = [];
  const fetchImpl = createFetchMock((url) => {
    if (String(url).endsWith("/api/hccgw/platform/v1/token/get")) {
      return jsonResponse(200, { errorCode: "0", data: { token: "token-1", areaDomain: "https://area-1", expire: 600 } });
    }

    if (String(url).includes("/api/hccgw/resource/v1/areas/get")) {
      return jsonResponse(400, { errorCode: "LAP000001", errorMsg: "bad params" });
    }

    throw new Error(`Beklenmeyen fetch cagrisi: ${url}`);
  });

  const service = createTeamOpenApiService({
    appKey: "app-key",
    appSecret: "app-secret",
    fetchImpl,
    logger: { error(entry) { errors.push(entry); } },
    now: () => 1000,
  });

  await assert.rejects(
    () =>
      service.addDeviceToAreaWorkflow({
        shortSerial: "ERR001",
        verificationCode: "VERIFYERR001",
        areaName: "Hatali Alan",
      }),
    /Giris parametresi hatasi var/
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorCode, "LAP000001");
});
