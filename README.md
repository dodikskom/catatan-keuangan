# Catatan Keuangan — PWA

Aplikasi web untuk mencatat **pendapatan** dan **pengeluaran** pribadi.
Bisa dipasang di HP seperti aplikasi biasa dan berfungsi **offline**.

## Fitur
- **Login** username/password + Kode Ruang bersama (tersembunyi) — semua
  perangkat yang login berbagi data yang sama secara real-time via Firestore
- **Dashboard** informatif: rata-rata pengeluaran/hari, tingkat menabung,
  pengeluaran terbesar, grafik donut per kategori, dan tren 6 bulan
- **Anggaran per kategori** — batas belanja bulanan dengan progress bar dan
  peringatan saat mendekati/melebihi batas (tab Anggaran)
- **Pencarian & filter** — cari catatan/kategori di seluruh riwayat, filter
  per kategori atau transfer
- **Multi-dompet** (Tunai, Bank, E-Wallet) + **transfer antar dompet**;
  saldo per dompet di tab Lainnya
- **Transaksi berulang** — gaji/tagihan/cicilan otomatis tercatat tiap bulan
  pada tanggal yang ditentukan (ID deterministik, aman antar perangkat)
- **Target tabungan** — buat target, tambah dana, pantau progresnya
- **Template cepat** — simpan isian form sebagai template satu-tap
- **Laporan** rentang tanggal bebas + ringkasan tahunan per bulan
- **Ekspor CSV** (per bulan / semua) dan **backup/pulihkan JSON**
- **Foto struk** — lampirkan foto pada transaksi (dikompres otomatis,
  ikut tersinkron ke cloud)
- **Pengingat harian** untuk mencatat (saat aplikasi terbuka)
- Catat pemasukan & pengeluaran (jumlah, kategori, tanggal, catatan)
- Ringkasan saldo, total pemasukan & pengeluaran per bulan
- Filter transaksi per bulan, dengan navigasi bulan sebelumnya/berikutnya (‹ ›)
- Tap transaksi untuk mengedit, tombol ✕ untuk menghapus
- Format Rupiah otomatis, mode gelap otomatis
- Data tersimpan di perangkat (localStorage) — tetap jalan tanpa internet,
  disinkronkan ke Firestore otomatis saat online & login. Pengaturan
  (anggaran, target, jadwal, template) ikut tersinkron di `rooms/{room}/meta`.

## Tentang login (penting)
- Login memakai username/password sederhana yang tertanam di `app.js`
  (default `admin`/`admin`) — ini kunci **kenyamanan**, bukan keamanan kuat.
- Kunci data sesungguhnya adalah **Kode Ruang** acak yang tersembunyi di
  `app.js`; siapa pun yang tahu kode itu dapat mengakses data ruang.
- Tombol keluar di kanan atas untuk keluar dari aplikasi kapan saja.

## Menjalankan di komputer (lokal)
Service worker butuh `http://localhost` (tidak bisa dari `file://`).
Pilih salah satu:

```bash
# Python (sudah ada di komputer ini)
python -m http.server 8000

# atau Node
npx serve
```

Lalu buka http://localhost:8000

## Memasang di HP
1. Deploy ke internet (lihat di bawah) — PWA butuh **HTTPS**.
2. Buka URL-nya di Chrome/Safari HP.
3. Menu browser → **"Tambahkan ke Layar Utama" / "Install app"**.

## Menjadikan online (deploy gratis)
Cukup unggah folder ini (file statis, tanpa build):

- **Netlify**: drag & drop folder ke https://app.netlify.com/drop
- **Vercel**: `npx vercel` di folder ini
- **GitHub Pages**: push ke repo, aktifkan Pages
- **Cloudflare Pages**: hubungkan repo / upload folder

Semua otomatis memberi HTTPS sehingga PWA bisa di-install.

## Sinkronisasi antar perangkat (Firebase)
Data disimpan lokal (localStorage, offline-first) dan disinkronkan ke
**Firestore** setelah login dengan **Google Sign-In**. Struktur data:
`users/{uid}/transactions/{txId}` — satu dokumen per transaksi, hanya bisa
diakses oleh pemiliknya (lihat Firestore Security Rules di Firebase Console).

Saat login pertama kali di suatu akun, data lokal yang sudah ada otomatis
di-upload ke cloud (migrasi satu kali). Setelah itu, setiap perangkat yang
login dengan akun Google yang sama akan menerima update secara real-time
lewat listener `onSnapshot`. Jika offline, transaksi baru tetap tersimpan
lokal dan otomatis disinkronkan begitu koneksi kembali.

Konfigurasi Firebase ada di `firebase-config.js` (aman untuk publik — Firebase
`apiKey` bukan secret, keamanan sesungguhnya ditegakkan oleh Security Rules
di server).

## Struktur
```
index.html          # tampilan
styles.css          # gaya (mendukung mode gelap)
app.js              # logika + penyimpanan + sinkronisasi Firebase
firebase-config.js  # konfigurasi project Firebase
manifest.json       # metadata PWA
sw.js               # service worker (offline)
icons/              # ikon aplikasi
```
