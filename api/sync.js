const {
  supabase, generateID, setCors,
  hariIni, isHariLibur, getSemesterAktif
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'batchSync') return res.json(await batchSync(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── BATCH SYNC: terima array antrian scan dari offline ────────────
async function batchSync({ items }) {
  if (!items || !Array.isArray(items) || items.length === 0)
    return { success: false, message: 'Tidak ada data untuk disinkronkan' };

  const results = [];

  for (const item of items) {
    try {
      const r = await processSingleScan(item);
      results.push({ id: item.localId, ...r });
    } catch(e) {
      results.push({ id: item.localId, success: false, message: e.message });
    }
  }

  const berhasil = results.filter(r => r.success).length;
  const gagal    = results.filter(r => !r.success).length;

  return {
    success: true,
    total: items.length,
    berhasil,
    gagal,
    results
  };
}

async function processSingleScan({ identifier, mode, tanggal, jam, hari, namaGuru, idGuru }) {
  if (!identifier) return { success: false, message: 'Identifier kosong' };

  // Format QR siswa: "SW_ID|NISN" — ambil bagian sebelum "|"
  const raw = identifier.trim();
  const id  = raw.includes('|') && !raw.startsWith('ADMIN|') && !raw.startsWith('GR')
    ? raw.split('|')[0]
    : raw;

  // ── CEK GURU ────────────────────────────────────────────────────
  if (id.startsWith('GR')) {
    const { data: guru } = await supabase
      .from('guru').select('id,nama,jabatan,status').eq('id', id).maybeSingle();

    if (!guru)           return { success: false, message: 'Guru tidak ditemukan', tipe: 'guru' };
    if (guru.status !== 'Aktif') return { success: false, message: 'Akun guru tidak aktif', tipe: 'guru' };

    const { data: sudahScan } = await supabase
      .from('sesi_piket').select('id')
      .eq('tanggal', tanggal).eq('id_guru', guru.id).maybeSingle();

    if (sudahScan) return {
      success: false, tipe: 'guru',
      message: `${guru.nama} sudah tercatat sebagai guru piket`
    };

    const sesiId = generateID('SP');
    await supabase.from('sesi_piket').insert({
      id: sesiId, tanggal, id_guru: guru.id,
      nama_guru: guru.nama, jabatan: guru.jabatan, jam_scan: jam
    });

    return {
      success: true, tipe: 'guru',
      message: `${guru.nama} tercatat sebagai guru piket (${jam})`
    };
  }

  // ── CEK SISWA ───────────────────────────────────────────────────
  const { data: siswaById } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('id', id).maybeSingle();
  const { data: siswaByNisn } = siswaById ? { data: null } : await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('nisn', id).maybeSingle();

  const siswa = siswaById || siswaByNisn;
  if (!siswa) return { success: false, tipe: 'siswa', message: 'Siswa tidak ditemukan' };
  if (siswa.status !== 'Aktif') return { success: false, tipe: 'siswa', message: 'Siswa tidak aktif' };

  // Ambil guru piket dari sesi hari itu
  const { data: sesiList } = await supabase
    .from('sesi_piket').select('*').eq('tanggal', tanggal).order('jam_scan');

  const guruAktif  = sesiList && sesiList.length > 0 ? sesiList[sesiList.length - 1] : null;
  const namaGP     = namaGuru || guruAktif?.nama_guru || null;
  const idGP       = idGuru   || guruAktif?.id_guru   || null;

  // Cek absensi hari itu
  const { data: absenHariIni } = await supabase
    .from('absensi').select('*')
    .eq('id_siswa', siswa.id).eq('tanggal', tanggal).maybeSingle();

  const jamPulangMulai = '14:00';

  // Mode pulang
  if (mode === 'pulang' || jam >= jamPulangMulai) {
    if (!absenHariIni)
      return { success: false, tipe: 'siswa', message: `${siswa.nama} belum absen datang` };
    if (absenHariIni.jam_pulang)
      return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen pulang pukul ${absenHariIni.jam_pulang}` };

    await supabase.from('absensi').update({
      jam_pulang: jam, status_pulang: 'Pulang',
      nama_guru_piket: namaGP, id_guru_piket: idGP
    }).eq('id', absenHariIni.id);

    return {
      success: true, tipe: 'siswa', status: 'Pulang',
      message: `${siswa.nama} absen pulang - ${jam}`,
      siswa: { nama: siswa.nama, kelas: siswa.kelas }
    };
  }

  // Mode datang
  if (absenHariIni?.jam_datang)
    return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen datang pukul ${absenHariIni.jam_datang}` };

  const jamBatasDatang = '08:00';
  const statusDatang   = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
  const absenId        = generateID('AB');

  await supabase.from('absensi').insert({
    id: absenId, id_siswa: siswa.id, nisn: siswa.nisn,
    nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal, hari, jam_datang: jam,
    status_datang: statusDatang,
    id_guru_piket: idGP, nama_guru_piket: namaGP,
    metode: 'QR-OFFLINE'
  });

  return {
    success: true, tipe: 'siswa', status: statusDatang,
    message: `${siswa.nama} absen datang - ${jam} (${statusDatang})`,
    siswa: { nama: siswa.nama, kelas: siswa.kelas }
  };
}
