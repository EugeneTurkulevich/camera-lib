// @ts-check
// Вибір формату запису відео та значення бітрейту за замовчуванням.

export const DEFAULT_VIDEO_BITS_PER_SECOND = 2_500_000;
export const DEFAULT_AUDIO_BITS_PER_SECOND = 64_000;

// mp4 першим: WebKit записує через MediaRecorder лише mp4/h264.
const MIME_TYPE_PREFERENCE = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/**
 * Перший підтримуваний браузером формат зі списку уподобань.
 * @param {(mimeType: string) => boolean} isTypeSupported напр. `(t) => MediaRecorder.isTypeSupported(t)`
 * @returns {string | undefined} undefined — жоден не підтримується (браузер обере сам)
 */
export function pickRecorderMimeType(isTypeSupported) {
  for (const candidate of MIME_TYPE_PREFERENCE) {
    if (isTypeSupported(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Розширення файла для mimeType запису.
 * @param {string | undefined} mimeType
 * @returns {"mp4" | "webm"}
 */
export function recorderExtension(mimeType) {
  return mimeType !== undefined && mimeType.startsWith("video/webm") ? "webm" : "mp4";
}
