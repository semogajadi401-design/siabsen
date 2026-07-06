// api/siswa.js — CRUD Data Siswa
const { supabase, generateID, setCors, generateQrToken, generateRiwayatToken, generateRiwayatTokenBatch, requireAdminToken } = require('./_db');

// getAll & getByScan TETAP TERBUKA karena dipakai scan.html (guru piket
// offline, tanpa sesi admin) untuk mengisi daftar kelas & mencari siswa.
// Aksi lain (tambah/ubah/hapus/reset/import/naik-kelas) mengubah data
// master, jadi wajib token admin valid.
const AKSI_TERKUNCI = new Set([
  'tambah', 'edit', 'hapus', 'resetSemua',
  'importSiswa', 'naikkanKelas', 'resetRiwayatToken'
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
    // getAll TETAP dibiarkan bisa dipanggil tanpa login (dipakai scan.html
    // offline untuk mengisi daftar siswa di kios scan tanpa perlu sesi
    // admin). TAPI data yang dikembalikan sekarang tergantung status login:
    // kalau adminToken valid -> data lengkap (untuk halaman kelola siswa di
    // index.html); kalau tidak -> hanya kolom yang benar-benar dibutuhkan
    // scan.html (id/nisn/nama/kelas/status), TIDAK termasuk alamat, no HP
    // ortu, dan riwayat_token. Sebelumnya endpoint ini mengembalikan SEMUA
    // kolom (termasuk data pribadi & token rahasia riwayat) ke siapa saja
    // yang memanggilnya tanpa login sama sekali — celah kebocoran data.
    if (action === 'getAll') {
      const isAdmin = await requireAdminToken(adminToken);
      return res.json(await getAll(params, isAdmin));
    }
    if (action === 'tambah')      return res.json(await tambah(params));
    if (action === 'edit')        return res.json(await edit(params));
    if (action === 'hapus')       return res.json(await hapus(params));
    if (action === 'getByScan')   return res.json(await getByScan(params));
    if (action === 'importSiswa') return res.json(await importSiswa(params));
    if (action === 'resetSemua')  return res.json(await resetSemua());
    if (action === 'naikkanKelas') return res.json(await naikkanKelas(params));
    if (action === 'resetRiwayatToken') return res.json(await resetRiwayatToken(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

async function getAll({ activeOnly, kelas }, isAdmin) {
  // Kolom yang diambil dari database dibedakan sejak awal (bukan cuma
  // disaring di response) supaya data sensitif tidak pernah ikut terbawa
  // ke memori proses untuk pemanggil yang tidak terautentikasi.
  const kolomPublik = 'id,nisn,nama,jenis_kelamin,kelas,status,riwayat_token';
  const kolomLengkap = '*';

  let q = supabase.from('siswa').select(isAdmin ? kolomLengkap : kolomPublik).order('nama');
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

  if (!isAdmin) {
    // Respons minimal untuk pemanggil tanpa login (scan.html offline):
    // cukup untuk mencari & mencocokkan siswa di kios scan, TANPA data
    // pribadi (alamat, no HP ortu) maupun riwayat_token (token rahasia
    // yang dipakai halaman riwayat absensi publik di api/riwayat.js).
    //
    // CATATAN: riwayat_token TETAP di-generate/backfill di atas kalau
    // belum ada (perlu supaya kartu siswa baru tetap bisa dicetak dengan
    // QR riwayat yang valid), tapi sengaja TIDAK diikutkan ke response ini.
    return {
      success: true,
      data: (data || []).map(s => ({
        id: s.id, nisn: s.nisn, nama: s.nama,
        jenisKelamin: s.jenis_kelamin, kelas: s.kelas, status: s.status
      }))
    };
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
// ── IMPORT SISWA (batch, bukan satu-satu) ─────────────────────────
// Versi sebelumnya melakukan minimal 3 query per baris siswa (cek NISN,
// generate token riwayat, insert) di dalam for-loop berurutan -- untuk
// 300 siswa itu ratusan/ribuan round-trip jaringan satu-satu, membuat
// import terasa sangat lama dan berisiko kena timeout function.
// Versi ini menggantinya dengan hanya BEBERAPA query total, tidak
// peduli berapa banyak baris yang diimport:
//   1. Satu query SELECT untuk cek semua NISN yang sudah terdaftar.
//   2. Satu query (generateRiwayatTokenBatch) untuk semua token riwayat.
//   3. Insert per-batch (200 baris/batch) supaya tetap tangguh kalau ada
//      satu batch gagal, tanpa balik lagi ke pola satu-per-baris.
async function importSiswa({ dataList }) {
  if (!dataList || !dataList.length)
    return { success: false, message: 'Tidak ada data untuk diimport' };

  const errors = [];
  let gagal = 0;

  // 1. Validasi dasar + buang duplikat NISN di DALAM file itu sendiri
  //    (kalau tidak dibuang di sini, baru ketahuan saat insert gagal
  //    karena constraint unique, dan errornya kurang jelas untuk admin)
  const valid = [];
  const nisnTerlihat = new Set();
  for (const data of dataList) {
    if (!data.nisn || !data.nama) {
      gagal++;
      errors.push(`Baris dilewati: NISN atau Nama kosong (${data.nisn || '-'})`);
      continue;
    }
    const nisn = String(data.nisn).trim();
    if (nisnTerlihat.has(nisn)) {
      gagal++;
      errors.push(`NISN ${nisn} (${data.nama}) duplikat di dalam file, dilewati`);
      continue;
    }
    nisnTerlihat.add(nisn);
    valid.push({ ...data, nisn });
  }

  if (!valid.length) {
    return { success: true, message: `Import selesai: 0 berhasil, ${gagal} gagal`, berhasil: 0, gagal, errors };
  }

  // 2. Cek NISN yang sudah ada di database -- SATU query untuk semua
  //    NISN sekaligus (bukan satu query per baris seperti sebelumnya)
  const { data: existingRows, error: errCekExisting } = await supabase
    .from('siswa')
    .select('nisn')
    .in('nisn', valid.map(v => v.nisn));

  if (errCekExisting) {
    return { success: false, message: 'Gagal cek NISN yang sudah terdaftar: ' + errCekExisting.message };
  }

  const nisnSudahAda = new Set((existingRows || []).map(r => r.nisn));
  const siapInsert = [];
  for (const v of valid) {
    if (nisnSudahAda.has(v.nisn)) {
      gagal++;
      errors.push(`NISN ${v.nisn} (${v.nama}) sudah terdaftar, dilewati`);
      continue;
    }
    siapInsert.push(v);
  }

  if (!siapInsert.length) {
    return { success: true, message: `Import selesai: 0 berhasil, ${gagal} gagal`, berhasil: 0, gagal, errors };
  }

  // 3. Generate semua token riwayat sekaligus -- SATU query cek tabrakan
  //    total, bukan satu query per siswa (lihat generateRiwayatTokenBatch
  //    di _db.js)
  const tokens = await generateRiwayatTokenBatch(siapInsert.length);

  // 4. Susun baris siap insert. Tambahan index di belakang ID supaya
  //    dijamin unik walau ratusan ID dibuat beruntun tanpa jeda dalam
  //    detik yang sama (bagian acak generateID cuma 4 digit, berisiko
  //    bentrok kalau dipakai sangat cepat berkali-kali tanpa penanda ini)
  const rows = siapInsert.map((data, i) => ({
    id: `${generateID('SW')}${i}`,
    nisn: data.nisn,
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
    riwayat_token: tokens[i]
  }));

  // 5. Insert per-batch (bukan satu-satu, juga bukan satu insert raksasa
  //    untuk ribuan baris) -- kalau satu batch gagal, batch lain tetap
  //    lanjut, dan pesan error tetap bisa menunjuk baris yang bermasalah.
  const UKURAN_BATCH = 200;
  let berhasil = 0;
  for (let i = 0; i < rows.length; i += UKURAN_BATCH) {
    const batch = rows.slice(i, i + UKURAN_BATCH);
    const { error } = await supabase.from('siswa').insert(batch);
    if (error) {
      gagal += batch.length;
      errors.push(`Gagal import baris ${i + 1}-${i + batch.length}: ${error.message}`);
    } else {
      berhasil += batch.length;
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
