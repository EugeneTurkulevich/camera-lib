// @ts-check
// Локальне сховище знятих фото й відео стенда (IndexedDB). Працює без мережі:
// записи лишаються на пристрої, доки їх не видалять.

const DB_NAME = "camera-test";
const DB_VERSION = 1;
const STORE = "media";

/**
 * @typedef {object} MediaRecord
 * @property {string} id
 * @property {"photo" | "video"} kind
 * @property {Blob} blob
 * @property {string} mime
 * @property {string} quality
 * @property {number} createdAt
 */

/** @returns {Promise<IDBDatabase>} */
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Просить браузер не очищати сховище під тиском місця. Без цього мобільний Chrome
// може прибрати записи, якщо місця бракує.
/** @returns {Promise<boolean>} */
export async function requestPersistence() {
  try {
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

/** @param {MediaRecord} rec */
export async function saveMedia(rec) {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Найновіші спершу.
/** @returns {Promise<MediaRecord[]>} */
export async function listMedia() {
  const db = await open();
  try {
    const all = /** @type {MediaRecord[]} */ (
      await request(db.transaction(STORE, "readonly").objectStore(STORE).getAll())
    );
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

/** @param {string} id */
export async function deleteMedia(id) {
  const db = await open();
  try {
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}
