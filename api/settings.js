// api/settings.js — Jam setting, jadwal piket, hari kerja
const { supabase, generateID, setCors, getJamSetting } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getJamSetting')     return res.json(await getAll());
    if (action === 'updateJamSetting')  return res.json(await updateSetting(params));
    if (action === 'getJadwalPiket')    return res.json(await getJadwalPiket());
    if (action === 'setJadwalPiket')    return res.json(await setJadwalPiket(params));
    if (action === 'getHariKerja')      return res.json(await getHariKerjaKalender(params));
    if (action === 'setHariLibur')      return res.json(await setHariLibur(params));
    if (action === 'hapusHariLibur')    return res.json(await hapusHariLibur(params));
    if (action === 'getConstants')      return res.json(getConstants());
    if (action === 'getGuruPiket')      return res.json(await getGuruPiket());
    if (action === 'getPengaturanHari') return res.json(await getPengaturanHari());
    if (action === 'updatePengaturanHari') return res.json(await updatePengaturanHari(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── GET SEMUA JAM SETTING ─────────────────────────────────────────
async function getAll() {
  try {
    return { success: true, data: await getJamSetting() };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// ── UPDATE JAM SETTING / PROFIL SEKOLAH ──────────────────────────
async function updateSetting({ settings }) {
  const upserts = Object.entries(settings).map(([kunci, nilai]) => ({
    kunci, nilai, deskripsi: ''
  }));
  const { error } = await supabase
    .from('jam_setting')
    .upsert(upserts, { onConflict: 'kunci' });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Pengaturan berhasil disimpan' };
}

// ── JADWAL PIKET ──────────────────────────────────────────────────
async function getJadwalPiket() {
  const { data, error } = await supabase.from('jadwal_piket').select('*');
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(j => ({
      id: j.id, hari: j.hari,
      idGuru: j.id_guru, namaGuru: j.nama_guru, jabatan: j.jabatan
    }))
  };
}

async function setJadwalPiket({ jadwalList }) {
  // Hapus semua jadwal lama
  await supabase.from('jadwal_piket').delete().neq('id', 'x');

  if (!jadwalList || !jadwalList.length)
    return { success: true, message: 'Jadwal piket dikosongkan' };

  const inserts = [];
  for (const j of jadwalList) {
    const guruIds = Array.isArray(j.idGuruList)
      ? j.idGuruList
      : [j.idGuru].filter(Boolean);

    for (const idGuru of guruIds) {
      const { data: guru } = await supabase
        .from('guru').select('nama,jabatan').eq('id', idGuru).single();
      if (!guru) continue;
      inserts.push({
        id: generateID('PK'),
        hari: j.hari,
        id_guru: idGuru,
        nama_guru: guru.nama,
        jabatan: guru.jabatan
      });
    }
  }

  if (inserts.length) {
    const { error } = await supabase.from('jadwal_piket').insert(inserts);
    if (error) return { success: false, message: error.message };
  }
  return { success: true, message: 'Jadwal piket berhasil disimpan' };
}

// ── HARI KERJA KALENDER (libur nasional per tanggal) ─────────────
// Dipakai oleh halaman Kalender Hari Kerja (klik tanggal = tandai libur)
async function getHariKerjaKalender({ bulan, tahun }) {
  if (!bulan || !tahun)
    return { success: false, message: 'Bulan dan tahun wajib diisi' };

  const start = `${tahun}-${String(bulan).padStart(2, '0')}-01`;
  const end   = `${tahun}-${String(bulan).padStart(2, '0')}-31`;

  const { data, error } = await supabase
    .from('hari_kerja').select('*')
    .gte('tanggal', start).lte('tanggal', end);

  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(h => ({
      tanggal: h.tanggal,
      keterangan: h.keterangan,
      tipe: h.tipe
    }))
  };
}

async function setHariLibur({ tanggal, keterangan }) {
  const { error } = await supabase
    .from('hari_kerja')
    .upsert({ tanggal, keterangan, tipe: 'Libur' }, { onConflict: 'tanggal' });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Hari libur berhasil disimpan' };
}

async function hapusHariLibur({ tanggal }) {
  const { error } = await supabase
    .from('hari_kerja').delete().eq('tanggal', tanggal);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Hari libur berhasil dihapus' };
}

// ── PENGATURAN HARI AKTIF SEKOLAH (Senin s/d Sabtu dst) ──────────
// Dipakai oleh halaman Pengaturan Semester → Hari Sekolah Aktif
async function getPengaturanHari() {
  const urutan = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const { data, error } = await supabase
    .from('pengaturan_hari_kerja').select('*');
  if (error) return { success: false, message: error.message };

  // Jika tabel kosong, kembalikan default Senin-Jumat aktif
  if (!data || !data.length) {
    return {
      success: true,
      data: urutan.map(h => ({ hari: h, aktif: ['Senin','Selasa','Rabu','Kamis','Jumat'].includes(h) }))
    };
  }

  const sorted = [...data].sort(
    (a, b) => urutan.indexOf(a.hari) - urutan.indexOf(b.hari)
  );
  return { success: true, data: sorted };
}

async function updatePengaturanHari({ hariList }) {
  if (!hariList || !hariList.length)
    return { success: false, message: 'Data hari kerja kosong' };

  for (const item of hariList) {
    await supabase
      .from('pengaturan_hari_kerja')
      .upsert({ hari: item.hari, aktif: item.aktif }, { onConflict: 'hari' });
  }
  return { success: true, message: 'Pengaturan hari kerja berhasil disimpan' };
}

// ── GURU PIKET HARI INI ───────────────────────────────────────────
async function getGuruPiket() {
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const wib = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  const hari = days[wib.getDay()];
  const { data } = await supabase
    .from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari);
  return {
    success: true,
    data: (data || []).map(p => ({
      idGuru: p.id_guru, namaGuru: p.nama_guru, jabatan: p.jabatan
    })),
    hari
  };
}

// ── CONSTANTS ─────────────────────────────────────────────────────
function getConstants() {
  return {
    success: true,
    jabatanList: [
      'Kepala Sekolah','Wakil Kepala Sekolah','Guru','Wali Kelas',
      'Guru BK','Guru Olahraga','Guru Agama','Staf Tata Usaha',
      'Operator','Kepala Tata Usaha','Pustakawan','Satpam','Petugas Kebersihan'
    ],
    agamaList: ['Islam','Kristen','Katolik','Hindu','Buddha','Konghucu'],
    hariList: ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'],
    kelasList: ['X-1','X-2','X-3','XI-1','XI-2','XI-3','XII-1','XII-2','XII-3']
  };
}
