const {
  supabase, generateID, setCors, getJamSetting,
  todayStr, jamSekarang, hariIni, tambahMenit,
  isHariLibur, isHariKerja, getSemesterAktif, requireAdminToken,
  // ── TAMBAHAN BARU (perbaikan keamanan) ──
  resolveGuruIdFromToken
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

// AKSI_BACA_TERBATAS (BARU — perbaikan keamanan): rekapHarian/rekapBulanan/
// rekapBulananRange mengembalikan `idSiswa` DAN `nisn` mentah untuk seluruh
// siswa pada rentang tanggal yang diminta -- sebelumnya endpoint ini SAMA
// SEKALI tidak butuh login apapun, jadi siapa saja di internet bisa:
//   1. Memanggil rekapBulanan tanpa login untuk mengumpulkan idSiswa/nisn
//      seluruh siswa sekolah, lalu
//   2. Memakai id/nisn itu untuk memalsukan scan kehadiran (celah ini
//      sekarang juga ditutup terpisah lewat kioskToken di api/scan.js,
//      tapi membocorkan idSiswa+nisn semua siswa ke publik tetap masalah
//      privasi tersendiri walau celah scan-nya sudah ditutup).
// Endpoint ini TIDAK dikunci seketat AKSI_TERKUNCI di atas (yang wajib
// adminToken) karena akun Kepala Sekolah (role terpisah, tanpa adminToken)
// memang perlu membaca laporan ini sebagai pengawas -- pola yang sama
// dipakai api/kehadiran.js & api/settings.js. Jadi cukup salah satu:
// adminToken ATAU guruToken (siapa pun staf yang sudah login), TIDAK
// terbuka untuk publik yang belum login sama sekali.
const AKSI_BACA_TERBATAS = new Set(['rekapHarian', 'rekapBulanan', 'rekapBulananRange']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, guruToken, ...params } = req.body || {};

  if (AKSI_TERKUNCI.has(action)) {
    const valid = await requireAdminToken(adminToken);
    if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  if (AKSI_BACA_TERBATAS.has(action)) {
    const adminValid = await requireAdminToken(adminToken);
    if (!adminValid) {
      const guruIdTerverifikasi = guruToken ? await resolveGuruIdFromToken(guruToken) : null;
      if (!guruIdTerverifikasi) {
        return res.status(401).json({ success: false, message: 'Sesi tidak valid. Silakan login untuk membuka laporan ini.' });
      }
    }
  }

  try {
    if (action === 'datang')            return res.json(await absensiDatang(params));
    if (action === 'pulang')            return res.json(await absensiPulang(params));
    if (action === 'rekapHarian')       return res.json(await rekapHarian(params));
    if (action === 'rekapBulanan')      return res.json(await rekapBulanan(params));
    if (action === 'rekapBulananRange') return res.json(await rekapBulananRange(params));
    // (BARU) Dipakai halaman Evaluasi Kehadiran untuk rekap % Kehadiran
    // PER BULAN PER KELAS -- lihat catatan lengkap di
    // rekapHarianPerKelas() di bawah. Sengaja TIDAK dimasukkan ke
    // AKSI_BACA_TERBATAS karena responsnya cuma tanggal+kelas+status
    // (tidak ada idSiswa/nisn/nama), jadi tidak membocorkan data siswa
    // individual -- sama seperti getJumlahHariSekolah di kehadiran.js.
    if (action === 'rekapHarianPerKelas') return res.json(await rekapHarianPerKelas(params));
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
  if (absen.jam_pulang) {
    const statusPC = absen.status_pulang;
    return {
      success: false,
      message: (statusPC && statusPC !== 'Pulang')
        ? `${absen.nama_siswa} sudah dipulangkan lebih awal karena ${statusPC} pukul ${absen.jam_pulang} — bukan absen pulang biasa`
        : `${absen.nama_siswa} sudah absen pulang hari ini pukul ${absen.jam_pulang}`
    };
  }

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

// ── REKAP HARIAN PER KELAS (untuk % Kehadiran per Bulan per Kelas) ──
// (BARU) Dipakai halaman Evaluasi Kehadiran untuk pecah rekap semester
// jadi per-bulan per-kelas. rekapBulananRange() di atas TIDAK bisa
// dipakai untuk ini karena hasilnya sudah dijumlahkan per siswa untuk
// SELURUH rentang tanggal (tidak ada info tanggalnya lagi, jadi tidak
// bisa dikelompokkan per bulan). Fungsi ini sengaja mengembalikan baris
// MENTAH per tanggal, tapi HANYA kolom tanggal+kelas+status_datang --
// TIDAK idSiswa/nisn/nama seperti rekapBulananRange -- supaya endpoint
// ini tidak membocorkan data siswa individual dan aman dibuka tanpa
// login (lihat AKSI_BACA_TERBATAS di atas).
async function rekapHarianPerKelas({ tanggalMulai, tanggalSelesai, kelas }) {
  let q = supabase.from('absensi').select('tanggal,kelas,status_datang')
    .gte('tanggal', tanggalMulai).lte('tanggal', tanggalSelesai);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(d => ({
      tanggal: d.tanggal, kelas: d.kelas, statusDatang: d.status_datang
    }))
  };
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
    piket,
    { data: siswaKelas }
  ] = await Promise.all([
    supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('guru').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('absensi')
      .select('nama_siswa, kelas, jam_datang, status_datang, status_pulang')
      .eq('tanggal', today),
    supabase.from('keterangan_absensi').select('id_siswa, status').eq('tanggal', today),
    getJamSetting(),
    supabase.from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari),
    // BARU: jumlah siswa per kelas, dipakai kartu "Jumlah Siswa per Kelas"
    // di dashboard (admin & kepsek) dan halaman beranda guru. Cuma select
    // kolom kelas siswa Aktif lalu di-group di JS -- seringan
    // getKelasList() di api/siswa.js, supaya tidak menambah beban berarti
    // ke endpoint dashboard yang publik/sering dipanggil.
    supabase.from('siswa').select('kelas').eq('status', 'Aktif')
  ]);

  const jumlahPerKelas = {};
  (siswaKelas || []).forEach(s => {
    const k = (s.kelas || '').trim();
    if (!k) return;
    jumlahPerKelas[k] = (jumlahPerKelas[k] || 0) + 1;
  });
  const siswaPerKelas = Object.keys(jumlahPerKelas)
    .sort((a, b) => a.localeCompare(b, 'id'))
    .map(k => ({ kelas: k, jumlah: jumlahPerKelas[k] }));

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
      // PENTING (perbaikan keamanan): dashboard() PUBLIK (tanpa login,
      // dipakai alur harian sebelum guru piket login) -- idGuru MENTAH
      // sengaja tidak diikutsertakan lagi (frontend cuma pakai
      // namaGuru/jabatan). Sama seperti perbaikan di settings.getGuruPiket:
      // kalau idGuru bocor lewat sini, orang bisa memakainya untuk
      // berpura-pura jadi guru itu di endpoint lain. Identitas guru yang
      // sesungguhnya selalu dibuktikan lewat guruToken, bukan idGuru --
      // lihat resolveGuruIdFromToken() di _db.js.
      piketHariIni: (piket.data || []).map(p => ({
        namaGuru: p.nama_guru, jabatan: p.jabatan
      })),
      hariIni: hari,
      absenTerkini,
      siswaPerKelas
    }
  };
}

// Reset absensi SEKARANG juga membersihkan data yang berhubungan langsung
// dengan periode yang direset — sebelumnya hanya tabel `absensi` yang
// dihapus, sehingga catatan sakit/izin (keterangan_absensi) dan riwayat
// guru piket (sesi_piket) untuk periode yang sama tetap tertinggal dan
// bisa membuat statistik di halaman lain (evaluasi kehadiran, riwayat QR
// siswa) tidak sinkron dengan riwayat absensi yang sudah "direset".
// BARU: absensi_mengajar & kehadiran_siswa_mapel (pasangan absensi untuk
// fitur "Jadwal Mengajar" di api/mengajar.js) ikut dibersihkan juga,
// dengan cakupan yang sama (semua kelas / per-kelas) seperti absensi biasa.
// BARU LAGI: keterangan_mengajar (izin/sakit guru mengajar -- termasuk
// status persetujuan kepsek & file bukti yang diupload) SEBELUMNYA TIDAK
// ikut dibersihkan sama sekali, padahal "pasangan"-nya (absensi_mengajar)
// sudah ikut. Akibatnya setelah Reset Absensi, rekap kehadiran guru jadi
// tidak konsisten (absensi_mengajar sudah kosong tapi keterangan_mengajar
// lama masih ada dan tetap dihitung Izin/Sakit), dan laporan yang masih
// "Menunggu Persetujuan" tetap nyangkut di halaman Persetujuan kepsek
// walau sesi absensinya sendiri sudah dianggap dihapus admin.
async function resetAbsensi({ kelas, semua }) {
  if (semua) {
    const { error: e0 } = await supabase.from('keterangan_absensi').delete().neq('id', 'x');
    if (e0) return { success: false, message: 'Gagal hapus data sakit/izin: ' + e0.message };

    // sesi_piket tidak punya kolom kelas (guru piket berlaku untuk semua
    // kelas dalam satu hari), jadi hanya ikut dihapus saat reset SEMUA,
    // bukan saat reset per-kelas.
    const { error: e1 } = await supabase.from('sesi_piket').delete().neq('id', 'x');
    if (e1) return { success: false, message: 'Gagal hapus riwayat sesi piket: ' + e1.message };

    // BARU: kehadiran_siswa_mapel & absensi_mengajar adalah "pasangan"
    // absensi/keterangan_absensi untuk fitur mengajar (absen guru per jam
    // pelajaran + verifikasi kehadiran siswa per sesi mengajar), tapi
    // sebelumnya tidak ikut dibersihkan sama sekali oleh Reset Absensi.
    // kehadiran_siswa_mapel dihapus dulu karena punya id_absensi_mengajar
    // (FK ke absensi_mengajar).
    const { error: e1b } = await supabase.from('kehadiran_siswa_mapel').delete().neq('id', 'x');
    if (e1b) return { success: false, message: 'Gagal hapus riwayat verifikasi kehadiran siswa per mapel: ' + e1b.message };

    const { error: e1c } = await supabase.from('absensi_mengajar').delete().neq('id', 'x');
    if (e1c) return { success: false, message: 'Gagal hapus riwayat absensi mengajar: ' + e1c.message };

    const { error: e1d } = await supabase.from('keterangan_mengajar').delete().neq('id', 'x');
    if (e1d) return { success: false, message: 'Gagal hapus keterangan izin/sakit mengajar: ' + e1d.message };

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
      message: 'Seluruh riwayat absensi, data sakit/izin, riwayat sesi piket, dan riwayat absensi/verifikasi/izin-sakit mengajar berhasil dihapus'
        + (eTs ? ' (peringatan: gagal mencatat waktu reset untuk proteksi sinkronisasi offline — ' + eTs.message + ')' : '')
    };
  }
  if (!kelas || !kelas.length)
    return { success: false, message: 'Pilih minimal satu kelas' };

  const { error: e0 } = await supabase.from('keterangan_absensi').delete().in('kelas', kelas);
  if (e0) return { success: false, message: 'Gagal hapus data sakit/izin: ' + e0.message };

  // BARU: kehadiran_siswa_mapel & absensi_mengajar sama-sama punya kolom
  // `kelas` (lihat api/mengajar.js), jadi reset per-kelas juga dilingkupi
  // ke kelas yang sama supaya konsisten dengan absensi biasa. Anak
  // (kehadiran_siswa_mapel) dihapus dulu, baru induknya (absensi_mengajar).
  const { error: e0b } = await supabase.from('kehadiran_siswa_mapel').delete().in('kelas', kelas);
  if (e0b) return { success: false, message: 'Gagal hapus riwayat verifikasi kehadiran siswa per mapel: ' + e0b.message };

  const { error: e0c } = await supabase.from('absensi_mengajar').delete().in('kelas', kelas);
  if (e0c) return { success: false, message: 'Gagal hapus riwayat absensi mengajar: ' + e0c.message };

  // BARU: keterangan_mengajar TIDAK punya kolom `kelas` sendiri (beda dari
  // absensi_mengajar/kehadiran_siswa_mapel) -- kelasnya cuma bisa diketahui
  // lewat jadwal_mengajar yang ditunjuk id_jadwal_mengajar. Jadi cari dulu
  // ID jadwal mengajar untuk kelas-kelas ini, baru hapus keterangan yang
  // menunjuk ke ID-ID itu.
  const { data: jadwalKelasTerkait, error: eJadwal } = await supabase
    .from('jadwal_mengajar').select('id').in('kelas', kelas);
  if (eJadwal) return { success: false, message: 'Gagal membaca jadwal mengajar kelas terkait: ' + eJadwal.message };
  const idJadwalKelasTerkait = (jadwalKelasTerkait || []).map(j => j.id);
  if (idJadwalKelasTerkait.length) {
    const { error: e0d } = await supabase.from('keterangan_mengajar').delete().in('id_jadwal_mengajar', idJadwalKelasTerkait);
    if (e0d) return { success: false, message: 'Gagal hapus keterangan izin/sakit mengajar: ' + e0d.message };
  }

  const { error } = await supabase.from('absensi').delete().in('kelas', kelas);
  if (error) return { success: false, message: 'Gagal reset absensi: ' + error.message };
  return { success: true, message: `Riwayat absensi, data sakit/izin, dan riwayat absensi/verifikasi/izin-sakit mengajar kelas ${kelas.join(', ')} berhasil dihapus` };
}
