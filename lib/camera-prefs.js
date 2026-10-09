// @ts-check
// Збереження вибору камери й зуму в key-value сховищі (за замовчуванням
// localStorage). Вибір камери один на всі режими; зум зберігається окремо на
// пару «камера × режим» (3× на головній камері ≠ 3× на ширококутній, для фото
// потрібен інший зум, ніж для відео). Ключі:
//   `${prefix}.camera`, `${prefix}.photo-zoom.<deviceId>`, `${prefix}.video-zoom.<deviceId>`.
// Збої сховища (приватний режим, переповнення) проковтуються: вибір тоді
// живе лише в межах сесії.

/**
 * @typedef {object} KeyValueStore
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} [removeItem] без нього очищення пише порожній рядок
 */

/** @typedef {"photo" | "video"} CameraMode */

/**
 * @typedef {object} CameraPrefs
 * @property {() => string | null} readCamera збережений deviceId або null
 * @property {(deviceId: string) => void} writeCamera
 * @property {() => void} clearCamera
 * @property {(mode: CameraMode, cameraId: string | null | undefined) => number | null} readZoom
 * @property {(mode: CameraMode, cameraId: string | null | undefined, zoom: number) => void} writeZoom
 */

/**
 * @param {{ store?: KeyValueStore | null, prefix?: string }} [opts]
 *   store — за замовчуванням localStorage (null вимикає збереження);
 *   prefix — за замовчуванням "camera".
 * @returns {CameraPrefs}
 */
export function createPrefs(opts = {}) {
  const prefix = opts.prefix ?? "camera";
  const store = opts.store !== undefined ? opts.store : defaultStore();
  const cameraKey = `${prefix}.camera`;

  /** @param {CameraMode} mode @param {string | null | undefined} cameraId */
  function zoomKey(mode, cameraId) {
    if (typeof cameraId !== "string" || cameraId.trim() === "") return null;
    return `${prefix}.${mode}-zoom.${cameraId}`;
  }

  return {
    readCamera() {
      if (store === null) return null;
      try {
        const raw = store.getItem(cameraKey);
        return raw === null || raw.trim() === "" ? null : raw;
      } catch {
        return null;
      }
    },
    writeCamera(deviceId) {
      if (store === null) return;
      try {
        store.setItem(cameraKey, deviceId);
      } catch {
        // вибір живе лише на сесію
      }
    },
    clearCamera() {
      if (store === null) return;
      try {
        if (store.removeItem) store.removeItem(cameraKey);
        else store.setItem(cameraKey, ""); // читання трактує порожнє як «нема»
      } catch {
        // збій очищення не критичний
      }
    },
    readZoom(mode, cameraId) {
      const key = zoomKey(mode, cameraId);
      if (store === null || key === null) return null;
      try {
        const raw = store.getItem(key);
        if (raw === null || raw.trim() === "") return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
    writeZoom(mode, cameraId, zoom) {
      const key = zoomKey(mode, cameraId);
      if (store === null || key === null) return;
      try {
        store.setItem(key, String(zoom));
      } catch {
        // зум живе лише на сесію
      }
    },
  };
}

/** @returns {KeyValueStore | null} */
function defaultStore() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
