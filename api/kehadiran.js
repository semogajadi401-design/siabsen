// api/kehadiran.js — Kehadiran hari ini, input sakit/izin
const {
  supabase, generateID, setCors, todayStr, hariIni,
  isHariLibur, isHariKerja, getHariKerjaSettings
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getStatusHariIni')    return res.json(await getStatusHariIni());
    if (action === 'getSiswaKehadiran')   return res.json(await getSiswaKehadiran(params));
    if (action === 'inputKeterangan')     return res.json(await inputKeterangan(params));
    if (action === 'hapusKeterangan')     return res.json(await hapusKeterangan(params));
    if (action === 'getHariKerja')        return res.json(await getHariKerja());
    if (action === 'rekapKeteranganRange') return res.json(await rekapKeteranganRange(params));
    if (action === 'updateHariKerja')     return res.json(await updateHariKerja(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── CEK STATUS HARI INI ───────────────────────────────────
// Apakah hari ini libur atau hari kerja aktif
async function getStatusHariIni() {
  const today = todayStr();
  const hari = hariIni();

  // Cek hari libur kalender
  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur) {
    return {
      success: true,
      bisaAbsen: false,
      alasan: 'libur_kalender',
      keterangan: cekLibur.keterangan,
      tanggal: today,
      hari
    };
  }

  // Cek hari kerja sesuai pengaturan sekolah
  const hariAktif = await isHariKerja(hari);
  if (!hariAktif) {
    return {
      success: true,
      bisaAbsen: false,
      alasan: 'hari_libur_sekolah',
      keterangan: `${hari} bukan hari sekolah`,
      tanggal: today,
      hari
    };
  }

  return {
    success: true,
    bisaAbsen: true,
    tanggal: today,
    hari
  };
}

async function rekapKeteranganRange({ tanggalMulai, tanggalSelesai, kelas }) {
  let q = supabase.from('keterangan_absensi').select('*')
    .gte('tanggal', tanggalMulai)
    .lte('tanggal', tanggalSelesai);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return { success: true, data: data || [] };
}

// ── GET DATA KEHADIRAN SISWA HARI INI ────────────────────
// Menggabungkan: siswa aktif + record absensi + keterangan sakit/izin
async function getSiswaKehadiran({ kelas, tanggal }) {
  const tgl = tanggal || todayStr();

  // 1. Ambil semua siswa aktif (filter kelas jika ada)
  let qSiswa = supabase.from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin')
    .eq('status', 'Aktif')
    .order('nama');
  if (kelas && kelas !== '') qSiswa = qSiswa.eq('kelas', kelas);
  const { data: siswaSemua, error: eSiswa } = await qSiswa;
  if (eSiswa) return { success: false, message: eSiswa.message };

  // 2. Ambil record absensi hari ini
  let qAbsen = supabase.from('absensi')
    .select('*').eq('tanggal', tgl);
  if (kelas && kelas !== '') qAbsen = qAbsen.eq('kelas', kelas);
  const { data: absenData } = await qAbsen;

  // 3. Ambil keterangan sakit/izin hari ini
  let qKet = supabase.from('keterangan_absensi')
    .select('*').eq('tanggal', tgl);
  if (kelas && kelas !== '') qKet = qKet.eq('kelas', kelas);
  const { data: ketData } = await qKet;

  // 4. Gabungkan data
  const absenMap = {};
  (absenData || []).forEach(a => { absenMap[a.id_siswa] = a; });

  const ketMap = {};
  (ketData || []).forEach(k => { ketMap[k.id_siswa] = k; });

  const hadir = [];
  const belumHadir = [];

  (siswaSemua || []).forEach(s => {
    const absen = absenMap[s.id];
    const ket = ketMap[s.id];

    if (absen && absen.jam_datang) {
      // Sudah scan absen datang
      hadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        jamDatang: absen.jam_datang,
        statusDatang: absen.status_datang,
        jamPulang: absen.jam_pulang || null,
        statusPulang: absen.status_pulang || null,
        idAbsen: absen.id
      });
    } else if (ket) {
      // Ada keterangan sakit/izin dari guru
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        status: ket.status,
        keterangan: ket.keterangan,
        diinputOleh: ket.diinput_oleh,
        idKeterangan: ket.id,
        sudahAdaKeterangan: true
      });
    } else {
      // Belum hadir, belum ada keterangan = Alpha
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        status: 'Alpha',
        keterangan: null,
        sudahAdaKeterangan: false
      });
    }
  });

  // 5. Hitung statistik
  const totalSiswa = siswaSemua?.length || 0;
  const totalHadir = hadir.filter(h => h.statusDatang === 'Hadir').length;
  const totalTerlambat = hadir.filter(h => h.statusDatang === 'Terlambat').length;
  const totalSakit = belumHadir.filter(b => b.status === 'Sakit').length;
  const totalIzin = belumHadir.filter(b =>
    ['Izin','Urusan Keluarga','Izin Lainnya'].includes(b.status)
  ).length;
  const totalAlpha = belumHadir.filter(b => b.status === 'Alpha').length;

  return {
    success: true,
    tanggal: tgl,
    statistik: {
      totalSiswa, totalHadir, totalTerlambat,
      totalSakit, totalIzin, totalAlpha,
      totalBelumHadir: belumHad
