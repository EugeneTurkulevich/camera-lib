// @ts-check
// Знімок і запис відео з відкритої сесії камери.
//
// І фото, і відео малюються на canvas фіксованого розміру (cover-кадрування):
// роздільність і якість JPEG гарантовані незалежно від того, що віддала камера.
// ImageCapture свідомо не використовується: він повертає роздільність
// пристрою, а не задану.
//
// Джерело кадрів — елемент <video>. Якщо інтегратор уже показує стрім у своєму
// <video>, його можна передати як `opts.video`; інакше модуль створює
// службовий елемент (не додається в DOM) і сам його прибирає.

import { DEFAULT_AUDIO_BITS_PER_SECOND, DEFAULT_VIDEO_BITS_PER_SECOND, pickRecorderMimeType } from "./recorder.js";

/** @typedef {import("./camera-session.js").CameraSession} CameraSession */

/**
 * @typedef {object} CaptureOptions
 * @property {number} width ширина результату, px
 * @property {number} height висота результату, px
 * @property {number} quality якість JPEG, 0..1
 * @property {HTMLVideoElement} [video] готовий <video> зі стрімом сесії
 * @property {HTMLCanvasElement} [canvas] свій canvas (його розмір буде змінено)
 */

/**
 * @typedef {object} RecordingOptions
 * @property {number} width
 * @property {number} height
 * @property {number} fps кадрів на секунду
 * @property {number} [videoBitsPerSecond] за замовчуванням 2 500 000
 * @property {number} [audioBitsPerSecond] за замовчуванням 64 000
 * @property {string} [mimeType] за замовчуванням — pickRecorderMimeType
 * @property {HTMLVideoElement} [video] готовий <video> зі стрімом сесії
 * @property {HTMLCanvasElement} [canvas]
 */

/**
 * @typedef {object} Recording
 * @property {() => Promise<Blob>} stop зупиняє запис і віддає зібраний Blob
 * @property {() => number} frames скільки кадрів намальовано
 * @property {() => number} bytes скільки байтів уже отримано від MediaRecorder
 * @property {string | undefined} mimeType формат, обраний для запису
 */

// Інтервал, з яким MediaRecorder віддає шматки: розмір росте плавно.
const TIMESLICE_MS = 250;
const FRAME_WAIT_MS = 3000;

/**
 * Малює кадр у canvas РІВНО цільового розміру: джерело обрізається по центру
 * до пропорцій цілі й масштабується.
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLVideoElement} src
 * @param {number} tw
 * @param {number} th
 */
function drawCover(ctx, src, tw, th) {
  const vw = src.videoWidth;
  const vh = src.videoHeight;
  let sx = 0;
  let sy = 0;
  let sw = vw;
  let sh = vh;
  if (vw / vh > tw / th) {
    sw = vh * (tw / th);
    sx = (vw - sw) / 2;
  } else {
    sh = vw * (th / tw);
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th);
}

/**
 * @param {HTMLCanvasElement | undefined} given
 * @param {number} tw
 * @param {number} th
 */
function prepareCanvas(given, tw, th) {
  const canvas = given ?? document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas недоступний");
  return { canvas, ctx };
}

/**
 * Джерело кадрів: переданий <video> або службовий із потоку сесії, у якому
 * вже є перший кадр.
 * @param {CameraSession} session
 * @param {HTMLVideoElement | undefined} given
 * @returns {Promise<{ video: HTMLVideoElement, release: () => void, stream: MediaStream }>}
 */
async function frameSource(session, given) {
  const stream = session.getState().stream;
  if (!stream) throw new Error("камера не відкрита");
  if (given) {
    const deadline = Date.now() + FRAME_WAIT_MS;
    while (!given.videoWidth) {
      if (Date.now() > deadline) throw new Error("кадру ще нема");
      await new Promise((r) => setTimeout(r, 50));
    }
    return { video: given, release() {}, stream };
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const release = () => {
    video.pause();
    video.srcObject = null;
  };
  try {
    await video.play();
    const deadline = Date.now() + FRAME_WAIT_MS;
    while (!video.videoWidth) {
      if (Date.now() > deadline) throw new Error("кадру ще нема");
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (e) {
    release();
    throw e;
  }
  return { video, release, stream };
}

/**
 * Знімок поточного кадру як JPEG.
 * @param {CameraSession} session відкрита сесія (session.open())
 * @param {CaptureOptions} opts
 * @returns {Promise<Blob>}
 * @throws {Error} камера не відкрита, кадру ще нема, canvas недоступний,
 *   браузер не віддав JPEG
 */
export async function capturePhoto(session, opts) {
  const src = await frameSource(session, opts.video);
  try {
    const { canvas, ctx } = prepareCanvas(opts.canvas, opts.width, opts.height);
    drawCover(ctx, src.video, opts.width, opts.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", opts.quality));
    if (blob === null) throw new Error("браузер не віддав JPEG");
    return /** @type {Blob} */ (blob);
  } finally {
    src.release();
  }
}

/**
 * Починає запис відео з canvas: фіксовані роздільність і кількість кадрів,
 * бітрейт задає якість. Аудіо береться з треків стріму сесії (є лише якщо
 * сесію відкрито з `baseConstraints.audio: true`).
 * @param {CameraSession} session відкрита сесія
 * @param {RecordingOptions} opts
 * @returns {Promise<Recording>}
 * @throws {Error} MediaRecorder недоступний, камера не відкрита, кадру ще
 *   нема; DOMException від new MediaRecorder (непідтримуваний формат)
 */
export async function startRecording(session, opts) {
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder недоступний");
  const src = await frameSource(session, opts.video);
  const { width, height, fps } = opts;
  let canvasStream;
  /** @type {MediaRecorder} */
  let rec;
  /** @type {(MediaStreamTrack & { requestFrame?: () => void }) | undefined} */
  let videoTrack;
  /** @type {string | undefined} */
  let mimeType;
  try {
    const { canvas, ctx } = prepareCanvas(opts.canvas, width, height);
    // captureStream(0) + requestFrame: кадр іде рівно на кожен наш малюнок, тож
    // лічильник кадрів точний. Без requestFrame — автоматичний потік зі швидкістю fps.
    canvasStream = canvas.captureStream(0);
    videoTrack = canvasStream.getVideoTracks()[0];
    if (typeof videoTrack?.requestFrame !== "function") {
      canvasStream.getTracks().forEach((t) => t.stop());
      canvasStream = canvas.captureStream(fps);
      videoTrack = canvasStream.getVideoTracks()[0];
    }
    const out = new MediaStream([...(videoTrack ? [videoTrack] : []), ...src.stream.getAudioTracks()]);
    mimeType = opts.mimeType ?? pickRecorderMimeType((c) => MediaRecorder.isTypeSupported(c));
    rec = new MediaRecorder(out, {
      ...(mimeType !== undefined ? { mimeType } : {}),
      videoBitsPerSecond: opts.videoBitsPerSecond ?? DEFAULT_VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: opts.audioBitsPerSecond ?? DEFAULT_AUDIO_BITS_PER_SECOND,
    });
    const track = videoTrack;
    const stream = canvasStream;
    let frames = 0;
    let bytes = 0;
    let drawId = 0;
    /** @type {Blob[]} */
    const chunks = [];
    const draw = () => {
      drawCover(ctx, src.video, width, height);
      track?.requestFrame?.();
      frames += 1;
    };
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
        bytes += e.data.size;
      }
    };
    /** @type {Promise<Blob>} */
    const finished = new Promise((resolve) => {
      rec.onstop = () => {
        clearInterval(drawId);
        stream.getTracks().forEach((t) => t.stop());
        src.release();
        resolve(new Blob(chunks, { type: rec.mimeType || mimeType || "video/mp4" }));
      };
    });
    rec.start(TIMESLICE_MS);
    draw();
    drawId = Number(setInterval(draw, 1000 / fps));
    const recorder = rec;
    return {
      stop() {
        if (recorder.state !== "inactive") recorder.stop();
        return finished;
      },
      frames: () => frames,
      bytes: () => bytes,
      mimeType,
    };
  } catch (e) {
    canvasStream?.getTracks().forEach((t) => t.stop());
    src.release();
    throw e;
  }
}
