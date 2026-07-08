const {
  supabase, generateID, setCors, getJamSetting,
  todayStr, jamSekarang, hariIni, tambahMenit,
  isHariLibur, isHariKerja, getSemesterAktif, requireAdminToken
} = require('./_db');

// PENTING — DIPERBAIKI: 'datang' dan 'pulang' SEBELUMNYA terbuka tanpa
// otentikasi apapun (tidak butuh adminToken, tidak butuh sesi guru piket
// seperti scanKartu()/inputTanpaKartu() di api/scan.js). Ternyata setelah
// ditelusuri, kedua action ini juga TIDAK PERNAH dipanggil dari halaman
// manapun (index.html/scan.html) — kode di frontend yang tadinya
// memanggilnya (fungsi doAbsensi()) tidak lagi terhubung ke tombol
// manapun. Karena endpoint publik http://.../api/absensi tetap bisa
// dipanggil langsung dari luar (curl/Postman) terlepas dari ada/tidaknya
// tombol di halaman web, dan aksi ini bisa membuat catatan hadir palsu
// untuk siswa manapun hanya bermodal idSiswa, keduanya sekarang WAJIB
// login admin — sama seperti resetAbsensi. rekap*/dashboard tetap terbuka
// karena isinya hanya laporan (baca data), dipakai alur harian guru piket
// tanpa sesi admin.
//
// CATATAN: action 'scanAbsen' yang dulu ada di file ini SUDAH DIHAPUS
// karena isinya menduplikasi scanKartu() di api/scan.js dan tidak pernah
// dipanggil oleh index.html maupun scan.html (keduanya memakai
// api('scan','scanKartu', ...)). Membiarkan dua implementasi kembar
// berisiko: perbaikan bug di satu tempat gampang lupa diterapkan juga
// di tempat lain. Kalau butuh endpoint scan, pakai api/scan.js.
const AKSI_TERKUNCI = new Set(['resetAbsensi', 'datang', 'pulang']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, ...params } = req.body || {};

  if (AKSI_TERKUNCI.has(action)) {
    const valid = await requireAdminToken(adminToken);
    if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  try {
    if (action === 'datang')            return res.json(await absensiDatang(params));
    if (action === 'pulang')            return res.json(await absensiPulang(params));
    if (action === 'rekapHarian')       return res.json(await rekapHarian(params));
    if (action === 'rekapBulanan')      return res.json(await rekapBulanan(params));
    if (action === 'rekapBulananRange') return res.json(await rekapBulananRange(params));
    if (action === 'dashboard')         return res.json(await dashboard());
    if (action === 'resetAbsensi')      return res.json(await resetAbsensi(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) { return res.status(500).json({ success: false, message: e.message }); }
};

// ── ABSEN DATANG (INPUT MANUAL OLEH ADMIN/GURU) ──────────────────
// Dipakai saat admin input kehadiran manual dari dashboard (bukan scan QR).
// Cek hari libur / hari sekolah aktif / periode semester DISAMAKAN dengan
// scanKartu() di api/scan.js supaya data yang masuk lewat input manual
// mengikuti aturan yang sama seperti data yang masuk lewat scan — cuma beda
// cara masuknya, bukan beda aturannya. Satu hal yang SENGAJA beda: input
// manual tidak mewajibkan guru piket sudah scan duluan, karena ini memang
// aksi admin/guru yang sedang login, bukan aksi siswa lewat kamera scan.
async function absensiDatang({ idSiswa, idGuru, namaGuru, metode }) {
  const { data: siswa } = await supabase.from('siswa').select('*').eq('id', idSiswa).single();
  if (!siswa) return { success: false, message: 'Data siswa tidak ditemukan' };
  if (siswa.status !== 'Aktif') return { success: false, message: 'Siswa sudah tidak aktif' };

  const today = todayStr();
  const jam   = jamSekarang();
  const hari  = hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur)
    return { success: false, message: `Hari ini libur: ${cekLibur.keterangan}` };

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif)
    return { success: false, message: `${hari} bukan hari sekolah` };

  const semester = await getSemesterAktif();
  if (!semester)
    return { success: false, message: 'Tidak ada semester aktif. Hubungi admin.' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: false, message: `Di luar periode semester aktif (${semester.nama})` };

  const { data: existing } = await supabase.from('absensi')
    .select('id,jam_datang').eq('id_siswa', idSiswa).eq('tanggal', today).maybeSingle();
  if (existing?.jam_datang)
    return { success: false, message: `${siswa.nama} sudah absen datang hari ini pukul ${existing.jam_datang}` };

  const jamSetting     = await getJamSetting();
  const toleransi      = Number(jamSetting['TOLERANSI_MENIT'] || 0);
  const jamBatasDatang = tambahMenit(jamSetting['JAM_DATANG_SELESAI'] || '08:00', toleransi);
  const statusDatang   = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';

  const id = generateID('AB');
  const { error } = await supabase.from('absensi').insert({
    id, id_siswa: idSiswa, nisn: siswa.nisn, nama_siswa: siswa.nama,
    kelas: siswa.kelas, tanggal: today, hari, jam_datang: jam,
    status_datang: statusDatang, id_guru_piket: idGuru || '',
    nama_guru_piket: namaGuru || '', metode: metode || 'Manual'
  });
  if (error) return { success: false, message: 'Gagal menyimpan absensi: ' + error.message };

  return {
    success: true,
    message: statusDatang === 'Terlambat'
      ? `⚠️ ${siswa.nama} TERLAMBAT - ${jam}`
      : `✅ ${siswa.nama} berhasil absen datang - ${jam}`,
    status: statusDatang,
    siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
  };
}

// ── ABSEN PULANG (INPUT MANUAL OLEH ADMIN/GURU) ──────────────────
// Sama seperti absensiDatang di atas: tambahkan cek libur/hari-kerja/semester
// supaya konsisten dengan jalur scan, tanpa mewajibkan guru piket sudah scan.
async function absensiPulang({ idSiswa, idGuru, namaGuru, metode }) {
  const today = todayStr();
  const jam   = jamSekarang();
  const hari  = hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur)
    return { success: false, message: `Hari ini libur: ${cekLibur.keterangan}` };

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif)
    return { success: false, message: `${hari} bukan hari sekolah` };

  const semester = await getSemesterAktif();
  if (!semester)
    return { success: false, message: 'Tidak ada semester aktif. Hubungi admin.' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: false, message: `Di luar periode semester aktif (${semester.nama})` };

  const { data: absen } = await supabase.from('absensi')
    .select('*').eq('id_siswa', idSiswa).eq('tanggal', today).maybeSingle();
  if (!absen)
    return { success: false, message: 'Siswa belum absen datang hari ini' };
  if (absen.jam_pulang)
    return { success: false, message: `${absen.nama_siswa} sudah absen pulang hari ini pukul ${absen.jam_pulang}` };

  const { error } = await supabase.from('absensi').update({
    jam_pulang: jam, status_pulang: 'Pulang',
    id_guru_piket: idGuru || '', nama_guru_piket: namaGuru || '',
    metode: metode || 'Manual'
  }).eq('id', absen.id);
  if (error) return { success: false, message: 'Gagal menyimpan absensi pulang: ' + error.message };

  return {
    success: true,
    message: `✅ ${absen.nama_siswa} berhasil absen pulang - ${jam}`,
    status: 'Pulang',
    siswa: { nama: absen.nama_siswa, kelas: absen.kelas, nisn: absen.nisn }
  };
}

async function rekapHarian({ tanggal }) {
  const { data, error } = await supabase.from('absensi')
    .select('*').eq('tanggal', tanggal).order('jam_datang');
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(d => ({
      id: d.id, idSiswa: d.id_siswa, nisn: d.nisn, nama: d.nama_siswa,
      kelas: d.kelas, tanggal: d.tanggal, hari: d.hari,
      jamDatang: d.jam_datang, statusDatang: d.status_datang,
      jamPulang: d.jam_pulang, statusPulang: d.status_pulang,
      namaGuruPiket: d.nama_guru_piket, keterangan: d.keterangan, metode: d.metode
    }))
  };
}

async function rekapBulanan({ bulan, tahun, kelas }) {
  const start = `${tahun}-${String(bulan).padStart(2, '0')}-01`;
  const end   = `${tahun}-${String(bulan).padStart(2, '0')}-31`;
  let q = supabase.from('absensi').select('*').gte('tanggal', start).lte('tanggal', end);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  const grouped = {};
  (data || []).forEach(r => {
    if (!grouped[r.id_siswa]) {
      grouped[r.id_siswa] = {
        idSiswa: r.id_siswa, nisn: r.nisn, nama: r.nama_siswa,
        kelas: r.kelas, hadir: 0, terlambat: 0, pulang: 0
      };
    }
    if (r.status_datang === 'Hadir')     grouped[r.id_siswa].hadir++;
    if (r.status_datang === 'Terlambat') grouped[r.id_siswa].terlambat++;
    if (r.status_pulang === 'Pulang')    grouped[r.id_siswa].pulang++;
  });
  return { success: true, data: Object.values(grouped) };
}

async function rekapBulananRange({ tanggalMulai, tanggalSelesai, kelas }) {
  let q = supabase.from('absensi').select('*')
    .gte('tanggal', tanggalMulai)
    .lte('tanggal', tanggalSelesai);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };

  const grouped = {};
  (data || []).forEach(r => {
    if (!grouped[r.id_siswa]) {
      grouped[r.id_siswa] = {
        idSiswa: r.id_siswa, nisn: r.nisn,
        nama: r.nama_siswa, kelas: r.kelas,
        hadir: 0, terlambat: 0, pulang: 0
      };
    }
    if (r.status_datang === 'Hadir')     grouped[r.id_siswa].hadir++;
    if (r.status_datang === 'Terlambat') grouped[r.id_siswa].terlambat++;
    if (r.status_pulang === 'Pulang')    grouped[r.id_siswa].pulang++;
  });
  return { success: true, data: Object.values(grouped) };
}

async function dashboard() {
  const today = todayStr();
  const hari  = hariIni();

  const [
    { count: totalSiswa },
    { count: totalGuru },
    { data: absenHariIni },
    { data: ketHariIni },
    jamSetting,
    piket
  ] = await Promise.all([
    supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('guru').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('absensi')
      .select('nama_siswa, kelas, jam_datang, status_datang, status_pulang')
      .eq('tanggal', today),
    supabase.from('keterangan_absensi').select('id_siswa, status').eq('tanggal', today),
    getJamSetting(),
    supabase.from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari)
  ]);

  const hadirHariIni     = (absenHariIni || []).filter(a =>
    a.status_datang === 'Hadir' || a.status_datang === 'Terlambat'
  ).length;
  const terlambatHariIni = (absenHariIni || []).filter(a =>
    a.status_datang === 'Terlambat'
  ).length;
  // Rincian sakit/izin hari ini, DITAMPILKAN sebagai kartu tersendiri di
  // dashboard (bukan cuma dikurangkan diam-diam dari Alpha) supaya
  // angkanya tetap kelihatan dan tidak jadi informasi yang hilang/tidak
  // relevan — total Hadir+Terlambat+Sakit/Izin+Alpha harus selalu pas
  // dengan Total Siswa.
  const sakitHariIni = (ketHariIni || []).filter(k => k.status === 'Sakit').length;
  const izinHariIni  = (ketHariIni || []).filter(k => k.status !== 'Sakit').length;
  const sakitIzinHariIni = sakitHariIni + izinHariIni;
  // SEBELUMNYA: alphaHariIni = totalSiswa - hadirHariIni, menganggap SEMUA
  // siswa yang belum absen fisik hari ini otomatis "Alpha" — padahal
  // sebagian bisa jadi sudah diinput Sakit/Izin lewat menu "Kehadiran Hari
  // Ini" (api/kehadiran.js). Akibatnya kartu "Tidak Hadir" di dashboard
  // selalu ikut menghitung siswa sakit/izin sebagai Alpha juga, padahal
  // halaman "Kehadiran Hari Ini" sudah benar memisahkannya. Sekarang
  // dikurangi dulu dengan siswa yang sudah ada keterangan hari ini.
  const alphaHariIni = Math.max(0, (totalSiswa || 0) - hadirHariIni - sakitIzinHariIni);

  const absenTerkini = (absenHariIni || [])
    .filter(a => a.jam_datang)
    .sort((a, b) => (b.jam_datang || '').localeCompare(a.jam_datang || ''))
    .slice(0, 5)
    .map(a => ({
      nama:      a.nama_siswa,
      kelas:     a.kelas,
      jamDatang: a.jam_datang,
      status:    a.status_datang
    }));

  return {
    success: true,
    data: {
      totalSiswa:      totalSiswa || 0,
      totalGuru:       totalGuru  || 0,
      hadirHariIni,
      terlambatHariIni,
      sakitIzinHariIni,
      alphaHariIni,
      jamSetting,
      piketHariIni: (piket.data || []).map(p => ({
        idGuru: p.id_guru, namaGuru: p.nama_guru, jabatan: p.jabatan
      })),
      hariIni: hari,
      absenTerkini
    }
  };
}

// Reset absensi SEKARANG juga membersihkan data yang berhubungan langsung
// dengan periode yang direset — sebelumnya hanya tabel `absensi` yang
// dihapus, sehingga catatan sakit/izin (keterangan_absensi) dan riwayat
// guru piket (sesi_piket) untuk periode yang sama tetap tertinggal dan
// bisa membuat statistik di halaman lain (evaluasi kehadiran, riwayat QR
// siswa) tidak sinkron dengan riwayat absensi yang sudah "direset".
async function resetAbsensi({ kelas, semua }) {
  if (semua) {
    const { error: e0 } = await supabase.from('keterangan_absensi').delete().neq('id', 'x');
    if (e0) return { success: false, message: 'Gagal hapus data sakit/izin: ' + e0.message };

    // sesi_piket tidak punya kolom kelas (guru piket berlaku untuk semua
    // kelas dalam satu hari), jadi hanya ikut dihapus saat reset SEMUA,
    // bukan saat reset per-kelas.
    const { error: e1 } = await supabase.from('sesi_piket').delete().neq('id', 'x');
    if (e1) return { success: false, message: 'Gagal hapus riwayat sesi piket: ' + e1.message };

    const { error } = await supabase.from('absensi').delete().neq('id', 'x');
    if (error) return { success: false, message: 'Gagal reset absensi: ' + error.message };

    // Catat waktu reset ini di jam_setting (kunci RESET_ABSENSI_TERAKHIR).
    // PENTING — celah yang ditutup: perangkat scan (HP/laptop guru piket)
    // yang sedang offline saat reset ini dijalankan menyimpan antrian
    // scan-nya sendiri secara lokal (IndexedDB, lihat scan.html) dan baru
    // mengirimkannya ke server belakangan lewat api/sync.js begitu online
    // lagi. Tanpa penanda ini, item antrian lama tsb bisa lolos masuk lagi
    // ke tabel `absensi`/`sesi_piket` yang baru saja "dibersihkan", padahal
    // dari sudut pandang admin data itu sudah sengaja dihapus. Kegagalan
    // upsert ini SENGAJA tidak membatalkan reset (reset absensi sendiri
    // sudah berhasil) — hanya dicatat sebagai peringatan di pesan balik,
    // supaya admin tahu proteksi tambahan ini mungkin belum aktif.
    const { error: eTs } = await supabase
      .from('jam_setting')
      .upsert({ kunci: 'RESET_ABSENSI_TERAKHIR', nilai: new Date().toISOString() }, { onConflict: 'kunci' });

    return {
      success: true,
      message: 'Seluruh riwayat absensi, data sakit/izin, dan riwayat sesi piket berhasil dihapus'
        + (eTs ? ' (peringatan: gagal mencatat waktu reset untuk proteksi sinkronisasi offline — ' + eTs.message + ')' : '')
    };
  }
  if (!kelas || !kelas.length)
    return { success: false, message: 'Pilih minimal satu kelas' };

  const { error: e0 } = await supabase.from('keterangan_absensi').delete().in('kelas', kelas);
  if (e0) return { success: false, message: 'Gagal hapus data sakit/izin: ' + e0.message };

  const { error } = await supabase.from('absensi').delete().in('kelas', kelas);
  if (error) return { success: false, message: 'Gagal reset absensi: ' + error.message };
  return { success: true, message: `Riwayat absensi dan data sakit/izin kelas ${kelas.join(', ')} berhasil dihapus` };
}
