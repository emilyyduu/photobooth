// ---------- Settings ----------
let countdownSeconds = 3;       // changed with the timer buttons in the top bar
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
let viewingId = null; // id of the gallery photo on the result screen
let busy = false;

const $ = (id) => document.getElementById(id);
const video = $('video');
if (MIRROR) video.classList.add('mirror');

// ---------- Screens ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

function goHome() {
  if (busy) return;
  stopCamera();
  show('pick');
  renderGallery();
}

// ---------- Timer setting ----------
try { countdownSeconds = Number(localStorage.getItem('timer')) || 3; } catch (e) {}

function renderTimer() {
  document.querySelectorAll('[data-timer]').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.timer) === countdownSeconds);
  });
}
document.querySelectorAll('[data-timer]').forEach((b) => {
  b.onclick = () => {
    countdownSeconds = Number(b.dataset.timer);
    try { localStorage.setItem('timer', countdownSeconds); } catch (e) {}
    renderTimer();
  };
});
renderTimer();

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

  // Templates uploaded on this device
  for (const rec of await dbAll('templates')) {
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
    card.querySelector('span').textContent = t.name;
    card.onclick = () => startBooth(t);

    if (t.uploaded) {
      const x = document.createElement('button');
      x.className = 'remove';
      x.textContent = '×';
      x.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove "${t.name}" from this device?`)) return;
        await dbDelete('templates', t.id);
        loadTemplates();
      };
      card.appendChild(x);
    }
    grid.appendChild(card);
  }
}

// ---------- Gallery of past photos ----------
async function renderGallery() {
  const photos = (await dbAll('photos')).sort((a, b) => b.created - a.created);
  const gallery = $('gallery');
  gallery.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
  gallery.innerHTML = '';
  $('gallery-section').hidden = photos.length === 0;

  for (const p of photos) {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(p.blob);
    img.alt = 'Saved photo';
    img.onclick = () => showResult(p.blob, p.id, false);
    gallery.appendChild(img);
  }
}

// ---------- Finding the photo slots ----------
// Scans the PNG for transparent areas and returns a box for each one,
// ordered top-to-bottom, then left-to-right. So you never have to type coordinates.
function detectSlots(img) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const scale = Math.min(1, 1000 / Math.max(W, H)); // scan a smaller copy, it's much faster
  const w = Math.round(W * scale), h = Math.round(H * scale);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const alpha = ctx.getImageData(0, 0, w, h).data;

  const seen = new Uint8Array(w * h);
  const boxes = [];
  const isClear = (i) => alpha[i * 4 + 3] < 128;

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
      // Bleed: make the photo a bit bigger than the gap so it tucks under the
      // template's edges. The template is drawn on top, so the extra is hidden.
      const pad = Math.ceil(1 / scale) + 6;
      const x1 = Math.max(0, minX / scale - pad);
      const y1 = Math.max(0, minY / scale - pad);
      const x2 = Math.min(W, (maxX + 1) / scale + pad);
      const y2 = Math.min(H, (maxY + 1) / scale + pad);
      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
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
    await dbPut('templates', { id: 'up-' + Date.now() + '-' + file.name, name: prettyName(file.name), blob: file });
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
  renderStrip();
  setPhase('ready');
  try {
    await startCamera();
  } catch (err) {
    $('status').textContent = 'Camera access is blocked. Allow it in your browser settings.';
    $('shoot').disabled = true;
  }
}

// ready: waiting to start / shooting: countdown running / review: all taken, tap one to retake
function setPhase(phase) {
  const n = current.slots.length;
  const shooting = phase === 'shooting';
  $('shoot').hidden = phase === 'review';
  $('print').hidden = phase !== 'review';
  $('retakeAll').hidden = phase !== 'review';
  [$('shoot'), $('print'), $('retakeAll'), $('backFromBooth')].forEach((b) => (b.disabled = shooting));
  $('strip').classList.toggle('reviewing', phase === 'review');
  if (phase === 'ready') $('status').textContent = '';
  if (phase === 'review') $('status').textContent = 'Tap a photo to retake it';
}

// Shape the live preview like the slot it's filling, so what you see is what you get
function setPreviewShape(i) {
  const s = current.slots[i];
  $('frame').style.aspectRatio = `${s.w} / ${s.h}`;
}

// The side strip: one numbered placeholder per slot, filled in as you go
function renderStrip() {
  const strip = $('strip');
  strip.innerHTML = '';
  current.slots.forEach((s, i) => {
    const box = document.createElement('div');
    box.className = 'shot';
    box.style.aspectRatio = `${s.w} / ${s.h}`;
    box.textContent = i + 1;
    box.onclick = () => retakeOne(i);
    strip.appendChild(box);
  });
}

function fillStrip(i, canvas) {
  const box = $('strip').children[i];
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/jpeg', 0.6);
  box.textContent = '';
  box.appendChild(img);
  box.classList.remove('filled');
  void box.offsetWidth; // replay the pop animation
  box.classList.add('filled');
}

function markActive(i) {
  [...$('strip').children].forEach((b, j) => b.classList.toggle('active', j === i));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Countdown, then capture photo number i
async function takeShot(i) {
  setPreviewShape(i);
  markActive(i);
  $('status').textContent = `${i + 1} / ${current.slots.length}`;
  for (let n = countdownSeconds; n > 0; n--) {
    $('count').textContent = n;
    await wait(1000);
  }
  $('count').textContent = '';
  const shot = captureFrame();
  shots[i] = shot;
  fillStrip(i, shot);
  flash();
  await wait(PAUSE_BETWEEN_SHOTS);
  markActive(-1);
}

$('shoot').onclick = async () => {
  if (busy) return;
  busy = true;
  setPhase('shooting');
  shots = [];
  renderStrip();
  for (let i = 0; i < current.slots.length; i++) await takeShot(i);
  busy = false;
  setPhase('review');
};

async function retakeOne(i) {
  if (busy || !$('strip').classList.contains('reviewing')) return;
  busy = true;
  setPhase('shooting');
  await takeShot(i);
  busy = false;
  setPhase('review');
}

$('retakeAll').onclick = () => $('shoot').onclick();
$('print').onclick = () => { if (!busy) makeResult(); };

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

  const blob = await new Promise((r) => c.toBlob(r, OUTPUT_TYPE, OUTPUT_QUALITY));
  const id = 'photo-' + Date.now();
  await dbPut('photos', { id, blob, created: Date.now() }); // keep a copy in the gallery
  stopCamera();
  showResult(blob, id, true);
}

// fresh = just taken, so play the printing animation
function showResult(blob, id, fresh) {
  resultBlob = blob;
  viewingId = id;
  const out = $('output');
  const printer = $('printer');
  const collect = $('save');
  if (out.src) URL.revokeObjectURL(out.src);

  printer.classList.remove('printing');
  collect.classList.remove('ready', 'hiding');
  $('retake').hidden = !fresh;
  $('deletePhoto').hidden = fresh;

  const done = () => {
    collect.classList.remove('hiding');
    collect.classList.add('ready');
  };

  if (fresh) {
    collect.classList.add('hiding');
    out.onload = () => {
      void printer.offsetWidth;
      printer.classList.add('printing');
    };
    out.onanimationend = (e) => { if (e.animationName === 'print') done(); };
  } else {
    out.onload = null;
    out.onanimationend = null;
    done();
  }

  out.src = URL.createObjectURL(blob);
  show('result');
}

// ---------- Saving ----------
// On iPhone/iPad (and Safari on Mac) this opens the share sheet, where you tap "Save Image".
// Anywhere share isn't available, it downloads the file instead.
$('save').onclick = async () => {
  const ext = OUTPUT_TYPE === 'image/png' ? 'png' : 'jpg';
  const file = new File([resultBlob], `photobooth-${Date.now()}.${ext}`, { type: resultBlob.type });

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

$('deletePhoto').onclick = async () => {
  if (!confirm('Delete this photo?')) return;
  await dbDelete('photos', viewingId);
  goHome();
};

// ---------- Navigation ----------
$('retake').onclick = () => startBooth(current);
$('backFromBooth').onclick = goHome;
$('backFromResult').onclick = goHome;

// ---------- Tiny IndexedDB helper (templates + photos, stored on this device) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('photobooth', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbTx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(request && request.result);
    tx.onerror = () => reject(tx.error);
  });
}
const dbAll = (store) => dbTx(store, 'readonly', (s) => s.getAll()).then((r) => r || []);
const dbPut = (store, rec) => dbTx(store, 'readwrite', (s) => s.put(rec));
const dbDelete = (store, id) => dbTx(store, 'readwrite', (s) => s.delete(id));

loadTemplates();
renderGallery();
