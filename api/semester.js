// api/semester.js — Manajemen Semester
const { supabase, generateID, setCors, requireAdminToken } = require('./_db');

// getAll & getAktif tetap terbuka (dipakai scan.js/absensi.js untuk validasi
// periode semester saat scan). tambah/edit/hapus/setAktif mengubah data
// master semester, wajib admin.
const AKSI_TERKUNCI = new Set(['tambah', 'edit', 'hapus', 'setAktif']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, ...params } = req.body || {};

  if (AKSI_TERKUNCI.has(action)) {
    const valid = await requireAdminToken(adminToken);
    if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  try {
    if (action === 'getAll')     return res.json(await getAll());
    if (action === 'tambah')     return res.json(await tambah(params));
    if (action === 'edit')       return res.json(await edit(params));
    if (action === 'hapus')      return res.json(await hapus(params));
    if (action === 'setAktif')   return res.json(await setAktif(params));
    if (action === 'getAktif')   return res.json(await getAktif());
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

async function getAll() {
  const { data, error } = await supabase
    .from('semester').select('*').order('tanggal_mulai', { ascending: false });
  if (error) return { success: false, message: error.message };
  return { success: true, data: data || [] };
}

async function tambah({ data }) {
  if (!data.nama || !data.tanggalMulai || !data.tanggalSelesai)
    return { success: false, message: 'Nama, tanggal mulai, dan tanggal selesai wajib diisi' };
  const id = generateID('SM');
  const { error } = await supabase.from('semester').insert({
    id, nama: data.nama, tahun_ajaran: data.tahunAjaran || '',
    tanggal_mulai: data.tanggalMulai,
    tanggal_selesai: data.tanggalSelesai,
    aktif: false
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Semester berhasil ditambahkan' };
}

async function edit({ id, data }) {
  const { error } = await supabase.from('semester').update({
    nama: data.nama, tahun_ajaran: data.tahunAjaran || '',
    tanggal_mulai: data.tanggalMulai,
    tanggal_selesai: data.tanggalSelesai
  }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Semester berhasil diperbarui' };
}

async function hapus({ id }) {
  const { error } = await supabase.from('semester').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Semester berhasil dihapus' };
}

async function setAktif({ id }) {
  // Nonaktifkan semua dulu
  await supabase.from('semester').update({ aktif: false }).neq('id', 'x');
  // Aktifkan yang dipilih
  const { error } = await supabase.from('semester').update({ aktif: true }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Semester aktif berhasil diubah' };
}

async function getAktif() {
  const { data } = await supabase.from('semester')
    .select('*').eq('aktif', true).maybeSingle();
  return { success: true, data: data || null };
}
