const { supabase, setCors, generateQrToken, generateGuruQrToken, hashPassword, verifyPassword } = require('./_db');

// ── RATE LIMITING SEDERHANA (anti brute-force) ──────────────────────
// PENTING: ini penyimpanan IN-MEMORY per instance serverless — bukan
// solusi sempurna (Vercel bisa menjalankan banyak instance paralel, dan
// counter ini hilang tiap cold start), TAPI tetap jauh lebih baik daripada
// tidak ada pembatasan sama sekali, dan langsung aktif tanpa perlu
// infrastruktur tambahan (Redis dll). Untuk perlindungan yang lebih kuat
// dan konsisten lintas instance, pertimbangkan Vercel KV / Upstash Redis
// di masa depan.
const percobaanLogin = new Map(); // key: username, value: { count, lastAttempt }
const BATAS_PERCOBAAN = 5;
const JEDA_MS = 5 * 60 * 1000; // 5 menit

function cekRateLimit(username) {
  const now = Date.now();
  const rec = percobaanLogin.get(username);
  if (!rec) return { boleh: true };
  if (now - rec.lastAttempt > JEDA_MS) {
    percobaanLogin.delete(username);
    return { boleh: true };
  }
  if (rec.count >= BATAS_PERCOBAAN) {
    const sisaMenit = Math.ceil((JEDA_MS - (now - rec.lastAttempt)) / 60000);
    return { boleh: false, sisaMenit };
  }
  return { boleh: true };
}

function catatPercobaanGagal(username) {
  const now = Date.now();
  const rec = percobaanLogin.get(username) || { count: 0, lastAttempt: now };
  rec.count += 1;
  rec.lastAttempt = now;
  percobaanLogin.set(username, rec);
}

function resetPercobaan(username) {
  percobaanLogin.delete(username);
}

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
  if (!username || !password)
    return { success: false, message: 'Username dan password wajib diisi' };

  const cek = cekRateLimit(username);
  if (!cek.boleh) {
    return {
      success: false,
      message: `Terlalu banyak percobaan gagal. Coba lagi dalam ${cek.sisaMenit} menit.`
    };
  }

  // Cek admin
  const { data: adminData } = await supabase
    .from('admin')
    .select('*')
    .eq('username', username)
    .single();

  if (adminData) {
    const cekPass = await verifyPassword(password, adminData.password);
    if (cekPass.valid) {
      resetPercobaan(username);

      // Migrasi transparan: kalau password ini masih pakai hash SHA-256
      // lama, upgrade ke bcrypt sekarang juga (password mentahnya baru
      // saja terverifikasi cocok, jadi aman dipakai untuk re-hash).
      if (cekPass.needsRehash) {
        const newHash = await hashPassword(password);
        await supabase.from('admin').update({ password: newHash }).eq('username', username);
      }

      // Pastikan admin punya qr_token unik untuk QR login yang aman.
      // Akun lama (dibuat sebelum kolom qr_token ada) dibuatkan sekali di sini.
      let qrToken = adminData.qr_token;
      if (!qrToken) {
        qrToken = generateQrToken();
        await supabase.from('admin').update({ qr_token: qrToken }).eq('username', username);
      }
      return {
        success: true, role: 'admin',
        nama: adminData.nama, username,
        email: adminData.email, qrToken
      };
    }
  }

  // Cek guru
  const { data: guruData } = await supabase
    .from('guru')
    .select('*')
    .eq('username', username)
    .eq('status', 'Aktif')
    .single();

  if (guruData) {
    const cekPass = await verifyPassword(password, guruData.password);
    if (cekPass.valid) {
      resetPercobaan(username);

      if (cekPass.needsRehash) {
        const newHash = await hashPassword(password);
        await supabase.from('guru').update({ password: newHash }).eq('username', username);
      }

      // PENTING: `role` yang dikembalikan di sini dipakai frontend
      // (index.html) untuk menentukan menu sidebar mana yang tampil
      // (adminNav / guruNav / kepsekNav). Sebelumnya SELALU 'guru' untuk
      // siapapun yang login lewat tabel guru -- termasuk akun Kepala
      // Sekolah, yang membuat kepsek dapat dashboard operasional guru
      // piket biasa. Sekarang pakai kolom guru.role (diisi lewat menu
      // Data Guru), bukan di-hardcode.

      // PENTING (perbaikan keamanan): pastikan guru punya qr_token unik --
      // dipakai frontend sebagai `guruToken` di setiap request yang
      // mengubah data atau membaca data pribadi guru (lihat helper api()
      // di index.html serta resolveGuruIdFromToken() di _db.js). Tanpa
      // token rahasia ini, server sebelumnya cuma bisa mempercayai idGuru
      // mentah dari klien -- yang TIDAK rahasia, sehingga siapa pun bisa
      // mengaku sebagai guru mana pun. Akun lama (dibuat sebelum kolom
      // qr_token dipakai untuk ini) dibuatkan token sekali di sini, sama
      // seperti pola yang sudah ada untuk admin di atas.
      let qrToken = guruData.qr_token;
      if (!qrToken) {
        qrToken = await generateGuruQrToken();
        await supabase.from('guru').update({ qr_token: qrToken }).eq('id', guruData.id);
      }

      return {
        success: true, role: guruData.role === 'kepsek' ? 'kepsek' : 'guru',
        id: guruData.id, nama: guruData.nama,
        jabatan: guruData.jabatan, username, qrToken
      };
    }
  }

  catatPercobaanGagal(username);
  return { success: false, message: 'Username atau password salah' };
}

async function changePassword({ username, oldPassword, newPassword }) {
  if (!newPassword || String(newPassword).trim().length < 6)
    return { success: false, message: 'Password baru minimal 6 karakter' };

  const { data: adm } = await supabase
    .from('admin').select('*')
    .eq('username', username).single();

  if (adm) {
    const cekPass = await verifyPassword(oldPassword, adm.password);
    if (cekPass.valid) {
      await supabase.from('admin')
        .update({ password: await hashPassword(newPassword) }).eq('username', username);
      return { success: true, message: 'Password berhasil diubah' };
    }
  }

  const { data: guru } = await supabase
    .from('guru').select('*')
    .eq('username', username).single();

  if (guru) {
    const cekPass = await verifyPassword(oldPassword, guru.password);
    if (cekPass.valid) {
      await supabase.from('guru')
        .update({ password: await hashPassword(newPassword) }).eq('username', username);
      return { success: true, message: 'Password berhasil diubah' };
    }
  }

  return { success: false, message: 'Password lama tidak sesuai' };
}
