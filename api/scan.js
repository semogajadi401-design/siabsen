const {
  supabase, generateID, setCors,
  todayStr, jamSekarang, hariIni, tambahMenit,
  isHariLibur, isHariKerja, getSemesterAktif, getJamSetting
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'ping')            return res.json({ ok: true });
    if (action === 'getStatus')       return res.json(await getStatus());
    if (action === 'scanKartu')       return res.json(await scanKartu(params));
    if (action === 'getLogHariIni')   return res.json(await getLogHariIni(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── GET STATUS HARI INI ───────────────────────────────────────────
async function getStatus() {
  const today = todayStr();
  const hari  = hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur)
    return { success: true, bisaAbsen: false, alasan: 'libur', keterangan: cekLibur.keterangan };

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif)
    return { success: true, bisaAbsen: false, alasan: 'hari_libur', keterangan: `${hari} bukan hari sekolah` };

  const semester = await getSemesterAktif();
  if (!semester)
    return { success: true, bisaAbsen: false, alasan: 'no_semester', keterangan: 'Tidak ada semester aktif' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: true, bisaAbsen: false, alasan: 'luar_semester', keterangan: `Di luar periode semester (${semester.nama})` };

  // Cek jam operasional
  const jamSetting = await getJamSetting();
  const jam = jamSekarang();
  const jamMulai   = jamSetting['JAM_DATANG_MULAI']   || '06:00';
  const jamSelesai = jamSetting['JAM_PULANG_SELESAI'] || '17:00';

  // Ambil sesi piket hari ini
  const { data: sesiList } = await supabase
    .from('sesi_piket')
    .select('*')
    .eq('tanggal', today)
    .order('jam_scan');

  const adaGuru = sesiList && sesiList.length > 0;

  return {
    success: true,
    bisaAbsen: true,
    adaGuru,
    guruPiket: sesiList || [],
    jam,
    jamMulai,
    jamSelesai,
    hari,
    tanggal: today,
    semester: semester.nama
  };
}

// ── SCAN KARTU (admin, guru, atau siswa) ─────────────────────────
async function scanKartu({ identifier, mode }) {
  if (!identifier) return { success: false, message: 'QR tidak valid' };

  const today = todayStr();
  const jam   = jamSekarang();
  const hari  = hariIni();
  // Format QR siswa: "SW_ID|NISN" — ambil bagian sebelum "|"
  const raw   = identifier.trim();
  const id    = raw.includes('|') && !raw.startsWith('ADMIN|') && !raw.startsWith('GR')
    ? raw.split('|')[0]
    : raw;

  // ========== 1. CEK ADMIN — WAJIB COCOK DENGAN qr_token RAHASIA ==========
  // Format QR: "ADMIN|username|qr_token". qr_token adalah string acak yang
  // hanya diketahui setelah admin login (lihat auth.js) dan tidak boleh
  // ditebak. Sebelumnya endpoint ini menerima siapa saja yang mengetik
  // "ADMIN|admin" tanpa validasi apapun — lubang keamanan yang memberi
  // akses admin tanpa password sama sekali.
  if (id.startsWith('ADMIN|')) {
    const parts = id.split('|');
    const adminUsername = parts[1];
    const qrToken = parts[2];

    if (!adminUsername || !qrToken) {
      return { success: false, tipe: 'admin', message: 'QR admin tidak valid' };
    }

    const { data: admin } = await supabase
      .from('admin')
      .select('username, nama, qr_token')
      .eq('username', adminUsername)
      .maybeSingle();

    if (admin && admin.qr_token && admin.qr_token === qrToken) {
      return {
        success: true,
        tipe: 'admin',
        message: 'Login sebagai Administrator',
        admin: { username: admin.username, nama: admin.nama }
      };
    }

    return {
      success: false,
      tipe: 'admin',
      message: 'Admin tidak dikenali'
    };
  }
  // ===========================================================================
  // ── VALIDASI JAM OPERASIONAL UNTUK GURU & SISWA ──
  const jamSetting = await getJamSetting();
  const jamMulai       = jamSetting['JAM_DATANG_MULAI']   || '06:00';
  const jamSelesaiOp   = jamSetting['JAM_PULANG_SELESAI'] || '16:00';
  
  if (jam < jamMulai || jam > jamSelesaiOp) {
    return { 
      success: false, 
      message: `Absensi hanya ${jamMulai} - ${jamSelesaiOp}` 
    };
  }

  // ── 2. CEK APAKAH QR GURU ───────────────────────────────────────
  if (id.startsWith('GR')) {
    const { data: guru } = await supabase
      .from('guru')
      .select('id,nama,jabatan,status')
      .eq('id', id)
      .maybeSingle();

    if (!guru) return { success: false, message: 'Guru tidak ditemukan', tipe: 'guru' };
    if (guru.status !== 'Aktif') return { success: false, message: 'Akun guru tidak aktif', tipe: 'guru' };

    // Cek sudah scan hari ini belum
    const { data: sudahScan } = await supabase
      .from('sesi_piket')
      .select('id')
      .eq('tanggal', today)
      .eq('id_guru', guru.id)
      .maybeSingle();

    if (sudahScan) {
      return {
        success: false,
        tipe: 'guru',
        message: `${guru.nama} sudah tercatat sebagai guru piket hari ini`
      };
    }

    // Simpan sesi piket
    const sesiId = generateID('SP');
    const { error } = await supabase.from('sesi_piket').insert({
      id: sesiId,
      tanggal: today,
      id_guru: guru.id,
      nama_guru: guru.nama,
      jabatan: guru.jabatan,
      jam_scan: jam
    });
    if (error) return { success: false, message: 'Gagal simpan sesi piket: ' + error.message, tipe: 'guru' };

    // Update semua absensi hari ini yang nama_guru_piket kosong
    await supabase
      .from('absensi')
      .update({ nama_guru_piket: guru.nama, id_guru_piket: guru.id })
      .eq('tanggal', today)
      .or('nama_guru_piket.is.null,nama_guru_piket.eq.');

    return {
      success: true,
      tipe: 'guru',
      message: `✅ ${guru.nama} tercatat sebagai guru piket`,
      guru: { nama: guru.nama, jabatan: guru.jabatan, jam: jam }
    };
  }

  // ── 3. CEK APAKAH QR SISWA ──────────────────────────────────────
  // Cek ada guru piket dulu
  const { data: sesiList } = await supabase
    .from('sesi_piket')
    .select('*')
    .eq('tanggal', today)
    .order('jam_scan');

  if (!sesiList || sesiList.length === 0) {
    return {
      success: false,
      tipe: 'siswa',
      message: 'Guru piket belum scan kartu. Minta guru piket scan kartunya dulu.'
    };
  }

  // Cek libur
  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur)
    return { success: false, tipe: 'siswa', message: `Hari ini libur: ${cekLibur.keterangan}` };

  // Cek semester
  const semester = await getSemesterAktif();
  if (!semester)
    return { success: false, tipe: 'siswa', message: 'Tidak ada semester aktif' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: false, tipe: 'siswa', message: `Di luar periode semester (${semester.nama})` };

  const toleransi      = Number(jamSetting['TOLERANSI_MENIT'] || 0);
  const jamBatasDatang = tambahMenit(jamSetting['JAM_DATANG_SELESAI'] || '08:00', toleransi);
  const jamPulangMulai = jamSetting['JAM_PULANG_MULAI']   || '14:00';

  // Nama guru piket — pakai yang terakhir scan
  const guruPiketAktif = sesiList[sesiList.length - 1];
  const namaGuru = guruPiketAktif.nama_guru;
  const idGuru   = guruPiketAktif.id_guru;

  // Cari siswa by ID atau NISN
  const { data: siswaById } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('id', id).maybeSingle();
  const { data: siswaByNisn } = siswaById ? { data: null } : await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('nisn', id).maybeSingle();

  const siswa = siswaById || siswaByNisn;
  if (!siswa) return { success: false, tipe: 'siswa', message: 'Siswa tidak ditemukan' };
  if (siswa.status !== 'Aktif') return { success: false, tipe: 'siswa', message: 'Siswa tidak aktif' };

  // Cek absensi hari ini
  const { data: absenHariIni } = await supabase
    .from('absensi').select('*')
    .eq('id_siswa', siswa.id).eq('tanggal', today).maybeSingle();

  // Mode pulang — hanya dipicu jika front-end memang eksplisit mengirim
  // mode 'pulang'. Sebelumnya ada auto-switch berdasarkan jam
  // (`jam >= jamPulangMulai`) yang membuat perilaku beda dari scanAbsen()
  // di absensi.js dan bisa mengabaikan pilihan mode yang sudah dipilih
  // guru piket di halaman scan.
  if (mode === 'pulang') {
    if (jam < jamPulangMulai)
      return { success: false, tipe: 'siswa', message: `Absensi pulang baru bisa dilakukan mulai ${jamPulangMulai}` };
    if (!absenHariIni)
      return { success: false, tipe: 'siswa', message: `${siswa.nama} belum absen datang` };
    if (absenHariIni.jam_pulang)
      return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen pulang pukul ${absenHariIni.jam_pulang}` };

    await supabase.from('absensi').update({
      jam_pulang: jam, status_pulang: 'Pulang',
      nama_guru_piket: namaGuru, id_guru_piket: idGuru
    }).eq('id', absenHariIni.id);

    return {
      success: true, tipe: 'siswa', status: 'Pulang',
      message: `🌙 ${siswa.nama} absen pulang - ${jam}`,
      siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
    };
  }

  // Mode datang
  if (absenHariIni?.jam_datang)
    return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen datang pukul ${absenHariIni.jam_datang}` };

  const statusDatang = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
  const absenId = generateID('AB');

  const { error } = await supabase.from('absensi').insert({
    id: absenId, id_siswa: siswa.id, nisn: siswa.nisn,
    nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal: today, hari, jam_datang: jam,
    status_datang: statusDatang,
    id_guru_piket: idGuru, nama_guru_piket: namaGuru,
    metode: 'QR'
  });
  if (error) return { success: false, tipe: 'siswa', message: 'Gagal simpan: ' + error.message };

  return {
    success: true, tipe: 'siswa', status: statusDatang,
    message: statusDatang === 'Terlambat'
      ? `⚠️ ${siswa.nama} TERLAMBAT - ${jam}`
      : `✅ ${siswa.nama} absen datang - ${jam}`,
    siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
  };
}

// ── GET LOG ABSENSI HARI INI ──────────────────────────────────────
async function getLogHariIni({ kelas }) {
  const today = todayStr();

  // Ambil semua siswa aktif
  let qSiswa = supabase.from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin')
    .eq('status', 'Aktif').order('nama');
  if (kelas) qSiswa = qSiswa.eq('kelas', kelas);
  const { data: siswaSemua } = await qSiswa;

  // Ambil absensi hari ini
  let qAbsen = supabase.from('absensi').select('*').eq('tanggal', today);
  if (kelas) qAbsen = qAbsen.eq('kelas', kelas);
  const { data: absenData } = await qAbsen;

  const absenMap = {};
  (absenData || []).forEach(a => { absenMap[a.id_siswa] = a; });

  const hadir     = [];
  const belumHadir = [];

  (siswaSemua || []).forEach(s => {
    const absen = absenMap[s.id];
    if (absen && absen.jam_datang) {
      hadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama, kelas: s.kelas,
        jamDatang: absen.jam_datang, statusDatang: absen.status_datang,
        jamPulang: absen.jam_pulang || null
      });
    } else {
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama, kelas: s.kelas
      });
    }
  });

  return {
    success: true,
    totalSiswa: (siswaSemua || []).length,
    totalHadir: hadir.length,
    totalBelum: belumHadir.length,
    hadir, belumHadir
  };
}

// CATATAN: fungsi getSesiPiket() yang dulu ada di sini SUDAH DIHAPUS karena
// tidak pernah dipanggil dari scan.html/index.html (kode mati). Data sesi
// piket hari ini sudah tersedia lewat action 'getStatus' di atas
// (field guruPiket), jadi tidak ada fitur yang hilang.
