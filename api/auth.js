// api/auth.js — Login, logout, ganti password
const { supabase, hashPassword, setCors } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, ...params } = req.body || {};

  try {
    if (action === 'login') return res.json(await login(params));
    if (action === 'changePassword') return res.json(await changePassword(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

async function login({ username, password }) {
  if (!username || !password) return { success: false, message: 'Username dan password wajib diisi' };
  const hashed = hashPassword(password);

  // Cek admin
  const { data: adminData } = await supabase
    .from('admin').select('*').eq('username', username).eq('password', hashed).single();
  if (adminData) {
    return { success: true, role: 'admin', nama: adminData.nama, username, email: adminData.email };
  }

  // Cek guru
  const { data: guruData } = await supabase
    .from('guru').select('*').eq('username', username).eq('password', hashed).eq('status', 'Aktif').single();
  if (guruData) {
    return { success: true, role: 'guru', id: guruData.id, nama: guruData.nama, jabatan: guruData.jabatan, username };
  }

  return { success: false, message: 'Username atau password salah' };
}

async function changePassword({ username, oldPassword, newPassword }) {
  const oldHashed = hashPassword(oldPassword);
  const newHashed = hashPassword(newPassword);

  // Cek admin
  const { data: adm } = await supabase.from('admin').select('*').eq('username', username).eq('password', oldHashed).single();
  if (adm) {
    await supabase.from('admin').update({ password: newHashed }).eq('username', username);
    return { success: true, message: 'Password berhasil diubah' };
  }

  // Cek guru
  const { data: guru } = await supabase.from('guru').select('*').eq('username', username).eq('password', oldHashed).single();
  if (guru) {
    await supabase.from('guru').update({ password: newHashed }).eq('username', username);
    return { success: true, message: 'Password berhasil diubah' };
  }

  return { success: false, message: 'Password lama tidak sesuai' };
}
