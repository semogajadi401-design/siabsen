// api/_db.js — Shared Supabase client untuk semua API functions

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── HASH PASSWORD ──────────────────────────────────────────────────
// SEBELUMNYA: SHA-256 polos tanpa salt, tanpa cost factor — kalau database
// bocor, semua password bisa di-crack pakai rainbow table dalam hitungan
// detik. Sekarang pakai bcrypt (cost factor 10), yang punya salt otomatis
// per-password dan sengaja lambat dihitung supaya brute-force jauh lebih
// mahal.
//
// MIGRASI: akun lama masih punya hash SHA-256 (64 karakter hex) di kolom
// password. Supaya tidak perlu reset password semua orang sekaligus,
// verifyPassword() di bawah mendukung KEDUA format — kalau password cocok
// dengan hash lama, hasilnya ditandai needsRehash:true supaya pemanggil
// (lihat auth.js) bisa langsung menimpa hash itu dengan bcrypt saat itu
// juga. Lama-lama, begitu semua akun pernah login sekali, seluruh hash di
// database otomatis sudah bcrypt.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 10;

function isBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[aby]\$/.test(hash);
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_COST);
}

// Cocokkan password mentah terhadap hash tersimpan. Mendeteksi otomatis
// format hash lama (SHA-256) vs baru (bcrypt).
async function verifyPassword(password, storedHash) {
  if (!storedHash) return { valid: false, needsRehash: false };

  if (isBcryptHash(storedHash)) {
    const valid = await bcrypt.compare(String(password), storedHash);
    return { valid, needsRehash: false };
  }

  // Format lama: SHA-256 tanpa salt
  const legacyHash = crypto.createHash('sha256').update(String(password), 'utf8').digest('hex');
  const valid = legacyHash === storedHash;
  return { valid, needsRehash: valid };
}

// ── ENKRIPSI PASSWORD (REVERSIBLE) UNTUK DICETAK DI KARTU GURU ───────
// BEDA dari hashPassword() di atas: hash bcrypt itu SATU ARAH (tidak
// bisa dibalikin ke password asli) dan tetap dipakai untuk verifikasi
// login — itu tidak berubah. Fungsi di bawah ini adalah tambahan
// terpisah, khusus supaya admin bisa mencetak ulang password guru di
// kartu identitas (termasuk lewat download kartu MASSAL) kapan saja,
// tanpa guru itu harus login/reset dulu.
//
// TRADE-OFF KEAMANAN yang perlu disadari: karena ini reversible
// (AES-256-GCM, bukan hash satu arah), siapa pun yang berhasil mencuri
// SUPABASE_SERVICE_KEY / PASSWORD_ENC_KEY sekaligus isi database bisa
// membaca ulang SEMUA password guru dalam bentuk asli. Ini beda dari
// kolom `password` (bcrypt) yang tetap aman walau database bocor. Kalau
// suatu saat kebutuhan cetak password ini sudah tidak diperlukan lagi,
// sebaiknya kolom `password_enc` dihapus dan admin kembali mengandalkan
// alur reset password biasa.
//
// Kunci enkripsi diambil dari PASSWORD_ENC_KEY (disarankan diisi khusus
// di environment variable Vercel), dengan fallback ke SUPABASE_SERVICE_KEY
// supaya tetap jalan walau env var itu belum diisi -- sama pola fallback
// yang sudah dipakai generateSesiToken() di bawah.
const PASSWORD_ENC_ALGO = 'aes-256-gcm';

function getPasswordEncKey() {
  const secret = process.env.PASSWORD_ENC_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  // sha256 supaya secret apapun panjangnya selalu jadi kunci 32-byte
  // yang valid untuk aes-256-gcm.
  return crypto.createHash('sha256').update(String(secret)).digest();
}

// Hasil enkripsi disimpan sebagai satu string "iv:authTag:ciphertext"
// (semua base64) supaya muat di satu kolom TEXT tanpa perlu kolom
// tambahan lain.
function encryptPassword(plainPassword) {
  const key = getPasswordEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(PASSWORD_ENC_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainPassword), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map(b => b.toString('base64')).join(':');
}

// Mengembalikan null (bukan melempar error) kalau data rusak/format
// lama/kunci berubah -- supaya satu baris guru yang gagal didekripsi
// tidak membuat SELURUH daftar guru gagal dimuat.
function decryptPassword(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  try {
    const [ivB64, tagB64, dataB64] = encoded.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const key = getPasswordEncKey();
    const decipher = crypto.createDecipheriv(PASSWORD_ENC_ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return null;
  }
}

// ── GENERATE TOKEN QR ADMIN (acak, tidak bisa ditebak) ────
function generateQrToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ── GENERATE TOKEN QR RIWAYAT SISWA (pendek tapi tetap unik) ──
// Dulu memakai generateQrToken() yang menghasilkan 48 karakter hex.
// Digabung dengan URL (origin + "/riwayat?t=") itu membuat QR jadi
// sangat padat (versi QR tinggi) sehingga susah dibaca kamera HP,
// apalagi kartu dicetak kecil. Token base62 8 karakter di bawah ini
// punya ruang kombinasi 62^8 (~2,18 x 10^14) — jauh lebih dari cukup
// untuk jumlah siswa satu sekolah, sekaligus jauh lebih pendek supaya
// QR yang dihasilkan lebih "renggang"/tidak padat modulnya.
// Tambahan: fungsi ini mengecek ke tabel siswa supaya dijamin 100%
// tidak ada dua siswa dengan token yang sama persis (bukan cuma
// mengandalkan probabilitas kecil terjadi tabrakan).
const RIWAYAT_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const RIWAYAT_TOKEN_LENGTH = 8;

function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += RIWAYAT_TOKEN_ALPHABET[bytes[i] % RIWAYAT_TOKEN_ALPHABET.length];
  }
  return out;
}

async function generateRiwayatToken() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBase62(RIWAYAT_TOKEN_LENGTH);
    const { data } = await supabase
      .from('siswa')
      .select('id')
      .eq('riwayat_token', token)
      .maybeSingle();
    if (!data) return token; // belum dipakai siswa manapun -> aman dipakai
  }
  // Fallback ekstrem (harusnya nyaris mustahil tercapai): tambah timestamp
  // supaya tetap unik walau 5x percobaan acak beruntun bertabrakan.
  return randomBase62(RIWAYAT_TOKEN_LENGTH) + Date.now().toString(36);
}

// ── GENERATE BANYAK TOKEN RIWAYAT SEKALIGUS (untuk import massal) ──
// generateRiwayatToken() di atas melakukan 1 query SELECT ke Supabase
// PER TOKEN — kalau dipanggil 300x berurutan dalam satu loop import,
// itu 300 round-trip jaringan cuma untuk urusan token, salah satu
// penyebab utama import siswa terasa lama. Fungsi ini menggantikannya
// dengan HANYA 1 query total, tidak peduli berapa banyak token yang
// dibutuhkan:
//   1. Generate `count` token acak sekaligus di memori (tidak ke DB).
//   2. Cek sekali ke DB, token mana saja dari hasil generate itu yang
//      ternyata sudah kepakai (in-clause tunggal).
//   3. Kalau ada yang bentrok (harusnya nyaris tidak pernah terjadi —
//      ruang kombinasi 62^8), generate ulang khusus yang bentrok saja,
//      lalu cek ulang. Diulang maksimal 5x sebelum fallback timestamp.
async function generateRiwayatTokenBatch(count) {
  let tokens = new Set();
  while (tokens.size < count) tokens.add(randomBase62(RIWAYAT_TOKEN_LENGTH));

  for (let attempt = 0; attempt < 5; attempt++) {
    const arr = [...tokens];
    const { data: dipakai } = await supabase
      .from('siswa')
      .select('riwayat_token')
      .in('riwayat_token', arr);

    const setDipakai = new Set((dipakai || []).map(d => d.riwayat_token));
    if (setDipakai.size === 0) return arr; // tidak ada yang bentrok -> aman semua

    // Ganti hanya yang bentrok, sisanya tetap dipakai
    for (const t of arr) {
      if (setDipakai.has(t)) {
        tokens.delete(t);
        let baru;
        do { baru = randomBase62(RIWAYAT_TOKEN_LENGTH); } while (tokens.has(baru));
        tokens.add(baru);
      }
    }
  }
  // Fallback ekstrem: tambah timestamp+index supaya pasti unik
  return [...tokens].map((t, i) => t + Date.now().toString(36) + i);
}

// ── GENERATE TOKEN QR LOGIN GURU (pendek, sama filosofinya dengan token
// riwayat siswa di atas) ──────────────────────────────────────────
// Dipakai di QR halaman BELAKANG kartu guru untuk bypass login cepat ke
// akun guru itu sendiri (lihat api/scan.js, format QR "GURU_LOGIN|token").
// Sengaja pakai alfabet & panjang yang sama dengan riwayat_token siswa
// (bukan generateQrToken() yang 48 karakter hex seperti dipakai admin)
// supaya QR tetap renggang modulnya dan gampang discan kamera HP walau
// kartu dicetak kecil. Token dicek unik ke tabel guru sendiri (kolom
// qr_token), terpisah dari pengecekan riwayat_token milik siswa.
async function generateGuruQrToken() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBase62(RIWAYAT_TOKEN_LENGTH);
    const { data } = await supabase
      .from('guru')
      .select('id')
      .eq('qr_token', token)
      .maybeSingle();
    if (!data) return token; // belum dipakai guru manapun -> aman dipakai
  }
  // Fallback ekstrem (harusnya nyaris mustahil tercapai)
  return randomBase62(RIWAYAT_TOKEN_LENGTH) + Date.now().toString(36);
}

// ── GENERATE TOKEN QR LOGIN ADMIN (pendek, sama filosofinya dengan
// token riwayat siswa & qr_token guru di atas) ──────────────────────
// Dulu admin memakai generateQrToken() (48 karakter hex) -- jauh lebih
// panjang dari token guru/siswa (8 karakter base62). Digabung dengan
// prefix "ADMIN|username|" di QR depan, atau dengan URL dashboard penuh
// (origin + "/admin-monitor/") di QR belakang, itu membuat versi QR
// admin jadi jauh lebih tinggi (modul jauh lebih padat/halus) daripada
// kartu guru & siswa -- itulah sebabnya QR admin lebih lambat & lebih
// sering gagal discan kamera HP dibanding kartu lain. Fungsi ini
// menyamakan admin dengan pola guru/siswa: token base62 8 karakter,
// dicek unik ke tabel admin sendiri (kolom qr_token).
async function generateAdminQrToken() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBase62(RIWAYAT_TOKEN_LENGTH);
    const { data } = await supabase
      .from('admin')
      .select('username')
      .eq('qr_token', token)
      .maybeSingle();
    if (!data) return token; // belum dipakai admin manapun -> aman dipakai
  }
  // Fallback ekstrem (harusnya nyaris mustahil tercapai)
  return randomBase62(RIWAYAT_TOKEN_LENGTH) + Date.now().toString(36);
}

// ── GENERATE BANYAK QR_TOKEN GURU SEKALIGUS (backfill saat getAll) ──
// SEBELUMNYA guru.getAll() memanggil generateGuruQrToken() SATU PER SATU
// di dalam for-loop untuk tiap guru yang belum punya qr_token — itu 2
// round-trip Supabase (SELECT cek unik + UPDATE) PER GURU, dijalankan
// berurutan (await di dalam loop). Kalau ada banyak guru lama yang belum
// punya token, menu "Data Guru" / "Kartu Identitas" jadi terasa SANGAT
// lambat setiap kali dibuka, dan kalau responsnya sampai melewati batas
// waktu function serverless, request bisa gagal total di tengah jalan.
// Sama seperti generateRiwayatTokenBatch() untuk siswa: cukup 1 query
// SELECT total untuk cek tabrakan, lalu semua UPDATE dijalankan PARALEL
// (Promise.all), bukan berantai.
async function generateGuruQrTokenBatch(count) {
  let tokens = new Set();
  while (tokens.size < count) tokens.add(randomBase62(RIWAYAT_TOKEN_LENGTH));

  for (let attempt = 0; attempt < 5; attempt++) {
    const arr = [...tokens];
    const { data: dipakai } = await supabase
      .from('guru')
      .select('qr_token')
      .in('qr_token', arr);

    const setDipakai = new Set((dipakai || []).map(d => d.qr_token));
    if (setDipakai.size === 0) return arr; // tidak ada yang bentrok -> aman semua

    for (const t of arr) {
      if (setDipakai.has(t)) {
        tokens.delete(t);
        let baru;
        do { baru = randomBase62(RIWAYAT_TOKEN_LENGTH); } while (tokens.has(baru));
        tokens.add(baru);
      }
    }
  }
  return [...tokens].map((t, i) => t + Date.now().toString(36) + i);
}

// ── GENERATE ID ───────────────────────────────────────────
function generateID(prefix) {
  const now = new Date();
  const ts = now.getFullYear().toString().slice(-2)
    + String(now.getMonth()+1).padStart(2,'0')
    + String(now.getDate()).padStart(2,'0')
    + String(now.getHours()).padStart(2,'0')
    + String(now.getMinutes()).padStart(2,'0')
    + String(now.getSeconds()).padStart(2,'0');
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}${ts}${rand}`;
}

// ── GENERATE USERNAME ─────────────────────────────────────
async function generateUsername(nama) {
  const base = nama.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,8);
  let username = base;
  let counter = 1;
  while (true) {
    const { data } = await supabase.from('guru').select('id').eq('username', username).single();
    if (!data) break;
    username = base + counter++;
  }
  return username;
}

// ── GENERATE PASSWORD ─────────────────────────────────────
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 8; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
  return pass;
}

// ── CORS HEADERS ──────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── JAM SETTING ───────────────────────────────────────────
async function getJamSetting() {
  const { data } = await supabase.from('jam_setting').select('*');
  const result = {};
  (data || []).forEach(row => { result[row.kunci] = row.nilai; });
  return result;
}

// ── ZONA WAKTU ────────────────────────────────────────────────────
// PENTING: nilai ini WAJIB SAMA PERSIS dengan TIMEZONE_OFFSET_HOURS
// di file scan.html (dan riwayat.html bila ada logika jam serupa).
// Kalau beda, jam yang tercatat saat scan offline (di HP/tablet) akan
// tidak sinkron dengan jam yang dihitung server saat data disinkronkan.
//   WIB  (Jawa, Sumatera bagian selatan, dst)     = 7
//   WITA (Bali, NTB, NTT, Kalimantan, Sulawesi)   = 8  <- default saat ini
//   WIT  (Maluku, Papua)                          = 9
// Default diubah ke 8 (WITA) karena sekolah yang pakai sistem ini (Yayasan
// Alkhairaat Tatakalai) berada di Sulawesi. Kalau di kemudian hari dijual ke
// sekolah di zona lain, override lewat environment variable
// TIMEZONE_OFFSET_HOURS di Vercel — TAPI ingat scan.html juga harus
// diubah manual ke angka yang sama karena file itu tidak baca env var.
const TIMEZONE_OFFSET_HOURS = Number(process.env.TIMEZONE_OFFSET_HOURS || 8);
const TZ_OFFSET_MS = TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
function witaNow() { return new Date(Date.now() + TZ_OFFSET_MS); }

// (BARU) Format angka persentase ala Indonesia: 1 angka desimal TETAP
// (tidak dibulatkan ke bilangan bulat) dan pakai koma sebagai pemisah
// desimal (mis. 73.5 -> "73,5"), bukan titik seperti default JS.
// Dipakai supaya SEMUA fitur persentase kehadiran (widget hari ini,
// tren mingguan/bulanan, evaluasi semester, rekap mengajar guru, dst)
// menampilkan format yang seragam ke pengguna.
function fmtPersenID(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toFixed(1).replace('.', ',');
}

function todayStr() {
  return witaNow().toISOString().split('T')[0];
}

function jamSekarang() {
  return witaNow().toISOString().split('T')[1].substring(0, 5);
}

function hariIni() {
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  return days[witaNow().getDay()];
}

// ── TANGGAL & NAMA HARI BESOK (BARU) ──────────────────────────────
// Dipakai fitur "Jadwal Besok" (tab di modal Cek Aktivitas Guru selagi
// jam operasional, dan bagian "📅 Jadwal Besok" di panel Rekap Harian
// begitu jam operasional sudah berakhir) -- lihat getJadwalBesok() di
// api/scan.js. Ambil besok dengan cara yang SAMA seperti witaNow()
// (offset WITA), lalu tambah 1 hari, supaya konsisten dengan todayStr()/
// hariIni() dan tidak salah zona waktu dekat tengah malam.
function tanggalBesok() {
  const besok = new Date(witaNow().getTime() + 24 * 60 * 60 * 1000);
  return besok.toISOString().split('T')[0];
}
function hariBesok() {
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const besok = new Date(witaNow().getTime() + 24 * 60 * 60 * 1000);
  return days[besok.getDay()];
}

// ── TAMBAH MENIT KE STRING JAM "HH:MM" (untuk toleransi keterlambatan) ──
function tambahMenit(jamStr, menit) {
  const [h, m] = String(jamStr).split(':').map(Number);
  const total = h * 60 + m + Number(menit || 0);
  const hh = String(Math.floor((total % (24 * 60)) / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
// ── CEK HARI LIBUR ────────────────────────────────────────
async function isHariLibur(tanggal) {
  const { data } = await supabase
    .from('hari_kerja')
    // BARU: ikut ambil pesan/gambar_url/grup_id -- dipakai getStatus()
    // di api/scan.js supaya scan.html bisa menampilkan gambar +
    // pesan opsional di banner libur, bukan cuma judulnya saja.
    .select('keterangan,pesan,gambar_url,grup_id')
    .eq('tanggal', tanggal)
    .maybeSingle();
  return data
    ? { libur: true, keterangan: data.keterangan, pesan: data.pesan || null, gambarUrl: data.gambar_url || null, grupId: data.grup_id || null }
    : { libur: false };
}

// ── CEK HARI KERJA (sesuai pengaturan admin di Pengaturan Semester) ──
// PENTING: kalau baris untuk hari itu belum ada di tabel (admin belum
// pernah menyimpan Pengaturan Hari Kerja sama sekali), dianggap TIDAK
// aktif — bukan otomatis aktif. Ini supaya konsisten dengan
// getPengaturanHari() di settings.js (default awal = belum ada hari
// aktif) dan supaya sistem absensi benar-benar menahan diri sampai
// admin mengatur hari sekolah aktif, bukan diam-diam mengizinkan absen
// di semua hari (termasuk Sabtu/Minggu) sebelum diatur.
async function isHariKerja(namaHari) {
  const { data } = await supabase
    .from('pengaturan_hari_kerja')
    .select('aktif')
    .eq('hari', namaHari)
    .maybeSingle();
  return data ? data.aktif : false;
}

// ── GET SEMUA PENGATURAN HARI KERJA ──────────────────────
async function getHariKerjaSettings() {
  const { data } = await supabase
    .from('pengaturan_hari_kerja')
    .select('*')
    .order('hari');
  const urutan = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  return (data || []).sort((a,b) => urutan.indexOf(a.hari) - urutan.indexOf(b.hari));
}

// ── GET SEMESTER AKTIF ────────────────────────────────────
async function getSemesterAktif() {
  const { data } = await supabase
    .from('semester')
    .select('*')
    .eq('aktif', true)
    .maybeSingle();
  return data || null;
}
// ── JAM PULANG EFEKTIF (per hari, dengan fallback ke global) ─────
// Sekolah tidak selalu pulang jam yang sama tiap hari (mis. Jumat lebih
// awal). Admin bisa override JAM_PULANG_MULAI/SELESAI khusus untuk hari
// tertentu lewat menu Pengaturan Semester (tabel pengaturan_hari_kerja,
// kolom jam_pulang_mulai/jam_pulang_selesai). Kalau untuk hari itu
// override-nya kosong/NULL, otomatis pakai nilai global dari menu
// Pengaturan Jam (jam_setting). SEMUA tempat yang butuh jam pulang hari
// ini (getStatus, scanKartu, sync offline, scan.html) WAJIB lewat fungsi
// ini supaya tidak ada yang "ketinggalan" baca jam global secara terpisah.
// ── DIPISAH (perbaikan performa) ──────────────────────────────────
// getJamPulangEfektif() aslinya SATU fungsi yang query dulu baru gabung
// ke default global. Masalahnya: query pengaturan_hari_kerja di sini
// SEBENARNYA tidak butuh isi jamSetting sama sekali (jamSetting cuma
// dipakai belakangan, sebagai nilai fallback di JS) -- tapi karena
// tergabung dalam satu fungsi, pemanggil yang juga butuh getJamSetting()
// (semua pemanggil, karena jamSetting adalah parameternya) selalu
// terpaksa await getJamSetting() SELESAI dulu baru bisa mulai query ini,
// padahal keduanya bisa jalan BERSAMAAN.
//
// Sekarang dipecah jadi 2:
//   1. fetchJamPulangOverride(namaHari) -- query mentah saja, tidak butuh
//      jamSetting, jadi bisa di-Promise.all() bareng getJamSetting().
//   2. computeJamPulangEfektif(jamSetting, overrideRow) -- PURE, tidak ada
//      query sama sekali, cuma logika gabung override vs default global.
// getJamPulangEfektif(namaHari, jamSetting) TETAP ADA sebagai pembungkus
// (panggil 1 lalu 2) supaya SEMUA pemanggil lama (getStatus, sync.js, dst)
// tidak perlu diubah sama sekali. Yang butuh performa lebih (scanKartu di
// scan.js) tinggal panggil fetchJamPulangOverride() sendiri di dalam
// Promise.all miliknya, lalu computeJamPulangEfektif() untuk gabungnya --
// aturan gabungnya TETAP hanya ada di SATU tempat (computeJamPulangEfektif),
// tidak diduplikasi, jadi tidak ada risiko drift seperti yang diwanti-wanti
// di komentar atas fungsi ini sebelumnya.
async function fetchJamPulangOverride(namaHari) {
  const { data } = await supabase
    .from('pengaturan_hari_kerja')
    .select('jam_pulang_mulai, jam_pulang_selesai')
    .eq('hari', namaHari)
    .maybeSingle();
  return data || null;
}

function computeJamPulangEfektif(jamSetting, overrideRow) {
  const globalMulai   = (jamSetting && jamSetting['JAM_PULANG_MULAI'])   || '14:00';
  const globalSelesai = (jamSetting && jamSetting['JAM_PULANG_SELESAI']) || '16:00';

  return {
    jamPulangMulai:   (overrideRow && overrideRow.jam_pulang_mulai)   ? overrideRow.jam_pulang_mulai   : globalMulai,
    jamPulangSelesai: (overrideRow && overrideRow.jam_pulang_selesai) ? overrideRow.jam_pulang_selesai : globalSelesai,
    override: !!(overrideRow && (overrideRow.jam_pulang_mulai || overrideRow.jam_pulang_selesai))
  };
}

async function getJamPulangEfektif(namaHari, jamSetting) {
  const overrideRow = await fetchJamPulangOverride(namaHari);
  return computeJamPulangEfektif(jamSetting, overrideRow);
}

// ── SEBUTAN BAPAK/IBU BERDASARKAN JENIS KELAMIN GURU ─────────────
// Dipindah ke sini dari api/scan.js supaya bisa dipakai bareng oleh
// cekIzinPiket() di bawah, yang sekarang juga dipanggil dari api/sync.js
// (jalur offline) -- lihat catatan di cekIzinPiket().
function sebutanGuru(nama, jenisKelamin) {
  return `${jenisKelamin === 'Perempuan' ? 'Ibu' : 'Bapak'} ${nama}`;
}

// ── CEK APAKAH GURU BOLEH SCAN SEBAGAI PIKET ─────────────────────
// PENTING: fungsi ini DIPINDAH ke _db.js (sebelumnya cuma ada di
// api/scan.js) supaya bisa dipakai ULANG PERSIS SAMA oleh api/sync.js saat
// memproses antrian scan offline. Sebelumnya jalur offline (processSingleScan
// di sync.js) hanya menolak akun Kepala Sekolah dan tidak pernah mengecek
// jadwal_piket / slot yang sudah terkunci sama sekali -- artinya guru yang
// TIDAK terjadwal bisa lolos jadi guru piket kalau perangkatnya sempat
// offline, sesuatu yang jalur online tidak akan pernah izinkan. Sekarang
// kedua jalur memanggil fungsi yang SAMA, jadi tidak mungkin lagi drift.
//
// CATATAN UNTUK PEMANGGIL DARI JALUR OFFLINE (api/sync.js): hasil
// `perluKonfirmasi: true` TIDAK BOLEH otomatis diterima saat sync -- guru
// pengganti WAJIB scan ulang saat online supaya benar-benar mengonfirmasi
// (lihat komentar di processSingleScan()). Ini sengaja supaya dua device
// offline yang merekam guru pengganti berbeda tidak bisa dua-duanya lolos
// begitu saja saat sync.
// ── CEK JADWAL MENGAJAR SAAT INI (baca saja, tidak mencatat apa pun) ─────
// BARU (Langkah C sub-langkah 1). Dipakai api/scan.js untuk mendeteksi,
// pada saat kartu guru discan di kiosk, apakah guru itu sedang punya
// jadwal mengajar di jam sekarang -- SEBELUM diputuskan mau diproses
// sebagai absen mengajar atau piket (lihat modal pilihan di scan.html).
//
// Logika pencarian jam & jadwal ini SENGAJA meniru persis langkah 1-2 di
// scanSesiMengajar (api/mengajar.js), tapi TIDAK memanggil atau mengubah
// scanSesiMengajar itu sendiri -- fungsi ini murni SELECT (read-only),
// supaya endpoint scanSesiMengajar yang sudah dites & jalan normal (Langkah
// A) tidak berisiko ikut berubah. Ditaruh di _db.js (bukan di scan.js atau
// mengajar.js) mengikuti pola cekIzinPiket di atas, supaya nanti api/sync.js
// (jalur offline, Langkah C sub-langkah 5) bisa memakai fungsi yang SAMA
// PERSIS, bukan menduplikasi logikanya sendiri.
// ── RESOLVER JAM PELAJARAN PER HARI + KELAS (BARU) ──────────────────
// jam_pelajaran sekarang bisa punya baris default (kelas='') DAN baris
// override khusus 1 kelas (kelas=<nama kelas>) utk hari+jam_ke yang sama.
// Fungsi ini mengubah kumpulan baris jam_pelajaran UNTUK SATU HARI (hasil
// query .eq('hari', hari), TANPA filter kelas -- jadi berisi campuran baris
// default & override) menjadi satu fungsi resolve(jamKe, kelas) yang
// mengembalikan baris yang BERLAKU: override kelas itu kalau ada, kalau
// tidak baru fallback ke baris default. Dipakai bersama oleh
// cekJadwalMengajarSaatIni (di sini), scanSesiMengajar (api/mengajar.js),
// dan 2 fungsi tampilan jadwal di api/scan.js -- supaya logika "kelas mana
// menang" cuma ada di SATU tempat, tidak diduplikasi & berisiko drift.
function buatResolverJamPelajaran(jamPelajaranHariIni, fallbackDefaultRows) {
  const defaultMap = {};   // jam_ke -> baris default (kelas='') UTK HARI INI SAJA
  const overrideMap = {};  // `${kelas}|${jam_ke}` -> baris override kelas itu, HARI INI
  (jamPelajaranHariIni || []).forEach(j => {
    if (!j.kelas) defaultMap[j.jam_ke] = j;
    else overrideMap[`${j.kelas}|${j.jam_ke}`] = j;
  });

  // BUG YANG DIPERBAIKI: jam pelajaran "default" TIDAK benar-benar ada
  // sebagai satu baris global di database -- ia harus disalin (duplikat)
  // ke SETIAP hari aktif secara eksplisit lewat simpanJamPelajaranDefault()
  // di halaman admin (lihat catatan di sana). Kalau suatu hari baru saja
  // diaktifkan di Pengaturan Hari Kerja (atau baris jam_ke tertentu belum
  // sempat disalin ke hari itu) SEBELUM admin klik ulang "Simpan Jam
  // Pelajaran Default", maka `defaultMap` di atas kosong/tidak lengkap utk
  // hari itu -- padahal admin SUDAH bisa membuat jadwal_mengajar utk hari
  // itu (form Tambah Jadwal menampilkan jam dari perhitungan sinyal
  // mayoritas antar-hari, bukan dari baris literal hari itu -- lihat
  // hitungDefaultDanOverride() di index.html). Akibatnya: jadwal terlihat
  // benar di form, tapi absen scan gagal dengan "Bukan jam pelajaran
  // sekarang" karena resolve() di bawah gagal menemukan barisnya.
  //
  // fallbackDefaultRows (dari hitungDefaultJamPelajaran() di bawah, dihitung
  // dari SELURUH hari yang sudah ada datanya, pakai algoritma sinyal
  // mayoritas yang SAMA seperti di admin) dipakai sebagai penyelamat
  // terakhir per jam_ke yang tidak ditemukan di hari ini -- supaya guru
  // tetap bisa absen sesuai jam yang memang ditampilkan ke admin saat
  // membuat jadwalnya.
  const fallbackMap = {};
  (fallbackDefaultRows || []).forEach(r => {
    fallbackMap[r.jamKe] = { jam_ke: r.jamKe, jam_mulai: r.jamMulai, jam_selesai: r.jamSelesai };
  });

  return function resolve(jamKe, kelas) {
    if (kelas && overrideMap[`${kelas}|${jamKe}`]) return overrideMap[`${kelas}|${jamKe}`];
    if (defaultMap[jamKe]) return defaultMap[jamKe];
    return fallbackMap[jamKe] || null;
  };
}

// hitungDefaultJamPelajaran: hitung "jam pelajaran default" yang SAMA
// persis seperti algoritma hitungDefaultDanOverride() di index.html --
// dari SEMUA baris jam_pelajaran (semua hari, baris default kelas='' saja),
// cari signature (urutan jamKe+jamMulai+jamSelesai) yang paling sering
// dipakai di antara hari-hari yang sudah ada datanya. Dipakai sebagai
// fallback resolver di atas supaya hari yang belum sempat "disalin ulang"
// jam defaultnya tidak membuat absen scan gagal total.
function hitungDefaultJamPelajaran(semuaBarisJamPelajaran) {
  const perHari = {};
  (semuaBarisJamPelajaran || []).forEach(j => {
    if (j.kelas) return; // baris override kelas tidak ikut hitung signature default
    if (!perHari[j.hari]) perHari[j.hari] = [];
    perHari[j.hari].push({ jamKe: j.jam_ke, jamMulai: j.jam_mulai, jamSelesai: j.jam_selesai });
  });
  Object.keys(perHari).forEach(h => perHari[h].sort((a, b) => Number(a.jamKe) - Number(b.jamKe)));

  const sig = arr => JSON.stringify(arr);
  let defaultSig = null, jumlahTerbanyak = -1;
  const jumlahPerSig = {};
  Object.keys(perHari).forEach(h => {
    const s = sig(perHari[h]);
    jumlahPerSig[s] = (jumlahPerSig[s] || 0) + 1;
    if (jumlahPerSig[s] > jumlahTerbanyak) { jumlahTerbanyak = jumlahPerSig[s]; defaultSig = s; }
  });
  return defaultSig ? JSON.parse(defaultSig) : [];
}

async function cekJadwalMengajarSaatIni({ guruId, hari, jam }) {
  const jamSetting = await getJamSetting();
  const toleransi = Number(jamSetting['TOLERANSI_MENGAJAR_MENIT'] || 15);

  // PERBAIKAN (sadar kelas): SEBELUMNYA jam_ke "sekarang" ditentukan lebih
  // dulu dari jam_pelajaran GLOBAL saja, baru dicocokkan ke jadwal_mengajar
  // guru -- ini berarti override per-kelas (mis. Kamis kelas X-1 pulang
  // lebih cepat) tidak pernah ikut terpakai, karena kelasnya belum
  // diketahui saat jam_ke dicari. Sekarang urutannya dibalik: ambil dulu
  // semua jadwal_mengajar guru ini hari ini (tiap baris sudah punya
  // kelasnya sendiri), baru untuk TIAP baris dihitung jam efektifnya
  // (pakai override kelas itu kalau ada, kalau tidak baru default) dan
  // dicek apakah waktu sekarang jatuh di rentang itu.
  const [{ data: jadwalGuruHariIni }, { data: jamPelajaranSemua }] = await Promise.all([
    supabase.from('jadwal_mengajar').select('*').eq('id_guru', guruId).eq('hari', hari),
    // BARU: ambil SEMUA hari (bukan cuma .eq('hari', hari)) supaya bisa
    // hitung fallback jam default lewat hitungDefaultJamPelajaran() kalau
    // hari ini kebetulan belum punya baris defaultnya sendiri -- lihat
    // catatan lengkap di buatResolverJamPelajaran().
    supabase.from('jam_pelajaran').select('hari,jam_ke,jam_mulai,jam_selesai,kelas').order('jam_ke')
  ]);

  if (!jadwalGuruHariIni || jadwalGuruHariIni.length === 0) return { ada: false };

  const jamPelajaranHariIni = (jamPelajaranSemua || []).filter(j => j.hari === hari);
  const fallbackDefault = hitungDefaultJamPelajaran(jamPelajaranSemua);
  const resolve = buatResolverJamPelajaran(jamPelajaranHariIni, fallbackDefault);

  for (const jadwal of jadwalGuruHariIni) {
    const jpMulai = resolve(jadwal.jam_ke_mulai, jadwal.kelas);
    const jpSelesai = resolve(jadwal.jam_ke_selesai, jadwal.kelas) || jpMulai;
    if (!jpMulai || !jpSelesai) continue;
    if (jam >= jpMulai.jam_mulai && jam <= tambahMenit(jpSelesai.jam_selesai, toleransi)) {
      return { ada: true, jadwal, jamKeSekarang: jpMulai };
    }
  }
  return { ada: false };
}

async function cekIzinPiket({ guruId, guruRole, hari, today, jam }) {
  if (guruRole === 'kepsek') {
    return {
      boleh: false,
      message: 'Akun Kepala Sekolah tidak diperbolehkan tercatat sebagai guru piket (baik terjadwal maupun pengganti). Kepsek berperan sebagai pengawas piket, bukan pelaksana.'
    };
  }

  const { data: jadwalHariIni } = await supabase
    .from('jadwal_piket')
    .select('id_guru,nama_guru')
    .eq('hari', hari);

  const idTerjadwal = (jadwalHariIni || []).map(j => j.id_guru);

  if (idTerjadwal.length === 0) {
    return { boleh: true };
  }

  if (idTerjadwal.includes(guruId)) {
    return { boleh: true };
  }

  const { data: sesiHariIni } = await supabase
    .from('sesi_piket')
    .select('id_guru')
    .eq('tanggal', today);

  // PERBAIKAN: dulu di sini dicek "apakah ADA sesi piket hari ini?" (>0),
  // jadi begitu 1 dari beberapa guru piket terjadwal datang, slot guru
  // LAIN yang belum datang ikut tertutup untuk pengganti -- padahal
  // slotnya sendiri masih kosong. Sekarang dibandingkan ke JUMLAH yang
  // dijadwalkan (idTerjadwal.length), supaya sekolah dengan >1 guru piket
  // tetap membuka slot pengganti untuk siapa pun yang belum tercatat,
  // sampai semua slot terjadwal terisi.
  if (sesiHariIni && sesiHariIni.length >= idTerjadwal.length) {
    return {
      boleh: false,
      message: 'Piket hari ini sudah lengkap, semua guru piket sudah tercatat.'
    };
  }

  const { data: dataGuruTerjadwal } = await supabase
    .from('guru')
    .select('id,nama,jenis_kelamin')
    .in('id', idTerjadwal);

  const teksNama = (dataGuruTerjadwal && dataGuruTerjadwal.length
    ? dataGuruTerjadwal
    : jadwalHariIni.map(j => ({ nama: j.nama_guru, jenis_kelamin: null }))
  ).map(g => sebutanGuru(g.nama, g.jenis_kelamin)).join(' / ');

  const jamSetting = await getJamSetting();
  const jamMulai    = jamSetting['JAM_DATANG_MULAI'] || '06:30';
  const toleransi   = Number(jamSetting['TOLERANSI_PIKET_MENIT'] || 15);
  const batasJam    = tambahMenit(jamMulai, toleransi);
  const sebelumToleransi = jam < batasJam;

  return {
    boleh: false,
    perluKonfirmasi: true,
    sebelumToleransi,
    teksNama,
    message: sebelumToleransi
      ? `Anda bukan guru piket hari ini. Apakah Anda akan menggantikan ${teksNama} untuk piket hari ini?`
      : `Anda akan menjadi guru piket menggantikan ${teksNama} hari ini. Tekan Ya jika benar.`
  };
}

// ── CEK APAKAH GURU BENAR-BENAR PIKET HARI INI (via sesi_piket) ──────
// PENTING: sengaja cek ke sesi_piket (guru yang benar-benar SCAN kartu
// piket), BUKAN ke jadwal_piket (jadwal terjadwal admin). Ini menyamakan
// prinsip "kebenaran ikut sesi_piket" yang sudah dipakai di
// getRiwayatPiketGuru & laporan kepatuhan piket (lihat api/settings.js).
// Efeknya: guru pengganti yang scan tetap dianggap piket hari itu, dan
// guru yang terjadwal di admin tapi TIDAK scan dianggap TIDAK piket.
async function isGuruPiketHariIni(idGuru) {
  if (!idGuru) return false;
  const { data } = await supabase
    .from('sesi_piket')
    .select('id')
    .eq('tanggal', todayStr())
    .eq('id_guru', idGuru)
    .maybeSingle();
  return !!data;
}

// ── RESOLVE IDENTITAS GURU DARI guruToken (qr_token) ─────────────────
// PENTING (perbaikan keamanan): sebelumnya endpoint seperti
// kehadiran.inputKeterangan/hapusKeterangan dan settings.getRiwayatPiketGuru
// mempercayai `idGuru` yang dikirim MENTAH oleh klien. Masalahnya, id guru
// itu BUKAN rahasia -- bisa dibaca siapa saja lewat settings.getGuruPiket
// (endpoint publik, "siapa piket hari ini"). Akibatnya siapa pun yang tahu
// idGuru itu bisa mengaku sebagai guru tersebut tanpa login sama sekali.
//
// Perbaikannya: identitas guru sekarang HARUS dibuktikan lewat `guruToken`,
// yaitu qr_token milik guru yang hanya didapat setelah login berhasil
// (lihat auth.js -- disisipkan otomatis oleh helper api() di frontend,
// sama seperti pola adminToken yang sudah ada). qr_token ini sama dengan
// yang dipakai untuk QR "GURU_LOGIN|..." (bypass login lewat kartu), jadi
// tidak menambah rahasia baru -- kalau qr_token ini bocor, akun guru itu
// memang sudah bisa di-login penuh lewat QR juga.
// ── SESI TOKEN untuk MODE VERIFIKASI KELAS (BARU) ─────────────────
// scanSiswaMapel & selesaiVerifikasi (api/mengajar.js) sebelumnya tidak
// mensyaratkan apa pun selain idAbsensiMengajar + idSiswa -- keduanya ID
// server biasa (bukan rahasia seperti qr_token), jadi siapa pun yang
// tahu/menebak kombinasinya bisa memalsukan verifikasi kehadiran dari
// luar kiosk, tanpa perlu hadir fisik di kelas. Perbaikannya: begitu
// scanSesiMengajar berhasil, server menerbitkan "sesiToken" -- HMAC dari
// idAbsensiMengajar itu sendiri, ditandatangani pakai SESI_MENGAJAR_SECRET
// (rahasia yang cuma ada di server, tidak pernah dicetak di kartu/QR
// mana pun). Token ini dibawa balik oleh klien di setiap scanSiswaMapel/
// selesaiVerifikasi untuk sesi itu, dan diverifikasi sebelum data ditulis.
// Tanpa token yang valid (yang hanya bisa didapat dari scanSesiMengajar
// yang sah), permintaan ditolak. Tidak mengubah alur/urutan panggilan
// yang sudah ada -- cuma menambah satu bukti keabsahan yang wajib disertakan.
function generateSesiToken(idAbsensiMengajar) {
  const secret = process.env.SESI_MENGAJAR_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
  return crypto.createHmac('sha256', secret).update(String(idAbsensiMengajar)).digest('hex');
}

function verifySesiToken(idAbsensiMengajar, token) {
  if (!token) return false;
  const expected = generateSesiToken(idAbsensiMengajar);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── KIOSK TOKEN (BARU — perbaikan keamanan) ────────────────────────
// LATAR BELAKANG: scanKartu() di api/scan.js (dan alur offline-nya di
// api/sync.js) sebelumnya menerima siapa saja yang tahu/menebak `id`
// atau `nisn` siswa — keduanya BUKAN rahasia (nisn tercetak di rapor,
// id bisa bocor lewat endpoint laporan seperti rekapHarian). Karena
// endpoint ini publik (dipanggil dari kiosk TANPA login), siapa pun di
// internet yang tahu id/nisn seorang siswa bisa memalsukan catatan
// hadir/pulang lewat panggilan API langsung (curl/Postman), tanpa
// pernah berada di sekolah maupun menyentuh kartu fisik.
//
// PERBAIKAN: halaman kiosk (scan.html) memanggil getStatus() setiap
// kali dimuat DAN setiap 10 detik selagi terbuka (lihat checkStatus()
// di scan.html) — setiap balasannya sekarang menyertakan `kioskToken`,
// sebuah HMAC yang dihasilkan dari "jendela waktu" saat ini (bukan dari
// data apapun yang dikirim klien, jadi tidak perlu disimpan di DB).
// scanKartu() WAJIB menerima kioskToken yang masih berlaku sebelum
// memproses scan apapun. Ini TIDAK 100% membuktikan kehadiran fisik
// (siapa pun yang membuka scan.html di browser tetap bisa melihat
// tokennya di Network tab), TAPI menutup jalur serangan yang paling
// mudah & realistis: panggilan API buta dari luar tanpa pernah memuat
// halaman kiosk sama sekali. Jendela token sengaja pendek (2 menit) dan
// menerima jendela saat ini + jendela sebelumnya (total toleransi
// hingga ~4 menit) supaya tidak terganggu jeda refresh/loading normal.
const KIOSK_TOKEN_WINDOW_MS = 2 * 60 * 1000; // 2 menit per jendela

function getKioskSecret() {
  return process.env.KIOSK_SESSION_SECRET
    || process.env.SESI_MENGAJAR_SECRET
    || process.env.SUPABASE_SERVICE_KEY
    || '';
}

function kioskTokenUntukJendela(bucket) {
  return crypto.createHmac('sha256', getKioskSecret())
    .update('KIOSK|' + bucket)
    .digest('hex')
    .slice(0, 32); // dipendekkan -- ini token sesi berumur pendek, bukan kunci kriptografi jangka panjang
}

function generateKioskToken() {
  const bucket = Math.floor(Date.now() / KIOSK_TOKEN_WINDOW_MS);
  return kioskTokenUntukJendela(bucket);
}

function verifyKioskToken(token) {
  if (!token || typeof token !== 'string') return false;
  const bucket = Math.floor(Date.now() / KIOSK_TOKEN_WINDOW_MS);
  const kandidat = [kioskTokenUntukJendela(bucket), kioskTokenUntukJendela(bucket - 1)];
  return kandidat.some(exp => {
    const a = Buffer.from(token);
    const b = Buffer.from(exp);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ── RATE LIMITER GENERIK (BARU — perbaikan keamanan) ────────────────
// Sama filosofinya dengan rate limiter login di api/auth.js (in-memory
// per instance serverless -- bukan solusi sempurna lintas banyak
// instance Vercel paralel, tapi jauh lebih baik daripada tidak ada
// pembatasan sama sekali). Dipakai bersama oleh api/scan.js (action
// scanKartu/inputTanpaKartu) dan api/sync.js (action batchSync) untuk
// membatasi berapa kali satu alamat IP boleh memanggil endpoint yang
// bisa membuat catatan hadir, supaya percobaan tebak-tebakan id/nisn
// atau spam sinkronisasi dari luar tidak bisa dilakukan tanpa batas.
const _rateLimitStore = new Map(); // key -> { count, windowStart }

function checkRateLimit(key, { maxRequest = 30, windowMs = 60 * 1000 } = {}) {
  const now = Date.now();
  const rec = _rateLimitStore.get(key);
  if (!rec || now - rec.windowStart > windowMs) {
    _rateLimitStore.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  rec.count += 1;
  if (rec.count > maxRequest) {
    const retryAfterSec = Math.ceil((windowMs - (now - rec.windowStart)) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

// Ambil alamat IP pemanggil dari header proxy Vercel (x-forwarded-for),
// fallback ke koneksi socket langsung kalau header tidak ada.
function getClientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function resolveGuruIdFromToken(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('guru')
    .select('id,status')
    .eq('qr_token', String(token).trim())
    .limit(1);
  const guru = data && data[0];
  if (!guru || guru.status !== 'Aktif') return null;
  return guru.id;
}

// ════════════════════════════════════════════════════════════════
// RINGKASAN SEKOLAH (BARU) — ditarik keluar dari api/monitor.js supaya
// bisa dipakai ulang oleh api/admin-monitor.js (Dashboard Admin) tanpa
// menyalin-tempel logika yang sama persis. Fungsi-fungsi ini TIDAK
// melakukan validasi token apapun -- itu tanggung jawab pemanggil
// (findKepsekByToken di monitor.js, findAdminByToken di admin-monitor.js)
// supaya aturan siapa yang boleh akses tetap terpisah dari cara datanya
// dihitung.
// ════════════════════════════════════════════════════════════════

// ── LIVE HARI INI — kehadiran siswa, piket, & status mengajar guru
// SAAT INI JUGA (real-time), TIDAK dipengaruhi filter minggu/bulan.
async function ringkasanLiveHariIni() {
  const today  = todayStr();
  const hari   = hariIni();
  const jamNow = jamSekarang();
  const settings = await getJamSetting();
  const cekLibur = await isHariLibur(today);
  const hariSekolah = !cekLibur.libur && await isHariKerja(hari);

  const [
    { count: totalSiswa },
    { data: absenHariIni },
    { data: ketHariIni },
    { data: jadwalPiket },
    { data: sesiPiketHariIni },
    { data: jadwalMengajarHariIni },
    { data: jamPelajaranHariIni },
    { data: absensiMengajarHariIni }
  ] = await Promise.all([
    supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('absensi').select('nama_siswa,kelas,jam_datang,status_datang,jam_pulang,status_pulang,keterangan_pulang_cepat').eq('tanggal', today),
    supabase.from('keterangan_absensi').select('nama_siswa,kelas,status,keterangan').eq('tanggal', today),
    supabase.from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari),
    supabase.from('sesi_piket').select('id_guru,nama_guru,jam_scan').eq('tanggal', today),
    supabase.from('jadwal_mengajar').select('id,id_guru,nama_guru,jam_ke_mulai,jam_ke_selesai,kelas,mapel').eq('hari', hari),
    supabase.from('jam_pelajaran').select('jam_ke,jam_mulai,jam_selesai').eq('hari', hari).order('jam_ke'),
    supabase.from('absensi_mengajar').select('id_jadwal_mengajar,id_guru,nama_guru,kelas,mapel,jam_scan,status').eq('tanggal', today)
  ]);

  const hadirHariIni     = (absenHariIni || []).filter(a => a.status_datang === 'Hadir' || a.status_datang === 'Terlambat').length;
  const terlambatHariIni = (absenHariIni || []).filter(a => a.status_datang === 'Terlambat').length;
  const sakitHariIni     = (ketHariIni || []).filter(k => k.status === 'Sakit').length;
  const izinHariIni      = (ketHariIni || []).filter(k => k.status !== 'Sakit').length;
  const alphaHariIni     = Math.max(0, (totalSiswa || 0) - hadirHariIni - sakitHariIni - izinHariIni);
  const daftarSakitIzin  = (ketHariIni || []).map(k => ({ nama: k.nama_siswa, kelas: k.kelas, status: k.status, keterangan: k.keterangan || null }));

  // (BARU) Siswa yang SEMPAT hadir lalu ditandai pulang cepat (sakit/izin
  // mendadak di tengah hari, lihat tandaiPulangCepat di api/kehadiran.js)
  // -- dibedakan dari status_pulang = 'Pulang' (checkout normal). Tidak
  // dicampur ke daftarSakitIzin/sakitHariIni/izinHariIni di atas (yang
  // menghitung siswa yang memang TIDAK hadir dari awal), supaya kedua
  // angka itu tidak tertukar sesuai concern awal fitur ini -- ditampilkan
  // sebagai daftar & hitungan terpisah.
  const daftarPulangCepat = (absenHariIni || [])
    .filter(a => a.status_pulang && a.status_pulang !== 'Pulang')
    .map(a => ({
      nama: a.nama_siswa, kelas: a.kelas,
      status: a.status_pulang, jam: a.jam_pulang,
      keterangan: a.keterangan_pulang_cepat || null
    }));
  const pulangCepatHariIni = daftarPulangCepat.length;

  const idSudahLapor = new Set((sesiPiketHariIni || []).map(s => s.id_guru));
  const daftarPiket = (jadwalPiket || []).map(p => ({
    namaGuru: p.nama_guru, jabatan: p.jabatan,
    sudahLapor: idSudahLapor.has(p.id_guru),
    jamLapor: (sesiPiketHariIni || []).find(s => s.id_guru === p.id_guru)?.jam_scan || null
  }));
  const idTerjadwalPiket = new Set((jadwalPiket || []).map(p => p.id_guru));
  (sesiPiketHariIni || []).forEach(s => {
    if (!idTerjadwalPiket.has(s.id_guru)) {
      daftarPiket.push({ namaGuru: s.nama_guru, jabatan: 'Piket Pengganti', sudahLapor: true, jamLapor: s.jam_scan });
    }
  });

  const jpMap = {};
  (jamPelajaranHariIni || []).forEach(j => { jpMap[j.jam_ke] = j; });
  const tercatatMap = {};
  (absensiMengajarHariIni || []).forEach(a => { tercatatMap[a.id_jadwal_mengajar] = a; });

  const guruMap = {};
  (jadwalMengajarHariIni || []).forEach(j => {
    const jpMulai   = jpMap[j.jam_ke_mulai];
    const jpSelesai = jpMap[j.jam_ke_selesai] || jpMulai;
    if (!jpMulai || !jpSelesai) return;
    let statusSesi = 'belum-mulai';
    if (jamNow > jpSelesai.jam_selesai) statusSesi = 'selesai';
    else if (jamNow >= jpMulai.jam_mulai) statusSesi = 'berlangsung';

    if (!guruMap[j.id_guru]) guruMap[j.id_guru] = { idGuru: j.id_guru, namaGuru: j.nama_guru, sesi: [] };
    guruMap[j.id_guru].sesi.push({
      kelas: j.kelas, mapel: j.mapel,
      jamMulai: jpMulai.jam_mulai, jamSelesai: jpSelesai.jam_selesai,
      status: statusSesi,
      tercatat: !!tercatatMap[j.id],
      statusAbsen: tercatatMap[j.id] ? tercatatMap[j.id].status : null
    });
  });

  const sedangMengajar = [], sudahSelesai = [], belumMulai = [];
  Object.values(guruMap).forEach(g => {
    const adaBerlangsung = g.sesi.some(s => s.status === 'berlangsung');
    const semuaSelesai   = g.sesi.every(s => s.status === 'selesai');
    const belumAda       = g.sesi.every(s => s.status === 'belum-mulai');
    if (adaBerlangsung) {
      const sesiAktif = g.sesi.find(s => s.status === 'berlangsung');
      sedangMengajar.push({ namaGuru: g.namaGuru, kelas: sesiAktif.kelas, mapel: sesiAktif.mapel, tercatatAbsen: sesiAktif.tercatat });
    } else if (semuaSelesai) {
      sudahSelesai.push({ namaGuru: g.namaGuru, totalSesi: g.sesi.length, adaYangTidakTercatat: g.sesi.some(s => !s.tercatat) });
    } else if (belumAda) {
      const sesiBerikut = g.sesi.sort((a,b)=>a.jamMulai.localeCompare(b.jamMulai))[0];
      belumMulai.push({ namaGuru: g.namaGuru, kelas: sesiBerikut.kelas, mapel: sesiBerikut.mapel, jamMulai: sesiBerikut.jamMulai });
    }
  });

  return {
    tanggal: today, hari, jamSekarang: jamNow,
    namaSekolah: settings['NAMA_SEKOLAH'] || 'Sekolah',
    hariSekolah,
    keteranganLibur: cekLibur.libur ? (cekLibur.keterangan || 'Hari libur') : null,
    kehadiranSiswa: {
      totalSiswa: totalSiswa || 0, hadir: hadirHariIni, terlambat: terlambatHariIni,
      sakit: sakitHariIni, izin: izinHariIni, alpha: alphaHariIni,
      daftarSakitIzin,
      // (BARU) Lihat catatan daftarPulangCepat di atas.
      pulangCepat: pulangCepatHariIni,
      daftarPulangCepat
    },
    piket: daftarPiket,
    mengajar: { sedangMengajar, sudahSelesai, belumMulai }
  };
}

// ── REKAP PERIODE — kehadiran siswa & kepatuhan piket untuk rentang
// minggu (7 hari terakhir termasuk hari ini) atau bulan (1 s/d hari ini
// bulan berjalan).
async function ringkasanRekapPeriode(rentang) {
  const today = todayStr();
  let start;
  if (rentang === 'minggu') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 6);
    start = d.toISOString().substring(0, 10);
  } else {
    start = today.substring(0, 7) + '-01';
  }
  const end = today;

  const { count: totalSiswa } = await supabase
    .from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif');

  const [
    { data: absenRange },
    { data: ketRange },
    { data: liburRows },
    { data: hariKerjaSetting },
    { data: jadwalPiketAll },
    { data: sesiPiketRange }
  ] = await Promise.all([
    supabase.from('absensi').select('tanggal,status_datang').gte('tanggal', start).lte('tanggal', end),
    supabase.from('keterangan_absensi').select('tanggal,status').gte('tanggal', start).lte('tanggal', end),
    supabase.from('hari_kerja').select('tanggal').gte('tanggal', start).lte('tanggal', end),
    supabase.from('pengaturan_hari_kerja').select('*'),
    supabase.from('jadwal_piket').select('hari,id_guru,nama_guru'),
    supabase.from('sesi_piket').select('tanggal,id_guru,nama_guru').gte('tanggal', start).lte('tanggal', end)
  ]);

  const liburSet = new Set((liburRows || []).map(r => String(r.tanggal).substring(0, 10)));
  const hariAktifMap = {};
  (hariKerjaSetting || []).forEach(h => { hariAktifMap[h.hari] = h.aktif; });
  const namaHariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  let jumlahHariSekolah = 0;
  const cur = new Date(start + 'T00:00:00Z');
  const akhir = new Date(end + 'T00:00:00Z');
  while (cur <= akhir) {
    const tgl = cur.toISOString().substring(0, 10);
    const namaHari = namaHariArr[cur.getUTCDay()];
    const aktif = hariAktifMap.hasOwnProperty(namaHari) ? hariAktifMap[namaHari] : false;
    if (aktif && !liburSet.has(tgl)) jumlahHariSekolah++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const hadirTotal     = (absenRange || []).filter(a => a.status_datang === 'Hadir' || a.status_datang === 'Terlambat').length;
  const terlambatTotal = (absenRange || []).filter(a => a.status_datang === 'Terlambat').length;
  const sakitTotal      = (ketRange || []).filter(k => k.status === 'Sakit').length;
  const izinTotal       = (ketRange || []).filter(k => k.status !== 'Sakit').length;
  const totalKemungkinanHadir = jumlahHariSekolah * (totalSiswa || 0);
  const alphaTotal = Math.max(0, totalKemungkinanHadir - hadirTotal - sakitTotal - izinTotal);
  const persentaseKehadiran = totalKemungkinanHadir > 0
    ? Math.round((hadirTotal / totalKemungkinanHadir) * 1000) / 10 : 0;

  const jadwalPerHari = {};
  (jadwalPiketAll || []).forEach(j => {
    if (!jadwalPerHari[j.hari]) jadwalPerHari[j.hari] = [];
    jadwalPerHari[j.hari].push({ idGuru: j.id_guru, namaGuru: j.nama_guru });
  });
  const sesiPerTanggal = {};
  (sesiPiketRange || []).forEach(s => {
    if (!sesiPerTanggal[s.tanggal]) sesiPerTanggal[s.tanggal] = [];
    sesiPerTanggal[s.tanggal].push(s);
  });
  const rekapGuru = {};
  function ambil(idGuru, namaGuru) {
    if (!rekapGuru[idGuru]) rekapGuru[idGuru] = { namaGuru, hadirTepat: 0, tanpaPiket: 0, digantikan: 0 };
    return rekapGuru[idGuru];
  }
  const cur2 = new Date(start + 'T00:00:00Z');
  while (cur2 <= akhir) {
    const tgl = cur2.toISOString().substring(0, 10);
    const namaHari = namaHariArr[cur2.getUTCDay()];
    const terjadwal = jadwalPerHari[namaHari] || [];
    const sesiHariItu = sesiPerTanggal[tgl] || [];
    terjadwal.forEach(t => {
      const r = ambil(t.idGuru, t.namaGuru);
      const scanSendiri = sesiHariItu.find(s => s.id_guru === t.idGuru);
      if (scanSendiri) r.hadirTepat++;
      else if (sesiHariItu.length) r.digantikan++;
      else r.tanpaPiket++;
    });
    cur2.setUTCDate(cur2.getUTCDate() + 1);
  }
  const kepatuhanPiket = Object.values(rekapGuru).sort((a, b) => a.namaGuru.localeCompare(b.namaGuru));

  return {
    rentang, tanggalMulai: start, tanggalSelesai: end, jumlahHariSekolah,
    kehadiranSiswa: {
      totalSiswa: totalSiswa || 0, hadir: hadirTotal, terlambat: terlambatTotal,
      sakit: sakitTotal, izin: izinTotal, alpha: alphaTotal, persentaseKehadiran
    },
    kepatuhanPiket
  };
}

// ── TREN PERSENTASE KEHADIRAN (BARU) ──────────────────────────────
// Dipakai tombol "📊 Persentase Kehadiran" di scan.html (dibuka guru
// piket langsung dari kios, TANPA perlu login/scan kartu -- read-only
// murni, sama semangatnya dengan getAktivitasGuruHariIni() di
// api/scan.js). Dua mode:
//   - rentang='minggu' -> persentase kehadiran PER HARI untuk 7 hari
//     kalender terakhir (termasuk hari ini).
//   - rentang='bulan'  -> persentase kehadiran PER MINGGU untuk 4
//     minggu (28 hari) terakhir, tiap titik = agregat 1 minggu.
// Opsional difilter per `kelas` (kalau kosong/tidak diisi -> semua
// kelas digabung), sesuai keputusan produk (lihat catatan di PR/chat).
// "Hari sekolah" dihitung dengan pola SAMA PERSIS seperti
// ringkasanRekapPeriode() di atas (pengaturan_hari_kerja + tabel
// hari_kerja sebagai kalender libur override) supaya kedua rekap ini
// tidak pernah berbeda angka untuk rentang yang sama.
// Kesimpulan tren dihitung dengan membandingkan DUA TITIK TERAKHIR yang
// punya data (bukan hari/minggu tanpa sekolah) -- "periode terakhir vs
// periode sebelumnya", sesuai definisi yang disepakati: untuk mode
// minggu itu berarti hari sekolah terakhir vs hari sekolah sebelum itu,
// untuk mode bulan berarti minggu terakhir vs minggu sebelum itu.
async function getTrenPersentaseKehadiran(params = {}) {
  const rentang = params.rentang === 'bulan' ? 'bulan' : 'minggu';
  const kelas   = (params.kelas || '').trim();

  const today = todayStr();
  const totalHari = rentang === 'minggu' ? 7 : 28;
  const startDate = new Date(today + 'T00:00:00Z');
  startDate.setUTCDate(startDate.getUTCDate() - (totalHari - 1));
  const start = startDate.toISOString().substring(0, 10);

  let qSiswa = supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif');
  if (kelas) qSiswa = qSiswa.eq('kelas', kelas);

  let qAbsen = supabase.from('absensi').select('tanggal,status_datang').gte('tanggal', start).lte('tanggal', today);
  if (kelas) qAbsen = qAbsen.eq('kelas', kelas);

  const [{ count: totalSiswa }, { data: absenRange }, { data: liburRows }, { data: hariKerjaSetting }] = await Promise.all([
    qSiswa, qAbsen,
    supabase.from('hari_kerja').select('tanggal').gte('tanggal', start).lte('tanggal', today),
    supabase.from('pengaturan_hari_kerja').select('*')
  ]);

  const liburSet = new Set((liburRows || []).map(r => String(r.tanggal).substring(0, 10)));
  const hariAktifMap = {};
  (hariKerjaSetting || []).forEach(h => { hariAktifMap[h.hari] = h.aktif; });
  const namaHariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const namaHariSingkat = { Minggu: 'Min', Senin: 'Sen', Selasa: 'Sel', Rabu: 'Rab', Kamis: 'Kam', Jumat: 'Jum', Sabtu: 'Sab' };

  const hadirPerTanggal = {};
  (absenRange || []).forEach(a => {
    if (a.status_datang === 'Hadir' || a.status_datang === 'Terlambat') {
      hadirPerTanggal[a.tanggal] = (hadirPerTanggal[a.tanggal] || 0) + 1;
    }
  });

  function isHariSekolah(tgl, namaHari) {
    const aktif = hariAktifMap.hasOwnProperty(namaHari) ? hariAktifMap[namaHari] : false;
    return aktif && !liburSet.has(tgl);
  }

  const poin = [];
  if (rentang === 'minggu') {
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate); d.setUTCDate(d.getUTCDate() + i);
      const tgl = d.toISOString().substring(0, 10);
      const namaHari = namaHariArr[d.getUTCDay()];
      const sekolah = isHariSekolah(tgl, namaHari);
      const persen = (sekolah && totalSiswa) ? Math.round(((hadirPerTanggal[tgl] || 0) / totalSiswa) * 1000) / 10 : null;
      poin.push({ label: namaHariSingkat[namaHari], tanggal: tgl, persen, sekolah });
    }
  } else {
    for (let w = 0; w < 4; w++) {
      const wStart = new Date(startDate); wStart.setUTCDate(wStart.getUTCDate() + w * 7);
      const wEnd = new Date(wStart); wEnd.setUTCDate(wEnd.getUTCDate() + 6);
      let hadirMinggu = 0, kemungkinanMinggu = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(wStart); d.setUTCDate(d.getUTCDate() + i);
        const tgl = d.toISOString().substring(0, 10);
        const namaHari = namaHariArr[d.getUTCDay()];
        if (isHariSekolah(tgl, namaHari) && totalSiswa) {
          kemungkinanMinggu += totalSiswa;
          hadirMinggu += (hadirPerTanggal[tgl] || 0);
        }
      }
      const persen = kemungkinanMinggu > 0 ? Math.round((hadirMinggu / kemungkinanMinggu) * 1000) / 10 : null;
      poin.push({
        label: `Minggu ${w + 1}`,
        tanggalMulai: wStart.toISOString().substring(0, 10),
        tanggalSelesai: wEnd.toISOString().substring(0, 10),
        persen, sekolah: persen !== null
      });
    }
  }

  // ── PERBAIKAN: titik "HARI INI" jangan dihitung 0% kalau jam absen
  // datang belum dimulai ────────────────────────────────────────────
  // Sebelum perbaikan ini, titik hari ini selalu dihitung
  // (hadirPerTanggal[tgl]||0)/totalSiswa -- yang, sebelum jam
  // JAM_DATANG_MULAI, HAMPIR SELALU menghasilkan 0,0% (karena memang
  // belum ada siswa yang sempat scan), lalu dibandingkan ke hari
  // sekolah sebelumnya yang datanya sudah lengkap -> muncul pesan
  // "Tren menurun ... turun 89,2%" yang MENYESATKAN, seolah-olah
  // kehadiran hari ini benar-benar anjlok, padahal sekolah belum buka
  // jam absen sama sekali. Di sini titik hari ini di-null-kan (supaya
  // tidak masuk hitungan tren & rata-rata) dan ditandai `belumMulai`
  // kalau memang jam sekarang masih sebelum JAM_DATANG_MULAI, supaya
  // frontend bisa menampilkan pesan yang jelas ("belum dimulai"),
  // bukan angka 0,0% yang terkesan sebagai kehadiran gagal.
  let belumMulaiHariIni = false;
  let jamMulaiAbsen = '06:30';
  if (rentang === 'minggu') {
    const jamSetting = await getJamSetting();
    jamMulaiAbsen = jamSetting['JAM_DATANG_MULAI'] || '06:30';
    const titikHariIni = poin[poin.length - 1];
    if (titikHariIni && titikHariIni.tanggal === today && titikHariIni.sekolah && jamSekarang() < jamMulaiAbsen) {
      titikHariIni.persen = null;
      titikHariIni.belumMulai = true;
      belumMulaiHariIni = true;
    }
  }

  const poinValid = poin.filter(p => p.persen !== null);
  const rataRata = poinValid.length
    ? Math.round((poinValid.reduce((s, p) => s + p.persen, 0) / poinValid.length) * 10) / 10 : null;

  let tren = { arah: 'kosong', selisih: 0, pesan: 'Belum ada data kehadiran di periode ini.' };
  if (belumMulaiHariIni) {
    // Pesan jelas & netral (bukan merah/"turun") -- ini bukan sinyal
    // kehadiran buruk, cuma jam absen datang belum dimulai.
    tren = {
      arah: 'menunggu', selisih: 0,
      pesan: `⏳ Jam absen datang hari ini belum dimulai (mulai pukul ${jamMulaiAbsen}). Data hari ini belum dihitung -- tren di bawah dibandingkan dari hari-hari sekolah sebelumnya.`
    };
  }
  if (!belumMulaiHariIni && poinValid.length >= 2) {
    const terakhir = poinValid[poinValid.length - 1];
    const sebelumnya = poinValid[poinValid.length - 2];
    const selisih = Math.round((terakhir.persen - sebelumnya.persen) * 10) / 10;
    let arah = 'stabil';
    if (selisih >= 1) arah = 'naik';
    else if (selisih <= -1) arah = 'turun';

    const satuan = rentang === 'minggu' ? 'hari' : 'minggu';
    if (arah === 'naik') {
      tren = {
        arah, selisih,
        pesan: `📈 Tren membaik — kehadiran ${satuan} terakhir naik ${fmtPersenID(selisih)}% dibanding ${satuan} sebelumnya.`
      };
    } else if (arah === 'turun') {
      tren = {
        arah, selisih,
        pesan: `📉 Tren menurun — kehadiran ${satuan} terakhir turun ${fmtPersenID(Math.abs(selisih))}% dibanding ${satuan} sebelumnya. Perlu perhatian.`
      };
    } else {
      tren = {
        arah, selisih,
        pesan: `➡️ Tren stabil — kehadiran ${satuan} terakhir relatif sama dengan ${satuan} sebelumnya (${selisih > 0 ? '+' : ''}${fmtPersenID(selisih)}%).`
      };
    }
  } else if (!belumMulaiHariIni && poinValid.length === 1) {
    tren = { arah: 'kosong', selisih: 0, pesan: 'Baru ada 1 periode dengan data, tren belum bisa dibandingkan.' };
  }

  return {
    success: true,
    rentang, kelas: kelas || null,
    totalSiswa: totalSiswa || 0,
    poin, rataRata, tren
  };
}

module.exports = {
  supabase, hashPassword, verifyPassword, generateID, generateUsername,
  generatePassword, setCors, getJamSetting, todayStr,
  jamSekarang, hariIni, tambahMenit, generateQrToken, generateAdminQrToken, generateRiwayatToken,
  generateRiwayatTokenBatch, generateGuruQrToken, generateGuruQrTokenBatch,
  encryptPassword, decryptPassword,
  // ── TAMBAHAN BARU ──
  isHariLibur, isHariKerja, getHariKerjaSettings, getSemesterAktif,
  requireAdminToken, getJamPulangEfektif, isGuruPiketHariIni,
  // ── TAMBAHAN BARU (perbaikan performa scan) ──
  fetchJamPulangOverride, computeJamPulangEfektif,
  cekIzinPiket, resolveGuruIdFromToken,
  cekJadwalMengajarSaatIni, buatResolverJamPelajaran, hitungDefaultJamPelajaran,
  generateSesiToken, verifySesiToken,
  ringkasanLiveHariIni, ringkasanRekapPeriode,
  // ── TAMBAHAN BARU (perbaikan keamanan: kiosk token & rate limit) ──
  generateKioskToken, verifyKioskToken,
  checkRateLimit, getClientIp,
  // ── TAMBAHAN BARU (perbaikan bug: % Kehadiran Evaluasi Semester) ──
  hitungJumlahHariSekolah, hitungTanggalEvaluasiEfektif,
  // ── TAMBAHAN BARU (fitur Jadwal Besok) ──
  tanggalBesok, hariBesok,
  // ── TAMBAHAN BARU (fitur tombol "Persentase Kehadiran" di scan.html) ──
  getTrenPersentaseKehadiran
};

// ── HITUNG JUMLAH HARI SEKOLAH EFEKTIF DALAM RENTANG TANGGAL BEBAS ──
// (BARU) Sebelumnya logika "jumlah hari sekolah dalam rentang" cuma ada
// inline di dalam ringkasanRekapPeriode() (khusus rentang 'minggu'/'bulan'
// relatif ke hari ini). Halaman "Evaluasi Kehadiran" (semester) butuh
// hitungan yang sama tapi untuk rentang tanggal BEBAS (tanggal mulai/
// selesai semester) -- makanya dipisah jadi fungsi sendiri yang bisa
// dipakai ulang, dan dipakai kehadiran.js untuk action baru
// 'getJumlahHariSekolah'. Menghitung: untuk tiap tanggal di rentang,
// hari itu dianggap "hari sekolah" kalau nama harinya aktif di
// pengaturan_hari_kerja DAN tanggal itu tidak ada di tabel hari_kerja
// (kalender hari libur).
async function hitungJumlahHariSekolah(tanggalMulai, tanggalSelesai) {
  const [
    { data: liburRows },
    { data: hariKerjaSetting }
  ] = await Promise.all([
    supabase.from('hari_kerja').select('tanggal').gte('tanggal', tanggalMulai).lte('tanggal', tanggalSelesai),
    supabase.from('pengaturan_hari_kerja').select('*')
  ]);

  const liburSet = new Set((liburRows || []).map(r => String(r.tanggal).substring(0, 10)));
  const hariAktifMap = {};
  (hariKerjaSetting || []).forEach(h => { hariAktifMap[h.hari] = h.aktif; });
  const namaHariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  let jumlahHariSekolah = 0;
  const cur = new Date(tanggalMulai + 'T00:00:00Z');
  const akhir = new Date(tanggalSelesai + 'T00:00:00Z');
  while (cur <= akhir) {
    const tgl = cur.toISOString().substring(0, 10);
    const namaHari = namaHariArr[cur.getUTCDay()];
    const aktif = hariAktifMap.hasOwnProperty(namaHari) ? hariAktifMap[namaHari] : false;
    if (aktif && !liburSet.has(tgl)) jumlahHariSekolah++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return jumlahHariSekolah;
}
// ── TANGGAL EVALUASI EFEKTIF (single source of truth) ──────────────
// (BARU) Akar masalah bug "% Kehadiran > 100%" di halaman Evaluasi
// Kehadiran BUKAN di rumusnya, tapi di INKONSISTENSI rentang tanggal:
//   - Pembilang (rekapBulananRange / rekapKeteranganRange di
//     absensi.js & kehadiran.js) query pakai tanggalSelesai = akhir
//     SEMESTER (dataset.selesai di index.html, sering bulan depan),
//     jadi otomatis ikut data absensi HARI INI kalau sudah ada.
//   - Penyebut (jumlahHariSekolah) sebelumnya dibatasi sampai
//     "kemarin" (lihat komentar lama di getJumlahHariSekolah) --
//     sengaja TIDAK menghitung hari ini sama sekali.
//   => Begitu ada absensi hari ini, pembilang naik duluan sementara
//      penyebut masih tertinggal 1 hari di belakang -> persentase
//      bisa lewat 100%.
// Perbaikannya: satu fungsi ini dipakai sebagai SATU-SATUNYA sumber
// kebenaran untuk "sampai tanggal berapa evaluasi ini dihitung", lalu
// dipakai SAMA PERSIS oleh pembilang maupun penyebut. Aturannya
// sederhana: batasi tanggalSelesai semester supaya tidak pernah lebih
// jauh dari HARI INI (menurut waktu sekolah/WITA, lihat todayStr()) --
// hari-hari di masa depan yang jelas belum terjadi tidak pernah
// dihitung di kedua sisi, dan hari ini dihitung di KEDUA sisi kalau
// sudah masuk rentang semester (bukan cuma di satu sisi seperti bug
// sebelumnya).
//
// PERBAIKAN BARU (bug "Alpha 1" muncul padahal jam absen belum buka):
// Sebelumnya begitu HARI INI masuk rentang semester, hari itu LANGSUNG
// dihitung sebagai hari sekolah efektif (masuk ke penyebut) walaupun
// jam absen datang (JAM_DATANG_MULAI) belum mulai sama sekali -- jadi
// dari tengah malam sampai sebelum jam absen dibuka, SEMUA siswa
// otomatis kehilangan 1 hari "kemungkinan hadir" yang belum sempat
// mereka penuhi sama sekali -> tampil "Alpha 1" massal yang menyesatkan.
// Sekarang dipakai pola yang sama dengan getTrenPersentaseKehadiran()
// di atas: kalau tanggalSelesaiEfektif jatuh persis di hari ini DAN
// jam sekarang masih sebelum JAM_DATANG_MULAI, hari ini dianggap
// "belum bisa dievaluasi" -> tanggalSelesaiEfektif dimundurkan ke
// kemarin, sehingga hari ini tidak ikut dihitung di kedua sisi
// (pembilang maupun penyebut) sampai jam absen benar-benar dibuka.
async function hitungTanggalEvaluasiEfektif(tanggalMulaiSemester, tanggalSelesaiSemester) {
  const hariIniStr = todayStr();
  const tanggalMulaiEfektif = tanggalMulaiSemester;
  let tanggalSelesaiEfektif = tanggalSelesaiSemester < hariIniStr
    ? tanggalSelesaiSemester   // semester sudah berakhir sebelum hari ini
    : hariIniStr;              // semester masih berjalan -> batasi sampai hari ini

  let belumMulaiHariIni = false;
  let jamMulaiAbsen = '06:30';
  if (tanggalSelesaiEfektif === hariIniStr) {
    const jamSetting = await getJamSetting();
    jamMulaiAbsen = jamSetting['JAM_DATANG_MULAI'] || '06:30';
    if (jamSekarang() < jamMulaiAbsen) {
      belumMulaiHariIni = true;
      const kemarin = new Date(hariIniStr + 'T00:00:00Z');
      kemarin.setUTCDate(kemarin.getUTCDate() - 1);
      tanggalSelesaiEfektif = kemarin.toISOString().substring(0, 10);
    }
  }

  // Semester belum mulai (mis. tanggal mulai masih di masa depan), ATAU
  // hari ini dimundurkan ke kemarin di atas padahal semester baru mulai
  // hari ini juga -> belum ada satu hari pun yang bisa dievaluasi.
  const belumMulai = tanggalMulaiEfektif > tanggalSelesaiEfektif;
  return { tanggalMulaiEfektif, tanggalSelesaiEfektif, belumMulai, belumMulaiHariIni, jamMulaiAbsen };
}

async function requireAdminToken(token) {
  if (!token) return false;
  // Sengaja TIDAK pakai .maybeSingle() di sini: kalau suatu saat ada lebih
  // dari 1 baris admin yang qr_token-nya kebetulan sama (data lama/dobel,
  // migrasi, dll), .maybeSingle() akan mengembalikan ERROR (bukan data)
  // untuk kasus itu -- dan kode sebelumnya HANYA membaca `data` (mengabaikan
  // `error`), jadi token yang sebenarnya valid bisa dianggap tidak valid
  // ("Sesi admin tidak valid") padahal cocok. .limit(1) + cek panjang array
  // tidak punya masalah ini.
  const { data } = await supabase
    .from('admin')
    .select('username')
    .eq('qr_token', String(token).trim())
    .limit(1);
  return !!(data && data.length > 0);
}
