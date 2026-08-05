// api/kehadiran.js — Kehadiran hari ini, input sakit/izin
const {
  supabase, generateID, setCors, todayStr, hariIni,
  isHariLibur, isHariKerja, requireAdminToken, isGuruPiketHariIni,
  resolveGuruIdFromToken, hitungJumlahHariSekolah,
  hitungTanggalEvaluasiEfektif
} = require('./_db');

// CATATAN: action 'getHariKerja' dan 'updateHariKerja' yang dulu ada di file
// ini SUDAH DIHAPUS karena isinya menduplikasi persis action
// 'getPengaturanHari'/'updatePengaturanHari' di api/settings.js (sama-sama
// baca/tulis tabel pengaturan_hari_kerja). Frontend (index.html) memang
// sudah memakai versi settings.js, jadi versi di sini kode mati — dan
// nama 'getHariKerja' di sini membingungkan karena api/settings.js punya
// action dengan nama SAMA ('getHariKerja') untuk hal yang beda sama sekali
// (kalender hari libur per tanggal, tabel hari_kerja). Kalau butuh
// pengaturan hari sekolah aktif, pakai api/settings.js.
//
// PENTING — DIPERBAIKI: sebelumnya SEMUA action di file ini dikunci
// requireAdminToken, termasuk yang cuma baca laporan (getStatusHariIni,
// getSiswaKehadiran, rekapKeteranganRange). Itu cocok selama halaman yang
// memakainya (Kehadiran Hari Ini, Evaluasi Kehadiran) cuma dibuka oleh
// admin -- tapi begitu akun Kepala Sekolah (role terpisah, lihat
// api/guru.js & schema.sql) perlu buka menu Rekap/Evaluasi Kehadiran
// sebagai pengawas, requestnya GAGAL karena kepsek tidak dan tidak
// seharusnya punya adminToken. Disamakan dengan pola api/absensi.js &
// api/settings.js: hanya action yang MENGUBAH/MENGHAPUS data
// (inputKeterangan, hapusKeterangan) yang dikunci; action baca (laporan)
// tetap terbuka.
const AKSI_TERKUNCI = new Set(['inputKeterangan', 'hapusKeterangan', 'updateKeteranganTerlambat', 'tandaiPulangCepat', 'batalkanPulangCepat']);

// STATUS_PULANG_CEPAT (BARU) -- daftar status yang boleh dipakai untuk
// menandai siswa yang SUDAH HADIR lalu dipulangkan lebih awal (sakit/
// izin mendadak di tengah hari). Sama persis dengan pilihan status yang
// sudah ada di modal inputKeterangan (dropdown Sakit/Izin/Urusan
// Keluarga/Izin Lainnya) -- kasusnya sama (hadir → dijemput mendadak),
// jadi digeneralisir ke 4 status ini, bukan cuma "Sakit".
const STATUS_PULANG_CEPAT = new Set(['Sakit', 'Izin', 'Urusan Keluarga', 'Izin Lainnya']);

// AKSI_BACA_TERBATAS (BARU — perbaikan keamanan): getSiswaKehadiran &
// rekapKeteranganRange mengembalikan `idSiswa` DAN `nisn` mentah untuk
// seluruh siswa -- sebelumnya terbuka tanpa login sama sekali (niatnya
// supaya Kepala Sekolah bisa baca laporan tanpa adminToken), tapi itu
// juga berarti SIAPA SAJA di internet bisa memanennya. Sekarang tetap
// tidak mewajibkan adminToken (supaya kepsek tetap bisa akses), tapi
// WAJIB minimal login sebagai staf (admin ATAU guru/kepsek lewat
// guruToken) -- pola yang sama dengan perbaikan di api/absensi.js.
const AKSI_BACA_TERBATAS = new Set(['getSiswaKehadiran', 'rekapKeteranganRange']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, guruToken, ...params } = req.body || {};
  // PENTING (perbaikan keamanan): `idGuru` TIDAK LAGI dipercaya dari body
  // untuk urusan identitas/otorisasi -- id guru bisa dibaca siapa saja
  // lewat settings.getGuruPiket (endpoint publik "siapa piket hari ini"),
  // jadi kalau dipercaya mentah, siapa pun bisa mengaku jadi guru piket
  // tanpa login sama sekali. Identitas guru sekarang HARUS diturunkan dari
  // `guruToken` (qr_token rahasia, didapat saat login lewat auth.js dan
  // disisipkan otomatis oleh helper api() di frontend) lewat
  // resolveGuruIdFromToken() -- lihat _db.js.
  const guruIdTerverifikasi = guruToken ? await resolveGuruIdFromToken(guruToken) : null;
  // (BARU) Dipindah ke scope luar supaya bisa diteruskan ke inputKeterangan()
  // -- dipakai untuk membatasi input keterangan tanggal LAMPAU hanya untuk
  // admin (lihat catatan di fungsi inputKeterangan di bawah).
  const adminValid = await requireAdminToken(adminToken);

  if (AKSI_TERKUNCI.has(action)) {
    // Dua jalur yang diizinkan:
    //   1. Admin dengan adminToken valid (seperti sebelumnya, tidak berubah).
    //   2. Guru yang BENAR-BENAR piket hari ini (sesi_piket), dan identitas
    //      guru itu sendiri sudah dibuktikan lewat guruToken di atas --
    //      bukan sekadar idGuru yang diklaim klien.
    if (!adminValid) {
      const guruValid = guruIdTerverifikasi && await isGuruPiketHariIni(guruIdTerverifikasi);
      if (!guruValid) {
        return res.status(401).json({ success: false, message: 'Sesi tidak valid. Hanya admin atau guru piket hari ini yang bisa mengubah keterangan.' });
      }
    }
  }

  if (AKSI_BACA_TERBATAS.has(action)) {
    if (!adminValid && !guruIdTerverifikasi) {
      return res.status(401).json({ success: false, message: 'Sesi tidak valid. Silakan login untuk membuka laporan ini.' });
    }
  }

  try {
    if (action === 'getStatusHariIni')     return res.json(await getStatusHariIni());
    if (action === 'getSiswaKehadiran')    return res.json(await getSiswaKehadiran(params));
    if (action === 'inputKeterangan')      return res.json(await inputKeterangan(params, adminValid));
    if (action === 'hapusKeterangan')      return res.json(await hapusKeterangan(params));
    if (action === 'updateKeteranganTerlambat') return res.json(await updateKeteranganTerlambat(params, adminValid));
    // (BARU) Tandai siswa yang SUDAH HADIR sebagai pulang cepat (sakit/
    // izin mendadak) -- lihat tandaiPulangCepat() di bawah untuk detail
    // validasi & otorisasi.
    if (action === 'tandaiPulangCepat')    return res.json(await tandaiPulangCepat(params, adminValid));
    if (action === 'batalkanPulangCepat')  return res.json(await batalkanPulangCepat(params, adminValid));
    if (action === 'rekapKeteranganRange') return res.json(await rekapKeteranganRange(params));
    // (BARU) Dipakai halaman Evaluasi Kehadiran (semester) untuk menghitung
    // % kehadiran & jumlah Alpha yang BENAR -- lihat catatan di
    // hitungJumlahHariSekolah() (_db.js) dan loadEvaluasi() (index.html).
    // Tidak membocorkan data siswa individual, jadi tidak perlu login.
    if (action === 'getJumlahHariSekolah') {
      const { tanggalMulai, tanggalSelesai } = params;
      if (!tanggalMulai || !tanggalSelesai)
        return res.json({ success: false, message: 'tanggalMulai dan tanggalSelesai wajib diisi' });
      // PERBAIKAN BUG (% Kehadiran > 100%): tanggalSelesai yang dikirim
      // frontend adalah akhir SEMESTER (mis. Desember), sementara data
      // absensi yang sudah tercatat (dipakai loadEvaluasi() di
      // index.html untuk pembilang) cuma sampai HARI INI. Sebelumnya
      // fungsi ini membatasi penyebut sampai "kemarin" secara terpisah
      // -- beda satu hari dari rentang yang dipakai pembilang -- jadi
      // begitu ada absensi hari ini, pembilang naik duluan sementara
      // penyebut tertinggal, persentase bisa lewat 100%.
      // Sekarang pakai hitungTanggalEvaluasiEfektif() (_db.js) sebagai
      // SATU-SATUNYA sumber kebenaran, dan tanggalSelesaiEfektif-nya
      // dikirim balik ke frontend supaya dipakai juga oleh
      // rekapBulananRange & rekapKeteranganRange (pembilang) -- jadi
      // kedua sisi PASTI memakai rentang tanggal yang sama persis.
      // (BARU) Fungsi ini sekarang async -- lihat catatan di
      // hitungTanggalEvaluasiEfektif() (_db.js): dia juga mengecek apakah
      // jam absen datang hari ini sudah mulai, supaya hari ini tidak ikut
      // dihitung sebagai hari sekolah efektif kalau belum (mencegah bug
      // "Alpha 1" massal sebelum jam absen dibuka).
      const { tanggalSelesaiEfektif, belumMulai, belumMulaiHariIni, jamMulaiAbsen } =
        await hitungTanggalEvaluasiEfektif(tanggalMulai, tanggalSelesai);

      if (belumMulai) {
        // Semester belum mulai / baru mulai setelah hari ini, ATAU
        // satu-satunya hari yang tersisa (hari ini) belum bisa dievaluasi
        // karena jam absen belum dimulai -- belum ada satu pun hari yang
        // bisa dievaluasi.
        return res.json({
          success: true, jumlahHariSekolah: 0, tanggalSelesaiEfektif: tanggalMulai,
          belumMulaiHariIni, jamMulaiAbsen
        });
      }
      const jumlahHariSekolah = await hitungJumlahHariSekolah(tanggalMulai, tanggalSelesaiEfektif);
      return res.json({
        success: true, jumlahHariSekolah, tanggalSelesaiEfektif,
        belumMulaiHariIni, jamMulaiAbsen
      });
    }
    // Dipakai frontend (guruNav) untuk tahu apakah menu "Kehadiran Hari Ini"
    // perlu ditampilkan: true hanya kalau guru YANG SEDANG LOGIN (dibuktikan
    // lewat guruToken) ada di sesi_piket hari ini, terlepas dari jadwal_piket
    // admin. Tidak lagi menerima idGuru mentah dari klien.
    if (action === 'cekPiketSaya') {
      const piket = guruIdTerverifikasi ? await isGuruPiketHariIni(guruIdTerverifikasi) : false;
      return res.json({ success: true, piketHariIni: piket });
    }
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── CEK STATUS HARI INI ───────────────────────────────────────────
async function getStatusHariIni() {
  const today = todayStr();
  const hari  = hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur) {
    return {
      success: true, bisaAbsen: false,
      alasan: 'libur_kalender',
      keterangan: cekLibur.keterangan,
      tanggal: today, hari
    };
  }

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif) {
    return {
      success: true, bisaAbsen: false,
      alasan: 'hari_libur_sekolah',
      keterangan: `${hari} bukan hari sekolah`,
      tanggal: today, hari
    };
  }

  return { success: true, bisaAbsen: true, tanggal: today, hari };
}

// ── GET DATA KEHADIRAN SISWA ──────────────────────────────────────
async function getSiswaKehadiran({ kelas, tanggal }) {
  const tgl = tanggal || todayStr();

  // 1. Semua siswa aktif
  let qSiswa = supabase
    .from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin')
    .eq('status', 'Aktif')
    .order('nama');
  if (kelas && kelas !== '') qSiswa = qSiswa.eq('kelas', kelas);
  const { data: siswaSemua, error: eSiswa } = await qSiswa;
  if (eSiswa) return { success: false, message: eSiswa.message };

  // 2. Record absensi hari ini
  let qAbsen = supabase.from('absensi').select('*').eq('tanggal', tgl);
  if (kelas && kelas !== '') qAbsen = qAbsen.eq('kelas', kelas);
  const { data: absenData } = await qAbsen;

  // 3. Keterangan sakit/izin hari ini
  let qKet = supabase.from('keterangan_absensi').select('*').eq('tanggal', tgl);
  if (kelas && kelas !== '') qKet = qKet.eq('kelas', kelas);
  const { data: ketData } = await qKet;

  // 4. Buat map untuk lookup cepat
  const absenMap = {};
  (absenData || []).forEach(a => { absenMap[a.id_siswa] = a; });

  const ketMap = {};
  (ketData || []).forEach(k => { ketMap[k.id_siswa] = k; });

  const hadir      = [];
  const belumHadir = [];

  (siswaSemua || []).forEach(s => {
    const absen = absenMap[s.id];
    const ket   = ketMap[s.id];

    if (absen && absen.jam_datang) {
      // (BARU) Apakah siswa ini sudah ditandai "pulang cepat" (sakit/izin
      // mendadak setelah sempat hadir) -- dibedakan dari absen pulang
      // NORMAL lewat status_pulang: 'Pulang' = pulang biasa, salah satu
      // dari STATUS_PULANG_CEPAT = dipulangkan lebih awal karena sakit/
      // izin. Dikirim sebagai field terpisah supaya frontend tidak perlu
      // menebak-nebak dari nilai status_pulang mentah.
      const statusPulangCepat = absen.status_pulang && STATUS_PULANG_CEPAT.has(absen.status_pulang)
        ? absen.status_pulang : null;
      hadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        jamDatang:    absen.jam_datang,
        statusDatang: absen.status_datang,
        jamPulang:    absen.jam_pulang    || null,
        statusPulang: absen.status_pulang || null,
        idAbsen: absen.id,
        // (BARU) Catatan alasan terlambat (kolom `keterangan` di tabel
        // absensi, sudah ada di database tapi belum pernah dipakai) --
        // dipakai guru piket/admin untuk mencatat alasan siswa terlambat
        // (mis. "ban bocor", "urus adik sakit") vs terlambat biasa,
        // lihat updateKeteranganTerlambat() di bawah.
        keteranganTerlambat: absen.keterangan || '',
        // (BARU) Info pulang cepat -- null kalau siswa belum/tidak
        // dipulangkan lebih awal (jam_pulang masih kosong ATAU sudah
        // absen pulang NORMAL di jam pulang resmi).
        pulangCepat: statusPulangCepat ? {
          status: statusPulangCepat,
          jam: absen.jam_pulang,
          keterangan: absen.keterangan_pulang_cepat || ''
        } : null
      });
    } else if (ket) {
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        status:       ket.status,
        keterangan:   ket.keterangan,
        diinputOleh:  ket.diinput_oleh,
        idKeterangan: ket.id,
        sudahAdaKeterangan: true
      });
    } else {
      belumHadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        status: 'Alpha', keterangan: null,
        sudahAdaKeterangan: false
      });
    }
  });

  // 5. Statistik
  const totalSiswa     = siswaSemua?.length || 0;
  const totalHadir     = hadir.filter(h => h.statusDatang === 'Hadir').length;
  const totalTerlambat = hadir.filter(h => h.statusDatang === 'Terlambat').length;
  const totalSakit     = belumHadir.filter(b => b.status === 'Sakit').length;
  const totalIzin      = belumHadir.filter(b =>
    ['Izin','Urusan Keluarga','Izin Lainnya'].includes(b.status)
  ).length;
  const totalAlpha     = belumHadir.filter(b => b.status === 'Alpha').length;
  // (BARU) Dihitung TERPISAH dari totalSakit/totalIzin di atas (yang
  // menghitung siswa yang memang TIDAK datang dari awal) -- ini
  // menghitung siswa yang SEMPAT hadir lalu dipulangkan lebih awal,
  // sesuai concern awal fitur ini supaya dua angka itu tidak tertukar.
  const totalPulangCepat = hadir.filter(h => h.pulangCepat).length;

  return {
    success: true,
    tanggal: tgl,
    statistik: {
      totalSiswa, totalHadir, totalTerlambat,
      totalSakit, totalIzin, totalAlpha, totalPulangCepat,
      totalBelumHadir: belumHadir.length
    },
    hadir,
    belumHadir
  };
}

// ── INPUT KETERANGAN SAKIT / IZIN ────────────────────────────────
// PERBAIKAN BUG (race condition -> data dobel): sebelumnya fungsi ini
// SELECT dulu untuk cek "sudah ada keterangan hari ini atau belum", baru
// INSERT/UPDATE terpisah berdasarkan hasil cek itu -- pola yang SAMA
// PERSIS dipakai scanKartu()/processSingleScan() untuk tabel `absensi`/
// `sesi_piket`, TAPI tabel-tabel itu punya UNIQUE constraint di database
// sebagai jaring pengaman kalau dua request kebetulan lolos SELECT
// nyaris bersamaan (lihat penanganan error.code === '23505' di api/
// scan.js & api/sync.js). Tabel `keterangan_absensi` TIDAK punya
// constraint itu (celah yang baru ditutup di schema.sql --
// uniq_keteranganabsensi_siswa_tanggal), jadi race yang sama (mis. guru
// piket tap ganda tombol di koneksi lambat, atau admin & guru piket
// menginput keterangan untuk siswa yang sama hampir bersamaan) benar-
// benar bisa membuat DUA baris keterangan_absensi untuk siswa+tanggal
// yang sama -- bukan cuma race di memori yang aman. Baris dobel ini
// membuat siswa yang sama terhitung 2x sebagai Sakit/Izin di dashboard
// admin (api/absensi.js), dashboard live/rekap kepsek & admin (_db.js),
// dan evaluasi kehadiran semester (rekapKeteranganRange di bawah).
//
// Perbaikan: pakai upsert() dengan onConflict ke UNIQUE constraint
// (id_siswa, tanggal) -- cek "sudah ada" dan tulis datanya jadi SATU
// operasi atomik di sisi database (Postgres ON CONFLICT ... DO UPDATE),
// bukan dua operasi terpisah di sisi aplikasi yang punya celah waktu di
// antaranya. Kalau ada dua request yang tetap lolos SELECT di bawah
// bersamaan (dipakai hanya untuk teks pesan "diperbarui" vs "disimpan"),
// upsert tetap menjamin hasil akhirnya SATU baris per siswa+tanggal --
// yang "kalah" otomatis jadi UPDATE ke baris yang "menang", bukan insert
// baris baru.
// (BARU) Sebelumnya fungsi ini SELALU memakai tanggal HARI INI
// (todayStr()) secara hardcode -- tidak ada cara untuk admin menginput/
// mengoreksi keterangan sakit/izin untuk tanggal yang SUDAH LEWAT.
// Akibatnya kalau ada siswa yang terlanjur tercatat Alpha di hari
// sebelumnya (mis. guru piket lupa/gagal menginput saat itu), tidak ada
// jalan untuk memperbaikinya lagi selamanya -- padahal keterangan_absensi
// tidak punya validasi "harus hari ini" sama sekali di level database.
// Sekarang menerima `tanggal` opsional (default: hari ini kalau kosong).
// PENTING (keamanan/otorisasi): guru piket HANYA berwenang untuk hari
// dia terverifikasi piket (lihat isGuruPiketHariIni di pengecekan
// AKSI_TERKUNCI atas) -- wewenang itu tidak boleh otomatis meluas ke
// tanggal LAIN hanya karena dia piket hari ini. Jadi request dengan
// `tanggal` selain hari ini HANYA diizinkan kalau pemanggilnya admin
// (adminValid) -- diperiksa lewat parameter `isAdmin` yang dikirim dari
// pengecekan otorisasi di atas, BUKAN dipercaya dari body/klien.
async function inputKeterangan({ idSiswa, status, keterangan, diinputOleh, tanggal }, isAdmin) {
  if (!idSiswa || !status)
    return { success: false, message: 'ID siswa dan status wajib diisi' };

  const today = todayStr();
  const tglTarget = tanggal || today;

  if (tglTarget !== today && !isAdmin) {
    return { success: false, message: 'Hanya admin yang bisa menginput/mengubah keterangan untuk tanggal selain hari ini' };
  }
  if (tglTarget > today) {
    return { success: false, message: 'Tidak bisa menginput keterangan untuk tanggal yang belum terjadi' };
  }

  const { data: siswa } = await supabase
    .from('siswa').select('nisn,nama,kelas').eq('id', idSiswa).maybeSingle();
  if (!siswa) return { success: false, message: 'Siswa tidak ditemukan' };

  // PERBAIKAN BUG: sebelumnya fungsi ini TIDAK PERNAH mengecek tabel
  // `absensi` sama sekali -- jadi kalau siswa SUDAH tercatat Hadir/
  // Terlambat lewat scan/checklist untuk tanggal ini, guru piket/admin
  // tetap bisa "Input Keterangan" (Sakit/Izin/dst) untuk tanggal yang
  // SAMA, menghasilkan DUA catatan yang saling bertentangan: Terlambat
  // di `absensi` DAN Sakit/Izin di `keterangan_absensi` untuk hari yang
  // sama. Di Evaluasi Kehadiran, dua-duanya ikut terhitung terpisah
  // (lihat loadEvaluasi() di index.html), jadi satu hari terhitung 2x
  // untuk siswa itu -- inilah yang terjadi pada laporan "siswa datang
  // terlambat, tapi guru piket tetap input keterangan" sebelumnya.
  // Sekarang: kalau siswa TERBUKTI sudah hadir secara fisik (ada
  // jam_datang), tolak permintaan ini dan arahkan ke fitur yang memang
  // dibuat untuk kasus "sempat hadir lalu pulang karena sakit/izin" --
  // yaitu Tandai Pulang Cepat (tandaiPulangCepat) -- BUKAN diam-diam
  // menimpa/menghapus data absensi yang sudah benar terverifikasi scan.
  const { data: absenTglIni } = await supabase
    .from('absensi').select('jam_datang,status_datang')
    .eq('id_siswa', idSiswa).eq('tanggal', tglTarget).maybeSingle();
  if (absenTglIni?.jam_datang) {
    return {
      success: false,
      message: `${siswa.nama} sudah tercatat ${absenTglIni.status_datang} pukul ${absenTglIni.jam_datang} pada tanggal ini -- tidak bisa juga ditandai ${status}. Kalau siswa sempat hadir lalu harus pulang karena sakit/izin, gunakan fitur "Tandai Pulang Cepat", bukan Input Keterangan.`
    };
  }

  // Dipakai hanya untuk menentukan teks pesan balik (diperbarui/disimpan)
  // dan supaya baris yang diperbarui tetap mempertahankan id lamanya --
  // BUKAN satu-satunya penjaga terhadap duplikat (itu tugas upsert +
  // UNIQUE constraint di bawah).
  const { data: existing } = await supabase
    .from('keterangan_absensi')
    .select('id').eq('id_siswa', idSiswa).eq('tanggal', tglTarget).maybeSingle();

  const { error } = await supabase
    .from('keterangan_absensi')
    .upsert({
      id:           existing?.id || generateID('KT'),
      id_siswa:     idSiswa,
      nisn:         siswa.nisn,
      nama_siswa:   siswa.nama,
      kelas:        siswa.kelas,
      tanggal:      tglTarget,
      status,
      keterangan:   keterangan  || '',
      diinput_oleh: diinputOleh || ''
    }, { onConflict: 'id_siswa,tanggal' });

  if (error) return { success: false, message: error.message };
  return {
    success: true,
    message: existing ? 'Keterangan berhasil diperbarui' : 'Keterangan berhasil disimpan'
  };
}

// ── HAPUS KETERANGAN ─────────────────────────────────────────────
async function hapusKeterangan({ idKeterangan }) {
  if (!idKeterangan)
    return { success: false, message: 'ID keterangan wajib diisi' };

  const { error } = await supabase
    .from('keterangan_absensi').delete().eq('id', idKeterangan);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan berhasil dihapus' };
}

// ── UPDATE KETERANGAN TERLAMBAT (BARU) ───────────────────────────
// Sebelumnya tidak ada cara mencatat ALASAN siswa terlambat -- status
// "Terlambat" cuma angka/badge tanpa konteks, padahal alasannya bisa
// macam-macam (urusan mendadak vs memang malas berangkat) dan berguna
// buat wali kelas/BK menindaklanjuti. Kolom `keterangan` di tabel
// `absensi` sudah ada dari awal tapi belum pernah dipakai untuk ini.
// Otorisasi mengikuti pola yang SAMA PERSIS dengan inputKeterangan:
// admin bebas untuk tanggal berapa pun; guru piket HANYA untuk baris
// absensi hari ini (wewenangnya tidak meluas ke hari lain -- sesuai
// permintaan: begitu hari berganti, guru piket kemarin sudah tidak
// piket lagi hari ini, jadi menu-nya otomatis tidak muncul; kalau mau
// dikoreksi belakangan, harus admin).
async function updateKeteranganTerlambat({ idAbsen, keterangan }, isAdmin) {
  if (!idAbsen) return { success: false, message: 'ID absen wajib diisi' };

  const { data: absen } = await supabase
    .from('absensi').select('id,tanggal,status_datang').eq('id', idAbsen).maybeSingle();
  if (!absen) return { success: false, message: 'Data absensi tidak ditemukan' };

  if (absen.status_datang !== 'Terlambat')
    return { success: false, message: 'Keterangan ini hanya berlaku untuk siswa berstatus Terlambat' };

  const today = todayStr();
  if (absen.tanggal !== today && !isAdmin) {
    return { success: false, message: 'Hanya admin yang bisa mengubah keterangan terlambat untuk tanggal selain hari ini' };
  }

  const { error } = await supabase
    .from('absensi').update({ keterangan: keterangan || '' }).eq('id', idAbsen);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan terlambat berhasil disimpan' };
}

// ── TANDAI PULANG CEPAT (BARU) ───────────────────────────────────
// Dipakai saat siswa yang SUDAH HADIR ternyata sakit/izin di tengah hari
// (mis. jam 10 pagi) dan harus dipulangkan sebelum jam pulang resmi dan
// sebelum dia sempat absen pulang sendiri. Menyimpan status + keterangan
// WAJIB (supaya jelas alasannya, sesuai permintaan) dan jam manual (jam
// guru piket menginput, BUKAN otomatis jam server -- sengaja, karena
// guru piket bisa saja baru sempat input belakangan padahal siswa sudah
// dipulangkan dari tadi; frontend yang mem-prefill jam sekarang tapi
// tetap bisa diedit).
//
// Otorisasi mengikuti pola YANG SAMA PERSIS dengan updateKeteranganTerlambat:
// admin bebas tanggal berapa pun; guru piket HANYA untuk baris absensi
// hari ini (wewenangnya sudah diverifikasi di AKSI_TERKUNCI di atas via
// isGuruPiketHariIni, tapi itu cuma membuktikan dia piket HARI INI --
// tidak otomatis memberi wewenang ke tanggal lampau kalau baris absen
// yang mau diubah ternyata bukan hari ini).
async function tandaiPulangCepat({ idAbsen, status, keterangan, jam, diinputOleh, idGuru }, isAdmin) {
  if (!idAbsen) return { success: false, message: 'ID absen wajib diisi' };
  if (!status || !STATUS_PULANG_CEPAT.has(status))
    return { success: false, message: 'Status tidak valid. Pilih Sakit/Izin/Urusan Keluarga/Izin Lainnya' };
  if (!keterangan || !keterangan.trim())
    return { success: false, message: 'Keterangan wajib diisi supaya jelas alasannya' };
  if (!jam) return { success: false, message: 'Jam wajib diisi' };

  const { data: absen } = await supabase
    .from('absensi').select('id,tanggal,jam_datang,jam_pulang,nama_siswa').eq('id', idAbsen).maybeSingle();
  if (!absen) return { success: false, message: 'Data absensi tidak ditemukan' };
  if (!absen.jam_datang)
    return { success: false, message: 'Siswa ini belum absen datang, gunakan menu Input Keterangan biasa' };

  const today = todayStr();
  if (absen.tanggal !== today && !isAdmin) {
    return { success: false, message: 'Hanya admin yang bisa menandai pulang cepat untuk tanggal selain hari ini' };
  }
  if (absen.jam_pulang) {
    return { success: false, message: `${absen.nama_siswa} sudah tercatat pulang pukul ${absen.jam_pulang}, tidak bisa ditandai pulang cepat lagi` };
  }
  // Jam pulang cepat tidak boleh lebih awal dari jam datang siswa itu
  // sendiri -- pengaman dasar supaya input manual guru piket tidak salah
  // ketik jam yang tidak masuk akal (mis. "sakit" jam sebelum dia datang).
  if (jam < absen.jam_datang) {
    return { success: false, message: `Jam tidak valid: tidak boleh lebih awal dari jam datang (${absen.jam_datang})` };
  }

  const updatePayload = {
    jam_pulang: jam,
    status_pulang: status,
    keterangan_pulang_cepat: keterangan.trim()
  };
  // Hanya timpa nama/ID guru piket kalau memang diketahui siapa yang
  // menandai -- kalau kosong (mis. admin, atau guru piket tidak
  // mengirimkannya), JANGAN ditimpa jadi kosong supaya nama guru piket
  // yang sudah tercatat saat siswa absen datang tidak hilang.
  if (diinputOleh) updatePayload.nama_guru_piket = diinputOleh;
  if (idGuru)       updatePayload.id_guru_piket   = idGuru;

  const { error } = await supabase
    .from('absensi')
    .update(updatePayload)
    .eq('id', idAbsen)
    .is('jam_pulang', null); // pengaman race condition, sama pola dengan scan.js
  if (error) return { success: false, message: error.message };

  return {
    success: true,
    message: `${absen.nama_siswa} ditandai ${status} (pulang cepat) pukul ${jam}`
  };
}

// ── BATALKAN PULANG CEPAT (BARU) ─────────────────────────────────
// Untuk koreksi kalau guru piket salah tandai. HANYA boleh membatalkan
// baris yang status_pulang-nya memang salah satu STATUS_PULANG_CEPAT --
// sengaja TIDAK mengizinkan membatalkan absen pulang NORMAL ('Pulang')
// lewat action ini, supaya tombol ini tidak disalahgunakan untuk
// menghapus riwayat pulang biasa siswa.
async function batalkanPulangCepat({ idAbsen }, isAdmin) {
  if (!idAbsen) return { success: false, message: 'ID absen wajib diisi' };

  const { data: absen } = await supabase
    .from('absensi').select('id,tanggal,status_pulang,nama_siswa').eq('id', idAbsen).maybeSingle();
  if (!absen) return { success: false, message: 'Data absensi tidak ditemukan' };
  if (!absen.status_pulang || !STATUS_PULANG_CEPAT.has(absen.status_pulang))
    return { success: false, message: 'Baris ini bukan status pulang cepat' };

  const today = todayStr();
  if (absen.tanggal !== today && !isAdmin) {
    return { success: false, message: 'Hanya admin yang bisa membatalkan pulang cepat untuk tanggal selain hari ini' };
  }

  const { error } = await supabase
    .from('absensi')
    .update({ jam_pulang: null, status_pulang: null, keterangan_pulang_cepat: null })
    .eq('id', idAbsen);
  if (error) return { success: false, message: error.message };
  return { success: true, message: `Penandaan pulang cepat ${absen.nama_siswa} dibatalkan` };
}

// ── REKAP KETERANGAN RANGE (untuk evaluasi semester) ─────────────
async function rekapKeteranganRange({ tanggalMulai, tanggalSelesai, kelas }) {
  let q = supabase.from('keterangan_absensi').select('*')
    .gte('tanggal', tanggalMulai)
    .lte('tanggal', tanggalSelesai);
  if (kelas) q = q.eq('kelas', kelas);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(d => ({
      idSiswa:    d.id_siswa,
      nisn:       d.nisn,
      nama:       d.nama_siswa,
      kelas:      d.kelas,
      tanggal:    d.tanggal,
      status:     d.status,
      keterangan: d.keterangan
    }))
  };
}

// (getHariKerja/updateHariKerja duplikat sudah dihapus — lihat catatan di atas)
