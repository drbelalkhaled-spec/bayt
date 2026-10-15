import { getToken } from "./api";

export interface UploadedMedia {
  key: string;
  content_type: string;
  size: number;
}

/** Opens the camera/photo picker. Resolves null if cancelled. */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.hidden = true;
    let done = false;
    const finish = (f: File | null): void => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Downscales to maxSide and re-encodes as image/webp (falls back to jpeg where webp encoding is unsupported). */
export async function compressImage(file: File | Blob, maxSide = 1600, quality = 0.8): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.drawImage(bmp, 0, 0, w, hgt);
  bmp.close();
  const toBlob = (type: string): Promise<Blob | null> => new Promise((res) => canvas.toBlob(res, type, quality));
  const webp = await toBlob("image/webp");
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await toBlob("image/jpeg");
  if (!jpeg) throw new Error("encode_failed");
  return jpeg;
}

/** Raw-body upload to POST /api/media. Throws Error(code) on failure (e.g. "too_large", "bad_type", "network"). */
export async function uploadMedia(blob: Blob): Promise<UploadedMedia> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": (blob.type || "").split(";")[0]!, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: blob,
    });
  } catch {
    throw new Error("network");
  }
  const data = (await res.json().catch(() => null)) as (UploadedMedia & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? "http_" + res.status);
  return data;
}

/** URL usable in <img>/<audio> src (the token rides in ?t= because those elements cannot send headers). */
export function mediaUrl(key: string): string {
  return `/api/media/${encodeURIComponent(key)}?t=${encodeURIComponent(getToken() ?? "")}`;
}

export const voiceSupported = (): boolean =>
  typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export interface VoiceRecording {
  stop(): Promise<{ blob: Blob; durationMs: number }>;
  cancel(): void;
}

const MAX_VOICE_MS = 120_000;

/** Starts recording (asks for mic permission). Auto-stops after 2 minutes; stop() then returns what was captured. */
export async function recordVoice(): Promise<VoiceRecording> {
  if (!voiceSupported()) throw new Error("voice_unsupported");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  const started = Date.now();
  const release = (): void => stream.getTracks().forEach((t) => t.stop());
  rec.addEventListener("dataavailable", (e) => {
    if (e.data.size) chunks.push(e.data);
  });
  const stopped = new Promise<void>((res) => rec.addEventListener("stop", () => res(), { once: true }));
  rec.start();
  const timer = setTimeout(() => {
    if (rec.state !== "inactive") rec.stop();
  }, MAX_VOICE_MS);
  return {
    async stop() {
      clearTimeout(timer);
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      release();
      const type = (rec.mimeType || mime || "audio/webm").split(";")[0]!;
      return { blob: new Blob(chunks, { type }), durationMs: Math.min(Date.now() - started, MAX_VOICE_MS) };
    },
    cancel() {
      clearTimeout(timer);
      if (rec.state !== "inactive") rec.stop();
      release();
    },
  };
}
