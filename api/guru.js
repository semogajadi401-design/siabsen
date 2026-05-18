// api/guru.js — CRUD Data Guru
const { supabase, hashPassword, generateID, generateUsername, generatePassword, setCors } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getAll')          return res.json(await getAll(params));
    if (action === 'tambah')          return res.json(await tambah(params));
    if (action === 'edit')            return res.json(await edit(params));
    if (action === 'hapus')           return res.json(await hapus(params));
    if (action === 'hapusPermanen')   return res.json(await hapusPermanen(params));
    if (action === 'resetPassword')   return res.json(await resetPassword(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function getAll({ activeOnly }) {
  let q = supabase.from('guru').select('id,nama,jenis_kelamin,jabatan,nip,no_hp,email,alamat,username,status,created_at').order('nama');
  if (activeOnly) q = q.eq('status', 'Aktif');
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data||[]).map(g => ({
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
    jabatan: data.jabatan, nip: data.nip||'', no_hp: data.noHp||'',
    email: data.email||'', alamat: data.alamat||'',
    username, password: hashPassword(rawPassword), status: 'Aktif'
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Guru berhasil ditambahkan', username, password: rawPassword, id };
}

async function edit({ id, data }) {
  const updates = {
    nama: data.nama, jenis_kelamin: data.jenisKelamin,
    jabatan: data.jabatan, nip: data.nip||'', no_hp: data.noHp||'',
    email: data.email||'', alamat: data.alamat||''
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
