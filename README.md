# Catatan Keuangan — PWA

Aplikasi web untuk mencatat **pendapatan** dan **pengeluaran** pribadi.
Bisa dipasang di HP seperti aplikasi biasa dan berfungsi **offline**.

## Fitur
- **Login PIN** 6 angka (lokal, offline) — dibuat saat pertama kali dibuka
- **Sinkronisasi cloud** via Google Sign-In + Firestore — data tersedia di semua
  perangkat yang login dengan akun Google yang sama, real-time
- **Dashboard** informatif: rata-rata pengeluaran/hari, tingkat menabung,
  pengeluaran terbesar, grafik donut per kategori, dan tren 6 bulan
- Catat pemasukan & pengeluaran (jumlah, kategori, tanggal, catatan)
- Ringkasan saldo, total pemasukan & pengeluaran per bulan
- Filter transaksi per bulan, dengan navigasi bulan sebelumnya/berikutnya (‹ ›)
- Tap transaksi untuk mengedit, tombol ✕ untuk menghapus
- Format Rupiah otomatis, mode gelap otomatis
- Data tersimpan di perangkat (localStorage) — tetap jalan tanpa internet,
  disinkronkan ke Firestore otomatis saat online & login

## Tentang PIN (penting)
- PIN disimpan sebagai **hash SHA-256**, bukan teks asli.
- Ini kunci **kenyamanan lokal**, bukan enkripsi data. Datanya sendiri belum
  dienkripsi, jadi lindungi perangkat Anda seperti biasa.
- **Lupa PIN?** Demi menghindari akses tak sah, PIN hanya bisa diatur ulang
  dengan **menghapus seluruh data transaksi**. Catat PIN Anda baik-baik.
- Tombol 🔒 di kanan atas untuk mengunci aplikasi kapan saja.

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
