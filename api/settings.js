// api/settings.js — Jam setting, jadwal piket, hari kerja
const { supabase, generateID, setCors, getJamSetting, hariIni, requireAdminToken } = require('./_db');

// Semua aksi "get*" tetap terbuka karena dipakai scan.html secara offline
// (getJamSetting untuk cek jam operasional) dan halaman lain tanpa sesi
// admin. Hanya aksi yang MENGUBAH pengaturan yang dikunci.
const AKSI_TERKUNCI = new Set([
  'updateJamSetting', 'setJadwalPiket',
  'setHariLibur', 'hapusHariLibur', 'updatePengaturanHari',
  'resetPengaturanAplikasi'
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
    if (action === 'getJamSetting')     return res.json(await getAll());
    if (action === 'updateJamSetting')  return res.json(await updateSetting(params));
    if (action === 'getJadwalPiket')    return res.json(await getJadwalPiket());
    if (action === 'setJadwalPiket')    return res.json(await setJadwalPiket(params));
    if (action === 'getHariKerja')      return res.json(await getHariKerjaKalender(params));
    if (action === 'setHariLibur')      return res.json(await setHariLibur(params));
    if (action === 'hapusHariLibur')    return res.json(await hapusHariLibur(params));
    if (action === 'getConstants')      return res.json(getConstants());
    if (action === 'getGuruPiket')      return res.json(await getGuruPiket());
    if (action === 'getPengaturanHari') return res.json(await getPengaturanHari());
    if (action === 'updatePengaturanHari') return res.json(await updatePengaturanHari(params));
    if (action === 'resetPengaturanAplikasi') return res.json(await resetPengaturanAplikasi());
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── GET SEMUA JAM SETTING ─────────────────────────────────────────
async function getAll() {
  try {
    return { success: true, data: await getJamSetting() };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// ── UPDATE JAM SETTING / PROFIL SEKOLAH ──────────────────────────
async function updateSetting({ settings }) {
  const upserts = Object.entries(settings).map(([kunci, nilai]) => ({
    kunci, nilai, deskripsi: ''
  }));
  const { error } = await supabase
    .from('jam_setting')
    .upsert(upserts, { onConflict: 'kunci' });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Pengaturan berhasil disimpan' };
}

// ── JADWAL PIKET ──────────────────────────────────────────────────
async function getJadwalPiket() {
  const { data, error } = await supabase.from('jadwal_piket').select('*');
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(j => ({
      id: j.id, hari: j.hari,
      idGuru: j.id_guru, namaGuru: j.nama_guru, jabatan: j.jabatan
    }))
  };
}

async function setJadwalPiket({ jadwalList }) {
  // Siapkan data dulu sebelum hapus apapun
  const inserts = [];

  for (const j of jadwalList || []) {
    const guruIds = Array.isArray(j.idGuruList)
      ? j.idGuruList
      : [j.idGuru].filter(Boolean);

    for (const idGuru of guruIds) {
      const { data: guru } = await supabase
        .from('guru').select('nama,jabatan').eq('id', idGuru).single();
      if (!guru) continue;
      inserts.push({
        id:        generateID('PK'),
        hari:      j.hari,
        id_guru:   idGuru,
        nama_guru: guru.nama,
        jabatan:   guru.jabatan
      });
    }
  }

  // Baru hapus setelah data siap
  const { error: errDel } = await supabase.from('jadwal_piket').delete().neq('id', 'x');
  if (errDel) return { success: false, message: 'Gagal hapus jadwal lama: ' + errDel.message };

  if (!inserts.length)
    return { success: true, message: 'Jadwal piket dikosongkan' };

  const { error: errIns } = await supabase.from('jadwal_piket').insert(inserts);
  if (errIns) return { success: false, message: 'Gagal simpan jadwal baru: ' + errIns.message };

  return { success: true, message: 'Jadwal piket berhasil disimpan' };
}

// ── HARI KERJA KALENDER (libur nasional per tanggal) ─────────────
// Dipakai oleh halaman Kalender Hari Kerja (klik tanggal = tandai libur)
async function getHariKerjaKalender({ bulan, tahun }) {
  if (!bulan || !tahun)
    return { success: false, message: 'Bulan dan tahun wajib diisi' };

  const start = `${tahun}-${String(bulan).padStart(2, '0')}-01`;
  const end   = `${tahun}-${String(bulan).padStart(2, '0')}-31`;

  const { data, error } = await supabase
    .from('hari_kerja').select('*')
    .gte('tanggal', start).lte('tanggal', end);

  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(h => ({
      tanggal: h.tanggal,
      keterangan: h.keterangan,
      tipe: h.tipe
    }))
  };
}

async function setHariLibur({ tanggal, keterangan }) {
  const { error } = await supabase
    .from('hari_kerja')
    .upsert({ tanggal, keterangan, tipe: 'Libur' }, { onConflict: 'tanggal' });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Hari libur berhasil disimpan' };
}

async function hapusHariLibur({ tanggal }) {
  const { error } = await supabase
    .from('hari_kerja').delete().eq('tanggal', tanggal);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Hari libur berhasil dihapus' };
}

// ── PENGATURAN HARI AKTIF SEKOLAH (Senin s/d Sabtu dst) ──────────
// Dipakai oleh halaman Pengaturan Semester → Hari Sekolah Aktif
async function getPengaturanHari() {
  const urutan = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const { data, error } = await supabase
    .from('pengaturan_hari_kerja').select('*');
  if (error) return { success: false, message: error.message };

  // Jika tabel kosong (pertama kali dipakai / belum pernah diatur admin),
  // JANGAN aktifkan hari apa pun secara default. Admin wajib mencentang
  // sendiri hari sekolah aktif di menu Pengaturan Semester supaya Jadwal
  // Piket (yang mengikuti pengaturan ini) tidak salah asumsi Senin-Jumat.
  if (!data || !data.length) {
    return {
      success: true,
      data: urutan.map(h => ({ hari: h, aktif: false }))
    };
  }

  const sorted = [...data].sort(
    (a, b) => urutan.indexOf(a.hari) - urutan.indexOf(b.hari)
  );
  return { success: true, data: sorted };
}

async function updatePengaturanHari({ hariList }) {
  if (!hariList || !hariList.length)
    return { success: false, message: 'Data hari kerja kosong' };

  // PENTING: sebelumnya kode ini upsert satu-satu di dalam loop TANPA
  // pernah mengecek hasil error dari Supabase. Kalau upsert gagal (RLS,
  // koneksi, tipe data, dsb.), fungsi ini tetap mengembalikan
  // success:true seolah-olah tersimpan -- padahal tabel di database
  // tidak berubah sama sekali. Efeknya: toast bilang "berhasil
  // disimpan", tapi begitu halaman dibuka lagi, getPengaturanHari()
  // membaca tabel yang ternyata masih kosong, jadi semua centang balik
  // ke tidak aktif lagi. Sekarang upsert dilakukan sekaligus (batch)
  // dan error-nya benar-benar dicek & dilaporkan ke user.
  const rows = hariList.map(item => ({ hari: item.hari, aktif: item.aktif }));
  const { error } = await supabase
    .from('pengaturan_hari_kerja')
    .upsert(rows, { onConflict: 'hari' });

  if (error) {
    return { success: false, message: 'Gagal menyimpan pengaturan hari kerja: ' + error.message };
  }
  return { success: true, message: 'Pengaturan hari kerja berhasil disimpan' };
}

// ── GURU PIKET HARI INI ───────────────────────────────────────────
async function getGuruPiket() {
  // Pakai hariIni() dari _db.js supaya konsisten dengan seluruh sistem (WITA).
  // Sebelumnya fungsi ini menghitung sendiri pakai offset WIB (UTC+7)
  // sehingga bisa beda hari dengan endpoint lain menjelang tengah malam.
  const hari = hariIni();
  const { data } = await supabase
    .from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari);
  return {
    success: true,
    data: (data || []).map(p => ({
      idGuru: p.id_guru, namaGuru: p.nama_guru, jabatan: p.jabatan
    })),
    hari
  };
}

// ── CONSTANTS ─────────────────────────────────────────────────────
function getConstants() {
  return {
    success: true,
    jabatanList: [
      'Kepala Sekolah','Wakil Kepala Sekolah','Guru','Wali Kelas',
      'Guru BK','Guru Olahraga','Guru Agama','Staf Tata Usaha',
      'Operator','Kepala Tata Usaha','Pustakawan','Satpam','Petugas Kebersihan'
    ],
    agamaList: ['Islam','Kristen','Katolik','Hindu','Buddha','Konghucu'],
    hariList: ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'],
    kelasList: ['X-1','X-2','X-3','XI-1','XI-2','XI-3','XII-1','XII-2','XII-3']
  };
}

// ── RESET PENGATURAN APLIKASI KE DEFAULT ──────────────────────────
// Mengembalikan 3 hal ke kondisi default seperti saat instalasi pertama
// (lihat schema.sql):
//  1. jam_setting     → jam operasional, toleransi, dan profil sekolah
//  2. pengaturan_hari_kerja → hari sekolah aktif (dikosongkan, jadi
//     otomatis kembali ke default belum ada hari aktif lewat
//     getPengaturanHari(), sampai admin mencentang ulang)
//  3. hari_kerja      → kalender hari libur per tanggal (dikosongkan)
// TIDAK menyentuh jadwal_piket, siswa, guru, absensi, atau semester —
// itu domain reset masing-masing (guru.resetSemua, siswa.resetSemua,
// absensi.resetAbsensi, semester.resetSemua).
async function resetPengaturanAplikasi() {
  const NAMA_SEKOLAH_SEBELUMNYA = (await getJamSetting())['NAMA_SEKOLAH'] || '';

  const defaults = [
    { kunci: 'JAM_DATANG_MULAI',   nilai: '06:30', deskripsi: 'Jam mulai absensi datang' },
    { kunci: 'JAM_DATANG_SELESAI', nilai: '08:00', deskripsi: 'Batas jam datang' },
    { kunci: 'JAM_PULANG_MULAI',   nilai: '14:00', deskripsi: 'Jam mulai absensi pulang' },
    { kunci: 'JAM_PULANG_SELESAI', nilai: '16:00', deskripsi: 'Batas jam absensi pulang' },
    { kunci: 'TOLERANSI_MENIT',    nilai: '15',    deskripsi: 'Toleransi keterlambatan menit' },
    { kunci: 'TOLERANSI_PIKET_MENIT', nilai: '15', deskripsi: 'Menit tunggu sebelum guru pengganti di luar jadwal piket diizinkan scan' },
    // Profil sekolah (nama/alamat/NPSN/dll) SENGAJA tidak ikut direset ke
    // nilai contoh bawaan supaya identitas sekolah yang sudah diisi admin
    // tidak hilang tanpa sengaja hanya karena reset jam operasional.
  ];

  const { error: e1 } = await supabase
    .from('jam_setting')
    .upsert(defaults, { onConflict: 'kunci' });
  if (e1) return { success: false, message: 'Gagal reset jam operasional: ' + e1.message };

  const { error: e2 } = await supabase.from('pengaturan_hari_kerja').delete().neq('hari', 'x');
  if (e2) return { success: false, message: 'Gagal reset hari sekolah aktif: ' + e2.message };

  const { error: e3 } = await supabase.from('hari_kerja').delete().neq('tanggal', '1900-01-01');
  if (e3) return { success: false, message: 'Gagal reset kalender hari libur: ' + e3.message };

  return {
    success: true,
    message: `Jam operasional, hari sekolah aktif (dikembalikan ke belum ada hari aktif, mohon atur ulang di Pengaturan Semester), dan kalender hari libur berhasil direset ke default. Profil sekolah "${NAMA_SEKOLAH_SEBELUMNYA}" tetap dipertahankan.`
  };
}
