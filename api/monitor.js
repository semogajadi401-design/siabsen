// api/monitor.js — Dashboard Pengawasan Kepala Sekolah (PUBLIK, diakses via
// QR halaman BELAKANG kartu kepsek).
//
// LATAR: sebelumnya QR belakang kartu kepsek sama persis fungsinya dengan
// QR belakang kartu guru biasa -- "GURU_LOGIN|token" untuk bypass login ke
// akun kepsek. Sekarang diganti KHUSUS untuk role kepsek: QR-nya jadi URL
// "https://.../monitor/TOKEN" yang membuka halaman ringkasan keadaan
// sekolah saat ini (read-only, tanpa perlu login manual sama sekali) --
// jalan pintas kepsek untuk lihat: kehadiran siswa, siapa piket & sudah
// lapor/belum, siapa guru sedang/sudah/belum mengajar, dan rekap kehadiran
// siswa per minggu/bulan.
//
// KEAMANAN (sama pola dengan api/riwayat.js untuk siswa):
//  - Kepsek dicari lewat guru.qr_token acak (kolom yang sama dipakai untuk
//    QR login guru biasa), BUKAN lewat id/username, supaya tidak bisa
//    ditebak-tebak.
//  - HANYA guru dengan role === 'kepsek' yang boleh lewat sini. Token guru
//    biasa yang kebetulan valid tetap DITOLAK -- endpoint ini tidak pernah
//    dipakai untuk bypass login akun apapun (beda dari GURU_LOGIN di
//    scan.js/auth.js), jadi aman diakses siapapun yang menemukan kartu
//    kepsek tercecer: paling jauh cuma bisa lihat ringkasan sekolah, tidak
//    bisa masuk ke akun kepsek.
//  - Data yang dikembalikan cuma agregat/ringkasan (jumlah, nama, kelas,
//    jam), tidak pernah data sensitif seperti alamat/no HP ortu/password.
const {
  supabase, setCors, getJamSetting, resolveGuruIdFromToken,
  ringkasanLiveHariIni, ringkasanRekapPeriode
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getInfo')         return res.json(await getInfo(params));
    if (action === 'getLiveHariIni')  return res.json(await getLiveHariIni(params));
    if (action === 'getRekapPeriode') return res.json(await getRekapPeriode(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── VALIDASI TOKEN: HARUS guru aktif DENGAN role kepsek ───────────
async function findKepsekByToken(token) {
  const idGuru = await resolveGuruIdFromToken(token);
  if (!idGuru) return null;
  const { data: guru } = await supabase
    .from('guru').select('id,nama,role,status').eq('id', idGuru).maybeSingle();
  if (!guru || guru.role !== 'kepsek' || guru.status !== 'Aktif') return null;
  return guru;
}

async function getInfo({ token }) {
  const kepsek = await findKepsekByToken(token);
  if (!kepsek) return { success: false, message: 'Kode QR tidak valid atau bukan kartu Kepala Sekolah' };
  const settings = await getJamSetting();
  return {
    success: true,
    kepsek: { nama: kepsek.nama },
    namaSekolah: settings['NAMA_SEKOLAH'] || 'Sekolah'
  };
}

// ════════════════════════════════════════════════════════════════
// LIVE HARI INI — kehadiran siswa, piket, & status mengajar guru
// SAAT INI JUGA (real-time), TIDAK dipengaruhi filter minggu/bulan.
// ════════════════════════════════════════════════════════════════
async function getLiveHariIni({ token }) {
  const kepsek = await findKepsekByToken(token);
  if (!kepsek) return { success: false, message: 'Kode QR tidak valid atau bukan kartu Kepala Sekolah' };
  const data = await ringkasanLiveHariIni();
  return { success: true, ...data };
}

// ════════════════════════════════════════════════════════════════
// REKAP PERIODE — kehadiran siswa & kepatuhan piket untuk rentang
// minggu (7 hari terakhir termasuk hari ini) atau bulan (1 s/d hari
// ini bulan berjalan).
// ════════════════════════════════════════════════════════════════
async function getRekapPeriode({ token, rentang }) {
  const kepsek = await findKepsekByToken(token);
  if (!kepsek) return { success: false, message: 'Kode QR tidak valid atau bukan kartu Kepala Sekolah' };
  if (!['minggu', 'bulan'].includes(rentang)) return { success: false, message: 'Rentang harus "minggu" atau "bulan"' };
  const data = await ringkasanRekapPeriode(rentang);
  return { success: true, ...data };
}
