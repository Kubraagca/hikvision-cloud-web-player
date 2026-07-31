const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      const message = json.error || `ALPR service returned HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = json;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function createAlprServiceBridge({ rootDir, logger = console }) {
  const serviceDir = path.join(rootDir, "alpr-service");
  const appPath = path.join(serviceDir, "app.py");
  const pythonExe = process.env.ALPR_PYTHON || "python";
  const host = process.env.ALPR_HOST || "127.0.0.1";
  const port = Number(process.env.ALPR_PORT || 53871);
  const startupTimeoutMs = Number(process.env.ALPR_STARTUP_TIMEOUT_MS || 45000);
  const baseUrl = `http://${host}:${port}`;
  const modelsDir = process.env.ALPR_MODELS_DIR || path.join(serviceDir, "models");

  let child = null;
  let startPromise = null;

  function serviceInstalled() {
    return fs.existsSync(appPath);
  }

  async function probeHealth(timeoutMs = 800) {
    try {
      return await fetchJson(`${baseUrl}/health`, {}, timeoutMs);
    } catch {
      return null;
    }
  }

  function spawnService() {
    if (child) {
      return child;
    }
    child = spawn(pythonExe, ["app.py"], {
      cwd: serviceDir,
      env: {
        ...process.env,
        ALPR_HOST: host,
        ALPR_PORT: String(port),
        ALPR_MODELS_DIR: modelsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      logger.log?.(`[alpr-service] ${String(chunk).trimEnd()}`);
    });
    child.stderr.on("data", (chunk) => {
      logger.error?.(`[alpr-service] ${String(chunk).trimEnd()}`);
    });
    child.on("exit", (code, signal) => {
      logger.warn?.(`[alpr-service] exited code=${code} signal=${signal}`);
      child = null;
      startPromise = null;
    });
    child.on("error", (error) => {
      logger.error?.(`[alpr-service] spawn failed: ${error.message}`);
    });
    return child;
  }

  async function ensureRunning() {
    if (!serviceInstalled()) {
      const error = new Error("ALPR service files are not installed in this workspace.");
      error.status = 503;
      throw error;
    }

    const healthy = await probeHealth();
    if (healthy) {
      return healthy;
    }

    if (!startPromise) {
      startPromise = (async () => {
        spawnService();
        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline) {
          const state = await probeHealth(1200);
          if (state) {
            return state;
          }
          await sleep(500);
        }
        const error = new Error(
          `ALPR service did not become healthy within ${Math.round(startupTimeoutMs / 1000)} seconds.`
        );
        error.status = 503;
        throw error;
      })();
    }

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function stopService() {
    startPromise = null;

    const healthy = await probeHealth(1000);
    if (!child && !healthy) {
      return {
        status: "stopped",
        baseUrl,
        message: "ALPR service is already stopped.",
      };
    }

    if (child) {
      const currentChild = child;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        currentChild.once("exit", finish);
        try {
          currentChild.kill();
        } catch {
          finish();
          return;
        }

        setTimeout(() => {
          if (!settled) {
            try {
              currentChild.kill("SIGKILL");
            } catch {}
            finish();
          }
        }, 3000);
      });
    }

    return {
      status: "stopped",
      baseUrl,
    };
  }

  return {
    async health({ autoStart = false } = {}) {
      if (autoStart) {
        return ensureRunning();
      }
      const healthy = await probeHealth(1000);
      return (
        healthy || {
          status: "offline",
          baseUrl,
        }
      );
    },

    async recognize(payload, timeoutMs = 15000) {
      await ensureRunning();
      return fetchJson(
        `${baseUrl}/recognize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        timeoutMs
      );
    },

    async warmup() {
      try {
        const state = await ensureRunning();
        logger.log?.(`[alpr-service] warmup OK on ${baseUrl}`);
        return state;
      } catch (error) {
        logger.error?.(`[alpr-service] warmup failed: ${error.message}`);
        throw error;
      }
    },

    async stop() {
      const result = await stopService();
      logger.log?.(`[alpr-service] stop requested for ${baseUrl}`);
      return result;
    },
  };
}

module.exports = {
  createAlprServiceBridge,
};
