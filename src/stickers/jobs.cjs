// Bounded conversions protect the WhatsApp socket from too many FFmpeg jobs.
// A timed-out worker keeps its slot briefly while abort cleanup finishes.
const { randomUUID } = require("node:crypto");
const { StickerError } = require("./errors.cjs");
const {
  JOB_CONCURRENCY,
  JOB_MAX_QUEUED,
  JOB_TIMEOUT_MS,
  JOB_RETENTION_MS,
} = require("./limits.cjs");

function createQueue({
  concurrency = JOB_CONCURRENCY,
  maxQueued = JOB_MAX_QUEUED,
  timeoutMs = JOB_TIMEOUT_MS,
  retentionMs = JOB_RETENTION_MS,
  timeoutGraceMs = 5000,
} = {}) {
  const records = new Map();
  const waiting = [];
  const running = new Set();
  let active = 0;

  function failRecord(record, error) {
    record.state = "failed";
    record.result = null;
    record.error =
      error instanceof StickerError
        ? { code: error.code, details: error.details }
        : { code: "CONVERSION_FAILED" };
  }

  function retainBriefly(record) {
    const retention = setTimeout(() => records.delete(record.id), retentionMs);
    retention.unref?.();
  }

  function drain() {
    while (active < concurrency && waiting.length) {
      const entry = waiting.shift();
      const { record, resolve, reject } = entry;
      active++;
      record.state = "running";
      const controller = new AbortController();
      entry.controller = controller;
      running.add(entry);
      let timeout;
      let timedOut = false;
      const cancelled = new Promise((_, fail) => {
        entry.cancel = (code) => {
          controller.abort();
          fail(new StickerError(code));
        };
      });
      const timeoutPromise = new Promise((_, fail) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          fail(new StickerError("TIMEOUT"));
        }, timeoutMs);
      });
      const work = Promise.resolve().then(() => {
        const run = entry.run;
        entry.run = null;
        if (controller.signal.aborted) throw new StickerError("CANCELLED");
        return run({
          signal: controller.signal,
          progress(stage, fraction) {
            if (record.state !== "running") return;
            record.stage = stage;
            record.progress = Math.max(0, Math.min(1, Number(fraction) || 0));
          },
        });
      });
      Promise.race([work, timeoutPromise, cancelled])
        .then(
          (result) => {
            if (entry.cancelledCode) {
              const error = new StickerError(entry.cancelledCode);
              failRecord(record, error);
              reject(error);
              return;
            }
            record.state = "done";
            record.result =
              record.kind === "create" && result?.sticker
                ? {
                    sticker: result.sticker,
                    created: result.created,
                    qualityReduced: !!result.qualityReduced,
                  }
                : null;
            record.progress = 1;
            resolve(result);
          },
          (error) => {
            const failure = entry.cancelledCode ? new StickerError(entry.cancelledCode) : error;
            failRecord(record, failure);
            reject(failure);
          },
        )
        .finally(() => {
          clearTimeout(timeout);
          entry.run = null;
          entry.cancel = null;
          running.delete(entry);
          retainBriefly(record);
          let released = false;
          const releaseSlot = () => {
            if (released) return;
            released = true;
            active--;
            drain();
          };
          if (timedOut || controller.signal.aborted) {
            // Abort is cooperative; wait for cleanup but never hold the slot forever.
            const grace = setTimeout(releaseSlot, timeoutGraceMs);
            work.then(
              () => {
                clearTimeout(grace);
                releaseSlot();
              },
              () => {
                clearTimeout(grace);
                releaseSlot();
              },
            );
          } else {
            releaseSlot();
          }
        });
    }
  }

  function submit(run, { kind } = {}) {
    if (typeof run !== "function") throw new TypeError("run must be a function");
    if (active >= concurrency && waiting.length >= maxQueued) throw new StickerError("BUSY");
    const id = randomUUID();
    const record = {
      id,
      kind,
      state: "queued",
      stage: null,
      progress: 0,
      error: null,
      result: null,
    };
    records.set(id, record);
    const promise = new Promise((resolve, reject) => {
      waiting.push({ record, run, resolve, reject });
      drain();
    });
    return { id, promise };
  }

  function cancelAll(code = "CANCELLED") {
    for (const entry of waiting.splice(0)) {
      const { record, reject } = entry;
      entry.run = null;
      const error = new StickerError(code);
      failRecord(record, error);
      retainBriefly(record);
      reject(error);
    }
    for (const entry of running) {
      entry.cancelledCode = code;
      failRecord(entry.record, new StickerError(code));
      entry.cancel?.(code);
    }
  }

  return {
    submit,
    cancelAll,
    get(id) {
      const record = records.get(id);
      return record ? { ...record } : null;
    },
  };
}

const queue = createQueue();
module.exports = { createQueue, submit: queue.submit, cancelAll: queue.cancelAll, get: queue.get };
