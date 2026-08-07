"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCaptureObjectUrl, revokeCaptureObjectUrl } = require("../capture-preview");

process.env.HIK_APP_KEY = process.env.HIK_APP_KEY || "test-app-key";
process.env.HIK_APP_SECRET = process.env.HIK_APP_SECRET || "test-app-secret";
process.env.HIK_INITIAL_SERVER = process.env.HIK_INITIAL_SERVER || "https://ieu.hikcentralconnect.com";

const {
  app,
  sanitizeMessage,
  isTrustedHikCaptureUrl,
  sniffImageContentType,
  normalizeHikCaptureUrl,
} = require("../server");

function createJsonResponse(status, body, headers = {}) {
  const runtimeHeaders = new Headers({
    "content-type": "application/json",
    ...headers,
  });
  const payload = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: runtimeHeaders,
    async text() {
      return payload;
    },
    async json() {
      return body;
    },
    async arrayBuffer() {
      return Buffer.from(payload);
    },
  };
}

function createBinaryResponse(status, buffer, headers = {}) {
  const runtimeHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: runtimeHeaders,
    async text() {
      return Buffer.from(buffer).toString("utf8");
    },
    async json() {
      return JSON.parse(Buffer.from(buffer).toString("utf8"));
    },
    async arrayBuffer() {
      return Buffer.from(buffer);
    },
  };
}

function createFakeJpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
}

async function withServerAndMock(t, externalHandler, run) {
  const realFetch = global.fetch;
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  global.fetch = async (url, options = {}) => {
    const normalizedUrl = String(url);
    if (normalizedUrl.startsWith(baseUrl)) {
      return realFetch(url, options);
    }
    return externalHandler(normalizedUrl, options);
  };

  t.after(async () => {
    global.fetch = realFetch;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  return run(baseUrl);
}

function buildCameraListResponse(cameraOverrides = {}) {
  return {
    errorCode: "0",
    data: {
      camera: [
        {
          id: "cam-1",
          name: "Kamera 1",
          online: "1",
          device: {
            devInfo: {
              serialNo: "GL4477439",
            },
            channelInfo: {
              no: 7,
            },
          },
          ...cameraOverrides,
        },
      ],
    },
  };
}

test("online kameradan basarili capture", async (t) => {
  const calls = [];
  const jpegBuffer = createFakeJpegBuffer();
  await withServerAndMock(
    t,
    async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            accessToken: "token-123",
            areaDomain: "https://isgpopen.ezvizlife.com",
            expireTime: 1890000000,
          },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            captureUrl: "https://snapshot.ezvizlife.com/capture.jpeg?token=super-secret",
            isEncrypted: 0,
          },
        });
      }
      if (url.startsWith("https://snapshot.ezvizlife.com/")) {
        return createBinaryResponse(200, jpegBuffer, {
          "content-type": "image/jpeg",
          "content-length": String(jpegBuffer.length),
        });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, jpegBuffer.length);
      assert.ok(calls.some((entry) => entry.url.includes("/device/capturePic")));
    }
  );
});

test("kamera bulunamadiginda hata", async (t) => {
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, { errorCode: "0", data: { camera: [] } });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-404/capture`, { method: "POST" });
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.match(body.error, /Kamera bulunamadi/);
    }
  );
});

test("kamera offline oldugunda capture API cagrilmaz", async (t) => {
  let capturePicCalled = false;
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse({ online: "0" }));
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        capturePicCalled = true;
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 409);
      assert.equal(capturePicCalled, false);
    }
  );
});

test("Hik-Connect errorCode 0 disinda cevap verdiginde hata", async (t) => {
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, { errorCode: "EVZ20007", errorMsg: "offline" });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.match(body.error || JSON.stringify(body), /cevrimdisi/);
    }
  );
});

test("captureUrl bos oldugunda hata", async (t) => {
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, { errorCode: "0", data: { captureUrl: "", isEncrypted: 0 } });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(body.error || JSON.stringify(body), /bos dondu/);
    }
  );
});

test("resim yerine HTML dondugunde istek reddedilir", async (t) => {
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { captureUrl: "https://snapshot.ezvizlife.com/error-page", isEncrypted: 0 },
        });
      }
      if (url.startsWith("https://snapshot.ezvizlife.com/error-page")) {
        return createBinaryResponse(200, Buffer.from("<html>bad</html>"), {
          "content-type": "text/html",
        });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(body.error || JSON.stringify(body), /gecerli bir resim donmedi/);
    }
  );
});

test("yanlis content-type gelse de gecerli png byte'lari render icin kabul edilir", async (t) => {
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);

  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { captureUrl: "https://snapshot.ezvizlife.com/capture.png", isEncrypted: 0 },
        });
      }
      if (url.startsWith("https://snapshot.ezvizlife.com/capture.png")) {
        return createBinaryResponse(200, pngBuffer, {
          "content-type": "image/jpeg",
          "content-length": String(pngBuffer.length),
        });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, pngBuffer.length);
    }
  );
});

test("isEncrypted 1 oldugunda desteklenmeyen sifreleme hatasi", async (t) => {
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { captureUrl: "https://snapshot.ezvizlife.com/capture.enc", isEncrypted: 1 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/thumbnail/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            pictureURL: "https://testuslite.ezvizlife.com/image/pic/thumb.jpg",
            isEncrypted: 1,
          },
        });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 501);
      const body = await response.json();
      assert.match(body.error, /Sifreli fotograf cozme destegi bulunmuyor/);
    }
  );
});

test("capturePic sifreliyse thumbnail fallback ile fotograf alinabilir", async (t) => {
  let thumbnailCalled = false;
  const jpegBuffer = createFakeJpegBuffer();
  await withServerAndMock(
    t,
    async (url, options) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { captureUrl: "https://snapshot.ezvizlife.com/capture.enc", isEncrypted: 1 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/thumbnail/get")) {
        thumbnailCalled = true;
        const payload = JSON.parse(options.body);
        assert.equal(payload.cameraID, "cam-1");
        assert.equal(payload.refresh, 1);
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            pictureURL: "https://testuslite.ezvizlife.com:443/https://testuslite.ezvizlife.com/image/pic/thumb.jpg",
            isEncrypted: 0,
          },
        });
      }
      if (url.startsWith("https://testuslite.ezvizlife.com/image/pic/thumb.jpg")) {
        return createBinaryResponse(200, jpegBuffer, {
          "content-type": "image/jpeg",
          "content-length": String(jpegBuffer.length),
        });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(thumbnailCalled, true);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, jpegBuffer.length);
    }
  );
});

test("channelNo kamera bilgisinden alinir", async (t) => {
  let seenPayload = null;
  const jpegBuffer = createFakeJpegBuffer();
  await withServerAndMock(
    t,
    async (url, options) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: { accessToken: "token-123", areaDomain: "https://isgpopen.ezvizlife.com", expireTime: 1890000000 },
        });
      }
      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse({
          device: { devInfo: { serialNo: "GL4477439" }, channelInfo: { no: "9" } },
        }));
      }
      if (url.includes("/api/hccgw/resource/v1/device/capturePic")) {
        seenPayload = JSON.parse(options.body);
        return createJsonResponse(200, {
          errorCode: "0",
          data: { captureUrl: "https://snapshot.ezvizlife.com/capture.jpeg", isEncrypted: 0 },
        });
      }
      if (url.startsWith("https://snapshot.ezvizlife.com/")) {
        return createBinaryResponse(200, jpegBuffer, {
          "content-type": "image/jpeg",
          "content-length": String(jpegBuffer.length),
        });
      }
      throw new Error(`Beklenmeyen fetch: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/capture`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(seenPayload.channelNo, 9);
    }
  );
});

test("token ve captureUrl loglardan maskelenir", () => {
  const message = sanitizeMessage(
    'Token: token-123 https://snapshot.ezvizlife.com/capture.jpeg?accessToken=abc&token=xyz "accessToken":"abc"'
  );
  assert.equal(message.includes("token-123"), false);
  assert.equal(message.includes("accessToken=abc"), false);
  assert.equal(message.includes('"accessToken":"abc"'), false);
  assert.equal(isTrustedHikCaptureUrl("https://snapshot.ezvizlife.com/capture.jpeg?token=abc", "https://isgpopen.ezvizlife.com"), true);
  assert.equal(isTrustedHikCaptureUrl("https://cdn-images.example.net/capture.jpeg?token=abc", "https://isgpopen.ezvizlife.com"), true);
  assert.equal(isTrustedHikCaptureUrl("http://10.19.215.172:31677/hcc-dev-2/hccopen/capture/demo.jpeg", "https://isgpopen.ezvizlife.com"), true);
  assert.equal(isTrustedHikCaptureUrl("https://localhost/capture.jpeg?token=abc", "https://isgpopen.ezvizlife.com"), false);
  assert.equal(isTrustedHikCaptureUrl("http://127.0.0.1/capture.jpeg?token=abc", "https://isgpopen.ezvizlife.com"), false);
  assert.equal(sniffImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
  assert.equal(sniffImageContentType(Buffer.from([0x3c, 0x68, 0x74, 0x6d, 0x6c])), "");
  assert.equal(
    normalizeHikCaptureUrl("https://testuslite.ezvizlife.com:443/https://testuslite.ezvizlife.com/image/pic/thumb.jpg"),
    "https://testuslite.ezvizlife.com/image/pic/thumb.jpg"
  );
});

test("frontend Blob URL olusturma ve temizleme", () => {
  const calls = [];
  const fakeUrlApi = {
    createObjectURL(blob) {
      calls.push({ type: "create", blob });
      return "blob:preview-1";
    },
    revokeObjectURL(url) {
      calls.push({ type: "revoke", url });
    },
  };

  const objectUrl = createCaptureObjectUrl({ size: 4 }, fakeUrlApi);
  assert.equal(objectUrl, "blob:preview-1");
  revokeCaptureObjectUrl(objectUrl, fakeUrlApi);
  assert.deepEqual(calls, [
    { type: "create", blob: { size: 4 } },
    { type: "revoke", url: "blob:preview-1" },
  ]);
});
