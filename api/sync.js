const {
  supabase, generateID, setCors,
  hariIni, isHariLibur, isHariKerja, getSemesterAktif, getJamSetting, tambahMenit
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'batchSync') return res.json(await batchSync(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── BATCH SYNC: terima array antrian scan dari offline ────────────
async function batchSync({ items }) {
  if (!items || !Array.isArray(items) || items.length === 0)
    return { success: false, message: 'Tidak ada data untuk disinkronkan' };

  const results = [];

  for (const item of items) {
    try {
      const r = await processSingleScan(item);
      results.push({ id: item.localId, ...r });
    } catch(e) {
      results.push({ id: item.localId, success: false, message: e.message });
    }
  }

  const berhasil = results.filter(r => r.success).length;
  const gagal    = results.filter(r => !r.success).length;

  return {
    success: true,
    total: items.length,
    berhasil,
    gagal,
    results
  };
}

// PENTING: fungsi ini SENGAJA dibuat semirip mungkin dengan scanKartu() di
// api/scan.js dan scanAbsen() di api/absensi.js. Sebelumnya ada 3 celah yang
// membuat hasil sync offline bisa berbeda dari hasil scan online:
//   1. Mode "pulang" bisa ke-trigger otomatis hanya karena jam >= 14:00,
//      padahal di scan.js hal ini sudah sengaja dihapus (lihat komentar di
//      scan.js) karena bisa mengabaikan pilihan mode yang dipilih guru piket.
//   2. Jam batas telat & jam mulai pulang di-hardcode ('08:00' / '14:00'),
//      tidak ikut pengaturan TOLERANSI_MENIT / JAM_DATANG_SELESAI /
//      JAM_PULANG_MULAI dari menu Pengaturan Jam.
//   3. Tidak ada pengecekan hari libur & periode semester aktif, sehingga
//      scan yang terjadi offline saat libur/luar semester tetap bisa masuk
//      ke database walau scan online untuk kasus yang sama akan ditolak.
async function processSingleScan({ identifier, mode, tanggal, jam, hari, namaGuru, idGuru }) {
  if (!identifier) return { success: false, message: 'Identifier kosong' };

  // Format QR siswa: "SW_ID|NISN" — ambil bagian sebelum "|"
  const raw = identifier.trim();
  const id  = raw.includes('|') && !raw.startsWith('ADMIN|') && !raw.startsWith('GR')
    ? raw.split('|')[0]
    : raw;

  // ── CEK GURU ────────────────────────────────────────────────────
  if (id.startsWith('GR')) {
    const { data: guru } = await supabase
      .from('guru').select('id,nama,jabatan,status').eq('id', id).maybeSingle();

    if (!guru)           return { success: false, message: 'Guru tidak ditemukan', tipe: 'guru' };
    if (guru.status !== 'Aktif') return { success: false, message: 'Akun guru tidak aktif', tipe: 'guru' };

    const { data: sudahScan } = await supabase
      .from('sesi_piket').select('id')
      .eq('tanggal', tanggal).eq('id_guru', guru.id).maybeSingle();

    if (sudahScan) return {
      success: false, tipe: 'guru',
      message: `${guru.nama} sudah tercatat sebagai guru piket`
    };

    const sesiId = generateID('SP');
    const { error: sesiError } = await supabase.from('sesi_piket').insert({
      id: sesiId, tanggal, id_guru: guru.id,
      nama_guru: guru.nama, jabatan: guru.jabatan, jam_scan: jam
    });

    if (sesiError) {
      // Kode 23505 = unique_violation. Ini bisa terjadi kalau 2 perangkat
      // offline sama-sama menyimpan scan guru yang sama dan melakukan
      // sync nyaris bersamaan — constraint UNIQUE(tanggal, id_guru) di
      // database yang mencegahnya. Perlakukan sebagai duplikat (pesan
      // mengandung kata "sudah"), BUKAN kegagalan, supaya item ini
      // otomatis dihapus dari antrian offline oleh scan.html.
      if (sesiError.code === '23505') {
        return {
          success: false, tipe: 'guru',
          message: `${guru.nama} sudah tercatat sebagai guru piket`
        };
      }
      return { success: false, tipe: 'guru', message: 'Gagal simpan sesi piket: ' + sesiError.message };
    }

    return {
      success: true, tipe: 'guru',
      message: `${guru.nama} tercatat sebagai guru piket (${jam})`
    };
  }

  // ── CEK HARI LIBUR & SEMESTER (baru — samakan dengan jalur online) ──
  // Scan siswa offline yang terjadi saat libur/luar-semester tetap harus
  // ditolak saat sync, sama seperti scanKartu()/scanAbsen() menolaknya
  // secara real-time. Kalau tidak, data yang seharusnya tidak valid bisa
  // lolos masuk ke tabel absensi hanya karena perangkat sedang offline.
  const cekLibur = await isHariLibur(tanggal);
  if (cekLibur.libur)
    return { success: false, tipe: 'siswa', message: `Hari ini libur: ${cekLibur.keterangan}` };

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif)
    return { success: false, tipe: 'siswa', message: `${hari} bukan hari sekolah` };

  const semester = await getSemesterAktif();
  if (!semester)
    return { success: false, tipe: 'siswa', message: 'Tidak ada semester aktif' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (tanggal < tglMulai || tanggal > tglSelesai)
    return { success: false, tipe: 'siswa', message: `Di luar periode semester (${semester.nama})` };

  // ── CEK SISWA ───────────────────────────────────────────────────
  const { data: siswaById } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('id', id).maybeSingle();
  const { data: siswaByNisn } = siswaById ? { data: null } : await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('nisn', id).maybeSingle();

  const siswa = siswaById || siswaByNisn;
  if (!siswa) return { success: false, tipe: 'siswa', message: 'Siswa tidak ditemukan' };
  if (siswa.status !== 'Aktif') return { success: false, tipe: 'siswa', message: 'Siswa tidak aktif' };

  // Ambil guru piket dari sesi hari itu
  const { data: sesiList } = await supabase
    .from('sesi_piket').select('*').eq('tanggal', tanggal).order('jam_scan');

  const guruAktif  = sesiList && sesiList.length > 0 ? sesiList[sesiList.length - 1] : null;
  const namaGP     = namaGuru || guruAktif?.nama_guru || null;
  const idGP       = idGuru   || guruAktif?.id_guru   || null;

  // Cek absensi hari itu
  const { data: absenHariIni } = await supabase
    .from('absensi').select('*')
    .eq('id_siswa', siswa.id).eq('tanggal', tanggal).maybeSingle();

  // ── AMBIL JAM SETTING DARI DATABASE (bukan hardcode) ─────────────
  // Sebelumnya nilai '08:00' dan '14:00' ditulis langsung di kode, jadi
  // tidak ikut berubah kalau admin mengubah pengaturan jam di menu
  // Pengaturan > Jam Operasional. Sekarang disamakan dengan scan.js.
  const jamSetting     = await getJamSetting();
  const toleransi      = Number(jamSetting['TOLERANSI_MENIT'] || 0);
  const jamBatasDatang = tambahMenit(jamSetting['JAM_DATANG_SELESAI'] || '08:00', toleransi);
  const jamPulangMulai = jamSetting['JAM_PULANG_MULAI'] || '14:00';

  // ── MODE PULANG — HANYA JIKA EKSPLISIT DIPILIH SAAT SCAN ─────────
  // Sebelumnya ada `|| jam >= jamPulangMulai` yang otomatis mengganti
  // scan "datang" jadi "pulang" hanya berdasarkan jam. Itu sudah sengaja
  // dihapus di scan.js (lihat komentar di sana) karena bisa mengabaikan
  // pilihan mode yang sebenarnya dipilih guru piket saat scan — misalnya
  // siswa yang datang terlambat setelah jam 14:00 tapi modenya masih
  // "Datang" malah diproses sebagai absen pulang. Baris ini disamakan.
  if (mode === 'pulang') {
    if (!absenHariIni)
      return { success: false, tipe: 'siswa', message: `${siswa.nama} belum absen datang` };
    if (absenHariIni.jam_pulang) {
      // Kalau baris pulang yang SUDAH ADA itu justru berasal dari scan yang
      // lebih SIANG daripada scan offline yang baru sync ini (misal: siswa
      // scan pulang offline jam 14:05 di laptop belum sempat sync, lalu ada
      // yang keliru/coba scan pulang lagi di HP jam 14:30 dan itu duluan
      // masuk ke server) — koreksi ke jam yang lebih awal karena itu yang
      // benar-benar terjadi lebih dulu.
      if (jam < absenHariIni.jam_pulang) {
        const { error: fixError } = await supabase.from('absensi').update({
          jam_pulang: jam, status_pulang: 'Pulang',
          nama_guru_piket: namaGP, id_guru_piket: idGP
        }).eq('id', absenHariIni.id);
        if (fixError) return { success: false, tipe: 'siswa', message: 'Gagal mengoreksi jam pulang: ' + fixError.message };
        return {
          success: true, tipe: 'siswa', status: 'Pulang',
          message: `${siswa.nama} - jam pulang dikoreksi ke ${jam} (scan offline lebih awal)`,
          siswa: { nama: siswa.nama, kelas: siswa.kelas }
        };
      }
      return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen pulang pukul ${absenHariIni.jam_pulang}` };
    }

    const { error: updError } = await supabase.from('absensi').update({
      jam_pulang: jam, status_pulang: 'Pulang',
      nama_guru_piket: namaGP, id_guru_piket: idGP
    }).eq('id', absenHariIni.id);
    if (updError) return { success: false, tipe: 'siswa', message: 'Gagal simpan: ' + updError.message };

    return {
      success: true, tipe: 'siswa', status: 'Pulang',
      message: `${siswa.nama} absen pulang - ${jam}`,
      siswa: { nama: siswa.nama, kelas: siswa.kelas }
    };
  }

  // Mode datang
  // PENTING — KOREKSI JAM SCAN OFFLINE YANG TERLAMBAT SYNC:
  // Kalau siswa sudah absen datang duluan (misal scan offline jam 07:00 di
  // laptop, tapi laptopnya belum sempat sinkron ke internet), lalu SEBELUM
  // laptop itu sempat sync, siswa yang sama scan lagi di perangkat lain yang
  // online (misal HP guru jam 08:00) — maka baris "datang" yang lebih dulu
  // masuk ke server adalah yang jam 08:00 (Terlambat), padahal siswa itu
  // SUDAH benar-benar hadir jam 07:00 (Tepat waktu). Begitu laptop akhirnya
  // online dan data offline jam 07:00 itu sync, JANGAN cuma dibuang sebagai
  // "duplikat" — itu tidak adil untuk siswa. Koreksi baris yang sudah ada
  // ke jam yang lebih awal (dan hitung ulang status Terlambat/Hadir-nya),
  // karena itulah yang sebenar-benarnya terjadi.
  if (absenHariIni?.jam_datang) {
    if (jam < absenHariIni.jam_datang) {
      const statusKoreksi = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
      const { error: fixError } = await supabase.from('absensi').update({
        jam_datang: jam, status_datang: statusKoreksi,
        id_guru_piket: idGP, nama_guru_piket: namaGP, metode: 'QR-OFFLINE'
      }).eq('id', absenHariIni.id);
      if (fixError) return { success: false, tipe: 'siswa', message: 'Gagal mengoreksi jam absen: ' + fixError.message };
      return {
        success: true, tipe: 'siswa', status: statusKoreksi,
        message: `${siswa.nama} - jam absen dikoreksi ke ${jam} (scan offline lebih awal)`,
        siswa: { nama: siswa.nama, kelas: siswa.kelas }
      };
    }
    return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen datang pukul ${absenHariIni.jam_datang}` };
  }

  const statusDatang = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
  const absenId      = generateID('AB');

  const { error: absenError } = await supabase.from('absensi').insert({
    id: absenId, id_siswa: siswa.id, nisn: siswa.nisn,
    nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal, hari, jam_datang: jam,
    status_datang: statusDatang,
    id_guru_piket: idGP, nama_guru_piket: namaGP,
    metode: 'QR-OFFLINE'
  });

  if (absenError) {
    // Kode 23505 = unique_violation — ini bisa kejadian kalau DUA proses
    // sync-nya benar-benar bersamaan (race asli, bukan sekadar absenHariIni
    // yang sempat basi karena SELECT di atas). Cek ulang baris yang barusan
    // "menang" itu, dan tetap terapkan koreksi jam-lebih-awal yang sama
    // seperti di atas, supaya hasil akhirnya konsisten siapa pun yang
    // menang race-nya.
    if (absenError.code === '23505') {
      const { data: existingRow } = await supabase
        .from('absensi').select('*')
        .eq('id_siswa', siswa.id).eq('tanggal', tanggal).maybeSingle();

      if (existingRow && jam < existingRow.jam_datang) {
        const statusKoreksi = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
        const { error: fixError } = await supabase.from('absensi').update({
          jam_datang: jam, status_datang: statusKoreksi,
          id_guru_piket: idGP, nama_guru_piket: namaGP, metode: 'QR-OFFLINE'
        }).eq('id', existingRow.id);
        if (!fixError) {
          return {
            success: true, tipe: 'siswa', status: statusKoreksi,
            message: `${siswa.nama} - jam absen dikoreksi ke ${jam} (scan offline lebih awal)`,
            siswa: { nama: siswa.nama, kelas: siswa.kelas }
          };
        }
      }
      return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen datang hari ini` };
    }
    return { success: false, tipe: 'siswa', message: 'Gagal simpan: ' + absenError.message };
  }

  return {
    success: true, tipe: 'siswa', status: statusDatang,
    message: `${siswa.nama} absen datang - ${jam} (${statusDatang})`,
    siswa: { nama: siswa.nama, kelas: siswa.kelas }
  };
}
