// @ts-check
// Публічний вхід бібліотеки камери: усе, що потрібно інтегратору.

export { createCameraSession } from "./camera-session.js";
export { capturePhoto, startRecording } from "./capture.js";
export { pickRecorderMimeType, recorderExtension } from "./recorder.js";
export { createPrefs } from "./camera-prefs.js";
