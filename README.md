# Камера: бібліотека `lib/` і стенд `demo/`

- `lib/` — те, що віддається в інший проєкт: ES-модулі на чистому JavaScript
  (типи в JSDoc), без збірки, без залежностей, без звернень до DOM за id.
  Нічого не виконується при імпорті.
- `demo/` — сторінка-PWA для власної перевірки бібліотеки на телефоні:
  режими фото/відео, якість, перемикач камер, спалах, зум, галерея знятого
  в IndexedDB, робота офлайн. Інтегратору не потрібна.

## Вбудування

```html
<video id="v" playsinline muted autoplay></video>
<script type="module">
  import { createCameraSession, capturePhoto } from "./lib/index.js";

  const session = createCameraSession({
    baseConstraints: { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
  });
  session.subscribe((s) => { document.getElementById("v").srcObject = s.stream; });
  await session.open();
  const blob = await capturePhoto(session, { width: 1280, height: 720, quality: 0.85, video: document.getElementById("v") });
</script>
```

Той самий `import` працює і з бандлера (vite, webpack, esbuild), і напряму
через `<script type="module">`.

## API (`lib/index.js`)

### `createCameraSession(opts) → CameraSession`

Сесія однієї камери. `opts`:

- `baseConstraints` — обовʼязково: `{ video: MediaTrackConstraints, audio: boolean }`;
  у `video` лише розмір/частота кадрів, без `facingMode`/`deviceId`.
- `mode` — `"photo"` (за замовчуванням) або `"video"`; обирає ключ збереженого зуму.
- `prefs` — результат `createPrefs(...)` або його параметри; за замовчуванням `createPrefs()`.
- `enumerateDevices`, `getUserMedia`, `sleep` — підміна для тестів.

Сесія:

- `open()` → `Promise<MediaStream | null>` — відкриває збережену камеру, а якщо
  її нема чи вона відмовила — задню (`facingMode: environment`). `null`, якщо
  сесію зупинено під час відкриття. Помилки браузера (`NotAllowedError`,
  `NotFoundError` тощо) приходять відхиленим промісом.
- `switchNext()` → `Promise<MediaStream | null>` — наступна камера по колу
  серед усіх камер пристрою. `null`, якщо перемикання нема чого робити
  (камера одна, не відкрита, вже перемикається). Якщо цільова камера не
  відкрилась — повертається попередня; якщо не відкрилась і вона — виняток.
- `setZoom(z)` — виставляє зум (викликається часто, повзунком), запамʼятовує
  його для пари камера × режим.
- `toggleTorch()` — спалах; відмова камери ігнорується. Після відкриття
  спалах завжди вимкнений.
- `stop()` — зупиняє треки, сесію можна відкрити знову; `dispose()` — назавжди.
- `getState()` → `CameraState`: `stream`, `track`, `cameraId`, `cameras`
  (`{deviceId, label}[]`), `zoomRange` (`null` — зуму нема), `zoom`,
  `torchAvailable`, `torchOn`, `generation`, `switching`.
- `subscribe(fn)` → функція відписки; `fn` отримує новий `CameraState` при кожній зміні.

### `capturePhoto(session, { width, height, quality, video?, canvas? }) → Promise<Blob>`

JPEG рівно `width`×`height` (кадр обрізається по центру до пропорцій і
масштабується), `quality` 0..1. `video` — ваш `<video>` зі стрімом сесії;
без нього створюється службовий. Першого кадру чекає до 3 с. Помилка (`Error`): камера не відкрита, кадру
ще нема, canvas недоступний, браузер не віддав JPEG.

### `startRecording(session, { width, height, fps, videoBitsPerSecond?, audioBitsPerSecond?, mimeType?, video?, canvas? }) → Promise<Recording>`

Запис відео з canvas: фіксовані розмір і кількість кадрів. Звук береться зі
стріму сесії (потрібен `audio: true` у `baseConstraints`). `Recording`:
`stop()` → `Promise<Blob>` (зібране відео), `frames()` — скільки кадрів
намальовано, `bytes()` — скільки байтів уже записано, `mimeType` — обраний
формат. Помилки: `MediaRecorder` недоступний, камера не відкрита, кадру ще
нема, `DOMException` від непідтримуваного формату.

### `createPrefs({ store?, prefix? }) → CameraPrefs`

Сховище вибору камери й зуму. `store` — обʼєкт з `getItem`/`setItem`
(необовʼязково `removeItem`), за замовчуванням `localStorage`, `null` вимикає
збереження; `prefix` — за замовчуванням `"camera"`. Ключі:
`<prefix>.camera`, `<prefix>.photo-zoom.<deviceId>`, `<prefix>.video-zoom.<deviceId>`.

### `pickRecorderMimeType(isTypeSupported)`, `recorderExtension(mimeType)`

Перший підтримуваний формат запису (mp4 раніше за webm) і розширення файла
(`"mp4"` | `"webm"`) для нього.

## Вимоги

HTTPS або `localhost` (інакше `getUserMedia` недоступний); Chrome.

## Запуск стенда локально

З кореня цієї папки будь-яким статичним сервером, наприклад
`npx serve . -l 4173` або `python3 -m http.server 4173`, і відкрити `http://localhost:4173/demo/`. Збірки нема:
сервер віддає файли як є. Версію стенда видно чипом у верхньому лівому
куті поверх відео: у репозиторії це `dev`, на розкоченій копії — штамп
`ММДД-ГГхх githash` із `demo/version.js`.
