// api/guru.js — CRUD Data Guru
const { supabase, hashPassword, generateID, generateUsername, generatePassword, setCors, requireAdminToken } = require('./_db');

// Semua aksi di file ini mengubah/menghapus data master guru, jadi semuanya
// wajib login admin. Hanya dipanggil dari index.html (dashboard admin),
// tidak dipakai scan.html, jadi aman dikunci semua.
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, ...params } = req.body || {};

  const valid = await requireAdminToken(adminToken);
  if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });

  try {
    if (action === 'getAll')        return res.json(await getAll(params));
    if (action === 'tambah')        return res.json(await tambah(params));
    if (action === 'edit')          return res.json(await edit(params));
    if (action === 'hapus')         return res.json(await hapus(params));
    if (action === 'hapusPermanen') return res.json(await hapusPermanen(params));
    if (action === 'resetPassword') return res.json(await resetPassword(params));
    if (action === 'resetSemua')    return res.json(await resetSemua());
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function getAll({ activeOnly }) {
  let q = supabase.from('guru')
    .select('id,nama,jenis_kelamin,jabatan,nip,no_hp,email,alamat,username,status,created_at')
    .order('nama');
  if (activeOnly === true || activeOnly === 'true') q = q.eq('status', 'Aktif');
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(g => ({
      id: g.id, nama: g.nama, jenisKelamin: g.jenis_kelamin,
      jabatan: g.jabatan, nip: g.nip, noHp: g.no_hp,
      email: g.email, alamat: g.alamat, username: g.username, status: g.status
    }))
  };
}

async function tambah({ data }) {
  const id = generateID('GR');
  const username = await generateUsername(data.nama);
  const rawPassword = (data.password && data.password.trim().length >= 6)
    ? data.password.trim() : generatePassword();
  const { error } = await supabase.from('guru').insert({
    id, nama: data.nama, jenis_kelamin: data.jenisKelamin,
    jabatan: data.jabatan, nip: data.nip || '', no_hp: data.noHp || '',
    email: data.email || '', alamat: data.alamat || '',
    username, password: hashPassword(rawPassword), status: 'Aktif'
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Guru berhasil ditambahkan', username, password: rawPassword, id };
}

async function edit({ id, data }) {
  const updates = {
    nama: data.nama, jenis_kelamin: data.jenisKelamin,
    jabatan: data.jabatan, nip: data.nip || '', no_hp: data.noHp || '',
    email: data.email || '', alamat: data.alamat || ''
  };
  if (data.password && data.password.trim().length >= 6) {
    updates.password = hashPassword(data.password.trim());
  }
  const { error } = await supabase.from('guru').update(updates).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Data guru berhasil diperbarui' };
}

async function hapus({ id }) {
  const { error } = await supabase.from('guru').update({ status: 'Nonaktif' }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Guru berhasil dinonaktifkan' };
}

async function hapusPermanen({ id }) {
  const { error } = await supabase.from('guru').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Data guru berhasil dihapus permanen' };
}

async function resetPassword({ id }) {
  const { data: guru } = await supabase.from('guru').select('username').eq('id', id).single();
  if (!guru) return { success: false, message: 'Guru tidak ditemukan' };
  const newPass = generatePassword();
  await supabase.from('guru').update({ password: hashPassword(newPass) }).eq('id', id);
  return { success: true, message: 'Password direset', password: newPass, username: guru.username };
}

async function resetSemua() {
  const { error: e1 } = await supabase.from('jadwal_piket').delete().neq('id', 'x');
  if (e1) return { success: false, message: 'Gagal hapus jadwal piket: ' + e1.message };

  // PENTING: sesi_piket.id_guru adalah FOREIGN KEY ke guru(id) tanpa
  // ON DELETE CASCADE (lihat schema.sql). Kalau baris ini tidak dihapus
  // dulu, DELETE ke tabel guru akan GAGAL (foreign key violation) begitu
  // ada guru yang pernah tercatat sebagai guru piket — bug ini sebelumnya
  // membuat "Reset Guru" bisa diam-diam gagal di tengah proses.
  const { error: e2 } = await supabase.from('sesi_piket').delete().neq('id', 'x');
  if (e2) return { success: false, message: 'Gagal hapus riwayat sesi piket: ' + e2.message };

  const { error: e3 } = await supabase.from('guru').delete().neq('id', 'x');
  if (e3) return { success: false, message: 'Gagal hapus guru: ' + e3.message };

  return { success: true, message: 'Semua data guru, jadwal piket, dan riwayat sesi piket berhasil dihapus (akun admin tetap aman)' };
}
