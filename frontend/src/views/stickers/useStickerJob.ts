import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { EditOptions, Job, StickerJobSource } from "../../types";

export interface StickerJobRequest {
  uploadId: string;
  options?: EditOptions;
  overlay?: string;
  name?: string;
  packId?: string;
  source?: StickerJobSource;
}

const POLL_MS = 600;

export function useStickerJob() {
  const [job, setJob] = useState<Job | null>(null);
  const [running, setRunning] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const ticket = useRef(0);

  useEffect(() => {
    return () => {
      ticket.current += 1;
    };
  }, []);

  const start = async (payload: StickerJobRequest) => {
    const mine = ++ticket.current;
    setSubmitError(null);
    setJob(null);
    setRunning(true);
    try {
      const { jobId } = await api.createStickerJob(payload);
      while (ticket.current === mine) {
        const next = await api.getStickerJob(jobId);
        if (ticket.current !== mine) return;
        setJob(next);
        if (next.state === "done" || next.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (err) {
      if (ticket.current === mine) setSubmitError(err);
    } finally {
      if (ticket.current === mine) setRunning(false);
    }
  };

  const reset = () => {
    ticket.current += 1;
    setJob(null);
    setSubmitError(null);
    setRunning(false);
  };

  return { job, running, submitError, start, reset };
}
