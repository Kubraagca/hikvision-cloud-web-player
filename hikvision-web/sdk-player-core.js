(function (global) {
  function toPromise(value) {
    if (value && typeof value.then === "function") {
      return value;
    }
    return Promise.resolve(value);
  }

  class HikSdkInlinePlayer {
    constructor(options) {
      this.options = {
        containerId: "",
        basePath: "/sdk/dist",
        fitMode: "cover",
        widthProvider: null,
        onStatus: null,
        onFirstFrameDisplay: null,
        onPluginError: null,
        ...options,
      };
      this.plugin = null;
      this.windowReady = false;
      this.observer = null;
      this.liveInput = null;
    }

    setStatus(message) {
      if (typeof this.options.onStatus === "function") {
        this.options.onStatus(message);
      }
    }

    getContainer() {
      return document.getElementById(this.options.containerId);
    }

    getSize() {
      if (typeof this.options.widthProvider === "function") {
        return this.options.widthProvider();
      }
      const container = this.getContainer();
      const width = Math.max(320, Math.floor(container?.clientWidth || container?.offsetWidth || 960));
      const height = Math.max(180, Math.floor(width * 9 / 16));
      return { width, height };
    }

    applyFill() {
      const container = this.getContainer();
      if (!container) return;

      container.style.width = "100%";
      container.style.height = "100%";
      container.style.overflow = "hidden";

      const children = container.querySelectorAll("*");
      children.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        node.style.width = "100%";
        node.style.height = "100%";
        if (node.tagName === "CANVAS" || node.tagName === "VIDEO") {
          node.style.objectFit = this.options.fitMode;
        }
      });
    }

    async ensureCreated() {
      if (typeof global.JSPlugin !== "function") {
        throw new Error("JSPlugin tarayiciya yuklenemedi.");
      }

      const container = this.getContainer();
      if (!container) {
        throw new Error(`SDK container bulunamadi: ${this.options.containerId}`);
      }

      const { width, height } = this.getSize();

      if (!this.plugin) {
        this.plugin = new global.JSPlugin({
          szId: this.options.containerId,
          iType: 2,
          iWidth: width,
          iHeight: height,
          iMaxSplit: 4,
          iCurrentSplit: 1,
          szBasePath: this.options.basePath,
          openDebug: true,
          openLogInfo: true,
          oStyle: {
            border: "#343434",
            borderSelect: "red",
            background: "#4C4B4B",
          },
        });

        await toPromise(
          this.plugin.JS_SetWindowControlCallback({
            windowEventSelect(wndIndex) {
              console.log("[SDK windowEventSelect]", wndIndex);
            },
            secretKeyError: (wndIndex) => {
              const message = `SDK secret key hatasi [wnd=${wndIndex}]`;
              this.setStatus(message);
              console.error("[SDK secretKeyError]", { wndIndex });
            },
            pluginErrorHandler: (wndIndex, errorCode, detail) => {
              const message = `SDK hata [wnd=${wndIndex}]: ${errorCode}${detail ? ` - ${detail}` : ""}`;
              this.setStatus(message);
              if (typeof this.options.onPluginError === "function") {
                this.options.onPluginError({ wndIndex, errorCode, detail, message });
              }
              console.error("[SDK pluginErrorHandler]", { wndIndex, errorCode, detail });
            },
            onFirstFrameDisplay: () => {
              if (typeof this.options.onFirstFrameDisplay === "function") {
                this.options.onFirstFrameDisplay();
              }
            },
          })
        );

        await toPromise(this.plugin.JS_ArrangeWindow(1));
        this.windowReady = true;

        if (typeof MutationObserver === "function") {
          this.observer = new MutationObserver(() => this.applyFill());
          this.observer.observe(container, { childList: true, subtree: true, attributes: true });
        }
      } else {
        if (this.plugin.JS_Resize) {
          await toPromise(this.plugin.JS_Resize(width, height));
        }
        if (!this.windowReady && this.plugin.JS_ArrangeWindow) {
          await toPromise(this.plugin.JS_ArrangeWindow(1));
          this.windowReady = true;
        }
      }

      this.applyFill();
      return this.plugin;
    }

    async fillFromBackend({ resourceId, deviceSerial, channelNo = "1", quality = "1", code = "" }) {
      const params = new URLSearchParams({
        resourceId: String(resourceId || ""),
        deviceSerial: String(deviceSerial || ""),
        channelNo: String(channelNo || "1"),
        quality: String(quality || "1"),
      });
      if (code) {
        params.set("code", String(code));
      }

      const response = await fetch(`/api/sdk-live-input?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "SDK live input alinamadi.");
      }

      if (!data?.accessToken) {
        throw new Error("sdk-live-input accessToken bos dondu.");
      }
      if (!data?.appKey) {
        throw new Error("sdk-live-input appKey bos dondu.");
      }
      if (!data?.domain) {
        throw new Error("sdk-live-input domain bos dondu.");
      }

      this.liveInput = data;
      return data;
    }

    async startLiveView(liveInput, codeOverride = "") {
      const data = liveInput || this.liveInput;
      if (!data?.deviceSerial) {
        throw new Error("SDK live input hazir degil.");
      }
      if (!data?.accessToken) {
        throw new Error("SDK play oncesi accessToken yok.");
      }
      if (!data?.appKey) {
        throw new Error("SDK play oncesi appKey yok.");
      }
      if (!data?.domain) {
        throw new Error("SDK play oncesi domain yok.");
      }

      await this.ensureCreated();

      const secretKey = String(codeOverride || "").trim();
      if (secretKey && this.plugin.JS_SetSecretKey) {
        await toPromise(this.plugin.JS_SetSecretKey(0, secretKey));
      }

      const qualitySuffix = ".live";
      const manualUrl = data.sourceUrl;
      const ezopenUrl =
        manualUrl && String(manualUrl).startsWith("ezopen://")
          ? manualUrl
          : `ezopen://open.ezviz.com/${data.deviceSerial}/${Number(data.channelNo || "1")}${qualitySuffix}`;
      await toPromise(
        this.plugin.JS_Play(
          ezopenUrl,
          {
            ezuikit: true,
            playURL: ezopenUrl,
            accessToken: data.accessToken,
            appKey: data.appKey,
            mode: "media",
            env: {
              domain: data.domain,
            },
          },
          0
        )
      );

      this.applyFill();
      return data;
    }

    async loadAndPlayLive(options) {
      const data = await this.fillFromBackend(options);
      await this.startLiveView(data, options?.code || "");
      return data;
    }

    async stop() {
      if (!this.plugin) return;
      try {
        await toPromise(this.plugin.JS_Stop(0));
      } catch (_error) {
      }
    }

    async resize() {
      if (!this.plugin || !this.plugin.JS_Resize) return;
      const { width, height } = this.getSize();
      await toPromise(this.plugin.JS_Resize(width, height));
      this.applyFill();
    }

    getPlayableFrameElement() {
      const container = this.getContainer();
      if (!container) {
        return null;
      }

      const candidates = Array.from(container.querySelectorAll("canvas, video"));
      if (!candidates.length) {
        return null;
      }

      let best = candidates[0];
      let bestArea = 0;
      for (const candidate of candidates) {
        const width = candidate.videoWidth || candidate.naturalWidth || candidate.width || candidate.clientWidth || 0;
        const height = candidate.videoHeight || candidate.naturalHeight || candidate.height || candidate.clientHeight || 0;
        const area = width * height;
        if (area > bestArea) {
          best = candidate;
          bestArea = area;
        }
      }

      return best;
    }

    getSdkDrawCanvas() {
      if (!this.plugin) {
        return null;
      }

      try {
        if (typeof this.plugin.JS_GetDrawCanvasObj === "function") {
          const canvasObj = this.plugin.JS_GetDrawCanvasObj(0);
          if (canvasObj instanceof HTMLCanvasElement || canvasObj instanceof HTMLVideoElement) {
            return {
              element: canvasObj,
              method: "JS_GetDrawCanvasObj",
            };
          }
        }
      } catch (error) {
        console.warn("JS_GetDrawCanvasObj failed", error);
      }

      try {
        if (typeof this.plugin.JS_GetCanvasIDByWnd === "function") {
          const canvasId = this.plugin.JS_GetCanvasIDByWnd(0);
          if (canvasId) {
            const element = document.getElementById(String(canvasId));
            if (element instanceof HTMLCanvasElement || element instanceof HTMLVideoElement) {
              return {
                element,
                method: "JS_GetCanvasIDByWnd",
              };
            }
          }
        }
      } catch (error) {
        console.warn("JS_GetCanvasIDByWnd failed", error);
      }

      const fallbackEl = this.getPlayableFrameElement();
      if (fallbackEl) {
        return {
          element: fallbackEl,
          method: "DOMQuery",
        };
      }

      return null;
    }

    captureCurrentFrame() {
      const source = this.getSdkDrawCanvas();
      if (!source?.element) {
        return null;
      }

      const width =
        source.element.videoWidth ||
        source.element.naturalWidth ||
        source.element.width ||
        source.element.clientWidth;
      const height =
        source.element.videoHeight ||
        source.element.naturalHeight ||
        source.element.height ||
        source.element.clientHeight;

      if (!width || !height) {
        return null;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(source.element, 0, 0, width, height);

      return {
        imageBase64: canvas.toDataURL("image/jpeg", 0.92),
        width,
        height,
        elementTag: source.element.tagName.toLowerCase(),
        method: source.method,
      };
    }
  }

  global.HikSdkPlayerCore = {
    createPlayer(options) {
      return new HikSdkInlinePlayer(options);
    },
  };
})(window);
