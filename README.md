# Catatan Keuangan — PWA

Aplikasi web untuk mencatat **pendapatan** dan **pengeluaran** pribadi.
Bisa dipasang di HP seperti aplikasi biasa dan berfungsi **offline**.

## Fitur
- **Login PIN** 6 angka (lokal, offline) — dibuat saat pertama kali dibuka
- **Dashboard** informatif: rata-rata pengeluaran/hari, tingkat menabung,
  pengeluaran terbesar, grafik donut per kategori, dan tren 6 bulan
- Catat pemasukan & pengeluaran (jumlah, kategori, tanggal, catatan)
- Ringkasan saldo, total pemasukan & pengeluaran per bulan
- Filter transaksi per bulan
- Tap transaksi untuk mengedit, tombol ✕ untuk menghapus
- Format Rupiah otomatis, mode gelap otomatis
- Data tersimpan di perangkat (localStorage) — jalan tanpa internet

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

## Langkah berikutnya: sinkronisasi antar perangkat
Saat ini data hanya di satu perangkat. Untuk online-sync, tambahkan backend:
- **Supabase** (Postgres + Auth, gratis) — paling mudah untuk data & login
- **Firebase Firestore** — sinkron real-time

Logika penyimpanan terpusat di fungsi `load()` dan `save()` pada `app.js`,
jadi cukup ganti dua fungsi itu untuk membaca/menulis ke backend.

## Struktur
```
index.html      # tampilan
styles.css      # gaya (mendukung mode gelap)
app.js          # logika + penyimpanan
manifest.json   # metadata PWA
sw.js           # service worker (offline)
icons/          # ikon aplikasi
```
