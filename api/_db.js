// api/_db.js — Shared Supabase client untuk semua API functions

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── HASH PASSWORD (SHA-256 sederhana via crypto) ──────────
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
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
    .select('keterangan')
    .eq('tanggal', tanggal)
    .maybeSingle();
  return data ? { libur: true, keterangan: data.keterangan } : { libur: false };
}

// ── CEK HARI KERJA (Senin-Sabtu sesuai pengaturan) ───────
async function isHariKerja(namaHari) {
  const { data } = await supabase
    .from('pengaturan_hari_kerja')
    .select('aktif')
    .eq('hari', namaHari)
    .maybeSingle();
  return data ? data.aktif : true;
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
module.exports = {
  supabase, hashPassword, generateID, generateUsername,
  generatePassword, setCors, getJamSetting, todayStr,
  jamSekarang, hariIni, tambahMenit, generateQrToken, generateRiwayatToken,
  // ── TAMBAHAN BARU ──
  isHariLibur, isHariKerja, getHariKerjaSettings, getSemesterAktif,
  requireAdminToken
};
async function requireAdminToken(token) {
  if (!token) return false;
  const { data } = await supabase
    .from('admin')
    .select('username')
    .eq('qr_token', token)
    .maybeSingle();
  return !!data;
}
