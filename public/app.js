// ---------- Settings ----------
const COUNTDOWN_SECONDS = 3;
const PAUSE_BETWEEN_SHOTS = 800; // ms
const MIRROR = true;             // selfie-style, like a real photobooth
const OUTPUT_TYPE = 'image/jpeg';
const OUTPUT_QUALITY = 0.92;

// ---------- State ----------
let templates = [];   // { id, name, img, slots, uploaded }
let current = null;   // the chosen template
let shots = [];       // captured canvases
let stream = null;
let resultBlob = null;
let busy = false;

const $ = (id) => document.getElementById(id);
const video = $('video');
if (MIRROR) video.classList.add('mirror');

// ---------- Screens ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---------- Loading templates ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function loadTemplates() {
  templates = [];

  // Built-in templates: listed in templates/templates.json
  try {
    const list = await (await fetch('templates/templates.json', { cache: 'no-cache' })).json();
    for (const file of list) {
      const img = await loadImage('templates/' + file);
      templates.push({ id: file, name: prettyName(file), img, slots: detectSlots(img), uploaded: false });
    }
  } catch (e) {
    console.warn('Could not load built-in templates', e);
  }

  // Templates uploaded on this device (kept in IndexedDB)
  for (const rec of await dbAll()) {
    const img = await loadImage(URL.createObjectURL(rec.blob));
    templates.push({ id: rec.id, name: rec.name, img, slots: detectSlots(img), uploaded: true });
  }

  renderGrid();
}

function prettyName(file) {
  return file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const t of templates) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<img alt=""><span></span>`;
    card.querySelector('img').src = t.img.src;
    card.querySelector('span').textContent =
      `${t.name} · ${t.slots.length} photo${t.slots.length === 1 ? '' : 's'}`;
    card.onclick = () => startBooth(t);

    if (t.uploaded) {
      const x = document.createElement('button');
      x.className = 'remove';
      x.textContent = '×';
      x.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove "${t.name}" from this device?`)) return;
        await dbDelete(t.id);
        loadTemplates();
      };
      card.appendChild(x);
    }
    grid.appendChild(card);
  }
}

// ---------- Finding the photo slots ----------
// Scans the PNG for transparent areas and returns a box for each one,
// ordered top-to-bottom, then left-to-right. So you never have to type coordinates.
function detectSlots(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const scale = Math.min(1, 400 / Math.max(W, H)); // scan a small copy, it's much faster
  const w = Math.round(W * scale), h = Math.round(H * scale);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const alpha = ctx.getImageData(0, 0, w, h).data;

  const seen = new Uint8Array(w * h);
  const boxes = [];
  const isClear = (i) => alpha[i * 4 + 3] < 30;

  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isClear(start)) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (n < 0 || n >= w * h) continue;
        if ((n === i - 1 && x === 0) || (n === i + 1 && x === w - 1)) continue;
        if (!seen[n] && isClear(n)) { seen[n] = 1; stack.push(n); }
      }
    }
    // Ignore tiny specks (anti-aliasing, little transparent details)
    if (count > w * h * 0.01) {
      boxes.push({
        x: minX / scale, y: minY / scale,
        w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale,
      });
    }
  }

  // No transparent area? Treat the whole template as an overlay on one photo.
  if (!boxes.length) return [{ x: 0, y: 0, w: W, h: H }];

  const rowTolerance = H * 0.05;
  boxes.sort((a, b) => (Math.abs(a.y - b.y) > rowTolerance ? a.y - b.y : a.x - b.x));
  return boxes;
}

// ---------- Uploading templates ----------
$('upload').onchange = async (e) => {
  for (const file of e.target.files) {
    await dbPut({ id: 'up-' + Date.now() + '-' + file.name, name: prettyName(file.name), blob: file });
  }
  e.target.value = '';
  loadTemplates();
};

// ---------- Camera ----------
async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function startBooth(t) {
  current = t;
  shots = [];
  show('booth');
  setPreviewShape(0);
  $('status').textContent = `${t.slots.length} photo${t.slots.length === 1 ? '' : 's'}. Tap Start when ready.`;
  $('shoot').disabled = false;
  try {
    await startCamera();
  } catch (err) {
    $('status').textContent = 'Camera blocked. Allow camera access in your browser settings and reload.';
    $('shoot').disabled = true;
  }
}

// Shape the live preview like the slot it's filling, so what you see is what you get
function setPreviewShape(i) {
  const s = current.slots[i];
  $('frame').style.aspectRatio = `${s.w} / ${s.h}`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

$('shoot').onclick = async () => {
  if (busy) return;
  busy = true;
  $('shoot').disabled = true;
  $('backFromBooth').disabled = true;
  shots = [];

  for (let i = 0; i < current.slots.length; i++) {
    setPreviewShape(i);
    $('status').textContent = `Photo ${i + 1} of ${current.slots.length}`;
    for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
      $('count').textContent = n;
      await wait(1000);
    }
    $('count').textContent = '';
    shots.push(captureFrame());
    flash();
    await wait(PAUSE_BETWEEN_SHOTS);
  }

  await makeResult();
  busy = false;
  $('shoot').disabled = false;
  $('backFromBooth').disabled = false;
};

function flash() {
  const f = $('flash');
  f.classList.remove('go');
  void f.offsetWidth; // restart the animation
  f.classList.add('go');
}

function captureFrame() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const ctx = c.getContext('2d');
  if (MIRROR) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0);
  return c;
}

// ---------- Putting it together ----------
// Draw each photo into its slot (cropped to fill), then lay the template on top.
function drawCover(ctx, src, box) {
  const sr = src.width / src.height, br = box.w / box.h;
  let sw = src.width, sh = src.height, sx = 0, sy = 0;
  if (sr > br) { sw = sh * br; sx = (src.width - sw) / 2; }
  else { sh = sw / br; sy = (src.height - sh) / 2; }
  ctx.drawImage(src, sx, sy, sw, sh, box.x, box.y, box.w, box.h);
}

async function makeResult() {
  const { img, slots } = current;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  slots.forEach((s, i) => drawCover(ctx, shots[i], s));
  ctx.drawImage(img, 0, 0);

  resultBlob = await new Promise((r) => c.toBlob(r, OUTPUT_TYPE, OUTPUT_QUALITY));
  $('output').src = URL.createObjectURL(resultBlob);
  show('result');
}

// ---------- Saving ----------
// On iPhone/iPad (and Safari on Mac) this opens the share sheet, where you tap "Save Image".
// Anywhere share isn't available, it downloads the file instead.
$('save').onclick = async () => {
  const ext = OUTPUT_TYPE === 'image/png' ? 'png' : 'jpg';
  const file = new File([resultBlob], `photobooth-${Date.now()}.${ext}`, { type: OUTPUT_TYPE });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // user closed the share sheet
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
};

// ---------- Navigation ----------
$('retake').onclick = () => startBooth(current);
$('backFromBooth').onclick = () => { stopCamera(); show('pick'); };
$('backFromResult').onclick = () => { stopCamera(); show('pick'); };

// ---------- Tiny IndexedDB helper (stores uploaded templates on this device) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('photobooth', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('templates', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('templates', mode);
    const result = fn(tx.objectStore('templates'));
    tx.oncomplete = () => resolve(result && result.result);
    tx.onerror = () => reject(tx.error);
  });
}
const dbAll = () => dbTx('readonly', (s) => s.getAll()).then((r) => r || []);
const dbPut = (rec) => dbTx('readwrite', (s) => s.put(rec));
const dbDelete = (id) => dbTx('readwrite', (s) => s.delete(id));

loadTemplates();
