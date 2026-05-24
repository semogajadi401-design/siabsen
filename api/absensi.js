const {
  supabase, generateID, setCors, getJamSetting,
  todayStr, jamSekarang, hariIni,
  isHariLibur, isHariKerja, getSemesterAktif
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'datang')            return res.json(await absensiDatang(params));
    if (action === 'pulang')            return res.json(await absensiPulang(params));
    if (action === 'rekapHarian')       return res.json(await rekapHarian(params));
    if (action === 'rekapBulanan')      return res.json(await rekapBulanan(params));
    if (action === 'rekapBulananRange') return res.json(await rekapBulananRange(params));
    if (action === 'dashboard')         return res.json(await dashboard());
    if (action === 'resetAbsensi')      return res.json(await resetAbsensi(params));
    if (action === 'scanAbsen')         return res.json(await scanAbsen(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function scanAbsen({ identifier, idGuru, namaGuru, mode }) {
  const today = todayStr();
  const hari  = hariIni();

  // Cek hari libur kalender
  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur)
    return { success: false, message: `Hari ini libur: ${cekLibur.keterangan}` };

  // Cek hari kerja sekolah
  const hariAktif = await isHariKerja(hari);
  if (!hariAktif)
    return { success: false, message: `${hari} bukan hari sekolah` };

  // Cek semester aktif
  const semester = await getSemesterAktif();
  if (!semester)
    return { success: false, message: 'Tidak ada semester aktif. Hubungi admin.' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: false, message: `Di luar periode semester aktif (${semester.nama})` };
  // Cek apakah ada guru piket yang sudah scan hari ini
  const { data: sesiList } = await supabase
    .from('sesi_piket')
    .select('id')
    .eq('tanggal', today);

  if (!sesiList || sesiList.length === 0)
    return {
      success: false,
      message: 'Guru piket belum scan kartu. Absensi tidak bisa dilakukan.'
    };
  // ─────────────────────────────────────────────────────────────

  // Ambil jam setting sekali saja
  const jamSetting   = await getJamSetting();
  // Ambil jam setting sekali saja
  const jamSetting   = await getJamSetting();
  const jamMulai     = jamSetting['JAM_DATANG_MULAI']   || '06:00';
  const jamSelesaiOp = jamSetting['JAM_PULANG_SELESAI'] || '17:00';
  const jamBatasDatang = jamSetting['JAM_DATANG_SELESAI'] || '08:00';

  const jam = jamSekarang();

  // Cek jam operasional
  if (jam < jamMulai || jam > jamSelesaiOp)
    return { success: false, message: `Absensi hanya bisa dilakukan antara ${jamMulai} - ${jamSelesaiOp}` };

  // Validasi identifier
  if (!identifier) return { success: false, message: 'Identifier kosong' };
  const id = identifier.trim();

  // Cari siswa
  const { data: siswaById } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('id', id).maybeSingle();
  const { data: siswaByNisn } = siswaById ? { data: null } : await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('nisn', id).maybeSingle();

  const siswa = siswaById || siswaByNisn;
  if (!siswa) return { success: false, message: 'Siswa tidak ditemukan' };
  if (siswa.status !== 'Aktif') return { success: false, message: 'Siswa sudah tidak aktif' };

  // MODE PULANG
  if (mode === 'pulang') {
    const jamPulangMulai = jamSetting['JAM_PULANG_MULAI'] || '14:00';
    if (jam < jamPulangMulai)
      return { success: false, message: `Absensi pulang baru bisa dilakukan mulai ${jamPulangMulai}` };

    const { data: absen } = await supabase.from('absensi')
      .select('*').eq('id_siswa', siswa.id).eq('tanggal', today).maybeSingle();
    if (!absen)
      return { success: false, message: 'Belum absen datang hari ini' };
    if (absen.jam_pulang)
      return { success: false, message: `${siswa.nama} sudah absen pulang pukul ${absen.jam_pulang}` };

    const { error } = await supabase.from('absensi').update({
      jam_pulang: jam, status_pulang: 'Pulang',
      id_guru_piket: idGuru || '', nama_guru_piket: namaGuru || ''
    }).eq('id', absen.id);
    if (error) return { success: false, message: 'Gagal simpan absensi pulang: ' + error.message };

    return {
      success: true, status: 'Pulang',
      message: `✅ ${siswa.nama} absen pulang - ${jam}`,
      siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
    };
  }

  // MODE DATANG
  const { data: existing } = await supabase.from('absensi')
    .select('id,jam_datang').eq('id_siswa', siswa.id).eq('tanggal', today).maybeSingle();
  if (existing?.jam_datang)
    return { success: false, message: `${siswa.nama} sudah absen datang pukul ${existing.jam_datang}` };

  const statusDatang = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';

  const absenId = generateID('AB');
  const { error } = await supabase.from('absensi').insert({
    id: absenId, id_siswa: siswa.id, nisn: siswa.nisn,
    nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal: today, hari, jam_datang: jam,
    status_datang: statusDatang,
    id_guru_piket: idGuru || '', nama_guru_piket: namaGuru || '', metode: 'QR'
  });
  if (error) return { success: false, message: 'Gagal simpan absensi: ' + error.message };

  return {
    success: true, status: statusDatang,
    message: statusDatang === 'Terlambat'
      ? `⚠️ ${siswa.nama} TERLAMBAT - ${jam}`
      : `✅ ${siswa.nama} absen datang - ${jam}`,
    siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
  };
}
async function absensiDatang({ idSiswa, idGuru, namaGuru, metode }) {
  const { data: siswa } = await supabase.from('siswa').select('*').eq('id', idSiswa).single();
  if (!siswa) return { success: false, message: 'Data siswa tidak ditemukan' };

  const today = todayStr();
  const jam   = jamSekarang();
  const hari  = hariIni();

  const { data: existing } = await supabase.from('absensi')
    .select('id,jam_datang').eq('id_siswa', idSiswa).eq('tanggal', today).maybeSingle();
  if (existing?.jam_datang)
    return { success: false, message: `${siswa.nama} sudah absen datang hari ini pukul ${existing.jam_datang}` };

  const jamSetting   = await getJamSetting();
  const statusDatang = jam > (jamSetting['JAM_DATANG_SELESAI'] || '08:00') ? 'Terlambat' : 'Hadir';

  const id = generateID('AB');
  const { error } = await supabase.from('absensi').insert({
    id, id_siswa: idSiswa, nisn: siswa.nisn, nama_siswa: siswa.nama,
    kelas: siswa.kelas, tanggal: today, hari, jam_datang: jam,
    status_datang: statusDatang, id_guru_piket: idGuru || '',
    nama_guru_piket: namaGuru || '', metode: metode || 'Manual'
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
  const jam   = jamSekarang();

  const { data: absen } = await supabase.from('absensi')
    .select('*').eq('id_siswa', idSiswa).eq('tanggal', today).maybeSingle();
  if (!absen)
    return { success: false, message: 'Siswa belum absen datang hari ini' };
  if (absen.jam_pulang)
    return { success: false, message: `${absen.nama_siswa} sudah absen pulang hari ini pukul ${absen.jam_pulang}` };

  const { error } = await supabase.from('absensi').update({
    jam_pulang: jam, status_pulang: 'Pulang',
    id_guru_piket: idGuru || '', nama_guru_piket: namaGuru || '',
    metode: metode || 'Manual'
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
  const { data, error } = await supabase.from('absensi')
    .select('*').eq('tanggal', tanggal).order('jam_datang');
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(d => ({
      id: d.id, idSiswa: d.id_siswa, nisn: d.nisn, nama: d.nama_siswa,
      kelas: d.kelas, tanggal: d.tanggal, hari: d.hari,
      jamDatang: d.jam_datang, statusDatang: d.status_datang,
      jamPulang: d.jam_pulang, statusPulang: d.status_pulang,
      namaGuruPiket: d.nama_guru_piket, keterangan: d.keterangan, metode: d.metode
    }))
  };
}

async function rekapBulanan({ bulan, tahun, kelas }) {
  const start = `${tahun}-${String(bulan).padStart(2, '0')}-01`;
  const end   = `${tahun}-${String(bulan).padStart(2, '0')}-31`;
  let q = supabase.from('absensi').select('*').gte('tanggal', start).lte('tanggal', end);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  const grouped = {};
  (data || []).forEach(r => {
    if (!grouped[r.id_siswa]) {
      grouped[r.id_siswa] = {
        idSiswa: r.id_siswa, nisn: r.nisn, nama: r.nama_siswa,
        kelas: r.kelas, hadir: 0, terlambat: 0, pulang: 0
      };
    }
    if (r.status_datang === 'Hadir')     grouped[r.id_siswa].hadir++;
    if (r.status_datang === 'Terlambat') grouped[r.id_siswa].terlambat++;
    if (r.status_pulang === 'Pulang')    grouped[r.id_siswa].pulang++;
  });
  return { success: true, data: Object.values(grouped) };
}

async function rekapBulananRange({ tanggalMulai, tanggalSelesai, kelas }) {
  let q = supabase.from('absensi').select('*')
    .gte('tanggal', tanggalMulai)
    .lte('tanggal', tanggalSelesai);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  const grouped = {};
  (data || []).forEach(r => {
    if (!grouped[r.id_siswa]) {
      grouped[r.id_siswa] = {
        idSiswa: r.id_siswa, nisn: r.nisn,
        nama: r.nama_siswa, kelas: r.kelas,
        hadir: 0, terlambat: 0, pulang: 0
      };
    }
    if (r.status_datang === 'Hadir')     grouped[r.id_siswa].hadir++;
    if (r.status_datang === 'Terlambat') grouped[r.id_siswa].terlambat++;
    if (r.status_pulang === 'Pulang')    grouped[r.id_siswa].pulang++;
  });
  return { success: true, data: Object.values(grouped) };
}

async function dashboard() {
  const today = todayStr();
  const hari  = hariIni();

  const [
    { count: totalSiswa },
    { count: totalGuru },
    { data: absenHariIni },
    jamSetting,
    piket
  ] = await Promise.all([
    supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('guru').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('absensi')
      .select('nama_siswa, kelas, jam_datang, status_datang, status_pulang')
      .eq('tanggal', today),
    getJamSetting(),
    supabase.from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari)
  ]);

  const hadirHariIni     = (absenHariIni || []).filter(a =>
    a.status_datang === 'Hadir' || a.status_datang === 'Terlambat'
  ).length;
  const terlambatHariIni = (absenHariIni || []).filter(a =>
    a.status_datang === 'Terlambat'
  ).length;
  const alphaHariIni     = Math.max(0, (totalSiswa || 0) - hadirHariIni);

  const absenTerkini = (absenHariIni || [])
    .filter(a => a.jam_datang)
    .sort((a, b) => (b.jam_datang || '').localeCompare(a.jam_datang || ''))
    .slice(0, 5)
    .map(a => ({
      nama:      a.nama_siswa,
      kelas:     a.kelas,
      jamDatang: a.jam_datang,
      status:    a.status_datang
    }));

  return {
    success: true,
    data: {
      totalSiswa:      totalSiswa || 0,
      totalGuru:       totalGuru  || 0,
      hadirHariIni,
      terlambatHariIni,
      alphaHariIni,
      jamSetting,
      piketHariIni: (piket.data || []).map(p => ({
        idGuru: p.id_guru, namaGuru: p.nama_guru, jabatan: p.jabatan
      })),
      hariIni: hari,
      absenTerkini
    }
  };
}

async function resetAbsensi({ kelas, semua }) {
  if (semua) {
    const { error } = await supabase.from('absensi').delete().neq('id', 'x');
    if (error) return { success: false, message: 'Gagal reset absensi: ' + error.message };
    return { success: true, message: 'Seluruh riwayat absensi berhasil dihapus' };
  }
  if (!kelas || !kelas.length)
    return { success: false, message: 'Pilih minimal satu kelas' };
  const { error } = await supabase.from('absensi').delete().in('kelas', kelas);
  if (error) return { success: false, message: 'Gagal reset absensi: ' + error.message };
  return { success: true, message: `Riwayat absensi kelas ${kelas.join(', ')} berhasil dihapus` };
}
