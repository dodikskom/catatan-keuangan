/* ============================================================
   Catatan Keuangan — PWA pencatatan pemasukan & pengeluaran
   - Login username/password + Kode Ruang bersama
   - Semua perangkat dengan Kode Ruang yang sama berbagi data yang sama
     (realtime via Firestore, tanpa perlu akun Google)
   - Dashboard grafik (donut kategori + tren 6 bulan)
   - Data di localStorage (offline-first), disinkronkan ke Firestore per-ruang.
   ============================================================ */

import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, collection, doc, setDoc, deleteDoc,
  onSnapshot, getDocs, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache() });

// Kredensial login (hardcode, sesuai permintaan)
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin';

const STORAGE_KEY = 'catatan-keuangan-v1';
const ROOM_KEY = 'catatan-keuangan-room'; // kode ruang aktif tersimpan agar tidak perlu login ulang

const CATEGORIES = {
  expense: [
    { id: 'makan', label: 'Makan & Minum', emoji: '🍽️' },
    { id: 'transport', label: 'Transportasi', emoji: '🚗' },
    { id: 'belanja', label: 'Belanja', emoji: '🛍️' },
    { id: 'tagihan', label: 'Tagihan', emoji: '🧾' },
    { id: 'kesehatan', label: 'Kesehatan', emoji: '💊' },
    { id: 'hiburan', label: 'Hiburan', emoji: '🎮' },
    { id: 'pendidikan', label: 'Pendidikan', emoji: '📚' },
    { id: 'lainnya-out', label: 'Lainnya', emoji: '📦' },
  ],
  income: [
    { id: 'gaji', label: 'Gaji', emoji: '💼' },
    { id: 'usaha', label: 'Usaha', emoji: '🏪' },
    { id: 'bonus', label: 'Bonus', emoji: '🎁' },
    { id: 'investasi', label: 'Investasi', emoji: '📈' },
    { id: 'lainnya-in', label: 'Lainnya', emoji: '💰' },
  ],
};

// Warna kategori (palet tervalidasi, urutan tetap) — dipetakan per id kategori pengeluaran
const CAT_COLORS = {
  makan: 'var(--cat-1)', transport: 'var(--cat-2)', belanja: 'var(--cat-3)',
  tagihan: 'var(--cat-4)', kesehatan: 'var(--cat-5)', hiburan: 'var(--cat-6)',
  pendidikan: 'var(--cat-7)', 'lainnya-out': 'var(--cat-8)',
};

// ---------- State ----------
let transactions = load();
let currentType = 'expense';
let editId = null;
let selectedMonth = ymNow();
let activeView = 'tx';
let currentRoom = null;      // kode ruang yang sedang aktif
let authReady = false;       // sudah anonymous sign-in ke Firebase?
let unsubscribeSnapshot = null;
let migrationChecked = false;

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function ymNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatRp(n) { return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }
function formatRpShort(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'M';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'jt';
  if (a >= 1e3) return Math.round(n / 1e3) + 'rb';
  return String(Math.round(n));
}
function formatDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
function monthName(ym) {
  const [y, m] = ym.split('-');
  return new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}
function monthShort(ym) {
  const [y, m] = ym.split('-');
  return new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'short' });
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function catInfo(type, id) {
  return (CATEGORIES[type] || []).find((c) => c.id === id) || { label: 'Lainnya', emoji: '📦' };
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Penyimpanan ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions)); }

/* ============================================================
   1. LOGIN (username/password + Kode Ruang)
   ============================================================ */
const lock = $('lock');

function lockError(msg) {
  $('lockError').textContent = msg || ' ';
  if (msg) { lock.classList.add('shake'); setTimeout(() => lock.classList.remove('shake'), 400); }
}

function unlock() {
  lock.style.display = 'none';
  $('app').hidden = false;
  render();
}

function lockApp() {
  $('app').hidden = true;
  lock.style.display = 'grid';
  lockError('');
}

// Normalisasi kode ruang jadi id dokumen Firestore yang valid & konsisten
function normalizeRoom(raw) {
  return (raw || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') // hanya huruf/angka/-/_ ; sisanya jadi '-'
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Masuk ke sebuah ruang: simpan, sambungkan sync, buka aplikasi
async function enterRoom(room) {
  currentRoom = room;
  localStorage.setItem(ROOM_KEY, room);
  $('roomLabel').textContent = room;
  $('userInfo').hidden = false;
  setSyncStatus('Menyinkronkan...');
  unlock();

  // Pastikan sudah terautentikasi (anonim) sebelum akses Firestore
  if (!authReady) {
    try { await signInAnonymously(auth); authReady = true; }
    catch { setSyncStatus('Gagal sinkron'); return; }
  }
  await maybeMigrateLocalData(room);
  startRemoteSync(room);
}

$('lockForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = $('lockUser').value.trim();
  const pass = $('lockPass').value;
  const room = normalizeRoom($('lockRoom').value);

  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    lockError('Username atau password salah');
    return;
  }
  if (!room) {
    lockError('Isi Kode Ruang (mis. keluarga2026)');
    return;
  }
  lockError('');
  enterRoom(room);
});

/* ============================================================
   2. RENDER TRANSAKSI + RINGKASAN
   ============================================================ */
function monthTxs() {
  return transactions
    .filter((t) => t.date.startsWith(selectedMonth))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}

function render() {
  const list = monthTxs();
  let income = 0, expense = 0;
  for (const t of list) (t.type === 'income' ? (income += t.amount) : (expense += t.amount));

  $('balance').textContent = formatRp(income - expense);
  $('totalIncome').textContent = formatRp(income);
  $('totalExpense').textContent = formatRp(expense);
  $('monthLabel').textContent = monthShort(selectedMonth);
  $('monthPicker').value = selectedMonth;
  $('txCount').textContent = list.length ? `${list.length} transaksi` : '';

  // Daftar transaksi
  const ul = $('txList');
  ul.innerHTML = '';
  $('emptyState').hidden = list.length > 0;
  for (const t of list) {
    const info = catInfo(t.type, t.category);
    const li = document.createElement('li');
    li.className = 'tx-item';
    li.innerHTML = `
      <div class="tx-emoji ${t.type}">${info.emoji}</div>
      <div class="tx-main">
        <p class="tx-cat">${info.label}</p>
        ${t.note ? `<p class="tx-note">${escapeHtml(t.note)}</p>` : ''}
      </div>
      <div class="tx-right">
        <p class="tx-amount ${t.type}">${t.type === 'income' ? '+' : '−'} ${formatRp(t.amount)}</p>
        <p class="tx-date">${formatDate(t.date)}</p>
      </div>
      <button class="tx-del" aria-label="Hapus" data-id="${t.id}">✕</button>`;
    li.querySelector('.tx-main').addEventListener('click', () => openForm(t));
    ul.appendChild(li);
  }

  if (activeView === 'dash') renderDashboard(list, income, expense);
}

/* ============================================================
   3. DASHBOARD
   ============================================================ */
function renderDashboard(list, income, expense) {
  // --- Stat tiles ---
  const now = new Date();
  const isCurrentMonth = selectedMonth === ymNow();
  const [yy, mm] = selectedMonth.split('-').map(Number);
  const daysInMonth = new Date(yy, mm, 0).getDate();
  const daysElapsed = isCurrentMonth ? now.getDate() : daysInMonth;
  $('statAvg').textContent = formatRp(expense / Math.max(1, daysElapsed));

  const rate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0;
  $('statSave').textContent = rate + '%';
  $('statSaveNote').textContent = income > 0 ? 'dari pemasukan' : 'belum ada pemasukan';

  const expenses = list.filter((t) => t.type === 'expense');
  const biggest = expenses.reduce((m, t) => (t.amount > (m?.amount || 0) ? t : m), null);
  $('statBig').textContent = biggest ? formatRp(biggest.amount) : 'Rp 0';
  $('statBigNote').textContent = biggest ? catInfo('expense', biggest.category).label : '—';

  $('statCount').textContent = list.length;

  // --- Donut per kategori (pengeluaran) ---
  const byCat = {};
  for (const t of expenses) byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  const cats = Object.entries(byCat)
    .map(([id, amount]) => ({ id, amount, ...catInfo('expense', id), color: CAT_COLORS[id] || 'var(--cat-8)' }))
    .sort((a, b) => b.amount - a.amount);

  drawDonut(cats, expense);

  // --- Tren 6 bulan ---
  drawBars();
}

/* ---- Donut chart (SVG) ---- */
function drawDonut(cats, total) {
  const wrap = $('donutWrap');
  const legend = $('catLegend');
  const empty = $('dashEmpty1');

  if (!cats.length || total <= 0) {
    wrap.innerHTML = ''; legend.innerHTML = ''; empty.hidden = false; return;
  }
  empty.hidden = true;

  const size = 168, cx = size / 2, cy = size / 2, r = 62, sw = 26;
  const C = 2 * Math.PI * r;
  const gap = 0.006 * C; // celah antar segmen

  let offset = 0;
  let segs = '';
  for (const c of cats) {
    const frac = c.amount / total;
    const len = Math.max(frac * C - gap, 0.5);
    segs += `<circle class="donut-seg" r="${r}" cx="${cx}" cy="${cy}" fill="none"
      stroke="${c.color}" stroke-width="${sw}"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      data-tip="${escapeHtml(c.label)}|${formatRp(c.amount)} · ${Math.round(frac * 100)}%"></circle>`;
    offset += frac * C;
  }

  wrap.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg)">
      ${segs}
      <g style="transform:rotate(90deg);transform-origin:center">
        <text class="donut-center-val" x="${cx}" y="${cy - 2}" text-anchor="middle">${formatRpShort(total)}</text>
        <text class="donut-center-lbl" x="${cx}" y="${cy + 12}" text-anchor="middle">TOTAL</text>
      </g>
    </svg>`;

  legend.innerHTML = cats.map((c) => {
    const pct = Math.round((c.amount / total) * 100);
    return `<li>
      <span class="lg-swatch" style="background:${c.color}"></span>
      <span class="lg-name">${c.emoji} ${c.label}</span>
      <span class="lg-bar"><i style="width:${pct}%;background:${c.color}"></i></span>
      <span class="lg-amt">${formatRpShort(c.amount)}</span>
      <span class="lg-pct">${pct}%</span>
    </li>`;
  }).join('');

  attachTip(wrap.querySelectorAll('.donut-seg'));
}

/* ---- Bar chart tren 6 bulan (SVG) ---- */
function drawBars() {
  // Kumpulkan 6 bulan terakhir (berbasis bulan terpilih)
  const months = [];
  const [by, bm] = selectedMonth.split('-').map(Number);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(by, bm - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const data = months.map((ym) => {
    let inc = 0, exp = 0;
    for (const t of transactions) {
      if (!t.date.startsWith(ym)) continue;
      t.type === 'income' ? (inc += t.amount) : (exp += t.amount);
    }
    return { ym, inc, exp };
  });

  const max = Math.max(1, ...data.map((d) => Math.max(d.inc, d.exp)));
  const W = 340, H = 180, padB = 24, padT = 14, padL = 6;
  const plotH = H - padB - padT;
  const groupW = W / data.length;
  const barW = 13, gapIn = 5;

  // gridline horizontal (3 garis)
  let grid = '';
  for (let g = 1; g <= 3; g++) {
    const y = padT + plotH - (plotH * g) / 3;
    grid += `<line class="bar-grid" x1="${padL}" y1="${y}" x2="${W - padL}" y2="${y}"/>`;
  }

  let bars = '', labels = '';
  data.forEach((d, i) => {
    const gx = padL + i * ((W - 2 * padL) / data.length) + ((W - 2 * padL) / data.length) / 2;
    const incH = (d.inc / max) * plotH;
    const expH = (d.exp / max) * plotH;
    const x1 = gx - barW - gapIn / 2;
    const x2 = gx + gapIn / 2;
    const baseY = padT + plotH;
    bars += `<rect class="bar-rect" x="${x1}" y="${baseY - incH}" width="${barW}" height="${incH}" rx="4" fill="var(--income)"
      data-tip="${monthShort(d.ym)} · Pemasukan|${formatRp(d.inc)}"></rect>`;
    bars += `<rect class="bar-rect" x="${x2}" y="${baseY - expH}" width="${barW}" height="${expH}" rx="4" fill="var(--expense)"
      data-tip="${monthShort(d.ym)} · Pengeluaran|${formatRp(d.exp)}"></rect>`;
    const isSel = d.ym === selectedMonth;
    labels += `<text class="bar-axis" x="${gx}" y="${H - 8}" text-anchor="middle"
      style="${isSel ? 'fill:var(--primary);font-weight:700' : ''}">${monthShort(d.ym)}</text>`;
  });

  $('barWrap').innerHTML = `
    <svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid}
      <line class="bar-grid" x1="${padL}" y1="${padT + plotH}" x2="${W - padL}" y2="${padT + plotH}"/>
      ${bars}${labels}
    </svg>`;

  attachTip($('barWrap').querySelectorAll('.bar-rect'));
}

/* ---- Tooltip grafik ---- */
const tip = $('chartTip');
function attachTip(nodes) {
  nodes.forEach((n) => {
    const show = (e) => {
      const [title, val] = (n.dataset.tip || '').split('|');
      tip.innerHTML = `${escapeHtml(title)}<br><b>${escapeHtml(val)}</b>`;
      tip.hidden = false;
      const p = e.touches ? e.touches[0] : e;
      tip.style.left = p.clientX + 'px';
      tip.style.top = p.clientY + 'px';
    };
    n.addEventListener('mouseenter', show);
    n.addEventListener('mousemove', show);
    n.addEventListener('mouseleave', () => (tip.hidden = true));
    n.addEventListener('touchstart', show, { passive: true });
    n.addEventListener('touchend', () => setTimeout(() => (tip.hidden = true), 1200));
  });
}

/* ============================================================
   4. NAVIGASI TAB
   ============================================================ */
function switchView(view) {
  activeView = view;
  $('view-tx').hidden = view !== 'tx';
  $('view-dash').hidden = view !== 'dash';
  $('fab').style.display = view === 'tx' ? 'grid' : 'none';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  window.scrollTo(0, 0);
  render();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

/* ============================================================
   5. FORM TRANSAKSI
   ============================================================ */
function fillCategories(type) {
  const sel = $('category');
  sel.innerHTML = '';
  for (const c of CATEGORIES[type]) {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = `${c.emoji}  ${c.label}`;
    sel.appendChild(opt);
  }
}
function syncTypeToggle() {
  document.querySelectorAll('.type-opt').forEach((b) => b.classList.toggle('active', b.dataset.type === currentType));
}
function openForm(tx = null) {
  editId = tx ? tx.id : null;
  currentType = tx ? tx.type : 'expense';
  $('formTitle').textContent = tx ? 'Edit Transaksi' : 'Tambah Transaksi';
  syncTypeToggle();
  fillCategories(currentType);
  $('amount').value = tx ? Number(tx.amount).toLocaleString('id-ID') : '';
  $('category').value = tx ? tx.category : CATEGORIES[currentType][0].id;
  $('date').value = tx ? tx.date : todayISO();
  $('note').value = tx ? tx.note || '' : '';
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('amount').focus(), 250);
}
function closeForm() {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  $('txForm').reset();
  editId = null;
}

$('fab').addEventListener('click', () => openForm());
$('cancelBtn').addEventListener('click', closeForm);
$('modal').querySelector('.modal-backdrop').addEventListener('click', closeForm);

document.querySelectorAll('.type-opt').forEach((btn) => {
  btn.addEventListener('click', () => { currentType = btn.dataset.type; syncTypeToggle(); fillCategories(currentType); });
});

$('amount').addEventListener('input', () => {
  const digits = $('amount').value.replace(/\D/g, '');
  $('amount').value = digits ? Number(digits).toLocaleString('id-ID') : '';
});

$('txForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = Number($('amount').value.replace(/\D/g, ''));
  if (!amount || amount <= 0) { $('amount').focus(); return; }
  const data = { type: currentType, amount, category: $('category').value, date: $('date').value, note: $('note').value.trim() };
  let savedTx;
  if (editId) {
    const idx = transactions.findIndex((t) => t.id === editId);
    if (idx !== -1) transactions[idx] = { ...transactions[idx], ...data };
    savedTx = transactions[idx];
  } else {
    savedTx = { id: uid(), createdAt: Date.now(), ...data };
    transactions.push(savedTx);
  }
  save();
  syncUpsertTx(savedTx);
  selectedMonth = data.date.slice(0, 7);
  render();
  closeForm();
});

$('txList').addEventListener('click', (e) => {
  const btn = e.target.closest('.tx-del');
  if (!btn) return;
  if (confirm('Hapus transaksi ini?')) {
    transactions = transactions.filter((t) => t.id !== btn.dataset.id);
    save(); render();
    syncDeleteTx(btn.dataset.id);
  }
});

$('monthPicker').addEventListener('change', () => { selectedMonth = $('monthPicker').value || ymNow(); render(); });
$('prevMonthBtn').addEventListener('click', () => { selectedMonth = shiftMonth(selectedMonth, -1); render(); });
$('nextMonthBtn').addEventListener('click', () => { selectedMonth = shiftMonth(selectedMonth, 1); render(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeForm(); });

/* ============================================================
   6. SINKRONISASI CLOUD (Firestore per Kode Ruang)
   ============================================================ */
function setSyncStatus(text) { $('syncStatus').textContent = text; }

function txDocRef(room, id) { return doc(db, 'rooms', room, 'transactions', id); }

async function syncUpsertTx(tx) {
  if (!currentRoom || !authReady) return;
  try {
    await setDoc(txDocRef(currentRoom, tx.id), {
      type: tx.type, amount: tx.amount, category: tx.category,
      date: tx.date, note: tx.note || '', createdAt: tx.createdAt,
    });
  } catch { /* offline: Firestore SDK meng-queue otomatis (persistentLocalCache) */ }
}

async function syncDeleteTx(id) {
  if (!currentRoom || !authReady) return;
  try { await deleteDoc(txDocRef(currentRoom, id)); } catch { /* akan di-retry otomatis saat online */ }
}

// Saat masuk ruang untuk pertama kali: jika ruang masih kosong tapi ada data lokal,
// unggah data lokal sebagai isi awal ruang. Jika ruang sudah berisi, snapshot yang menentukan.
async function maybeMigrateLocalData(room) {
  if (migrationChecked) return;
  migrationChecked = true;
  const col = collection(db, 'rooms', room, 'transactions');
  const snap = await getDocs(col);
  if (!snap.empty || transactions.length === 0) return;

  setSyncStatus('Menyinkronkan...');
  const chunks = [];
  for (let i = 0; i < transactions.length; i += 500) chunks.push(transactions.slice(i, i + 500));
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const tx of chunk) {
      batch.set(txDocRef(room, tx.id), {
        type: tx.type, amount: tx.amount, category: tx.category,
        date: tx.date, note: tx.note || '', createdAt: tx.createdAt,
      });
    }
    await batch.commit();
  }
  await setDoc(doc(db, 'rooms', room), { createdAt: serverTimestamp() }, { merge: true });
}

function startRemoteSync(room) {
  const col = collection(db, 'rooms', room, 'transactions');
  unsubscribeSnapshot = onSnapshot(col, (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    transactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    save();
    render();
    setSyncStatus('Tersinkron');
  }, () => setSyncStatus('Gagal sinkron'));
}

function stopRemoteSync() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
}

function signOut() {
  if (!confirm('Keluar & ganti ruang?\n\nData tetap aman di cloud. Anda perlu login lagi untuk masuk kembali.')) return;
  stopRemoteSync();
  migrationChecked = false;
  currentRoom = null;
  localStorage.removeItem(ROOM_KEY);
  transactions = [];
  save();
  $('userInfo').hidden = true;
  $('lockPass').value = '';
  lockApp();
}

// Anonymous sign-in dilacak sekali; setelah siap, auto-masuk ruang tersimpan (jika ada)
onAuthStateChanged(auth, (user) => {
  authReady = !!user;
});

window.addEventListener('online', () => currentRoom && setSyncStatus('Tersinkron'));
window.addEventListener('offline', () => setSyncStatus('Offline'));

$('signOutBtn').addEventListener('click', signOut);

/* ============================================================
   7. INIT
   ============================================================ */

// Jika sudah pernah masuk ruang di perangkat ini, buka langsung tanpa login ulang.
(function autoEnter() {
  const savedRoom = localStorage.getItem(ROOM_KEY);
  if (savedRoom) {
    $('lockUser').value = ADMIN_USER;
    enterRoom(savedRoom);
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW gagal:', err));
  });
}
