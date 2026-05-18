// api/siswa.js — CRUD Data Siswa
const { supabase, generateID, setCors } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getAll')      return res.json(await getAll(params));
    if (action === 'tambah')      return res.json(await tambah(params));
    if (action === 'edit')        return res.json(await edit(params));
    if (action === 'hapus')       return res.json(await hapus(params));
    if (action === 'getByScan')   return res.json(await getByScan(params));
    if (action === 'importSiswa') return res.json(await importSiswa(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function getAll({ activeOnly, kelas }) {
  let q = supabase.from('siswa').select('*').order('nama');
  if (activeOnly) q = q.eq('status', 'Aktif');
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data||[]).map(s => ({
      id: s.id, nisn: s.nisn, nama: s.nama,
      jenisKelamin: s.jenis_kelamin, tempatLahir: s.tempat_lahir,
      tanggalLahir: s.tanggal_lahir, agama: s.agama, kelas: s.kelas,
      tahunMasuk: s.tahun_masuk, namaOrtu: s.nama_ortu,
      noHpOrtu: s.no_hp_ortu, alamat: s.alamat, status: s.status
    }))
  };
}

async function tambah({ data }) {
  const id = generateID('SW');
  const { error } = await supabase.from('siswa').insert({
    id, nisn: data.nisn, nama: data.nama,
    jenis_kelamin: data.jenisKelamin, tempat_lahir: data.tempatLahir,
    tanggal_lahir: data.tanggalLahir||null, agama: data.agama,
    kelas: data.kelas, tahun_masuk: data.tahunMasuk||new Date().getFullYear(),
    nama_ortu: data.namaOrtu||'', no_hp_ortu: data.noHpOrtu||'',
    alamat: data.alamat||'', status: 'Aktif'
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Siswa berhasil ditambahkan', id };
}

async function edit({ id, data }) {
  const { error } = await supabase.from('siswa').update({
    nisn: data.nisn, nama: data.nama, jenis_kelamin: data.jenisKelamin,
    tempat_lahir: data.tempatLahir, tanggal_lahir: data.tanggalLahir||null,
    agama: data.agama, kelas: data.kelas,
    tahun_masuk: data.tahunMasuk, nama_ortu: data.namaOrtu||'',
    no_hp_ortu: data.noHpOrtu||'', alamat: data.alamat||''
  }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Data siswa berhasil diperbarui' };
}

async function hapus({ id }) {
  const { error } = await supabase.from('siswa').update({ status: 'Nonaktif' }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Siswa berhasil dinonaktifkan' };
}

// ── FIX: getByScan mendukung format QR "id|nisn|nama" dan pencarian fleksibel ──
async function getByScan({ identifier }) {
  if (!identifier) return { success: false, message: 'Identifier kosong' };

  // QR code format: "SW...|nisn|nama" — ambil bagian pertama
  const cleanId = identifier.split('|')[0].trim();

  // Coba cari berdasarkan id (exact) ATAU nisn (exact)
  const { data, error } = await supabase
    .from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin')
    .or(`id.eq.${cleanId},nisn.eq.${cleanId}`)
    .eq('status', 'Aktif')
    .limit(1);

  if (error) return { success: false, message: error.message };
  if (!data || data.length === 0) {
    return { success: false, message: `Siswa tidak ditemukan (ID: ${cleanId})` };
  }

  const s = data[0];
  return {
    success: true,
    data: { id: s.id, nisn: s.nisn, nama: s.nama, kelas: s.kelas, jenisKelamin: s.jenis_kelamin }
  };
}

// ── IMPORT SISWA MASSAL dari array data CSV/Excel ──
async function importSiswa({ dataList }) {
  if (!dataList || !Array.isArray(dataList) || dataList.length === 0) {
    return { success: false, message: 'Data kosong' };
  }

  const results = { berhasil: 0, gagal: 0, errors: [] };

  for (const row of dataList) {
    if (!row.nisn || !row.nama || !row.kelas) {
      results.gagal++;
      results.errors.push(`Baris dilewati: NISN/Nama/Kelas wajib (${row.nama || 'tanpa nama'})`);
      continue;
    }

    // Cek apakah NISN sudah ada
    const { data: existing } = await supabase
      .from('siswa').select('id').eq('nisn', row.nisn.toString().trim()).single();

    if (existing) {
      results.gagal++;
      results.errors.push(`NISN ${row.nisn} sudah terdaftar (${row.nama})`);
      continue;
    }

    const id = generateID('SW');
    const { error } = await supabase.from('siswa').insert({
      id,
      nisn: row.nisn.toString().trim(),
      nama: row.nama.toString().trim(),
      jenis_kelamin: row.jenisKelamin || row.jenis_kelamin || 'Laki-laki',
      tempat_lahir: row.tempatLahir || row.tempat_lahir || '',
      tanggal_lahir: row.tanggalLahir || row.tanggal_lahir || null,
      agama: row.agama || 'Islam',
      kelas: row.kelas.toString().trim(),
      tahun_masuk: parseInt(row.tahunMasuk || row.tahun_masuk) || new Date().getFullYear(),
      nama_ortu: row.namaOrtu || row.nama_ortu || '',
      no_hp_ortu: row.noHpOrtu || row.no_hp_ortu || '',
      alamat: row.alamat || '',
      status: 'Aktif'
    });

    if (error) {
      results.gagal++;
      results.errors.push(`${row.nama}: ${error.message}`);
    } else {
      results.berhasil++;
    }
  }

  return {
    success: true,
    message: `Import selesai: ${results.berhasil} berhasil, ${results.gagal} gagal`,
    berhasil: results.berhasil,
    gagal: results.gagal,
    errors: results.errors
  };
}
