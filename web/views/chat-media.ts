import { add, h } from "../lib/dom";
import { mediaUrl } from "../lib/media";

export interface MediaMsg {
  media_key: string | null;
  media_meta: { w?: number; h?: number; durationMs?: number } | null;
}

const PHOTO_MAX_W = 240;

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Sizes an <img> from known dimensions so the chat does not jump when it loads. */
function sizeImg(img: HTMLImageElement, w?: number, h2?: number): void {
  if (w && h2) {
    const dw = Math.min(PHOTO_MAX_W, w);
    img.style.width = dw + "px";
    img.style.aspectRatio = `${w} / ${h2}`;
  }
}

// ---------- full-screen photo viewer ----------
let viewer: HTMLElement | null = null;
let viewerKey: ((e: KeyboardEvent) => void) | null = null;

export function closeViewer(): void {
  if (viewerKey) document.removeEventListener("keydown", viewerKey);
  viewerKey = null;
  viewer?.remove();
  viewer = null;
}

export function openViewer(src: string): void {
  closeViewer();
  const img = h("img", { class: "viewer-img", src, alt: "Photo" });
  viewer = h(
    "div",
    { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": "Photo", onclick: closeViewer },
    img,
    h("button", { class: "viewer-x", type: "button", "aria-label": "Close", onclick: closeViewer }, "✕"),
  );
  viewerKey = (e) => {
    if (e.key === "Escape") closeViewer();
  };
  document.addEventListener("keydown", viewerKey);
  document.body.appendChild(viewer);
}

export function photoEl(m: MediaMsg): HTMLElement {
  const img = h("img", { class: "photo", alt: "Photo", loading: "lazy", draggable: false });
  sizeImg(img, m.media_meta?.w, m.media_meta?.h);
  const url = mediaUrl(m.media_key ?? "");
  img.src = url;
  return h("button", { class: "photo-btn", type: "button", "aria-label": "Open photo", onclick: () => openViewer(url) }, img);
}

/** Local preview while a photo uploads. */
export function pendingPhotoEl(previewUrl: string): HTMLElement {
  const img = h("img", { class: "photo", alt: "Uploading photo" });
  img.src = previewUrl;
  return h("div", { class: "photo-btn uploading" }, img, h("span", { class: "spin", role: "progressbar", "aria-label": "Uploading" }));
}

// ---------- voice player (one at a time) ----------
let current: { audio: HTMLAudioElement; reset: () => void } | null = null;

export function stopAllAudio(): void {
  current?.audio.pause();
  current?.reset();
  current = null;
}

export function voiceEl(m: MediaMsg): HTMLElement {
  const total = m.media_meta?.durationMs ?? 0;
  const btn = h("button", { class: "play-btn", type: "button", "aria-label": "Play voice note" }, "▶");
  const fill = h("div", { class: "vfill" });
  const knob = h("div", { class: "vknob" });
  const track = h("div", { class: "vtrack", role: "slider", "aria-label": "Seek", tabIndex: 0 }, fill, knob);
  const label = h("span", { class: "vdur" }, fmtDur(total));
  let audio: HTMLAudioElement | null = null;
  let dragging = false;

  const dur = (): number => (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total / 1000);
  const paint = (ratio: number): void => {
    const p = Math.max(0, Math.min(1, ratio)) * 100;
    fill.style.width = p + "%";
    knob.style.insetInlineStart = p + "%";
  };
  const reset = (): void => {
    btn.textContent = "▶";
    btn.setAttribute("aria-label", "Play voice note");
    label.textContent = fmtDur(total);
    paint(0);
  };
  const ensure = (): HTMLAudioElement => {
    if (audio) return audio;
    const a = new Audio();
    a.preload = "auto";
    a.src = mediaUrl(m.media_key ?? "");
    a.addEventListener("timeupdate", () => {
      if (dragging) return;
      const d = dur();
      paint(d ? a.currentTime / d : 0);
      label.textContent = fmtDur(a.currentTime * 1000);
    });
    a.addEventListener("play", () => {
      btn.textContent = "❚❚";
      btn.setAttribute("aria-label", "Pause voice note");
    });
    a.addEventListener("pause", () => {
      btn.textContent = "▶";
      btn.setAttribute("aria-label", "Play voice note");
    });
    a.addEventListener("ended", () => {
      reset();
      a.currentTime = 0;
      if (current?.audio === a) current = null;
    });
    audio = a;
    return a;
  };
  const toggle = (): void => {
    const a = ensure();
    if (!a.paused) {
      a.pause();
      return;
    }
    if (current && current.audio !== a) {
      current.audio.pause();
      current.reset();
    }
    current = { audio: a, reset };
    a.play().catch(() => reset());
  };
  btn.addEventListener("click", toggle);

  const ratioAt = (e: PointerEvent): number => {
    const r = track.getBoundingClientRect();
    return r.width ? (e.clientX - r.left) / r.width : 0;
  };
  const seekTo = (ratio: number): void => {
    const a = ensure();
    const d = dur();
    if (!d) return;
    a.currentTime = Math.max(0, Math.min(1, ratio)) * d;
    paint(ratio);
    label.textContent = fmtDur(a.currentTime * 1000);
  };
  track.addEventListener("pointerdown", (e) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    paint(ratioAt(e));
  });
  track.addEventListener("pointermove", (e) => {
    if (dragging) paint(ratioAt(e));
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    seekTo(ratioAt(e));
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", () => {
    dragging = false;
  });
  track.addEventListener("keydown", (e) => {
    const a = ensure();
    const d = dur();
    if (!d) return;
    if (e.key === "ArrowRight") seekTo((a.currentTime + 5) / d);
    else if (e.key === "ArrowLeft") seekTo((a.currentTime - 5) / d);
  });

  const el = h("div", { class: "voice" }, btn, h("div", { class: "vbody" }, track, label));
  return el;
}

export function pendingVoiceEl(): HTMLElement {
  const el = h("div", { class: "voice uploading" });
  add(el, h("span", { class: "spin", role: "progressbar", "aria-label": "Sending" }), h("span", { class: "vdur" }, "Sending voice note…"));
  return el;
}
