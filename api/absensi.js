// api/absensi.js — Absensi datang, pulang, rekap
const { supabase, generateID, setCors, getJamSetting, todayStr, jamSekarang, hariIni } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'datang')        return res.json(await absensiDatang(params));
    if (action === 'pulang')        return res.json(await absensiPulang(params));
    if (action === 'rekapHarian')   return res.json(await rekapHarian(params));
    if (action === 'rekapBulanan')  return res.json(await rekapBulanan(params));
    if (action === 'dashboard')     return res.json(await dashboard());
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function absensiDatang({ idSiswa, idGuru, namaGuru, metode }) {
  // Ambil data siswa
  const { data: siswa } = await supabase.from('siswa').select('*').eq('id', idSiswa).single();
  if (!siswa) return { success: false, message: 'Data siswa tidak ditemukan' };

  const today = todayStr();
  const jam = jamSekarang();
  const hari = hariIni();

  // Cek sudah absen belum
  const { data: existing } = await supabase.from('absensi')
    .select('id,jam_datang').eq('id_siswa', idSiswa).eq('tanggal', today).single();
  if (existing?.jam_datang) {
    return { success: false, message: `${siswa.nama} sudah absen datang hari ini pukul ${existing.jam_datang}` };
  }

  // Ambil jam setting
  const jamSetting = await getJamSetting();
  const jamMulai  = jamSetting['JAM_DATANG_MULAI']   || '06:30';
  const jamSelesai = jamSetting['JAM_DATANG_SELESAI'] || '08:00';

  // Validasi rentang jam absensi datang
  if (jam < jamMulai) {
    return { success: false, message: `Absensi datang belum dibuka. Mulai pukul ${jamMulai} WIB` };
  }
  if (jam > jamSelesai) {
    // Tetap izinkan tapi tandai Terlambat (tidak blokir)
  }

  const statusDatang = jam > jamSelesai ? 'Terlambat' : 'Hadir';

  const id = generateID('AB');
  const { error } = await supabase.from('absensi').insert({
    id, id_siswa: idSiswa, nisn: siswa.nisn, nama_siswa: siswa.nama,
    kelas: siswa.kelas, tanggal: today, hari, jam_datang: jam,
    status_datang: statusDatang, id_guru_piket: idGuru||'',
    nama_guru_piket: namaGuru||'', metode: metode||'Manual'
  });

  if (error) return { success: false, message: 'Gagal menyimpan absensi: ' + error.message };

  return {
    success: true,
    message: statusDatang === 'Terlambat'
      ? `⚠️ ${siswa.nama} TERLAMBAT - ${jam}`
      : `✅ ${siswa.nama} berhasil absen datang - ${jam}`,
    status: statusDatang,
    siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
  };
}

async function absensiPulang({ idSiswa, idGuru, namaGuru, metode }) {
  const today = todayStr();
  const jam = jamSekarang();

  const { data: absen } = await supabase.from('absensi')
    .select('*').eq('id_siswa', idSiswa).eq('tanggal', today).single();
  if (!absen) return { success: false, message: 'Siswa belum absen datang hari ini' };
  if (absen.jam_pulang) return { success: false, message: `${absen.nama_siswa} sudah absen pulang hari ini pukul ${absen.jam_pulang}` };
  if (!absen.jam_datang) return { success: false, message: `${absen.nama_siswa} belum absen datang hari ini` };

  // Validasi jam pulang
  const jamSetting = await getJamSetting();
  const jamMulaiPulang = jamSetting['JAM_PULANG_MULAI'] || '14:00';
  if (jam < jamMulaiPulang) {
    return { success: false, message: `Absensi pulang belum dibuka. Mulai pukul ${jamMulaiPulang} WIB` };
  }

  const { error } = await supabase.from('absensi').update({
    jam_pulang: jam, status_pulang: 'Pulang',
    id_guru_piket: idGuru||'', nama_guru_piket: namaGuru||'', metode: metode||'Manual'
  }).eq('id', absen.id);

  if (error) return { success: false, message: 'Gagal menyimpan absensi pulang: ' + error.message };

  return {
    success: true,
    message: `✅ ${absen.nama_siswa} berhasil absen pulang - ${jam}`,
    status: 'Pulang',
    siswa: { nama: absen.nama_siswa, kelas: absen.kelas, nisn: absen.nisn }
  };
}

async function rekapHarian({ tanggal }) {
  const { data, error } = await supabase.from('absensi').select('*').eq('tanggal', tanggal).order('jam_datang');
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data||[]).map(d => ({
      id: d.id, idSiswa: d.id_siswa, nisn: d.nisn, nama: d.nama_siswa,
      kelas: d.kelas, tanggal: d.tanggal, hari: d.hari,
      jamDatang: d.jam_datang, statusDatang: d.status_datang,
      jamPulang: d.jam_pulang, statusPulang: d.status_pulang,
      namaGuruPiket: d.nama_guru_piket, keterangan: d.keterangan, metode: d.metode
    }))
  };
}

async function rekapBulanan({ bulan, tahun, kelas }) {
  const start = `${tahun}-${String(bulan).padStart(2,'0')}-01`;
  const end = `${tahun}-${String(bulan).padStart(2,'0')}-31`;
  let q = supabase.from('absensi').select('*').gte('tanggal', start).lte('tanggal', end);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  const grouped = {};
  (data||[]).forEach(r => {
    if (!grouped[r.id_siswa]) {
      grouped[r.id_siswa] = { idSiswa: r.id_siswa, nisn: r.nisn, nama: r.nama_siswa, kelas: r.kelas, hadir: 0, terlambat: 0, pulang: 0 };
    }
    if (r.status_datang === 'Hadir') grouped[r.id_siswa].hadir++;
    if (r.status_datang === 'Terlambat') grouped[r.id_siswa].terlambat++;
    if (r.status_pulang === 'Pulang') grouped[r.id_siswa].pulang++;
  });
  return { success: true, data: Object.values(grouped) };
}

async function dashboard() {
  const today = todayStr();
  const [{ count: totalSiswa }, { count: totalGuru }, { data: absenHariIni }, jamSetting, piket] = await Promise.all([
    supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status','Aktif'),
    supabase.from('guru').select('*', { count: 'exact', head: true }).eq('status','Aktif'),
    supabase.from('absensi').select('status_datang,status_pulang').eq('tanggal', today),
    getJamSetting(),
    supabase.from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hariIni())
  ]);

  const hadirHariIni = (absenHariIni||[]).filter(a => a.status_datang === 'Hadir').length;
  const terlambatHariIni = (absenHariIni||[]).filter(a => a.status_datang === 'Terlambat').length;

  return {
    success: true,
    data: {
      totalSiswa: totalSiswa||0, totalGuru: totalGuru||0,
      hadirHariIni, terlambatHariIni,
      alphaHariIni: Math.max(0, (totalSiswa||0) - hadirHariIni - terlambatHariIni),
      jamSetting,
      piketHariIni: (piket.data||[]).map(p => ({ idGuru: p.id_guru, namaGuru: p.nama_guru, jabatan: p.jabatan })),
      hariIni: hariIni()
    }
  };
}
