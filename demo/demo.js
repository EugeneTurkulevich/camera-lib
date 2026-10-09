// @ts-check
// Стенд для перевірки бібліотеки камери (../lib/) на телефоні: режими
// фото/відео, якість, перемикач камер, спалах, зум, результат, галерея в
// IndexedDB, офлайн. Уся логіка сторінки тут; бібліотека DOM не чіпає.

import {
  capturePhoto,
  createCameraSession,
  createPrefs,
  recorderExtension,
  startRecording,
} from "../lib/index.js";
import { deleteMedia, listMedia, requestPersistence, saveMedia } from "./media-store.js";
import { BUILD_STAMP } from "./version.js";

/** @typedef {import("../lib/camera-session.js").CameraSession} CameraSession */
/** @typedef {import("../lib/camera-session.js").CameraState} CameraState */
/** @typedef {import("../lib/capture.js").Recording} Recording */
/** @typedef {import("./media-store.js").MediaRecord} MediaRecord */
/** @typedef {"photo" | "video"} Mode */
/** @typedef {"720p" | "1080p"} Quality */
/** @typedef {15 | 30} Fps */

// Пауза перед повторним відкриттям камери після зміни режиму/якості:
// попередній стрім ще тримає камеру.
const REOPEN_DELAY_MS = 300;

// 720p — 1280×720, JPEG 0.85, відео 2.5 Мбіт/с. 1080p — 1920×1080, JPEG 0.92, відео 6 Мбіт/с.
/** @type {Record<Quality, { width: number, height: number, jpeg: number, videoBps: number }>} */
const QUALITY = {
  "720p": { width: 1280, height: 720, jpeg: 0.85, videoBps: 2_500_000 },
  "1080p": { width: 1920, height: 1080, jpeg: 0.92, videoBps: 6_000_000 },
};

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id}: елемент відсутній або іншого типу`);
  return el;
}

/**
 * @template {HTMLElement} T
 * @param {string} selector
 * @param {new () => T} type
 * @returns {T[]}
 */
const all = (selector, type) =>
  [...document.querySelectorAll(selector)].filter(/** @returns {el is T} */ (el) => el instanceof type);

const els = {
  video: byId("video", HTMLVideoElement),
  start: byId("start", HTMLButtonElement),
  camLabel: byId("cam-label", HTMLSpanElement),
  switchBtn: byId("switch", HTMLButtonElement),
  torchBtn: byId("torch", HTMLButtonElement),
  result: byId("result", HTMLDivElement),
  resultImg: byId("result-img", HTMLImageElement),
  resultVideo: byId("result-video", HTMLVideoElement),
  resultInfo: byId("result-info", HTMLParagraphElement),
  download: byId("download", HTMLAnchorElement),
  resultClose: byId("result-close", HTMLButtonElement),
  shutter: byId("shutter", HTMLButtonElement),
  timer: byId("timer", HTMLSpanElement),
  hint: byId("hint", HTMLParagraphElement),
  status: byId("status", HTMLParagraphElement),
  stamp: byId("stamp", HTMLParagraphElement),
  modeBtns: all("[data-mode]", HTMLButtonElement),
  qualityBtns: all("[data-quality]", HTMLButtonElement),
  fpsGroup: byId("fps-group", HTMLDivElement),
  fpsBtns: all("[data-fps]", HTMLButtonElement),
  zoom: byId("zoom", HTMLLabelElement),
  zoomRange: byId("zoom-range", HTMLInputElement),
  zoomValue: byId("zoom-value", HTMLSpanElement),
  net: byId("net", HTMLSpanElement),
  galleryBtn: byId("gallery-btn", HTMLButtonElement),
  gallery: byId("gallery", HTMLDivElement),
  galleryList: byId("gallery-list", HTMLDivElement),
  galleryEmpty: byId("gallery-empty", HTMLParagraphElement),
  galleryClose: byId("gallery-close", HTMLButtonElement),
};

/**
 * @typedef {object} ResultMeta
 * @property {string} kind
 * @property {number} size
 * @property {string} type
 * @property {boolean} isVideo
 */

/**
 * @typedef {object} RecordingRun
 * @property {Recording} rec
 * @property {number} startedAt
 * @property {number} fps
 * @property {string} src джерело: розмір кадру камери
 * @property {boolean} stopping
 */

const st = {
  /** @type {Mode} */
  mode: "photo",
  /** @type {Quality} */
  quality: "720p",
  /** @type {Fps} */
  fps: 30,
  started: false,
  busy: false,
  /** @type {CameraSession | null} */
  session: null,
  /** @type {RecordingRun | null} */
  recording: null,
  timerId: 0,
  /** @type {string | null} */
  resultUrl: null,
  /** @type {ResultMeta | null} */
  resultMeta: null,
  /** @type {string[]} */
  galleryUrls: [],
};

// Префікс зберігає ключ вибору камери (camera-test.camera) тим самим, що й раніше.
const prefs = createPrefs({ prefix: "camera-test" });

/**
 * Після зйомки запис іде в IndexedDB: офлайн це єдине місце зберігання.
 * @param {Blob} blob
 * @param {"photo" | "video"} kind
 */
async function persist(blob, kind) {
  /** @type {MediaRecord} */
  const rec = {
    id: crypto.randomUUID(),
    kind,
    blob,
    mime: blob.type,
    quality: st.quality,
    createdAt: Date.now(),
  };
  try {
    await saveMedia(rec);
    const n = (await listMedia()).length;
    els.galleryBtn.textContent = `Збережене · ${n}`;
    setStatus(`Збережено на пристрої · ${n} у галереї`);
  } catch (e) {
    setStatus(`Не вдалося зберегти на пристрої: ${errName(e)}`);
  }
}

function clearGalleryUrls() {
  for (const u of st.galleryUrls) URL.revokeObjectURL(u);
  st.galleryUrls = [];
}

/** @param {MediaRecord} rec */
function galleryItem(rec) {
  const url = URL.createObjectURL(rec.blob);
  st.galleryUrls.push(url);
  const fig = document.createElement("figure");
  fig.className = "gallery-item";

  if (rec.kind === "photo") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Фото";
    fig.append(img);
  } else {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    fig.append(video);
  }

  const cap = document.createElement("figcaption");
  const when = new Date(rec.createdAt).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
  cap.textContent = `${rec.kind === "photo" ? "Фото" : "Відео"} · ${rec.quality} · ${when} · ${(rec.blob.size / 1e6).toFixed(2)} МБ`;
  fig.append(cap);

  const actions = document.createElement("div");
  actions.className = "gallery-actions";
  const dl = document.createElement("a");
  dl.href = url;
  dl.download = `camera-test-${rec.quality}-${rec.createdAt}.${rec.kind === "photo" ? "jpg" : recorderExtension(rec.mime)}`;
  dl.textContent = "Завантажити";
  dl.className = "gallery-dl";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "gallery-del";
  del.textContent = "×";
  del.setAttribute("aria-label", "Видалити");
  del.addEventListener("click", () => {
    if (!window.confirm("Видалити цей запис з пристрою?")) return;
    void deleteMedia(rec.id).then(openGallery, (/** @type {unknown} */ e) =>
      setStatus(`Не вдалося видалити: ${errName(e)}`),
    );
  });
  actions.append(dl, del);
  fig.append(actions);
  return fig;
}

async function openGallery() {
  clearGalleryUrls();
  const items = await listMedia();
  els.galleryBtn.textContent = `Збережене · ${items.length}`;
  els.galleryList.replaceChildren(...items.map(galleryItem));
  els.galleryEmpty.hidden = items.length > 0;
  els.gallery.hidden = false;
}

function closeGallery() {
  els.gallery.hidden = true;
  clearGalleryUrls();
  els.galleryList.replaceChildren();
}

function renderNet() {
  els.net.hidden = navigator.onLine;
}

/** @param {string} text */
function setStatus(text) {
  els.status.textContent = text;
}

/** @param {unknown} e */
function errName(e) {
  return /** @type {{ name?: string } | null} */ (e)?.name ?? "помилка";
}

/** @param {number} ms */
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** @returns {CameraSession} */
function makeSession() {
  const q = QUALITY[st.quality];
  const session = createCameraSession({
    mode: st.mode,
    prefs,
    baseConstraints: {
      video: {
        width: { ideal: q.width },
        height: { ideal: q.height },
        frameRate: { ideal: 30, max: 30 },
      },
      // Звук лише для відео: фото не має просити мікрофон.
      audio: st.mode === "video",
    },
  });
  session.subscribe((s) => {
    if (els.video.srcObject !== s.stream) els.video.srcObject = s.stream;
    render();
  });
  return session;
}

// Нова сесія — при зміні режиму (звук) або якості (роздільність): constraints
// задаються один раз на сесію. Стару зупиняємо, перш ніж відкрити нову.
function rebuild() {
  st.session?.dispose();
  st.session = makeSession();
}

function describeTrack() {
  const s = st.session?.getState().track?.getSettings();
  return `${s?.width ?? "?"}×${s?.height ?? "?"} · ${Math.round(s?.frameRate ?? 0)} к/с`;
}

// Одна операція з камерою в різний час; нові тапи під час неї ігноруються.
/** @param {() => Promise<void>} fn */
async function runExclusive(fn) {
  if (st.busy || st.recording) return;
  st.busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    setStatus(`Камера недоступна: ${errName(e)}`);
  } finally {
    st.busy = false;
    render();
  }
}

async function openCamera() {
  setStatus("Відкриваю камеру…");
  const stream = await st.session?.open();
  if (stream) {
    st.started = true;
    setStatus(`Камера відкрита: ${describeTrack()}`);
  }
}

async function switchCamera() {
  await runExclusive(async () => {
    const stream = await st.session?.switchNext();
    if (stream) setStatus(`Камера перемкнена: ${describeTrack()}`);
  });
}

async function toggleTorch() {
  const session = st.session;
  if (!session || st.busy) return;
  const before = session.getState().torchOn;
  await session.toggleTorch();
  const after = session.getState().torchOn;
  setStatus(after === before ? "Спалах не застосувався" : `Спалах ${after ? "увімкнено" : "вимкнено"}`);
  render();
}

// Зміна режиму/якості: нова сесія з іншими constraints. Якщо камера вже відкрита —
// відкриваємо знову, з паузою: попередній стрім ще тримає камеру.
/** @param {() => void} apply */
async function changeSettings(apply) {
  if (st.busy || st.recording) return;
  apply();
  rebuild();
  if (!st.started) {
    render();
    return;
  }
  await runExclusive(async () => {
    await new Promise((r) => setTimeout(r, REOPEN_DELAY_MS));
    await openCamera();
  });
}

async function takePhoto() {
  const session = st.session;
  const v = els.video;
  if (!session?.getState().stream || st.busy) return;
  if (!v.videoWidth) {
    setStatus("Кадру ще нема, спробуйте за секунду");
    return;
  }
  st.busy = true;
  render();
  try {
    const q = QUALITY[st.quality];
    const src = `${v.videoWidth}×${v.videoHeight}`;
    const blob = await capturePhoto(session, { width: q.width, height: q.height, quality: q.jpeg, video: v });
    showResult(blob, `Фото (джерело ${src})`);
    await persist(blob, "photo");
  } catch (e) {
    setStatus(`Знімок не вдався: ${/** @type {Error} */ (e).message}`);
  } finally {
    st.busy = false;
    render();
  }
}

async function beginRecording() {
  const session = st.session;
  const v = els.video;
  if (!session?.getState().stream || st.busy || st.recording) return;
  if (!window.MediaRecorder) {
    setStatus("Запис відео недоступний у цьому браузері");
    return;
  }
  if (!v.videoWidth) {
    setStatus("Кадру ще нема, спробуйте за секунду");
    return;
  }
  const q = QUALITY[st.quality];
  const fps = st.fps;
  const src = `${v.videoWidth}×${v.videoHeight}`;
  st.busy = true;
  render();
  try {
    const rec = await startRecording(session, {
      width: q.width,
      height: q.height,
      fps,
      videoBitsPerSecond: q.videoBps,
      video: v,
    });
    st.recording = { rec, startedAt: Date.now(), fps, src, stopping: false };
    st.timerId = window.setInterval(renderTimer, 250);
    setStatus(
      `Запис: ${rec.mimeType ?? "тип браузера за замовчуванням"} · ${q.width}×${q.height} · ${fps} к/с · ${q.videoBps / 1e6} Мбіт/с`,
    );
  } catch (e) {
    setStatus(`Запис не почався: ${errName(e)}`);
  } finally {
    st.busy = false;
    render();
  }
}

async function endRecording() {
  const run = st.recording;
  if (!run || run.stopping) return;
  run.stopping = true;
  const blob = await run.rec.stop();
  clearInterval(st.timerId);
  st.recording = null;
  showResult(blob, `Відео · ${run.fps} к/с · кадрів ${run.rec.frames()} · джерело ${run.src}`);
  void persist(blob, "video");
  render();
}

function renderTimer() {
  const run = st.recording;
  if (!run) {
    els.timer.textContent = "";
    return;
  }
  els.timer.textContent = `● ${fmtTime(Date.now() - run.startedAt)} · ${run.rec.frames()} кадрів · ${(run.rec.bytes() / 1e6).toFixed(1)} МБ`;
}

/**
 * @param {Blob} blob
 * @param {string} kind
 */
function showResult(blob, kind) {
  if (st.resultUrl) URL.revokeObjectURL(st.resultUrl);
  const url = URL.createObjectURL(blob);
  st.resultUrl = url;
  const isVideo = blob.type.startsWith("video/");
  st.resultMeta = { kind, size: blob.size, type: blob.type || "—", isVideo };
  els.resultImg.hidden = isVideo;
  els.resultVideo.hidden = !isVideo;
  if (isVideo) els.resultVideo.src = url;
  else els.resultImg.src = url;
  const ext = isVideo ? recorderExtension(blob.type) : "jpg";
  els.download.href = url;
  els.download.download = `camera-test-${st.quality}-${Date.now()}.${ext}`;
  els.resultInfo.textContent = "";
  els.result.hidden = false;
}

// Розмір і тривалість — після завантаження метаданих: видно, що якість справді обрана.
function fillResultInfo() {
  const meta = st.resultMeta;
  if (!meta) return;
  const w = meta.isVideo ? els.resultVideo.videoWidth : els.resultImg.naturalWidth;
  const h = meta.isVideo ? els.resultVideo.videoHeight : els.resultImg.naturalHeight;
  const sec = els.resultVideo.duration;
  const dur = meta.isVideo && Number.isFinite(sec) ? ` · ${sec.toFixed(1)} с` : "";
  els.resultInfo.textContent = `${meta.kind} · ${w}×${h}${dur} · ${(meta.size / 1e6).toFixed(2)} МБ · ${meta.type}`;
}

/** @param {CameraState} cam */
function camLabel(cam) {
  const cur = cam.cameras.find((c) => c.deviceId === cam.cameraId);
  return cur?.label || "Камера";
}

function qualityHint() {
  const q = QUALITY[st.quality];
  return st.mode === "photo"
    ? `Фото ${q.width}×${q.height} · JPEG ${Math.round(q.jpeg * 100)}%`
    : `Відео ${q.width}×${q.height} · ${(q.videoBps / 1e6).toFixed(1)} Мбіт/с · ${st.fps} к/с`;
}

function render() {
  const cam = st.session?.getState();
  const live = cam?.stream != null;
  const rec = st.recording !== null;
  const lock = st.busy || rec;
  const video = st.mode === "video";

  els.start.hidden = live;
  els.start.disabled = st.busy;
  els.camLabel.textContent = live && cam ? camLabel(cam) : "";

  els.switchBtn.hidden = !cam || cam.cameras.length < 2;
  els.switchBtn.disabled = lock || cam?.switching === true;

  els.torchBtn.hidden = !cam?.torchAvailable;
  els.torchBtn.classList.toggle("on", cam?.torchOn === true);
  els.torchBtn.setAttribute("aria-pressed", String(cam?.torchOn === true));
  els.torchBtn.disabled = st.busy;

  for (const b of els.modeBtns) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === st.mode));
    b.disabled = lock;
  }
  for (const b of els.qualityBtns) {
    b.setAttribute("aria-pressed", String(b.dataset.quality === st.quality));
    b.disabled = lock;
  }
  els.fpsGroup.hidden = !video;
  for (const b of els.fpsBtns) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.fps) === st.fps));
    b.disabled = lock;
  }
  els.hint.textContent = qualityHint();

  const zr = cam?.zoomRange ?? null;
  els.zoom.hidden = zr === null;
  if (cam && zr) {
    els.zoomRange.min = String(zr.min);
    els.zoomRange.max = String(zr.max);
    els.zoomRange.step = String(zr.step ?? 0.1);
    // Не перебиваємо повзунок, поки палець на ньому: інакше стрибає під рукою.
    if (document.activeElement !== els.zoomRange) els.zoomRange.value = String(cam.zoom);
    els.zoomValue.textContent = `${cam.zoom.toFixed(1)}×`;
  }
  els.zoomRange.disabled = lock;

  els.shutter.disabled = st.busy || !live;
  els.shutter.classList.toggle("shutter--video", video);
  els.shutter.classList.toggle("shutter--rec", rec);
  els.shutter.setAttribute("aria-label", video ? (rec ? "Зупинити запис" : "Почати запис") : "Зняти фото");
  if (!rec) els.timer.textContent = "";
}

function init() {
  els.stamp.textContent = BUILD_STAMP;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus("Камера недоступна: потрібні https або localhost і підтримка getUserMedia");
    els.start.disabled = true;
  }
  rebuild();
  els.start.addEventListener("click", () => void runExclusive(openCamera));
  els.switchBtn.addEventListener("click", () => void switchCamera());
  els.zoomRange.addEventListener("input", () => {
    void st.session?.setZoom(Number(els.zoomRange.value));
  });
  els.torchBtn.addEventListener("click", () => void toggleTorch());
  for (const b of els.modeBtns) {
    b.addEventListener("click", () => void changeSettings(() => (st.mode = /** @type {Mode} */ (b.dataset.mode))));
  }
  for (const b of els.qualityBtns) {
    b.addEventListener(
      "click",
      () => void changeSettings(() => (st.quality = /** @type {Quality} */ (b.dataset.quality))),
    );
  }
  for (const b of els.fpsBtns) {
    b.addEventListener("click", () => {
      if (st.busy || st.recording) return;
      st.fps = /** @type {Fps} */ (Number(b.dataset.fps));
      render();
    });
  }
  els.shutter.addEventListener("click", () => {
    if (st.mode === "photo") void takePhoto();
    else if (st.recording) void endRecording();
    else void beginRecording();
  });
  els.resultClose.addEventListener("click", () => {
    els.result.hidden = true;
  });
  els.resultImg.addEventListener("load", fillResultInfo);
  els.resultVideo.addEventListener("loadedmetadata", fillResultInfo);
  els.galleryBtn.addEventListener("click", () => void openGallery());
  els.galleryClose.addEventListener("click", closeGallery);
  window.addEventListener("online", renderNet);
  window.addEventListener("offline", renderNet);
  window.addEventListener("pagehide", () => st.session?.dispose());
  renderNet();
  void requestPersistence();
  void listMedia().then(
    (items) => {
      els.galleryBtn.textContent = `Збережене · ${items.length}`;
    },
    () => {
      els.galleryBtn.textContent = "Збережене · ?";
    },
  );
  registerServiceWorker();
  render();
}

// Офлайн-оболонка. Нова версія service worker-а підхоплюється сама; сторінка
// перезавантажується на нову лише коли не йде запис.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !st.recording) location.reload();
  });
  navigator.serviceWorker.register("./sw.js", { type: "module", updateViaCache: "none" }).catch(() => {
    // без service worker-а стенд працює, лише не офлайн
  });
}

init();
