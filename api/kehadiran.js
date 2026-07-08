// api/kehadiran.js — Kehadiran hari ini, input sakit/izin
const {
  supabase, generateID, setCors, todayStr, hariIni,
  isHariLibur, isHariKerja, requireAdminToken, isGuruPiketHariIni,
  resolveGuruIdFromToken
} = require('./_db');

// CATATAN: action 'getHariKerja' dan 'updateHariKerja' yang dulu ada di file
// ini SUDAH DIHAPUS karena isinya menduplikasi persis action
// 'getPengaturanHari'/'updatePengaturanHari' di api/settings.js (sama-sama
// baca/tulis tabel pengaturan_hari_kerja). Frontend (index.html) memang
// sudah memakai versi settings.js, jadi versi di sini kode mati — dan
// nama 'getHariKerja' di sini membingungkan karena api/settings.js punya
// action dengan nama SAMA ('getHariKerja') untuk hal yang beda sama sekali
// (kalender hari libur per tanggal, tabel hari_kerja). Kalau butuh
// pengaturan hari sekolah aktif, pakai api/settings.js.
//
// PENTING — DIPERBAIKI: sebelumnya SEMUA action di file ini dikunci
// requireAdminToken, termasuk yang cuma baca laporan (getStatusHariIni,
// getSiswaKehadiran, rekapKeteranganRange). Itu cocok selama halaman yang
// memakainya (Kehadiran Hari Ini, Evaluasi Kehadiran) cuma dibuka oleh
// admin -- tapi begitu akun Kepala Sekolah (role terpisah, lihat
// api/guru.js & schema.sql) perlu buka menu Rekap/Evaluasi Kehadiran
// sebagai pengawas, requestnya GAGAL karena kepsek tidak dan tidak
// seharusnya punya adminToken. Disamakan dengan pola api/absensi.js &
// api/settings.js: hanya action yang MENGUBAH/MENGHAPUS data
// (inputKeterangan, hapusKeterangan) yang dikunci; action baca (laporan)
// tetap terbuka.
const AKSI_TERKUNCI = new Set(['inputKeterangan', 'hapusKeterangan']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, guruToken, ...params } = req.body || {};
  // PENTING (perbaikan keamanan): `idGuru` TIDAK LAGI dipercaya dari body
  // untuk urusan identitas/otorisasi -- id guru bisa dibaca siapa saja
  // lewat settings.getGuruPiket (endpoint publik "siapa piket hari ini"),
  // jadi kalau dipercaya mentah, siapa pun bisa mengaku jadi guru piket
  // tanpa login sama sekali. Identitas guru sekarang HARUS diturunkan dari
  // `guruToken` (qr_token rahasia, didapat saat login lewat auth.js dan
  // disisipkan otomatis oleh helper api() di frontend) lewat
  // resolveGuruIdFromToken() -- lihat _db.js.
  const guruIdTerverifikasi = guruToken ? await resolveGuruIdFromToken(guruToken) : null;

  if (AKSI_TERKUNCI.has(action)) {
    // Dua jalur yang diizinkan:
    //   1. Admin dengan adminToken valid (seperti sebelumnya, tidak berubah).
    //   2. Guru yang BENAR-BENAR piket hari ini (sesi_piket), dan identitas
    //      guru itu sendiri sudah dibuktikan lewat guruToken di atas --
    //      bukan sekadar idGuru yang diklaim klien.
    const adminValid = await requireAdminToken(adminToken);
    if (!adminValid) {
      const guruValid = guruIdTerverifikasi && await isGuruPiketHariIni(guruIdTerverifikasi);
      if (!guruValid) {
        return res.status(401).json({ success: false, message: 'Sesi tidak valid. Hanya admin atau guru piket hari ini yang bisa mengubah keterangan.' });
      }
    }
  }

  try {
    if (action === 'getStatusHariIni')     return res.json(await getStatusHariIni());
    if (action === 'getSiswaKehadiran')    return res.json(await getSiswaKehadiran(params));
    if (action === 'inputKeterangan')      return res.json(await inputKeterangan(params));
    if (action === 'hapusKeterangan')      return res.json(await hapusKeterangan(params));
    if (action === 'rekapKeteranganRange') return res.json(await rekapKeteranganRange(params));
    // Dipakai frontend (guruNav) untuk tahu apakah menu "Kehadiran Hari Ini"
    // perlu ditampilkan: true hanya kalau guru YANG SEDANG LOGIN (dibuktikan
    // lewat guruToken) ada di sesi_piket hari ini, terlepas dari jadwal_piket
    // admin. Tidak lagi menerima idGuru mentah dari klien.
    if (action === 'cekPiketSaya') {
      const piket = guruIdTerverifikasi ? await isGuruPiketHariIni(guruIdTerverifikasi) : false;
      return res.json({ success: true, piketHariIni: piket });
    }
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── CEK STATUS HARI INI ───────────────────────────────────────────
async function getStatusHariIni() {
  const today = todayStr();
  const hari  = hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur) {
    return {
      success: true, bisaAbsen: false,
      alasan: 'libur_kalender',
      keterangan: cekLibur.keterangan,
      tanggal: today, hari
    };
  }

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif) {
    return {
      success: true, bisaAbsen: false,
      alasan: 'hari_libur_sekolah',
      keterangan: `${hari} bukan hari sekolah`,
      tanggal: today, hari
    };
  }

  return { success: true, bisaAbsen: true, tanggal: today, hari };
}

// ── GET DATA KEHADIRAN SISWA ──────────────────────────────────────
async function getSiswaKehadiran({ kelas, tanggal }) {
  const tgl = tanggal || todayStr();

  // 1. Semua siswa aktif
  let qSiswa = supabase
    .from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin')
    .eq('status', 'Aktif')
    .order('nama');
  if (kelas && kelas !== '') qSiswa = qSiswa.eq('kelas', kelas);
  const { data: siswaSemua, error: eSiswa } = await qSiswa;
  if (eSiswa) return { success: false, message: eSiswa.message };

  // 2. Record absensi hari ini
  let qAbsen = supabase.from('absensi').select('*').eq('tanggal', tgl);
  if (kelas && kelas !== '') qAbsen = qAbsen.eq('kelas', kelas);
  const { data: absenData } = await qAbsen;

  // 3. Keterangan sakit/izin hari ini
  let qKet = supabase.from('keterangan_absensi').select('*').eq('tanggal', tgl);
  if (kelas && kelas !== '') qKet = qKet.eq('kelas', kelas);
  const { data: ketData } = await qKet;

  // 4. Buat map untuk lookup cepat
  const absenMap = {};
  (absenData || []).forEach(a => { absenMap[a.id_siswa] = a; });

  const ketMap = {};
  (ketData || []).forEach(k => { ketMap[k.id_siswa] = k; });

  const hadir      = [];
  const belumHadir = [];

  (siswaSemua || []).forEach(s => {
    const absen = absenMap[s.id];
    const ket   = ketMap[s.id];

    if (absen && absen.jam_datang) {
      hadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        jamDatang:    absen.jam_datang,
        statusDatang: absen.status_datang,
        jamPulang:    absen.jam_pulang    || null,
        statusPulang: absen.status_pulang || null,
        idAbsen: absen.id
      });
    } else if (ket) {
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        status:       ket.status,
        keterangan:   ket.keterangan,
        diinputOleh:  ket.diinput_oleh,
        idKeterangan: ket.id,
        sudahAdaKeterangan: true
      });
    } else {
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        status: 'Alpha', keterangan: null,
        sudahAdaKeterangan: false
      });
    }
  });

  // 5. Statistik
  const totalSiswa     = siswaSemua?.length || 0;
  const totalHadir     = hadir.filter(h => h.statusDatang === 'Hadir').length;
  const totalTerlambat = hadir.filter(h => h.statusDatang === 'Terlambat').length;
  const totalSakit     = belumHadir.filter(b => b.status === 'Sakit').length;
  const totalIzin      = belumHadir.filter(b =>
    ['Izin','Urusan Keluarga','Izin Lainnya'].includes(b.status)
  ).length;
  const totalAlpha     = belumHadir.filter(b => b.status === 'Alpha').length;

  return {
    success: true,
    tanggal: tgl,
    statistik: {
      totalSiswa, totalHadir, totalTerlambat,
      totalSakit, totalIzin, totalAlpha,
      totalBelumHadir: belumHadir.length
    },
    hadir,
    belumHadir
  };
}

// ── INPUT KETERANGAN SAKIT / IZIN ────────────────────────────────
async function inputKeterangan({ idSiswa, status, keterangan, diinputOleh }) {
  if (!idSiswa || !status)
    return { success: false, message: 'ID siswa dan status wajib diisi' };

  const today = todayStr();

  const { data: siswa } = await supabase
    .from('siswa').select('nisn,nama,kelas').eq('id', idSiswa).maybeSingle();
  if (!siswa) return { success: false, message: 'Siswa tidak ditemukan' };

  // Cek sudah ada keterangan hari ini atau belum
  const { data: existing } = await supabase
    .from('keterangan_absensi')
    .select('id').eq('id_siswa', idSiswa).eq('tanggal', today).maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('keterangan_absensi')
      .update({
        status,
        keterangan:   keterangan   || '',
        diinput_oleh: diinputOleh  || ''
      })
      .eq('id', existing.id);
    if (error) return { success: false, message: error.message };
    return { success: true, message: 'Keterangan berhasil diperbarui' };
  }

  const id = generateID('KT');
  const { error } = await supabase.from('keterangan_absensi').insert({
    id,
    id_siswa:     idSiswa,
    nisn:         siswa.nisn,
    nama_siswa:   siswa.nama,
    kelas:        siswa.kelas,
    tanggal:      today,
    status,
    keterangan:   keterangan  || '',
    diinput_oleh: diinputOleh || ''
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan berhasil disimpan' };
}

// ── HAPUS KETERANGAN ─────────────────────────────────────────────
async function hapusKeterangan({ idKeterangan }) {
  if (!idKeterangan)
    return { success: false, message: 'ID keterangan wajib diisi' };

  const { error } = await supabase
    .from('keterangan_absensi').delete().eq('id', idKeterangan);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan berhasil dihapus' };
}

// ── REKAP KETERANGAN RANGE (untuk evaluasi semester) ─────────────
async function rekapKeteranganRange({ tanggalMulai, tanggalSelesai, kelas }) {
  let q = supabase.from('keterangan_absensi').select('*')
    .gte('tanggal', tanggalMulai)
    .lte('tanggal', tanggalSelesai);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(d => ({
      idSiswa:    d.id_siswa,
      nisn:       d.nisn,
      nama:       d.nama_siswa,
      kelas:      d.kelas,
      tanggal:    d.tanggal,
      status:     d.status,
      keterangan: d.keterangan
    }))
  };
}

// (getHariKerja/updateHariKerja duplikat sudah dihapus — lihat catatan di atas)
