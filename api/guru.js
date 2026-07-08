// api/guru.js — CRUD Data Guru
const { supabase, hashPassword, generateID, generateUsername, generatePassword, setCors, requireAdminToken, generateGuruQrToken, generateGuruQrTokenBatch } = require('./_db');

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
    if (action === 'importGuru')    return res.json(await importGuru(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function getAll({ activeOnly }) {
  let q = supabase.from('guru')
    .select('id,nama,jenis_kelamin,jabatan,nip,no_hp,email,alamat,username,status,qr_token,role,created_at')
    .order('nama');
  if (activeOnly === true || activeOnly === 'true') q = q.eq('status', 'Aktif');
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  // Backfill qr_token untuk guru lama yang belum punya token (misal guru
  // yang ditambahkan sebelum fitur QR login kartu belakang ada). Sama
  // pola dengan backfill riwayat_token siswa di api/siswa.js.
  // PERBAIKAN: sebelumnya ini loop sekuensial (await 1-per-1, 2 round-trip
  // DB per guru) — sangat lambat kalau banyak guru belum bertoken, dan
  // bisa membuat request timeout total di server tanpa data apapun
  // kembali ke client (makanya menu Data Guru/Kartu Identitas kadang
  // terasa lama, atau kadang gagal muat). Sekarang: 1 query untuk generate
  // semua token sekaligus (cek tabrakan hanya 1x ke DB), lalu semua UPDATE
  // dijalankan PARALEL (Promise.all), bukan berantai.
  const belumAdaToken = (data || []).filter(g => !g.qr_token);
  if (belumAdaToken.length > 0) {
    const tokens = await generateGuruQrTokenBatch(belumAdaToken.length);
    await Promise.all(belumAdaToken.map((g, i) =>
      supabase.from('guru').update({ qr_token: tokens[i] }).eq('id', g.id)
        .then(({ error }) => { if (!error) g.qr_token = tokens[i]; })
    ));
  }

  return {
    success: true,
    data: (data || []).map(g => ({
      id: g.id, nama: g.nama, jenisKelamin: g.jenis_kelamin,
      jabatan: g.jabatan, nip: g.nip, noHp: g.no_hp,
      email: g.email, alamat: g.alamat, username: g.username, status: g.status,
      qrToken: g.qr_token, role: g.role || 'guru'
    }))
  };
}

async function tambah({ data }) {
  const id = generateID('GR');
  const username = await generateUsername(data.nama);
  const rawPassword = (data.password && data.password.trim().length >= 6)
    ? data.password.trim() : generatePassword();
  // Whitelist nilai role secara ketat -- JANGAN percaya begitu saja nilai
  // dari frontend, supaya tidak ada jalan (sengaja/tidak sengaja) untuk
  // menyimpan role selain 'guru'/'kepsek' ke database.
  const role = data.role === 'kepsek' ? 'kepsek' : 'guru';
  const { error } = await supabase.from('guru').insert({
    id, nama: data.nama, jenis_kelamin: data.jenisKelamin,
    jabatan: data.jabatan, nip: data.nip || '', no_hp: data.noHp || '',
    email: data.email || '', alamat: data.alamat || '',
    username, password: await hashPassword(rawPassword), status: 'Aktif',
    qr_token: await generateGuruQrToken(), role
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Guru berhasil ditambahkan', username, password: rawPassword, id };
}

async function edit({ id, data }) {
  const updates = {
    nama: data.nama, jenis_kelamin: data.jenisKelamin,
    jabatan: data.jabatan, nip: data.nip || '', no_hp: data.noHp || '',
    email: data.email || '', alamat: data.alamat || '',
    // Sama seperti tambah(): whitelist ketat, jangan simpan nilai role
    // apapun selain 'guru'/'kepsek'.
    role: data.role === 'kepsek' ? 'kepsek' : 'guru'
  };
  if (data.password && data.password.trim().length >= 6) {
    updates.password = await hashPassword(data.password.trim());
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
  // SAMA seperti resetSemua() di bawah: jadwal_piket & sesi_piket.id_guru
  // adalah FOREIGN KEY ke guru(id) tanpa ON DELETE CASCADE (schema.sql).
  // Kalau baris guru ini pernah dijadwalkan piket atau pernah scan sebagai
  // guru piket, DELETE langsung ke tabel guru akan GAGAL (foreign key
  // violation) dan admin cuma lihat error mentah dari database. Bersihkan
  // dulu baris terkait guru ini sebelum hapus baris guru-nya.
  const { error: e1 } = await supabase.from('jadwal_piket').delete().eq('id_guru', id);
  if (e1) return { success: false, message: 'Gagal hapus jadwal piket guru ini: ' + e1.message };

  const { error: e2 } = await supabase.from('sesi_piket').delete().eq('id_guru', id);
  if (e2) return { success: false, message: 'Gagal hapus riwayat sesi piket guru ini: ' + e2.message };

  const { error } = await supabase.from('guru').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Data guru berhasil dihapus permanen' };
}

async function resetPassword({ id }) {
  const { data: guru } = await supabase.from('guru').select('username').eq('id', id).single();
  if (!guru) return { success: false, message: 'Guru tidak ditemukan' };
  const newPass = generatePassword();
  await supabase.from('guru').update({ password: await hashPassword(newPass) }).eq('id', id);
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

// ── IMPORT GURU (batch, sama pola dengan importSiswa di api/siswa.js) ──
// Beda dari siswa: tidak ada NISN, jadi dedupe pakai NIP (kalau diisi;
// kalau NIP kosong tidak ada pengecekan duplikat -- diimport sebagai
// guru baru). Username & password akun dibuat otomatis per baris (bukan
// batch) karena generateUsername() perlu cek unik sekuensial ke DB;
// jumlah guru yang diimport sekali jalan biasanya jauh lebih sedikit
// dari siswa jadi ini tidak jadi masalah performa. qr_token tetap
// dibuat sekaligus lewat generateGuruQrTokenBatch (1 query cek tabrakan
// untuk semua baris, bukan 1 query per guru).
async function importGuru({ dataList }) {
  if (!dataList || !dataList.length)
    return { success: false, message: 'Tidak ada data untuk diimport' };

  const errors = [];
  let gagal = 0;

  // 1. Validasi dasar + buang duplikat NIP di DALAM file itu sendiri
  //    (NIP boleh kosong -- guru honorer/baru kadang belum punya NIP)
  const valid = [];
  const nipTerlihat = new Set();
  for (const data of dataList) {
    if (!data.nama || !String(data.nama).trim()) {
      gagal++;
      errors.push('Baris dilewati: Nama kosong');
      continue;
    }
    const nip = String(data.nip || '').trim();
    if (nip && nipTerlihat.has(nip)) {
      gagal++;
      errors.push(`NIP ${nip} (${data.nama}) duplikat di dalam file, dilewati`);
      continue;
    }
    if (nip) nipTerlihat.add(nip);
    valid.push({ ...data, nip });
  }

  if (!valid.length) {
    return { success: true, message: `Import selesai: 0 berhasil, ${gagal} gagal`, berhasil: 0, gagal, errors };
  }

  // 2. Cek NIP yang sudah ada di database -- SATU query untuk semua NIP
  //    non-kosong sekaligus (NIP kosong tidak dicek, lihat komentar di atas)
  const nipUntukCek = valid.map(v => v.nip).filter(Boolean);
  let nipSudahAda = new Set();
  if (nipUntukCek.length) {
    const { data: existingRows, error: errCekExisting } = await supabase
      .from('guru')
      .select('nip')
      .in('nip', nipUntukCek);
    if (errCekExisting) {
      return { success: false, message: 'Gagal cek NIP yang sudah terdaftar: ' + errCekExisting.message };
    }
    nipSudahAda = new Set((existingRows || []).map(r => r.nip).filter(Boolean));
  }

  const siapInsert = [];
  for (const v of valid) {
    if (v.nip && nipSudahAda.has(v.nip)) {
      gagal++;
      errors.push(`NIP ${v.nip} (${v.nama}) sudah terdaftar, dilewati`);
      continue;
    }
    siapInsert.push(v);
  }

  if (!siapInsert.length) {
    return { success: true, message: `Import selesai: 0 berhasil, ${gagal} gagal`, berhasil: 0, gagal, errors };
  }

  // 3. Generate semua qr_token sekaligus (1 query cek tabrakan total)
  const qrTokens = await generateGuruQrTokenBatch(siapInsert.length);

  // 4. Username + password + hash tetap per-baris (lihat catatan di atas
  //    function ini) supaya generateUsername() bisa mengecek tabrakan
  //    nama depan yang sama antar baris secara berurutan.
  const rows = [];
  const akun = [];
  for (let i = 0; i < siapInsert.length; i++) {
    const data = siapInsert[i];
    const nama = String(data.nama).trim();
    const username = await generateUsername(nama);
    const rawPassword = (data.password && String(data.password).trim().length >= 6)
      ? String(data.password).trim() : generatePassword();
    const role = data.role === 'kepsek' ? 'kepsek' : 'guru';

    rows.push({
      id: `${generateID('GR')}${i}`,
      nama,
      jenis_kelamin: data.jenisKelamin || 'Laki-laki',
      jabatan: data.jabatan || '',
      nip: data.nip || '',
      no_hp: data.noHp || '',
      email: data.email || '',
      alamat: data.alamat || '',
      username,
      password: await hashPassword(rawPassword),
      status: 'Aktif',
      qr_token: qrTokens[i],
      role
    });
    akun.push({ nama, username, password: rawPassword });
  }

  // 5. Insert per-batch (sama seperti importSiswa) -- kalau satu batch
  //    gagal, batch lain tetap lanjut. rows[i] dan akun[i] selalu sejajar
  //    (dibangun di loop yang sama tanpa skip), jadi index batch yang
  //    gagal dipakai langsung untuk menandai akun mana yang jangan
  //    dilaporkan (guru itu tidak benar-benar tersimpan di DB).
  const UKURAN_BATCH = 200;
  let berhasil = 0;
  const akunGagalIdx = new Set();
  for (let i = 0; i < rows.length; i += UKURAN_BATCH) {
    const batch = rows.slice(i, i + UKURAN_BATCH);
    const { error } = await supabase.from('guru').insert(batch);
    if (error) {
      gagal += batch.length;
      errors.push(`Gagal import baris ${i + 1}-${i + batch.length}: ${error.message}`);
      for (let k = i; k < i + batch.length; k++) akunGagalIdx.add(k);
    } else {
      berhasil += batch.length;
    }
  }
  const akunBerhasil = akun.filter((_, idx) => !akunGagalIdx.has(idx));

  return {
    success: true,
    message: `Import selesai: ${berhasil} berhasil, ${gagal} gagal`,
    berhasil, gagal, errors, akun: akunBerhasil
  };
}
