"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.HIK_APP_KEY = process.env.HIK_APP_KEY || "test-app-key";
process.env.HIK_APP_SECRET = process.env.HIK_APP_SECRET || "test-app-secret";
process.env.HIK_INITIAL_SERVER = process.env.HIK_INITIAL_SERVER || "https://ieu.hikcentralconnect.com";

const { app } = require("../server");

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

function buildCameraListResponse() {
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
              id: "dev-1",
              serialNo: "GL4477439",
            },
            channelInfo: {
              no: 1,
            },
          },
        },
      ],
    },
  };
}

test("playback export route selected segment icin mp4 URL hazirlar", async (t) => {
  let downloadPollCount = 0;
  let videoSaveBody = null;

  await withServerAndMock(
    t,
    async (url, options) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            accessToken: "token-1",
            areaDomain: "https://area-1",
            expireTime: 999999,
          },
        });
      }

      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }

      if (url.includes("/api/hccgw/video/v1/record/element/search")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            pageIndex: 1,
            pageSize: 50,
            recordList: [
              {
                beginTime: "2026-08-06T15:32:10+03:00",
                endTime: "2026-08-06T16:14:20+03:00",
                targetType: 0,
              },
            ],
          },
        });
      }

      if (url.includes("/api/hccgw/video/v1/video/save")) {
        videoSaveBody = JSON.parse(String(options.body || "{}"));
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            taskId: "task-123",
          },
        });
      }

      if (url.includes("/api/hccgw/video/v1/video/download/url")) {
        downloadPollCount += 1;
        if (downloadPollCount === 1) {
          return createJsonResponse(200, {
            errorCode: "0",
            data: {
              status: 1,
              urls: [],
            },
          });
        }
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            status: 0,
            expireTime: 1786025804953,
            urls: ["https://download.example.com/export.mp4"],
          },
        });
      }

      throw new Error(`Beklenmeyen fetch cagrisi: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/playback/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beginTime: "2026-08-06T15:40:00+03:00",
          endTime: "2026-08-06T16:10:00+03:00",
          targetType: 0,
        }),
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.ready, true);
      assert.equal(body.taskId, "task-123");
      assert.equal(body.downloadUrl, "https://download.example.com/export.mp4");
      assert.equal(body.statusLabel, "hazir");
      assert.equal(body.selectedSegment.beginTime, "2026-08-06T15:32:10+03:00");
      assert.equal(videoSaveBody.cameraId, "cam-1");
      assert.equal(videoSaveBody.voiceSwitch, 0);
      assert.equal(downloadPollCount, 2);
    }
  );
});

test("playback export OPEN000009 dondugunde anlamli hata mesaji verir", async (t) => {
  await withServerAndMock(
    t,
    async (url) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            accessToken: "token-1",
            areaDomain: "https://area-1",
            expireTime: 999999,
          },
        });
      }

      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }

      if (url.includes("/api/hccgw/video/v1/record/element/search")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            pageIndex: 1,
            pageSize: 50,
            recordList: [
              {
                beginTime: "2026-08-06T15:32:10+03:00",
                endTime: "2026-08-06T16:14:20+03:00",
                targetType: 0,
              },
            ],
          },
        });
      }

      if (url.includes("/api/hccgw/video/v1/video/save")) {
        return createJsonResponse(200, {
          errorCode: "OPEN000009",
          errorMsg: "Network exception. Please try again later.",
        });
      }

      throw new Error(`Beklenmeyen fetch cagrisi: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/cameras/cam-1/playback/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beginTime: "2026-08-06T15:40:00+03:00",
          endTime: "2026-08-06T16:10:00+03:00",
          targetType: 0,
        }),
      });

      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(body.error, /Hik-Connect MP4 export islemi sirasinda network\/upstream hatasi dondurdu\./);
      assert.equal(body.diagnostic.errorCode, "OPEN000009");
    }
  );
});

test("motion events route gun bazli sayfalama ile sadece secili kameranin motion alarmlarini dondurur", async (t) => {
  let alarmCallCount = 0;

  await withServerAndMock(
    t,
    async (url, options = {}) => {
      if (url.endsWith("/api/hccgw/platform/v1/token/get")) {
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            accessToken: "token-1",
            areaDomain: "https://area-1",
            expireTime: 999999,
          },
        });
      }

      if (url.includes("/api/hccgw/resource/v1/areas/cameras/get")) {
        return createJsonResponse(200, buildCameraListResponse());
      }

      if (url.includes("/api/hccgw/alarm/v1/alarmlog")) {
        alarmCallCount += 1;
        const body = JSON.parse(String(options.body || "{}"));

        if (alarmCallCount === 1) {
          assert.equal(body.pageIndex, 1);
          assert.deepEqual(body.eventTypeList, ["10002"]);
          assert.equal(body.timeRange.beginTime, "2026-08-05 23:30:00");
          assert.equal(body.timeRange.endTime, "2026-08-05 23:59:59");
          return createJsonResponse(200, {
            errorCode: "0",
            data: {
              moreData: true,
              alarmLogList: [
                {
                  eventSource: {
                    eventType: "10002",
                    sourceID: "cam-1",
                    sourceType: "camera",
                  },
                  timeInfo: {
                    startTime: "2026-08-05 23:40:00",
                    endTime: "2026-08-05 23:45:00",
                  },
                },
              ],
            },
          });
        }

        if (alarmCallCount === 2) {
          assert.equal(body.pageIndex, 2);
          return createJsonResponse(200, {
            errorCode: "0",
            data: {
              moreData: false,
              alarmLogList: [
                {
                  eventSource: {
                    eventType: "10002",
                    sourceID: "cam-2",
                    sourceType: "camera",
                  },
                  timeInfo: {
                    startTime: "2026-08-05 23:50:00",
                    endTime: "2026-08-05 23:52:00",
                  },
                },
              ],
            },
          });
        }

        assert.equal(body.pageIndex, 1);
        assert.equal(body.timeRange.beginTime, "2026-08-06 00:00:00");
        assert.equal(body.timeRange.endTime, "2026-08-06 01:15:00");
        return createJsonResponse(200, {
          errorCode: "0",
          data: {
            moreData: false,
            alarmLogList: [
              {
                eventSource: {
                  eventType: "10002",
                  sourceID: "cam-1",
                  sourceType: "camera",
                },
                timeInfo: {
                  startTime: "2026-08-06 00:10:00",
                  endTime: "2026-08-06 00:17:00",
                },
              },
              {
                eventSource: {
                  eventType: "10003",
                  sourceID: "cam-1",
                  sourceType: "camera",
                },
                timeInfo: {
                  startTime: "2026-08-06 00:20:00",
                  endTime: "2026-08-06 00:25:00",
                },
              },
            ],
          },
        });
      }

      throw new Error(`Beklenmeyen fetch cagrisi: ${url}`);
    },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/cameras/cam-1/motion-events?beginTime=${encodeURIComponent("2026-08-05T23:30:00+03:00")}&endTime=${encodeURIComponent("2026-08-06T01:15:00+03:00")}`
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.cameraId, "cam-1");
      assert.equal(body.motionEvents.length, 2);
      assert.deepEqual(body.motionEvents.map((item) => item.startTime), [
        "2026-08-05 23:40:00",
        "2026-08-06 00:10:00",
      ]);
      assert.ok(body.motionEvents.every((item) => item.cameraId === "cam-1"));
      assert.equal(alarmCallCount, 3);
    }
  );
});
