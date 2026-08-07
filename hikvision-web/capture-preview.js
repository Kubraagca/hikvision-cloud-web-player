(function (globalScope) {
  function createCaptureObjectUrl(blob, urlApi) {
    const runtimeUrlApi = urlApi || globalScope.URL;
    if (!runtimeUrlApi || typeof runtimeUrlApi.createObjectURL !== "function") {
      throw new Error("Blob URL olusturma destegi bulunamadi.");
    }
    return runtimeUrlApi.createObjectURL(blob);
  }

  function revokeCaptureObjectUrl(objectUrl, urlApi) {
    if (!objectUrl) {
      return;
    }
    const runtimeUrlApi = urlApi || globalScope.URL;
    if (!runtimeUrlApi || typeof runtimeUrlApi.revokeObjectURL !== "function") {
      return;
    }
    runtimeUrlApi.revokeObjectURL(objectUrl);
  }

  const api = {
    createCaptureObjectUrl,
    revokeCaptureObjectUrl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.HikCapturePreview = api;
})(typeof window !== "undefined" ? window : globalThis);
