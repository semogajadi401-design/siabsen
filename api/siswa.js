// api/siswa.js — CRUD Data Siswa
const { supabase, generateID, setCors } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getAll')     return res.json(await getAll(params));
    if (action === 'tambah')     return res.json(await tambah(params));
    if (action === 'edit')       return res.json(await edit(params));
    if (action === 'hapus')      return res.json(await hapus(params));
    if (action === 'getByScan')  return res.json(await getByScan(params));
    if (action === 'importSiswa')return res.json(await importSiswa(params)); // ← TAMBAHAN FIX
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

async function getByScan({ identifier }) {
  const { data } = await supabase.from('siswa').select('id,nisn,nama,kelas,jenis_kelamin')
    .or(`id.eq.${identifier},nisn.eq.${identifier}`).eq('status','Aktif').single();
  if (!data) return { success: false, message: 'Siswa tidak ditemukan' };
  return { success: true, data: { id: data.id, nisn: data.nisn, nama: data.nama, kelas: data.kelas, jenisKelamin: data.jenis_kelamin } };
}

// ── IMPORT SISWA (TAMBAHAN) ───────────────────────────────────────────────────
async function importSiswa({ dataList }) {
  if (!dataList || !dataList.length) {
    return { success: false, message: 'Tidak ada data untuk diimport' };
  }

  let berhasil = 0;
  let gagal = 0;
  const errors = [];

  for (const data of dataList) {
    // Validasi field wajib
    if (!data.nisn || !data.nama) {
      gagal++;
      errors.push(`Baris dilewati: NISN atau Nama kosong (${data.nisn || '-'})`);
      continue;
    }

    // Cek NISN sudah ada
    const { data: existing } = await supabase
      .from('siswa').select('id').eq('nisn', data.nisn.trim()).single();
    if (existing) {
      gagal++;
      errors.push(`NISN ${data.nisn} (${data.nama}) sudah terdaftar, dilewati`);
      continue;
    }

    const id = generateID('SW');
    const { error } = await supabase.from('siswa').insert({
      id,
      nisn: data.nisn.trim(),
      nama: data.nama.trim(),
      jenis_kelamin: data.jenisKelamin || 'Laki-laki',
      tempat_lahir: data.tempatLahir || '',
      tanggal_lahir: data.tanggalLahir || null,
      agama: data.agama || 'Islam',
      kelas: data.kelas || '',
      tahun_masuk: parseInt(data.tahunMasuk) || new Date().getFullYear(),
      nama_ortu: data.namaOrtu || '',
      no_hp_ortu: data.noHpOrtu || '',
      alamat: data.alamat || '',
      status: 'Aktif'
    });

    if (error) {
      gagal++;
      errors.push(`Gagal import ${data.nama} (${data.nisn}): ${error.message}`);
    } else {
      berhasil++;
    }
  }

  return {
    success: true,
    message: `Import selesai: ${berhasil} berhasil, ${gagal} gagal`,
    berhasil,
    gagal,
    errors
  };
}
