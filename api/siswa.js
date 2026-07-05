// api/siswa.js — CRUD Data Siswa
const { supabase, generateID, setCors, generateQrToken, generateRiwayatToken, requireAdminToken } = require('./_db');

// getAll & getByScan TETAP TERBUKA karena dipakai scan.html (guru piket
// offline, tanpa sesi admin) untuk mengisi daftar kelas & mencari siswa.
// Aksi lain (tambah/ubah/hapus/reset/import/naik-kelas) mengubah data
// master, jadi wajib token admin valid.
const AKSI_TERKUNCI = new Set([
  'tambah', 'edit', 'hapus', 'resetSemua',
  'importSiswa', 'naikkanKelas', 'resetRiwayatToken',
  'regenerateAllRiwayatTokens'
]);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, ...params } = req.body || {};

  if (AKSI_TERKUNCI.has(action)) {
    const valid = await requireAdminToken(adminToken);
    if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  try {
    if (action === 'getAll')      return res.json(await getAll(params));
    if (action === 'tambah')      return res.json(await tambah(params));
    if (action === 'edit')        return res.json(await edit(params));
    if (action === 'hapus')       return res.json(await hapus(params));
    if (action === 'getByScan')   return res.json(await getByScan(params));
    if (action === 'importSiswa') return res.json(await importSiswa(params));
    if (action === 'resetSemua')  return res.json(await resetSemua());
    if (action === 'naikkanKelas') return res.json(await naikkanKelas(params));
    if (action === 'resetRiwayatToken') return res.json(await resetRiwayatToken(params));
    if (action === 'regenerateAllRiwayatTokens') return res.json(await regenerateAllRiwayatTokens());
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function getAll({ activeOnly, kelas }) {
  let q = supabase.from('siswa').select('*').order('nama');
  // activeOnly bisa datang sebagai boolean true atau string "true" — handle keduanya
  if (activeOnly === true || activeOnly === 'true') q = q.eq('status', 'Aktif');
  if (kelas && kelas !== '') q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  // Backfill riwayat_token untuk siswa lama yang belum punya token
  // (misal siswa yang ditambahkan sebelum fitur QR riwayat ada).
  const belumAdaToken = (data || []).filter(s => !s.riwayat_token);
  for (const s of belumAdaToken) {
    const token = await generateRiwayatToken();
    const { error: eUpdate } = await supabase.from('siswa').update({ riwayat_token: token }).eq('id', s.id);
    if (!eUpdate) s.riwayat_token = token;
  }

  return {
    success: true,
    data: (data || []).map(s => ({
      id: s.id, nisn: s.nisn, nama: s.nama,
      jenisKelamin: s.jenis_kelamin, tempatLahir: s.tempat_lahir,
      tanggalLahir: s.tanggal_lahir, agama: s.agama, kelas: s.kelas,
      tahunMasuk: s.tahun_masuk, namaOrtu: s.nama_ortu,
      noHpOrtu: s.no_hp_ortu, alamat: s.alamat, status: s.status,
      riwayatToken: s.riwayat_token
    }))
  };
}

async function tambah({ data }) {
  const id = generateID('SW');
  const { error } = await supabase.from('siswa').insert({
    id, nisn: data.nisn, nama: data.nama,
    jenis_kelamin: data.jenisKelamin, tempat_lahir: data.tempatLahir,
    tanggal_lahir: data.tanggalLahir || null, agama: data.agama,
    kelas: data.kelas, tahun_masuk: data.tahunMasuk || new Date().getFullYear(),
    nama_ortu: data.namaOrtu || '', no_hp_ortu: data.noHpOrtu || '',
    alamat: data.alamat || '', status: 'Aktif',
    riwayat_token: await generateRiwayatToken()
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Siswa berhasil ditambahkan', id };
}

async function edit({ id, data }) {
  const { error } = await supabase.from('siswa').update({
    nisn: data.nisn, nama: data.nama, jenis_kelamin: data.jenisKelamin,
    tempat_lahir: data.tempatLahir, tanggal_lahir: data.tanggalLahir || null,
    agama: data.agama, kelas: data.kelas,
    tahun_masuk: data.tahunMasuk, nama_ortu: data.namaOrtu || '',
    no_hp_ortu: data.noHpOrtu || '', alamat: data.alamat || ''
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
  if (!identifier) return { success: false, message: 'Identifier kosong' };
  const id = identifier.trim();

  // Cari berdasarkan ID siswa dulu
  const { data: byId } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('id', id).maybeSingle();
  if (byId) {
    if (byId.status !== 'Aktif') return { success: false, message: 'Siswa sudah tidak aktif' };
    return { success: true, data: { id: byId.id, nisn: byId.nisn, nama: byId.nama, kelas: byId.kelas, jenisKelamin: byId.jenis_kelamin } };
  }

  // Kalau tidak ketemu by ID, cari by NISN
  const { data: byNisn } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('nisn', id).maybeSingle();
  if (byNisn) {
    if (byNisn.status !== 'Aktif') return { success: false, message: 'Siswa sudah tidak aktif' };
    return { success: true, data: { id: byNisn.id, nisn: byNisn.nisn, nama: byNisn.nama, kelas: byNisn.kelas, jenisKelamin: byNisn.jenis_kelamin } };
  }

  return { success: false, message: 'Siswa tidak ditemukan' };
}

// ── IMPORT SISWA ─────────────────────────────────────────────────
async function importSiswa({ dataList }) {
  if (!dataList || !dataList.length)
    return { success: false, message: 'Tidak ada data untuk diimport' };

  let berhasil = 0, gagal = 0;
  const errors = [];

  for (const data of dataList) {
    if (!data.nisn || !data.nama) {
      gagal++;
      errors.push(`Baris dilewati: NISN atau Nama kosong (${data.nisn || '-'})`);
      continue;
    }

    // Cek NISN sudah ada
    const { data: existing } = await supabase
      .from('siswa').select('id').eq('nisn', data.nisn.trim()).maybeSingle();
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
      status: 'Aktif',
      riwayat_token: await generateRiwayatToken()
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
    berhasil, gagal, errors
  };
}

// ── RESET SEMUA SISWA (hapus permanen + absensinya) ──────────────
async function resetSemua() {
  const { error: e0 } = await supabase.from('keterangan_absensi').delete().neq('id', 'x');
  if (e0) return { success: false, message: 'Gagal hapus keterangan: ' + e0.message };

  const { error: e1 } = await supabase.from('absensi').delete().neq('id', 'x');
  if (e1) return { success: false, message: 'Gagal hapus absensi: ' + e1.message };

  const { error: e2 } = await supabase.from('siswa').delete().neq('id', 'x');
  if (e2) return { success: false, message: 'Gagal hapus siswa: ' + e2.message };

  return { success: true, message: 'Semua data siswa dan absensi berhasil dihapus' };
}
// ── RESET TOKEN QR RIWAYAT (kartu hilang / dicetak ulang) ────────
// Token lama otomatis tidak berlaku lagi begitu diganti, karena
// halaman riwayat mencari siswa berdasarkan token yang cocok persis.
async function resetRiwayatToken({ id }) {
  if (!id) return { success: false, message: 'ID siswa wajib diisi' };
  const token = await generateRiwayatToken();
  const { error } = await supabase.from('siswa').update({ riwayat_token: token }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Token QR riwayat berhasil direset. Cetak ulang kartu agar QR baru terpakai.', riwayatToken: token };
}

// ── PERBARUI SEMUA TOKEN QR RIWAYAT SEKALIGUS ────────────────────
// Dipakai sekali saja setelah update ke token pendek (12 karakter),
// supaya siswa yang SUDAH ADA di database (yang tokennya masih versi
// lama 48 karakter hex) ikut dapat token baru yang pendek. Tanpa ini,
// token lama tetap tersimpan apa adanya dan QR di kartu lama akan
// tetap padat walau kode generatornya sudah diganti.
// PENTING: setelah dijalankan, SEMUA kartu siswa yang sudah dicetak
// duluan jadi tidak berlaku lagi untuk fitur riwayat (harus dicetak
// ulang), karena token lamanya sudah diganti.
async function regenerateAllRiwayatTokens() {
  const { data, error } = await supabase.from('siswa').select('id');
  if (error) return { success: false, message: error.message };

  let berhasil = 0, gagal = 0;
  for (const s of (data || [])) {
    const token = await generateRiwayatToken();
    const { error: eUpdate } = await supabase.from('siswa').update({ riwayat_token: token }).eq('id', s.id);
    if (eUpdate) gagal++; else berhasil++;
  }

  return {
    success: true,
    message: `Selesai. ${berhasil} token diperbarui${gagal ? `, ${gagal} gagal` : ''}. Cetak ulang SEMUA kartu siswa agar QR riwayat yang baru (lebih renggang) terpakai.`,
    berhasil, gagal
  };
}

async function naikkanKelas({ dari, ke, luluskan }) {
  if (!dari) return { success: false, message: 'Kelas asal wajib dipilih' };

  if (luluskan) {
    const { data, error } = await supabase
      .from('siswa')
      .update({ status: 'Lulus' })
      .eq('kelas', dari)
      .eq('status', 'Aktif')
      .select('id');
    if (error) return { success: false, message: error.message };
    return { success: true, message: `${data.length} siswa kelas ${dari} berhasil diluluskan`, jumlah: data.length };
  }

  if (!ke) return { success: false, message: 'Kelas tujuan wajib dipilih' };
  if (dari === ke) return { success: false, message: 'Kelas asal dan tujuan tidak boleh sama' };

  const { data, error } = await supabase
    .from('siswa')
    .update({ kelas: ke })
    .eq('kelas', dari)
    .eq('status', 'Aktif')
    .select('id');
  if (error) return { success: false, message: error.message };
  return { success: true, message: `${data.length} siswa berhasil dinaikkan dari ${dari} ke ${ke}`, jumlah: data.length };
}
