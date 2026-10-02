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
  let active = 0;

  function drain() {
    while (active < concurrency && waiting.length) {
      const { record, run, resolve, reject } = waiting.shift();
      active++;
      record.state = "running";
      const controller = new AbortController();
      let timeout;
      let timedOut = false;
      const timeoutPromise = new Promise((_, fail) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          fail(new StickerError("TIMEOUT"));
        }, timeoutMs);
      });
      const work = Promise.resolve().then(() =>
        run({
          signal: controller.signal,
          progress(stage, fraction) {
            if (record.state !== "running") return;
            record.stage = stage;
            record.progress = Math.max(0, Math.min(1, Number(fraction) || 0));
          },
        }),
      );
      Promise.race([work, timeoutPromise])
        .then(
          (result) => {
            record.state = "done";
            record.result = result;
            record.progress = 1;
            resolve(result);
          },
          (error) => {
            record.state = "failed";
            record.error =
              error instanceof StickerError
                ? { code: error.code, details: error.details }
                : { code: "CONVERSION_FAILED" };
            reject(error);
          },
        )
        .finally(() => {
          clearTimeout(timeout);
          const retention = setTimeout(() => records.delete(record.id), retentionMs);
          retention.unref?.();
          let released = false;
          const releaseSlot = () => {
            if (released) return;
            released = true;
            active--;
            drain();
          };
          if (timedOut) {
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

  return {
    submit,
    get(id) {
      const record = records.get(id);
      return record ? { ...record } : null;
    },
  };
}

const queue = createQueue();
module.exports = { createQueue, submit: queue.submit, get: queue.get };
