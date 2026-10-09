// @ts-check
// Сесія камери: відкриття збереженої (або задньої) камери, перемикання по колу
// між усіма камерами пристрою, зум із межами треку, спалах. Без DOM і без
// залежностей: сесія віддає MediaStream, показувати його — справа інтегратора.
//
// Вибір камери й зум зберігаються через CameraPrefs (camera-prefs.js); спалах
// завжди вимкнений при відкритті й не зберігається.
//
// Життєвий цикл: `open()` → (`switchNext()`)* → `stop()` (треки зупинено, сесію
// можна відкрити знову) або `dispose()` (назавжди). `stop()`/`dispose()` під час
// відкриття роблять відкриття недійсним: щойно отриманий стрім зупиняється,
// стан не оживає, а `open()`/`switchNext()` повертають null.

import { createPrefs } from "./camera-prefs.js";

/** @typedef {import("./camera-prefs.js").CameraMode} CameraMode */
/** @typedef {import("./camera-prefs.js").CameraPrefs} CameraPrefs */
/** @typedef {import("./camera-prefs.js").KeyValueStore} KeyValueStore */

/**
 * @typedef {object} ZoomRange
 * @property {number} min
 * @property {number} max
 * @property {number} [step]
 */

/**
 * @typedef {object} CameraInfo
 * @property {string} deviceId
 * @property {string} label порожній, доки браузер не дав дозвіл на камеру
 */

/**
 * @typedef {object} CameraState
 * @property {MediaStream | null} stream
 * @property {MediaStreamTrack | null} track
 * @property {string | null} cameraId deviceId відкритої камери
 * @property {CameraInfo[]} cameras усі камери пристрою (порядок enumerateDevices)
 * @property {ZoomRange | null} zoomRange null — камера не вміє зум
 * @property {number} zoom
 * @property {boolean} torchAvailable
 * @property {boolean} torchOn
 * @property {number} generation росте при кожному відкритті/перемиканні: операція,
 *   розпочата на попередній камері, порівнює й відкидає свій результат
 * @property {boolean} switching перемикання в польоті: нові виклики switchNext ігноруються
 */

/**
 * @typedef {object} CameraSession
 * @property {() => CameraState} getState
 * @property {(fn: (state: CameraState) => void) => () => void} subscribe повертає функцію відписки
 * @property {() => Promise<MediaStream | null>} open
 * @property {() => Promise<MediaStream | null>} switchNext
 * @property {(zoom: number) => Promise<void>} setZoom
 * @property {() => Promise<void>} toggleTorch
 * @property {() => void} stop
 * @property {() => void} dispose
 */

/**
 * @typedef {object} CameraSessionOptions
 * @property {{ video: MediaTrackConstraints, audio: boolean }} baseConstraints
 *   video-частина (width/height/frameRate) без facingMode/deviceId, плюс audio
 * @property {CameraMode} [mode] обирає ключ збереженого зуму; за замовчуванням "photo"
 * @property {CameraPrefs | { store?: KeyValueStore | null, prefix?: string }} [prefs]
 *   готовий createPrefs(...) або його параметри; за замовчуванням createPrefs()
 * @property {() => Promise<MediaDeviceInfo[]>} [enumerateDevices] інʼєкція для тестів
 * @property {(c: MediaStreamConstraints) => Promise<MediaStream>} [getUserMedia] інʼєкція для тестів
 * @property {(ms: number) => Promise<void>} [sleep] інʼєкція для тестів
 */

// Пауза перед єдиним ретраєм NotReadableError: щойно зупинений стрім ще
// тримає камеру.
const CAMERA_RETRY_MS = 300;

/** @param {MediaStreamTrack | null} track @returns {string | null} */
function trackDeviceId(track) {
  try {
    const id = track?.getSettings?.().deviceId;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/** @param {MediaStream} s @returns {MediaStreamTrack | null} */
function firstVideoTrack(s) {
  return s.getVideoTracks?.()[0] ?? s.getTracks()[0] ?? null;
}

/** @param {MediaStream | null} s */
function stopTracks(s) {
  s?.getTracks().forEach((track) => track.stop());
}

// lib.dom не знає полів zoom/torch (mediacapture-image): читаємо як невідомі.
/** @param {MediaStreamTrack | null | undefined} track @returns {{ zoom?: Partial<ZoomRange>, torch?: unknown } | undefined} */
function capabilitiesOf(track) {
  return /** @type {{ zoom?: Partial<ZoomRange>, torch?: unknown } | undefined} */ (
    /** @type {unknown} */ (track?.getCapabilities?.())
  );
}

/** @param {MediaStreamTrack | null | undefined} track */
function torchSupported(track) {
  try {
    return capabilitiesOf(track)?.torch === true;
  } catch {
    return false;
  }
}

/** @param {MediaStreamTrack | null | undefined} track @returns {ZoomRange | null} */
function zoomRangeOf(track) {
  try {
    const z = capabilitiesOf(track)?.zoom;
    if (!z || typeof z.min !== "number" || typeof z.max !== "number") return null;
    if (!(z.min < z.max)) return null;
    return typeof z.step === "number" ? { min: z.min, max: z.max, step: z.step } : { min: z.min, max: z.max };
  } catch {
    return null;
  }
}

/** @param {number} value @param {ZoomRange} range */
function clampZoom(value, range) {
  if (Number.isNaN(value)) return range.min;
  const inRange = (/** @type {number} */ v) => Math.min(range.max, Math.max(range.min, v));
  let v = inRange(value);
  if (range.step !== undefined && range.step > 0) {
    v = inRange(range.min + Math.round((v - range.min) / range.step) * range.step);
    // зрізати артефакти плаваючої крапки (1 + 3*0.1 = 1.3000000000000003)
    v = inRange(Number(v.toFixed(6)));
  }
  return v;
}

/**
 * Усі videoinput із непорожнім deviceId, порядок — як у enumerateDevices(),
 * щоб перемикач циклився стабільно.
 * @param {ReadonlyArray<{ kind: string, deviceId: string, label: string }>} devices
 * @returns {CameraInfo[]}
 */
function listCameras(devices) {
  /** @type {CameraInfo[]} */
  const out = [];
  for (const d of devices) {
    if (d.kind !== "videoinput") continue;
    if (typeof d.deviceId !== "string" || d.deviceId === "") continue;
    out.push({ deviceId: d.deviceId, label: typeof d.label === "string" ? d.label : "" });
  }
  return out;
}

/**
 * @param {CameraSessionOptions} opts
 * @returns {CameraSession}
 */
export function createCameraSession(opts) {
  const { baseConstraints } = opts;
  const mode = opts.mode ?? "photo";
  const prefs = opts.prefs && "readCamera" in opts.prefs ? opts.prefs : createPrefs(opts.prefs);

  /** @type {CameraState} */
  const st = {
    stream: null,
    track: null,
    cameraId: null,
    cameras: [],
    zoomRange: null,
    zoom: 1,
    torchAvailable: false,
    torchOn: false,
    generation: 0,
    switching: false,
  };
  let snap = { ...st };
  /** @type {Set<(s: CameraState) => void>} */
  const listeners = new Set();

  // epoch росте при stop()/dispose(): відкриття, розпочате раніше, недійсне.
  let epoch = 0;
  let destroyed = false;
  let zoomInFlight = false;
  /** @type {number | null} */
  let zoomPending = null;

  function emit() {
    snap = { ...st };
    for (const cb of [...listeners]) cb(snap);
  }

  const dead = (/** @type {number} */ ep) => destroyed || ep !== epoch;

  function gum() {
    return opts.getUserMedia ?? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  }

  /** @param {string} deviceId @returns {MediaStreamConstraints} */
  function exactCamera(deviceId) {
    return {
      video: { deviceId: { exact: deviceId }, ...baseConstraints.video },
      audio: baseConstraints.audio,
    };
  }

  /** @returns {MediaStreamConstraints} */
  function environmentCamera() {
    return {
      video: { facingMode: { ideal: "environment" }, ...baseConstraints.video },
      audio: baseConstraints.audio,
    };
  }

  /** @returns {number | null} */
  function currentTrackZoom() {
    try {
      const z = /** @type {{ zoom?: number } | undefined} */ (st.track?.getSettings?.())?.zoom;
      return typeof z === "number" ? z : null;
    } catch {
      return null;
    }
  }

  // Серіалізує applyConstraints: поки один виклик у польоті, запамʼятовуємо
  // останнє значення й застосовуємо після нього — паралельні виклики на
  // частих подіях повзунка камери відхиляють. Відмова — проковтнути.
  /** @param {number} first */
  async function pushZoom(first) {
    if (zoomInFlight) {
      zoomPending = first;
      return;
    }
    zoomInFlight = true;
    /** @type {number | null} */
    let next = first;
    while (next !== null && !destroyed) {
      const value = next;
      next = null;
      try {
        await st.track?.applyConstraints({ advanced: [/** @type {any} */ ({ zoom: value })] });
      } catch {
        const actual = currentTrackZoom();
        if (actual !== null && zoomPending === null) {
          st.zoom = actual;
          emit();
        }
      }
      if (zoomPending !== null) {
        next = zoomPending;
        zoomPending = null;
      }
    }
    zoomInFlight = false;
  }

  /** @param {number} v */
  function setZoom(v) {
    st.zoom = v;
    prefs.writeZoom(mode, st.cameraId, v);
    emit();
    return pushZoom(v);
  }

  // Виставляє трек/камеру/спалах/зум для щойно отриманого стріму. Збій зуму не
  // ламає запуск камери.
  /** @param {MediaStream} acquired @param {string | null} requestedId */
  function initTrack(acquired, requestedId) {
    try {
      st.stream = acquired;
      st.track = firstVideoTrack(acquired);
      st.cameraId = trackDeviceId(st.track) ?? requestedId;
      st.torchOn = false; // не застосовуємо: спалах лише за явним викликом
      st.torchAvailable = torchSupported(st.track);
      const range = zoomRangeOf(st.track);
      st.zoomRange = range;
      if (range === null) return;
      const start = clampZoom(
        prefs.readZoom(mode, st.cameraId) ?? currentTrackZoom() ?? range.min,
        range,
      );
      void setZoom(start);
    } catch {
      st.zoomRange = null;
    } finally {
      emit();
    }
  }

  // Список камер після відкриття (мітки доступні, дозвіл є). Збій — порожній
  // список (перемикання нема), камера працює далі.
  /** @param {MediaStream} acquired */
  async function loadCameras(acquired) {
    try {
      const list =
        opts.enumerateDevices ?? navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      const devices = await list();
      if (destroyed || st.stream !== acquired) return;
      st.cameras = listCameras(devices);
      emit();
    } catch {
      if (!destroyed && st.stream === acquired) {
        st.cameras = [];
        emit();
      }
    }
  }

  async function open() {
    const ep = epoch;
    const impl = gum();
    // Збережена камера; зникла/відмовила → очищаємо вибір і штатний environment.
    const saved = prefs.readCamera();
    /** @type {MediaStream | null} */
    let acquired = null;
    if (saved !== null) {
      try {
        acquired = await impl(exactCamera(saved));
      } catch {
        if (dead(ep)) return null;
        prefs.clearCamera();
      }
    }
    acquired ??= await impl(environmentCamera());
    if (dead(ep)) {
      stopTracks(acquired);
      return null;
    }
    st.generation += 1;
    initTrack(acquired, null);
    void loadCameras(acquired);
    return acquired;
  }

  // Відкрити конкретну камеру; NotReadableError (камеру ще тримає щойно
  // зупинений стрім) — один ретрай через CAMERA_RETRY_MS; інакше/вдруге → null.
  /** @param {string} deviceId @param {number} ep @returns {Promise<MediaStream | null>} */
  async function openExact(deviceId, ep) {
    const impl = gum();
    try {
      return await impl(exactCamera(deviceId));
    } catch (e) {
      if (/** @type {{ name?: string } | null} */ (e)?.name !== "NotReadableError" || dead(ep)) return null;
    }
    await (opts.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))))(CAMERA_RETRY_MS);
    if (dead(ep)) return null;
    try {
      return await impl(exactCamera(deviceId));
    } catch {
      return null;
    }
  }

  /** @returns {Promise<MediaStream | null>} */
  async function openEnvironment() {
    try {
      return await gum()(environmentCamera());
    } catch {
      return null;
    }
  }

  // Наступна камера по колу. Торч гасне, зум береться з ключа нової камери,
  // вибір пишеться ПІСЛЯ успіху. null — перемикання проігноровано (вже в
  // польоті / <2 камер / камера не відкрита) або сесію зупинено; відмова і
  // цільової, і попередньої камери — виняток.
  async function switchNext() {
    if (destroyed || st.switching || st.stream === null || st.cameras.length < 2) return null;
    const ep = epoch;
    const list = st.cameras;
    const prevId = st.cameraId;
    const at = list.findIndex((c) => c.deviceId === prevId);
    const target = list[(at + 1) % list.length];
    if (!target) return null;
    st.switching = true;
    st.generation += 1;
    stopTracks(st.stream);
    st.stream = null;
    st.track = null;
    zoomPending = null; // зум попередньої камери не переходить на нову
    st.zoomRange = null;
    st.torchAvailable = false;
    st.torchOn = false;
    emit();
    try {
      let acquired = await openExact(target.deviceId, ep);
      /** @type {string | null} */
      let openedId = target.deviceId;
      if (acquired === null && !dead(ep)) {
        // відмова → назад на попередню; збережений вибір не міняємо
        openedId = prevId;
        acquired = prevId !== null ? await openExact(prevId, ep) : await openEnvironment();
      }
      if (dead(ep)) {
        stopTracks(acquired);
        return null;
      }
      if (acquired === null) throw new Error("camera unavailable");
      initTrack(acquired, openedId);
      if (openedId === target.deviceId) {
        prefs.writeCamera(st.cameraId ?? target.deviceId);
      }
      return acquired;
    } finally {
      st.switching = false;
      emit();
    }
  }

  // Спалах. Збій applyConstraints проковтується, стан не міняється.
  async function toggleTorch() {
    const next = !st.torchOn;
    try {
      await st.track?.applyConstraints({ advanced: [/** @type {any} */ ({ torch: next })] });
      st.torchOn = next;
      emit();
    } catch {
      // камера відмовила — лишаємо як було
    }
  }

  function stop() {
    epoch += 1;
    stopTracks(st.stream);
    st.stream = null;
    st.track = null;
    st.zoomRange = null;
    st.torchAvailable = false;
    st.torchOn = false; // трек зупинено — спалах гасне сам
    emit();
  }

  function dispose() {
    destroyed = true;
    stop();
    listeners.clear();
  }

  return {
    getState: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    open,
    switchNext,
    setZoom,
    toggleTorch,
    stop,
    dispose,
  };
}
