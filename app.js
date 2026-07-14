/* ============================================================
   Catatan Keuangan — PWA pencatatan pemasukan & pengeluaran
   - Login username/password + Kode Ruang bersama
   - Semua perangkat dengan Kode Ruang yang sama berbagi data yang sama
     (realtime via Firestore, tanpa perlu akun Google)
   - Dashboard grafik (donut kategori + tren 6 bulan)
   - Anggaran per kategori, multi-dompet + transfer, transaksi berulang,
     target tabungan, template cepat, laporan, ekspor CSV/backup,
     pencarian & filter, foto struk, pengingat harian
   - Data di localStorage (offline-first), disinkronkan ke Firestore per-ruang.
     Pengaturan (anggaran, target, dll.) ikut tersinkron di rooms/{room}/meta.
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

// Kode ruang TETAP (tersembunyi): semua device yang login berbagi ruang yang sama.
// Acak & sulit ditebak karena berfungsi sebagai kunci data di cloud.
const ROOM = 'dodik-kas-9f3k7q2x';

const STORAGE_KEY = 'catatan-keuangan-v1';
const SETTINGS_KEY = 'catatan-keuangan-settings-v1';

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

const WALLETS = [
  { id: 'tunai', label: 'Tunai', emoji: '💵' },
  { id: 'bank', label: 'Bank', emoji: '🏦' },
  { id: 'ewallet', label: 'E-Wallet', emoji: '📱' },
];

const DEFAULT_SETTINGS = () => ({
  budgets: {},                              // { catId: jumlah }
  goals: [],                                // { id, name, target, saved }
  recurring: [],                            // { id, type, category, amount, day, note, wallet, start, lastPosted }
  templates: [],                            // { id, name, type, category, amount, note, wallet }
  reminder: { enabled: false, time: '20:00' },
  updatedAt: 0,
});

// ---------- State ----------
let transactions = load();
let settings = loadSettings();
let currentType = 'expense';
let editId = null;
let selectedMonth = ymNow();
let activeView = 'tx';
let currentRoom = null;      // kode ruang yang sedang aktif
let authReady = false;       // sudah anonymous sign-in ke Firebase?
let unsubscribeSnapshot = null;
let unsubscribeSettings = null;
let migrationChecked = false;
let searchQuery = '';
let filterCatVal = '';
let pendingPhoto = '';       // dataURL foto pada form yang sedang terbuka
let editGoalId = null;
let editRecId = null;

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function pad2(n) { return String(n).padStart(2, '0'); }
function ymNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
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
function formatDateFull(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
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
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function catInfo(type, id) {
  return (CATEGORIES[type] || []).find((c) => c.id === id) || { label: 'Lainnya', emoji: '📦' };
}
function walletInfo(id) {
  return WALLETS.find((w) => w.id === id) || WALLETS[0];
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Input jumlah dengan pemisah ribuan otomatis
function attachAmountFormat(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    input.value = digits ? Number(digits).toLocaleString('id-ID') : '';
  });
}
function amountVal(input) { return Number(input.value.replace(/\D/g, '')) || 0; }
function setAmountVal(input, n) { input.value = n ? Number(n).toLocaleString('id-ID') : ''; }
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Getar ringan (jika didukung) — memberi umpan balik taktil pada aksi penting
function haptic(ms = 12) { try { navigator.vibrate?.(ms); } catch { /* abaikan */ } }

/* ---------- Toast (notifikasi mengambang) ---------- */
const TOAST_ICONS = { ok: '✓', error: '!', info: 'i' };
function toast(msg, { type = 'ok', duration = 3200, action } = {}) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-ico">${TOAST_ICONS[type] || 'i'}</span>
    <span class="toast-msg">${escapeHtml(msg)}</span>`;
  let timer;
  const dismiss = () => {
    if (el.dataset.leaving) return;
    el.dataset.leaving = '1';
    clearTimeout(timer);
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // fallback bila animasi dimatikan
  };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'toast-action'; btn.textContent = action.label;
    btn.addEventListener('click', () => { haptic(); action.onClick(); dismiss(); });
    el.appendChild(btn);
  }
  wrap.appendChild(el);
  // Batasi jumlah toast di layar
  while (wrap.children.length > 3) wrap.firstElementChild.remove();
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------- Dialog konfirmasi / prompt (pengganti confirm/prompt native) ---------- */
let dlgResolve = null;
function closeDialog(value) {
  $('dialogModal').hidden = true;
  if (!anyModalOpen()) document.body.style.overflow = '';
  const r = dlgResolve; dlgResolve = null;
  if (r) r(value);
}
// Ada modal lain yang masih terbuka? (agar overflow body tidak keliru direset)
function anyModalOpen() {
  return ['modal', 'budgetModal', 'goalModal', 'recModal'].some((id) => !$(id).hidden);
}
function openDialog({ title, body = '', icon = '⚠️', danger = false, confirmText = 'OK', cancelText = 'Batal', input }) {
  return new Promise((resolve) => {
    dlgResolve = resolve;
    $('dlgTitle').textContent = title;
    $('dlgBody').textContent = body;
    $('dlgBody').hidden = !body;
    $('dlgIcon').textContent = icon;
    $('dlgIcon').className = 'dlg-icon' + (danger ? ' danger' : '');
    $('dlgConfirm').textContent = confirmText;
    $('dlgConfirm').className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    $('dlgCancel').textContent = cancelText;
    const wrap = $('dlgInputWrap');
    wrap.hidden = !input;
    if (input) {
      const el = $('dlgInput');
      $('dlgPrefix').textContent = input.prefix ?? 'Rp';
      $('dlgPrefix').style.display = input.prefix === '' ? 'none' : '';
      el.value = '';
      el.placeholder = input.placeholder || '0';
      el.inputMode = input.numeric === false ? 'text' : 'numeric';
      el.dataset.numeric = input.numeric === false ? '' : '1';
    }
    $('dialogModal').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => (input ? $('dlgInput') : $('dlgConfirm')).focus(), 260);
  });
}
// confirm(...) → Promise<boolean>. Default: aksi hapus (merah, ikon 🗑).
function confirmDialog(title, body, opts = {}) {
  return openDialog({
    title, body,
    icon: opts.icon || '🗑',
    danger: opts.danger ?? true,
    confirmText: opts.confirmText || 'Hapus',
    cancelText: opts.cancelText || 'Batal',
  }).then((v) => v !== null && v !== false);
}
$('dialogForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('dlgInputWrap').hidden) { closeDialog($('dlgInput').value); return; }
  closeDialog(true);
});
$('dlgCancel').addEventListener('click', () => closeDialog(null));
// Pemisah ribuan otomatis saat dialog dipakai untuk input Rupiah
$('dlgInput').addEventListener('input', () => {
  const el = $('dlgInput');
  if (!el.dataset.numeric) return;
  const digits = el.value.replace(/\D/g, '');
  el.value = digits ? Number(digits).toLocaleString('id-ID') : '';
});

// ---------- Penyimpanan ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function save() {
  // Foto tidak ikut ke localStorage (hemat kuota ~5MB); foto tersimpan di
  // Firestore (termasuk cache offline-nya) dan dipulihkan lewat snapshot.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions, (k, v) => (k === 'photo' ? undefined : v)));
  } catch { /* kuota penuh — data tetap aman di cloud */ }
}
function loadSettings() {
  const def = DEFAULT_SETTINGS();
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!s) return def;
    return { ...def, ...s, reminder: { ...def.reminder, ...(s.reminder || {}) } };
  } catch { return def; }
}
function persistSettingsLocal() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* abaikan */ }
}
function saveSettings() {
  settings.updatedAt = Date.now();
  persistSettingsLocal();
  syncSettings();
}

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

// Masuk ke ruang bersama: sambungkan sync, buka aplikasi
async function enterRoom() {
  currentRoom = ROOM;
  localStorage.setItem('catatan-logged-in', '1'); // penanda agar tak perlu login ulang
  $('userInfo').hidden = false;
  setSyncStatus('Menyinkronkan...');
  unlock();

  // Pastikan sudah terautentikasi (anonim) sebelum akses Firestore
  if (!authReady) {
    try { await signInAnonymously(auth); authReady = true; }
    catch { setSyncStatus('Gagal sinkron'); return; }
  }
  await maybeMigrateLocalData(ROOM);
  startRemoteSync(ROOM);
  applyRecurring();
}

$('lockForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const user = $('lockUser').value.trim();
  const pass = $('lockPass').value;

  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    lockError('Username atau password salah');
    return;
  }
  lockError('');
  enterRoom();
});

/* ============================================================
   2. RENDER TRANSAKSI + RINGKASAN (+ pencarian & filter)
   ============================================================ */
function byDateDesc(a, b) {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0);
}
function monthTxs() {
  return transactions.filter((t) => t.date.startsWith(selectedMonth)).sort(byDateDesc);
}
function isSearching() { return !!(searchQuery.trim() || filterCatVal); }
function searchTxs() {
  const q = searchQuery.trim().toLowerCase();
  return transactions.filter((t) => {
    if (filterCatVal) {
      if (filterCatVal === '__transfer') { if (t.type !== 'transfer') return false; }
      else if (t.type === 'transfer' || t.category !== filterCatVal) return false;
    }
    if (q) {
      const label = t.type === 'transfer' ? 'transfer' : catInfo(t.type, t.category).label.toLowerCase();
      if (!(`${(t.note || '').toLowerCase()} ${label}`).includes(q)) return false;
    }
    return true;
  }).sort(byDateDesc).slice(0, 300);
}

function txItemHtml(t, withYear) {
  const w = walletInfo(t.wallet || 'tunai');
  let emoji, label, amtClass, sign;
  if (t.type === 'transfer') {
    const w2 = walletInfo(t.walletTo || 'tunai');
    emoji = '⇄';
    label = `${w.label} → ${w2.label}`;
    amtClass = 'transfer'; sign = '';
  } else {
    const info = catInfo(t.type, t.category);
    emoji = info.emoji; label = info.label;
    amtClass = t.type; sign = t.type === 'income' ? '+ ' : '− ';
  }
  const dateStr = withYear ? formatDateFull(t.date) : formatDate(t.date);
  return `
    <div class="tx-emoji ${amtClass}">${emoji}</div>
    <div class="tx-main">
      <p class="tx-cat">${escapeHtml(label)}</p>
      ${t.note || t.photo ? `<p class="tx-note">${t.photo ? '📎 ' : ''}${escapeHtml(t.note || 'foto struk')}</p>` : ''}
    </div>
    <div class="tx-right">
      <p class="tx-amount ${amtClass}">${sign}${formatRp(t.amount)}</p>
      <p class="tx-date">${w.emoji} ${dateStr}</p>
    </div>
    <button class="tx-del" aria-label="Hapus" data-id="${t.id}">✕</button>`;
}

function render() {
  const monthly = monthTxs();
  let income = 0, expense = 0;
  for (const t of monthly) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
  }

  $('balance').textContent = formatRp(income - expense);
  $('totalIncome').textContent = formatRp(income);
  $('totalExpense').textContent = formatRp(expense);
  $('monthLabel').textContent = monthShort(selectedMonth);
  $('monthPicker').value = selectedMonth;

  const searching = isSearching();
  const list = searching ? searchTxs() : monthly;
  $('txCount').textContent = searching
    ? `${list.length} hasil`
    : (list.length ? `${list.length} transaksi` : '');

  // Daftar transaksi
  const ul = $('txList');
  ul.innerHTML = '';
  $('emptyState').hidden = list.length > 0;
  $('emptyTitle').textContent = searching ? 'Tidak ada hasil.' : 'Belum ada transaksi di bulan ini.';
  $('emptySub').textContent = searching ? 'Coba kata kunci atau filter lain.' : 'Tekan tombol + untuk menambah.';
  for (const t of list) {
    const li = document.createElement('li');
    li.className = 'tx-item';
    li.innerHTML = txItemHtml(t, searching);
    li.querySelector('.tx-main').addEventListener('click', () => openForm(t));
    ul.appendChild(li);
  }

  if (activeView === 'dash') renderDashboard(monthly, income, expense);
  if (activeView === 'budget') renderBudget(monthly);
  if (activeView === 'more') renderMore();
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
    months.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  const data = months.map((ym) => {
    let inc = 0, exp = 0;
    for (const t of transactions) {
      if (!t.date.startsWith(ym)) continue;
      if (t.type === 'income') inc += t.amount;
      else if (t.type === 'expense') exp += t.amount;
    }
    return { ym, inc, exp };
  });

  const max = Math.max(1, ...data.map((d) => Math.max(d.inc, d.exp)));
  const W = 340, H = 180, padB = 24, padT = 14, padL = 6;
  const plotH = H - padB - padT;
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
const VIEWS = ['tx', 'dash', 'budget', 'more'];
function switchView(view) {
  activeView = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $('fab').style.display = view === 'tx' ? 'grid' : 'none';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  window.scrollTo(0, 0);
  render();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

/* ---- Pencarian & filter ---- */
function populateFilterCat() {
  const sel = $('filterCat');
  const opt = (v, label) => `<option value="${v}">${label}</option>`;
  sel.innerHTML = opt('', 'Semua')
    + `<optgroup label="Pengeluaran">${CATEGORIES.expense.map((c) => opt(c.id, `${c.emoji} ${c.label}`)).join('')}</optgroup>`
    + `<optgroup label="Pemasukan">${CATEGORIES.income.map((c) => opt(c.id, `${c.emoji} ${c.label}`)).join('')}</optgroup>`
    + opt('__transfer', '⇄ Transfer');
}
$('searchInput').addEventListener('input', () => {
  searchQuery = $('searchInput').value;
  $('searchClear').hidden = !searchQuery;
  render();
});
$('searchClear').addEventListener('click', () => {
  searchQuery = ''; $('searchInput').value = ''; $('searchClear').hidden = true; render();
});
$('filterCat').addEventListener('change', () => { filterCatVal = $('filterCat').value; render(); });

/* ============================================================
   5. FORM TRANSAKSI (+ dompet, transfer, foto, template)
   ============================================================ */
function fillCategories(type) {
  const sel = $('category');
  sel.innerHTML = '';
  for (const c of CATEGORIES[type] || []) {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = `${c.emoji}  ${c.label}`;
    sel.appendChild(opt);
  }
}
function fillWalletSelect(sel) {
  sel.innerHTML = WALLETS.map((w) => `<option value="${w.id}">${w.emoji} ${w.label}</option>`).join('');
}
function syncTypeToggle() {
  document.querySelectorAll('#txForm .type-opt').forEach((b) => b.classList.toggle('active', b.dataset.type === currentType));
}
function setFormType(type) {
  currentType = type;
  const isTransfer = type === 'transfer';
  syncTypeToggle();
  $('categoryField').hidden = isTransfer;
  $('walletToField').hidden = !isTransfer;
  $('walletLabel').textContent = isTransfer ? 'Dari dompet' : 'Dompet';
  $('saveTplBtn').hidden = isTransfer || !!editId;
  if (!isTransfer) fillCategories(type);
}
function updatePhotoPreview() {
  $('photoPreviewWrap').hidden = !pendingPhoto;
  $('photoBtn').hidden = !!pendingPhoto;
  $('photoPreview').src = pendingPhoto || '';
}
function renderTplChips() {
  const row = $('tplRow');
  const list = settings.templates || [];
  row.hidden = !!editId || !list.length;
  row.innerHTML = list.map((t) => {
    const info = catInfo(t.type, t.category);
    return `<button type="button" class="tpl-chip" data-id="${t.id}">${info.emoji} ${escapeHtml(t.name)} · ${formatRpShort(t.amount)}</button>`;
  }).join('');
}
function openForm(tx = null) {
  editId = tx ? tx.id : null;
  $('formTitle').textContent = tx ? 'Edit Transaksi' : 'Tambah Transaksi';
  setFormType(tx ? tx.type : 'expense');
  setAmountVal($('amount'), tx ? tx.amount : 0);
  if (tx && tx.type !== 'transfer') $('category').value = tx.category;
  $('wallet').value = tx?.wallet || 'tunai';
  $('walletTo').value = tx?.walletTo || (($('wallet').value === 'bank') ? 'tunai' : 'bank');
  $('date').value = tx ? tx.date : todayISO();
  $('note').value = tx ? tx.note || '' : '';
  pendingPhoto = tx?.photo || '';
  updatePhotoPreview();
  renderTplChips();
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('amount').focus(), 250);
}
function closeForm() {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  $('txForm').reset();
  pendingPhoto = '';
  editId = null;
}

$('fab').addEventListener('click', () => openForm());
$('cancelBtn').addEventListener('click', closeForm);

document.querySelectorAll('#txForm .type-opt').forEach((btn) => {
  btn.addEventListener('click', () => setFormType(btn.dataset.type));
});

attachAmountFormat($('amount'));

// Terapkan template saat chip ditekan
$('tplRow').addEventListener('click', (e) => {
  const chip = e.target.closest('.tpl-chip');
  if (!chip) return;
  const tpl = (settings.templates || []).find((t) => t.id === chip.dataset.id);
  if (!tpl) return;
  setFormType(tpl.type);
  setAmountVal($('amount'), tpl.amount);
  $('category').value = tpl.category;
  $('note').value = tpl.note || '';
  $('wallet').value = tpl.wallet || 'tunai';
});

// Simpan isian form sebagai template cepat
$('saveTplBtn').addEventListener('click', () => {
  const amount = amountVal($('amount'));
  if (!amount) { $('amount').focus(); return; }
  const note = $('note').value.trim();
  const name = note || catInfo(currentType, $('category').value).label;
  settings.templates = settings.templates || [];
  settings.templates.push({
    id: uid(), name, type: currentType, category: $('category').value,
    amount, note, wallet: $('wallet').value,
  });
  saveSettings();
  renderTplChips();
  const btn = $('saveTplBtn');
  btn.textContent = '✓ Template tersimpan';
  setTimeout(() => { btn.textContent = '☆ Simpan sebagai template'; }, 1600);
});

// ---- Foto struk (dikompres agar muat di dokumen Firestore) ----
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 800;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      let q = 0.6;
      let out = canvas.toDataURL('image/jpeg', q);
      while (out.length > 400_000 && q > 0.25) {
        q -= 0.15;
        out = canvas.toDataURL('image/jpeg', q);
      }
      if (out.length > 700_000) reject(new Error('Foto terlalu besar'));
      else resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gagal membaca gambar')); };
    img.src = url;
  });
}
$('photoBtn').addEventListener('click', () => $('photoInput').click());
$('photoInput').addEventListener('change', async () => {
  const file = $('photoInput').files[0];
  $('photoInput').value = '';
  if (!file) return;
  try {
    pendingPhoto = await compressImage(file);
    updatePhotoPreview();
  } catch {
    toast('Foto tidak dapat dilampirkan (terlalu besar atau format tidak didukung).', { type: 'error' });
  }
});
$('removePhotoBtn').addEventListener('click', () => { pendingPhoto = ''; updatePhotoPreview(); });
$('photoPreview').addEventListener('click', () => {
  $('photoViewerImg').src = pendingPhoto;
  $('photoViewer').hidden = false;
});
$('photoViewer').addEventListener('click', () => { $('photoViewer').hidden = true; });

$('txForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = amountVal($('amount'));
  if (!amount || amount <= 0) { $('amount').focus(); return; }
  const isTransfer = currentType === 'transfer';
  if (isTransfer && $('wallet').value === $('walletTo').value) {
    toast('Dompet asal dan tujuan tidak boleh sama.', { type: 'error' });
    return;
  }
  const data = {
    type: currentType, amount,
    category: isTransfer ? '' : $('category').value,
    date: $('date').value, note: $('note').value.trim(),
    wallet: $('wallet').value,
    walletTo: isTransfer ? $('walletTo').value : '',
    photo: pendingPhoto || '',
  };
  let savedTx;
  if (editId) {
    const idx = transactions.findIndex((t) => t.id === editId);
    if (idx !== -1) transactions[idx] = { ...transactions[idx], ...data };
    savedTx = transactions[idx];
  } else {
    savedTx = { id: uid(), createdAt: Date.now(), ...data };
    transactions.push(savedTx);
  }
  const wasEdit = !!editId;
  save();
  syncUpsertTx(savedTx);
  selectedMonth = data.date.slice(0, 7);
  render();
  closeForm();
  haptic();
  toast(wasEdit ? 'Transaksi diperbarui.' : 'Transaksi tersimpan.');
});

// Hapus transaksi dengan UNDO (tanpa dialog — langsung + toast pembatalan)
function deleteTx(id) {
  const idx = transactions.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const removed = transactions[idx];
  const pos = idx;
  transactions = transactions.filter((t) => t.id !== id);
  save(); render();
  syncDeleteTx(id);
  haptic();
  toast('Transaksi dihapus.', {
    type: 'info',
    action: {
      label: 'Urungkan',
      onClick: () => {
        transactions.splice(Math.min(pos, transactions.length), 0, removed);
        save(); render();
        syncUpsertTx(removed);
        toast('Transaksi dikembalikan.');
      },
    },
  });
}
$('txList').addEventListener('click', (e) => {
  const btn = e.target.closest('.tx-del');
  if (!btn) return;
  deleteTx(btn.dataset.id);
});

$('monthPicker').addEventListener('change', () => { selectedMonth = $('monthPicker').value || ymNow(); render(); });
$('prevMonthBtn').addEventListener('click', () => { selectedMonth = shiftMonth(selectedMonth, -1); render(); });
$('nextMonthBtn').addEventListener('click', () => { selectedMonth = shiftMonth(selectedMonth, 1); render(); });

/* ============================================================
   6. ANGGARAN PER KATEGORI
   ============================================================ */
function budgetBarClass(pct) { return pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok'; }

function renderBudget(monthly) {
  const list = monthly || monthTxs();
  $('budgetMonthLabel').textContent = monthName(selectedMonth);

  const spent = {};
  for (const t of list) if (t.type === 'expense') spent[t.category] = (spent[t.category] || 0) + t.amount;
  const budgets = settings.budgets || {};

  const rows = [];
  let totB = 0, totS = 0;
  for (const c of CATEGORIES.expense) {
    const b = budgets[c.id] || 0;
    const s = spent[c.id] || 0;
    if (!b && !s) continue;
    if (b) { totB += b; totS += s; }
    rows.push({ ...c, b, s });
  }
  rows.sort((a, x) => (x.b ? x.s / x.b : -1) - (a.b ? a.s / a.b : -1) || x.s - a.s);

  const anyBudget = Object.values(budgets).some((v) => v > 0);
  $('budgetSummaryCard').hidden = !anyBudget;
  $('budgetEmpty').hidden = anyBudget || rows.length > 0;

  if (anyBudget) {
    const pct = totB > 0 ? (totS / totB) * 100 : 0;
    $('bgTotalSpent').textContent = formatRp(totS);
    $('bgTotalBudget').textContent = formatRp(totB);
    const bar = $('bgTotalBar');
    bar.style.width = Math.min(100, pct) + '%';
    bar.className = budgetBarClass(pct);
    $('bgTotalNote').textContent = totS <= totB
      ? `Sisa ${formatRp(totB - totS)} (${Math.round(pct)}% terpakai)`
      : `Melebihi anggaran ${formatRp(totS - totB)}!`;
  }

  $('budgetList').innerHTML = rows.map((r) => {
    const pct = r.b > 0 ? (r.s / r.b) * 100 : 0;
    const status = r.b
      ? (r.s <= r.b ? `sisa ${formatRp(r.b - r.s)}` : `lebih ${formatRp(r.s - r.b)}!`)
      : 'tanpa anggaran';
    return `<li class="budget-row">
      <div class="budget-row-top">
        <span class="budget-name">${r.emoji} ${r.label}</span>
        <span class="budget-amt">${formatRpShort(r.s)}${r.b ? ` / ${formatRpShort(r.b)}` : ''}</span>
      </div>
      <div class="budget-bar">${r.b ? `<i class="${budgetBarClass(pct)}" style="width:${Math.min(100, pct)}%"></i>` : ''}</div>
      <p class="budget-status ${r.b && r.s > r.b ? 'over-text' : ''}">${status}</p>
    </li>`;
  }).join('');
}

// Modal atur anggaran
function openBudgetModal() {
  const budgets = settings.budgets || {};
  $('budgetFields').innerHTML = CATEGORIES.expense.map((c) => `
    <label class="field">
      <span>${c.emoji} ${c.label}</span>
      <div class="amount-input"><span class="prefix">Rp</span>
        <input type="text" class="bg-input" data-cat="${c.id}" inputmode="numeric" placeholder="0" autocomplete="off"
          value="${budgets[c.id] ? Number(budgets[c.id]).toLocaleString('id-ID') : ''}" />
      </div>
    </label>`).join('');
  $('budgetFields').querySelectorAll('.bg-input').forEach(attachAmountFormat);
  $('budgetModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeBudgetModal() {
  $('budgetModal').hidden = true;
  document.body.style.overflow = '';
}
$('editBudgetBtn').addEventListener('click', openBudgetModal);
$('budgetCancel').addEventListener('click', closeBudgetModal);
$('budgetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const budgets = {};
  $('budgetFields').querySelectorAll('.bg-input').forEach((inp) => {
    const v = amountVal(inp);
    if (v > 0) budgets[inp.dataset.cat] = v;
  });
  settings.budgets = budgets;
  saveSettings();
  closeBudgetModal();
  renderBudget();
  haptic();
  toast('Anggaran tersimpan.');
});

/* ============================================================
   7. LAINNYA: DOMPET, TARGET, BERULANG, TEMPLATE, PENGINGAT
   ============================================================ */
function walletBalances() {
  const bal = {};
  for (const w of WALLETS) bal[w.id] = 0;
  for (const t of transactions) {
    const w = t.wallet || 'tunai';
    if (t.type === 'income') bal[w] = (bal[w] || 0) + t.amount;
    else if (t.type === 'expense') bal[w] = (bal[w] || 0) - t.amount;
    else if (t.type === 'transfer') {
      bal[w] = (bal[w] || 0) - t.amount;
      const w2 = t.walletTo || 'tunai';
      bal[w2] = (bal[w2] || 0) + t.amount;
    }
  }
  return bal;
}

function renderMore() {
  // --- Dompet ---
  const bal = walletBalances();
  const total = WALLETS.reduce((s, w) => s + (bal[w.id] || 0), 0);
  $('walletList').innerHTML = WALLETS.map((w) => `
    <li class="m-row">
      <span class="m-emoji">${w.emoji}</span>
      <span class="m-name">${w.label}</span>
      <span class="m-amt ${bal[w.id] < 0 ? 'neg' : ''}">${formatRp(bal[w.id] || 0)}</span>
    </li>`).join('')
    + `<li class="m-row m-row-total">
      <span class="m-emoji">Σ</span>
      <span class="m-name">Total</span>
      <span class="m-amt ${total < 0 ? 'neg' : ''}">${formatRp(total)}</span>
    </li>`;

  // --- Target tabungan ---
  const goals = settings.goals || [];
  $('goalEmpty').hidden = goals.length > 0;
  $('goalList').innerHTML = goals.map((g) => {
    const pct = g.target > 0 ? Math.min(100, (g.saved / g.target) * 100) : 0;
    const done = g.saved >= g.target && g.target > 0;
    return `<li class="m-row m-row-col goal-row" data-id="${g.id}">
      <div class="budget-row-top">
        <span class="m-name">${done ? '🎉' : '🎯'} ${escapeHtml(g.name)}</span>
        <button type="button" class="chip-btn g-add" data-id="${g.id}">＋ Dana</button>
      </div>
      <div class="budget-bar"><i class="${done ? 'ok' : 'goal'}" style="width:${pct}%"></i></div>
      <p class="budget-status">${formatRp(g.saved)} dari ${formatRp(g.target)} (${Math.round(pct)}%)</p>
    </li>`;
  }).join('');

  // --- Transaksi berulang ---
  const recs = settings.recurring || [];
  $('recEmpty').hidden = recs.length > 0;
  $('recList').innerHTML = recs.map((r) => {
    const info = catInfo(r.type, r.category);
    return `<li class="m-row rec-row" data-id="${r.id}">
      <span class="m-emoji">${info.emoji}</span>
      <span class="m-name">${escapeHtml(r.note || info.label)}
        <small>tiap tgl ${r.day} · ${walletInfo(r.wallet).label}</small></span>
      <span class="m-amt ${r.type}">${r.type === 'income' ? '+' : '−'} ${formatRpShort(r.amount)}</span>
    </li>`;
  }).join('');

  // --- Template cepat ---
  const tpls = settings.templates || [];
  $('tplEmpty').hidden = tpls.length > 0;
  $('tplList').innerHTML = tpls.map((t) => {
    const info = catInfo(t.type, t.category);
    return `<li class="m-row">
      <span class="m-emoji">${info.emoji}</span>
      <span class="m-name">${escapeHtml(t.name)}<small>${info.label} · ${walletInfo(t.wallet).label}</small></span>
      <span class="m-amt">${formatRpShort(t.amount)}</span>
      <button type="button" class="row-del" data-id="${t.id}" aria-label="Hapus template">✕</button>
    </li>`;
  }).join('');

  // --- Pengingat ---
  $('remEnabled').checked = !!settings.reminder?.enabled;
  $('remTime').value = settings.reminder?.time || '20:00';

  // --- Laporan (nilai default & pilihan tahun) ---
  if (!$('repFrom').value) $('repFrom').value = `${selectedMonth}-01`;
  if (!$('repTo').value) $('repTo').value = todayISO();
  fillYears();
}

// --- Target tabungan: modal + tambah dana ---
function openGoalModal(goal = null) {
  editGoalId = goal ? goal.id : null;
  $('goalTitle').textContent = goal ? 'Edit Target' : 'Tambah Target';
  $('goalName').value = goal ? goal.name : '';
  setAmountVal($('goalTarget'), goal ? goal.target : 0);
  setAmountVal($('goalSaved'), goal ? goal.saved : 0);
  $('goalDeleteBtn').hidden = !goal;
  $('goalModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeGoalModal() {
  $('goalModal').hidden = true;
  document.body.style.overflow = '';
  editGoalId = null;
}
$('addGoalBtn').addEventListener('click', () => openGoalModal());
$('goalCancel').addEventListener('click', closeGoalModal);
attachAmountFormat($('goalTarget'));
attachAmountFormat($('goalSaved'));
$('goalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('goalName').value.trim();
  const target = amountVal($('goalTarget'));
  const saved = amountVal($('goalSaved'));
  if (!name || !target) { toast('Isi nama & target.', { type: 'error' }); return; }
  settings.goals = settings.goals || [];
  const wasEdit = !!editGoalId;
  if (editGoalId) {
    const g = settings.goals.find((x) => x.id === editGoalId);
    if (g) { g.name = name; g.target = target; g.saved = saved; }
  } else {
    settings.goals.push({ id: uid(), name, target, saved });
  }
  saveSettings();
  closeGoalModal();
  renderMore();
  haptic();
  toast(wasEdit ? 'Target diperbarui.' : 'Target dibuat.');
});
$('goalDeleteBtn').addEventListener('click', async () => {
  if (!editGoalId) return;
  const gid = editGoalId;
  if (!await confirmDialog('Hapus target ini?', 'Riwayat dana yang sudah dikumpulkan akan hilang.')) return;
  settings.goals = settings.goals.filter((g) => g.id !== gid);
  saveSettings();
  closeGoalModal();
  renderMore();
  toast('Target dihapus.', { type: 'info' });
});
$('goalList').addEventListener('click', async (e) => {
  const add = e.target.closest('.g-add');
  if (add) {
    const g = settings.goals.find((x) => x.id === add.dataset.id);
    if (!g) return;
    const v = await openDialog({
      title: 'Tambah Dana', body: `Untuk "${g.name}"`, icon: '💰', danger: false,
      confirmText: 'Tambah', input: { prefix: 'Rp', placeholder: '0' },
    });
    if (v === null) return;
    const n = Number(String(v).replace(/\D/g, ''));
    if (n > 0) {
      g.saved += n; saveSettings(); renderMore(); haptic();
      const done = g.saved >= g.target && g.target > 0;
      toast(done ? `🎉 Target "${g.name}" tercapai!` : `+${formatRp(n)} ke "${g.name}".`);
    }
    return;
  }
  const row = e.target.closest('.goal-row');
  if (row) openGoalModal(settings.goals.find((x) => x.id === row.dataset.id));
});

// --- Transaksi berulang: modal + mesin posting otomatis ---
function fillRecCats() {
  const type = $('recType').value;
  $('recCat').innerHTML = CATEGORIES[type].map((c) => `<option value="${c.id}">${c.emoji} ${c.label}</option>`).join('');
}
function openRecModal(rule = null) {
  editRecId = rule ? rule.id : null;
  $('recTitle').textContent = rule ? 'Edit Transaksi Berulang' : 'Tambah Transaksi Berulang';
  $('recType').value = rule ? rule.type : 'expense';
  fillRecCats();
  if (rule) $('recCat').value = rule.category;
  setAmountVal($('recAmount'), rule ? rule.amount : 0);
  $('recDay').value = rule ? rule.day : 1;
  $('recWallet').value = rule ? rule.wallet || 'tunai' : 'tunai';
  $('recNote').value = rule ? rule.note || '' : '';
  $('recDeleteBtn').hidden = !rule;
  $('recModal').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeRecModal() {
  $('recModal').hidden = true;
  document.body.style.overflow = '';
  editRecId = null;
}
$('addRecBtn').addEventListener('click', () => openRecModal());
$('recCancel').addEventListener('click', closeRecModal);
$('recType').addEventListener('change', fillRecCats);
attachAmountFormat($('recAmount'));
$('recForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = amountVal($('recAmount'));
  const day = Math.min(31, Math.max(1, Number($('recDay').value) || 1));
  if (!amount) { $('recAmount').focus(); return; }
  settings.recurring = settings.recurring || [];
  const wasEdit = !!editRecId;
  if (editRecId) {
    const r = settings.recurring.find((x) => x.id === editRecId);
    if (r) {
      Object.assign(r, {
        type: $('recType').value, category: $('recCat').value, amount, day,
        wallet: $('recWallet').value, note: $('recNote').value.trim(),
      });
    }
  } else {
    settings.recurring.push({
      id: uid(), type: $('recType').value, category: $('recCat').value, amount, day,
      wallet: $('recWallet').value, note: $('recNote').value.trim(),
      start: ymNow(), lastPosted: '',
    });
  }
  saveSettings();
  closeRecModal();
  applyRecurring();
  renderMore();
  haptic();
  toast(wasEdit ? 'Jadwal diperbarui.' : 'Jadwal berulang dibuat.');
});
$('recDeleteBtn').addEventListener('click', async () => {
  if (!editRecId) return;
  const rid = editRecId;
  if (!await confirmDialog('Hapus jadwal berulang ini?', 'Transaksi yang sudah tercatat tidak ikut terhapus.')) return;
  settings.recurring = settings.recurring.filter((r) => r.id !== rid);
  saveSettings();
  closeRecModal();
  renderMore();
  toast('Jadwal berulang dihapus.', { type: 'info' });
});
$('recList').addEventListener('click', (e) => {
  const row = e.target.closest('.rec-row');
  if (row) openRecModal(settings.recurring.find((r) => r.id === row.dataset.id));
});

// Catat otomatis semua jadwal berulang yang sudah jatuh tempo.
// ID transaksi deterministik (rec-{rule}-{bulan}) agar tidak dobel antar perangkat.
function applyRecurring() {
  if (!currentRoom || !(settings.recurring || []).length) return;
  const today = todayISO();
  let changed = false;
  for (const r of settings.recurring) {
    let ym = r.lastPosted ? shiftMonth(r.lastPosted, 1) : (r.start || ymNow());
    let guard = 0;
    while (ym <= ymNow() && guard++ < 24) {
      const [y, m] = ym.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const date = `${ym}-${pad2(Math.min(r.day, daysInMonth))}`;
      if (date > today) break; // belum jatuh tempo bulan ini
      const id = `rec-${r.id}-${ym}`;
      if (!transactions.some((t) => t.id === id)) {
        const tx = {
          id, createdAt: Date.now(), type: r.type, amount: r.amount,
          category: r.category, date, note: r.note || catInfo(r.type, r.category).label,
          wallet: r.wallet || 'tunai', walletTo: '', photo: '',
        };
        transactions.push(tx);
        syncUpsertTx(tx);
      }
      r.lastPosted = ym;
      changed = true;
      ym = shiftMonth(ym, 1);
    }
  }
  if (changed) { save(); saveSettings(); render(); }
}

// --- Template cepat: hapus dari daftar ---
$('tplList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-del');
  if (!btn) return;
  const tid = btn.dataset.id;
  if (!await confirmDialog('Hapus template ini?')) return;
  settings.templates = settings.templates.filter((t) => t.id !== tid);
  saveSettings();
  renderMore();
  toast('Template dihapus.', { type: 'info' });
});

// --- Transfer antar dompet (buka form dalam mode transfer) ---
$('transferBtn').addEventListener('click', () => { openForm(); setFormType('transfer'); });

// --- Pengingat harian (hanya saat aplikasi terbuka — batasan PWA tanpa server push) ---
$('remEnabled').addEventListener('change', async () => {
  const on = $('remEnabled').checked;
  if (on) {
    if (!('Notification' in window)) {
      toast('Browser ini tidak mendukung notifikasi.', { type: 'error' });
      $('remEnabled').checked = false;
      return;
    }
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast('Izin notifikasi ditolak. Aktifkan lewat pengaturan browser.', { type: 'error' });
        $('remEnabled').checked = false;
        return;
      }
    }
  }
  settings.reminder = { enabled: $('remEnabled').checked, time: $('remTime').value || '20:00' };
  saveSettings();
});
$('remTime').addEventListener('change', () => {
  settings.reminder = { enabled: $('remEnabled').checked, time: $('remTime').value || '20:00' };
  saveSettings();
});

function checkReminder() {
  const r = settings.reminder;
  if (!r?.enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  if (hhmm < (r.time || '20:00')) return;
  const today = todayISO();
  if (localStorage.getItem('catatan-reminder-last') === today) return;
  localStorage.setItem('catatan-reminder-last', today);
  const opts = { body: 'Jangan lupa catat transaksi hari ini 📝', icon: 'icons/icon-192.png', tag: 'catatan-harian' };
  if (navigator.serviceWorker) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification('Catatan Keuangan', opts))
      .catch(() => { try { new Notification('Catatan Keuangan', opts); } catch { /* abaikan */ } });
  } else {
    try { new Notification('Catatan Keuangan', opts); } catch { /* abaikan */ }
  }
}

/* ============================================================
   8. LAPORAN (rentang bebas + tahunan)
   ============================================================ */
function rangeReportHtml(list) {
  let inc = 0, exp = 0;
  const byCat = {};
  for (const t of list) {
    if (t.type === 'income') inc += t.amount;
    else if (t.type === 'expense') {
      exp += t.amount;
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    }
  }
  const net = inc - exp;
  const cats = Object.entries(byCat)
    .map(([id, amount]) => ({ id, amount, ...catInfo('expense', id), color: CAT_COLORS[id] || 'var(--cat-8)' }))
    .sort((a, b) => b.amount - a.amount);

  const catHtml = cats.length ? `<ul class="cat-legend" style="margin-top:14px">${cats.map((c) => {
    const pct = exp > 0 ? Math.round((c.amount / exp) * 100) : 0;
    return `<li>
      <span class="lg-swatch" style="background:${c.color}"></span>
      <span class="lg-name">${c.emoji} ${c.label}</span>
      <span class="lg-bar"><i style="width:${pct}%;background:${c.color}"></i></span>
      <span class="lg-amt">${formatRpShort(c.amount)}</span>
      <span class="lg-pct">${pct}%</span>
    </li>`;
  }).join('')}</ul>` : '';

  return `
    <div class="rep-stats">
      <div><p class="stat-label">Pemasukan</p><p class="rep-val" style="color:var(--income)">${formatRp(inc)}</p></div>
      <div><p class="stat-label">Pengeluaran</p><p class="rep-val" style="color:var(--expense)">${formatRp(exp)}</p></div>
      <div><p class="stat-label">Selisih</p><p class="rep-val">${formatRp(net)}</p></div>
    </div>
    <p class="hint">${list.length} transaksi dalam rentang ini.</p>
    ${catHtml}`;
}

$('repRunBtn').addEventListener('click', () => {
  const from = $('repFrom').value, to = $('repTo').value;
  if (!from || !to) { toast('Isi tanggal Dari dan Sampai.', { type: 'error' }); return; }
  if (from > to) { toast('Tanggal "Dari" harus sebelum "Sampai".', { type: 'error' }); return; }
  const list = transactions.filter((t) => t.date >= from && t.date <= to);
  $('repResult').innerHTML = rangeReportHtml(list);
});

function fillYears() {
  const sel = $('repYear');
  const years = new Set(transactions.map((t) => t.date.slice(0, 4)));
  years.add(String(new Date().getFullYear()));
  const sorted = [...years].sort().reverse();
  const current = sel.value;
  sel.innerHTML = sorted.map((y) => `<option value="${y}">${y}</option>`).join('');
  sel.value = sorted.includes(current) ? current : sorted[0];
  renderYearReport();
}
function renderYearReport() {
  const year = $('repYear').value;
  if (!year) { $('repYearResult').innerHTML = ''; return; }
  let rows = '', totInc = 0, totExp = 0;
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${pad2(m)}`;
    let inc = 0, exp = 0;
    for (const t of transactions) {
      if (!t.date.startsWith(ym)) continue;
      if (t.type === 'income') inc += t.amount;
      else if (t.type === 'expense') exp += t.amount;
    }
    totInc += inc; totExp += exp;
    if (!inc && !exp) continue;
    rows += `<tr><td>${monthShort(ym)}</td>
      <td class="num" style="color:var(--income)">${formatRpShort(inc)}</td>
      <td class="num" style="color:var(--expense)">${formatRpShort(exp)}</td>
      <td class="num">${formatRpShort(inc - exp)}</td></tr>`;
  }
  $('repYearResult').innerHTML = rows
    ? `<div class="table-wrap"><table class="rep-table">
        <thead><tr><th>Bulan</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Selisih</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Total</th>
          <th class="num">${formatRpShort(totInc)}</th>
          <th class="num">${formatRpShort(totExp)}</th>
          <th class="num">${formatRpShort(totInc - totExp)}</th></tr></tfoot>
      </table></div>`
    : `<p class="mini-empty">Belum ada data di tahun ${year}.</p>`;
}
$('repYear').addEventListener('change', renderYearReport);

/* ============================================================
   9. EKSPOR CSV, BACKUP & PULIHKAN
   ============================================================ */
function typeLabel(t) {
  return t === 'income' ? 'Pemasukan' : t === 'expense' ? 'Pengeluaran' : 'Transfer';
}
function exportCsv(scope) {
  const list = (scope === 'month' ? monthTxs() : [...transactions]).sort((a, b) => (a.date > b.date ? 1 : -1));
  if (!list.length) { toast('Tidak ada transaksi untuk diekspor.', { type: 'error' }); return; }
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Tanggal', 'Jenis', 'Kategori', 'Dompet', 'Jumlah', 'Catatan'].map(esc).join(';')];
  for (const t of list) {
    const isTr = t.type === 'transfer';
    rows.push([
      t.date,
      typeLabel(t.type),
      isTr ? 'Transfer' : catInfo(t.type, t.category).label,
      isTr ? `${walletInfo(t.wallet).label} → ${walletInfo(t.walletTo).label}` : walletInfo(t.wallet || 'tunai').label,
      t.amount,
      t.note || '',
    ].map(esc).join(';'));
  }
  const name = `catatan-keuangan-${scope === 'month' ? selectedMonth : 'semua'}.csv`;
  download(name, '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
  toast(`${list.length} transaksi diekspor ke CSV.`);
}
$('expCsvMonthBtn').addEventListener('click', () => exportCsv('month'));
$('expCsvAllBtn').addEventListener('click', () => exportCsv('all'));

$('backupBtn').addEventListener('click', () => {
  const payload = {
    app: 'catatan-keuangan', version: 1, exportedAt: new Date().toISOString(),
    transactions, settings,
  };
  download(`catatan-keuangan-backup-${todayISO()}.json`, JSON.stringify(payload), 'application/json');
  toast('Backup JSON diunduh.');
});

$('restoreBtn').addEventListener('click', () => $('restoreInput').click());
$('restoreInput').addEventListener('change', () => {
  const file = $('restoreInput').files[0];
  $('restoreInput').value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { toast('File backup tidak valid.', { type: 'error' }); return; }
    if (!Array.isArray(data.transactions)) { toast('File backup tidak valid.', { type: 'error' }); return; }
    const valid = data.transactions.filter((t) => t && t.id && t.date && t.amount > 0 && t.type);
    if (!valid.length) { toast('Tidak ada transaksi valid di backup.', { type: 'error' }); return; }
    if (!await confirmDialog(
      `Pulihkan ${valid.length} transaksi?`,
      'Data digabung dengan data sekarang (tidak menghapus apa pun).',
      { icon: '♻', danger: false, confirmText: 'Pulihkan' },
    )) return;

    const map = new Map(transactions.map((t) => [t.id, t]));
    for (const t of valid) map.set(t.id, { ...t });
    transactions = [...map.values()];
    save();
    await batchUpsert(valid);

    if (data.settings && await confirmDialog(
      'Pulihkan pengaturan juga?',
      'Anggaran, target, jadwal, dan template dari backup akan diterapkan.',
      { icon: '⚙️', danger: false, confirmText: 'Ya, pulihkan' },
    )) {
      const def = DEFAULT_SETTINGS();
      settings = { ...def, ...data.settings, reminder: { ...def.reminder, ...(data.settings.reminder || {}) } };
      saveSettings();
    }
    render();
    haptic();
    toast('Backup berhasil dipulihkan.');
  };
  reader.readAsText(file);
});

/* ============================================================
   10. SINKRONISASI CLOUD (Firestore per Kode Ruang)
   ============================================================ */
function setSyncStatus(text) { $('syncStatus').textContent = text; }

function txDocRef(room, id) { return doc(db, 'rooms', room, 'transactions', id); }
function settingsDocRef(room) { return doc(db, 'rooms', room, 'meta', 'settings'); }

function txToDoc(tx) {
  return {
    type: tx.type, amount: tx.amount, category: tx.category || '',
    date: tx.date, note: tx.note || '', createdAt: tx.createdAt || Date.now(),
    wallet: tx.wallet || 'tunai', walletTo: tx.walletTo || '', photo: tx.photo || '',
  };
}

async function syncUpsertTx(tx) {
  if (!currentRoom || !authReady) return;
  try {
    await setDoc(txDocRef(currentRoom, tx.id), txToDoc(tx));
  } catch { /* offline: Firestore SDK meng-queue otomatis (persistentLocalCache) */ }
}

async function syncDeleteTx(id) {
  if (!currentRoom || !authReady) return;
  try { await deleteDoc(txDocRef(currentRoom, id)); } catch { /* akan di-retry otomatis saat online */ }
}

async function syncSettings() {
  if (!currentRoom || !authReady) return;
  try { await setDoc(settingsDocRef(currentRoom), settings); } catch { /* offline: queued */ }
}

async function batchUpsert(list) {
  if (!currentRoom || !authReady || !list.length) return;
  try {
    for (let i = 0; i < list.length; i += 500) {
      const batch = writeBatch(db);
      for (const tx of list.slice(i, i + 500)) batch.set(txDocRef(currentRoom, tx.id), txToDoc(tx));
      await batch.commit();
    }
  } catch { /* offline: queued */ }
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
  for (let i = 0; i < transactions.length; i += 500) {
    const batch = writeBatch(db);
    for (const tx of transactions.slice(i, i + 500)) batch.set(txDocRef(room, tx.id), txToDoc(tx));
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

  // Pengaturan bersama (anggaran, target, jadwal, template, pengingat)
  unsubscribeSettings = onSnapshot(settingsDocRef(room), (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    if (!snap.exists()) {
      // Ruang belum punya pengaturan → unggah milik lokal (jika ada)
      if (settings.updatedAt) syncSettings();
      return;
    }
    const d = snap.data();
    if ((d.updatedAt || 0) > (settings.updatedAt || 0)) {
      const def = DEFAULT_SETTINGS();
      settings = { ...def, ...d, reminder: { ...def.reminder, ...(d.reminder || {}) } };
      persistSettingsLocal();
      applyRecurring();
      render();
    }
  }, () => { /* abaikan */ });
}

function stopRemoteSync() {
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
  if (unsubscribeSettings) { unsubscribeSettings(); unsubscribeSettings = null; }
}

async function signOut() {
  if (!await confirmDialog(
    'Keluar dari aplikasi?',
    'Data tetap aman di cloud. Anda perlu login lagi untuk masuk kembali.',
    { icon: '🚪', danger: false, confirmText: 'Keluar' },
  )) return;
  stopRemoteSync();
  migrationChecked = false;
  currentRoom = null;
  localStorage.removeItem('catatan-logged-in');
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem('catatan-reminder-last');
  transactions = [];
  settings = DEFAULT_SETTINGS();
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
   11. INIT
   ============================================================ */
populateFilterCat();
fillWalletSelect($('wallet'));
fillWalletSelect($('walletTo'));
fillWalletSelect($('recWallet'));

// Escape menutup modal teratas; klik backdrop menutup modal terkait
const MODAL_CLOSERS = {
  modal: closeForm, budgetModal: closeBudgetModal, goalModal: closeGoalModal, recModal: closeRecModal,
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('photoViewer').hidden) { $('photoViewer').hidden = true; return; }
  if (!$('dialogModal').hidden) { closeDialog(null); return; } // dialog selalu teratas
  for (const [id, close] of Object.entries(MODAL_CLOSERS)) {
    if (!$(id).hidden) { close(); return; }
  }
});
for (const [id, close] of Object.entries(MODAL_CLOSERS)) {
  $(id).querySelector('.modal-backdrop').addEventListener('click', close);
}
$('dialogModal').querySelector('.modal-backdrop').addEventListener('click', () => closeDialog(null));

// Jika sudah pernah login di perangkat ini, buka langsung tanpa login ulang.
(function autoEnter() {
  if (localStorage.getItem('catatan-logged-in') === '1') {
    enterRoom();
  }
})();

// Pemeriksa berkala: jadwal berulang jatuh tempo + pengingat harian
setInterval(() => { applyRecurring(); checkReminder(); }, 60_000);
checkReminder();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW gagal:', err));
  });
}
