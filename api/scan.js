const {
  supabase, generateID, setCors,
  todayStr, jamSekarang, hariIni, tambahMenit,
  isHariLibur, isHariKerja, getSemesterAktif, getJamSetting,
  getJamPulangEfektif, cekIzinPiket, verifyPassword,
  // ── TAMBAHAN BARU (perbaikan keamanan) ──
  generateKioskToken, verifyKioskToken, checkRateLimit, getClientIp,
  // ── TAMBAHAN BARU (perbaikan performa scan siswa) ──
  fetchJamPulangOverride, computeJamPulangEfektif,
  // ── TAMBAHAN BARU (fitur Jadwal Besok) ──
  tanggalBesok, hariBesok
} = require('./_db');
// CATATAN: cekIzinPiket() (dan sebutanGuru() pendukungnya) DIPINDAH ke
// api/_db.js supaya api/sync.js (jalur offline) bisa memakai fungsi yang
// SAMA PERSIS, bukan menduplikasi/menyederhanakan aturannya sendiri —
// lihat komentar lengkap di _db.js. Modal pilihan Mengajar/Piket sudah
// dihapus -- lihat catatan di scanKartu() di bawah; absen mengajar
// sekarang HANYA lewat tombol "Absen Kelas".

// scanSesiMengajar (api/mengajar.js) DIPAKAI ULANG di sini, BUKAN dipanggil
// lewat HTTP -- di kiosk (scan.html) tidak ada guruToken (tidak ada sesi
// login), identitas guru di sini dijamin lewat pencocokan id kartu ke
// tabel guru di atas. Panggilan langsung sebagai fungsi (bukan lewat
// endpoint /api/mengajar) supaya guru.id yang sudah diverifikasi server
// bisa dipakai langsung, tanpa perlu qr_token yang memang tidak dicetak
// di QR depan kartu guru. module.exports di mengajar.js menempelkan
// fungsi ini sebagai properti tambahan pada handler-nya (lihat komentar
// di sana), jadi export default (handler HTTP-nya) tidak berubah sama
// sekali.
const scanSesiMengajarInternal = require('./mengajar').scanSesiMengajar;

// ── AKSI YANG BUTUH kioskToken + RATE LIMIT (BARU — perbaikan keamanan) ──
// scanKartu & inputTanpaKartu adalah aksi yang bisa MEMBUAT catatan
// hadir/pulang. Keduanya publik (kiosk tidak login), jadi keduanya kita
// lindungi dengan dua lapis:
//   1. kioskToken -- bukti request berasal dari halaman kiosk yang baru
//      saja memuat/refresh getStatus() (lihat generateKioskToken di
//      _db.js), bukan panggilan API buta dari luar.
//   2. Rate limit per IP -- membatasi berapa kali satu alamat bisa
//      mencoba scan per menit, supaya percobaan tebak-tebak id/nisn
//      (brute force) tetap tidak praktis walau kioskToken-nya entah
//      bagaimana bocor/dipakai ulang dalam jendela waktu yang sama.
//
// PERBAIKAN KEAMANAN (BARU): verifikasiGuruPiket ditambahkan ke daftar
// ini juga. Aksi ini memanggil cekGuruPiketHariIni(username, password) --
// SAMA PERSIS fungsi pengecekan password yang dipakai inputTanpaKartu --
// tapi sebelumnya TIDAK ikut dilindungi kioskToken/rate limit di sini,
// padahal fungsi login utama (api/auth.js -> login()) punya penguncian
// percobaan gagal per-username (lihat percobaanLogin di sana). Tanpa
// perbaikan ini, siapa pun yang tahu endpoint-nya bisa menebak password
// guru piket berkali-kali tanpa batas lewat jalur ini, melewati
// penguncian yang sudah ada di jalur login resmi.
// TAMBAHAN BARU: absenKelasUsername (verifikasi username+password guru
// sebagai pengganti scan kartu di mode "Absen Kelas", lihat fungsinya di
// bawah) memeriksa password guru sama seperti verifikasiGuruPiket, jadi
// ikut dilindungi kioskToken + rate limit yang sama -- kalau tidak, ini
// jadi jalur baru untuk menebak password guru tanpa batas.
const AKSI_BUTUH_KIOSK_TOKEN = new Set(['scanKartu', 'inputTanpaKartu', 'verifikasiGuruPiket', 'absenKelasUsername']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, kioskToken, ...params } = req.body || {};

  if (AKSI_BUTUH_KIOSK_TOKEN.has(action)) {
    const ip = getClientIp(req);
    const limit = checkRateLimit(`scan:${ip}`, { maxRequest: 40, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return res.status(429).json({
        success: false,
        message: `Terlalu banyak percobaan scan dari perangkat/jaringan ini. Coba lagi dalam ${limit.retryAfterSec} detik.`
      });
    }
    if (!verifyKioskToken(kioskToken)) {
      return res.status(401).json({
        success: false,
        message: 'Sesi kiosk tidak valid atau kedaluwarsa. Muat ulang halaman scan.'
      });
    }
  }

  try {
    if (action === 'ping')            return res.json({ ok: true });
    if (action === 'getStatus')       return res.json(await getStatus());
    if (action === 'scanKartu')       return res.json(await scanKartu(params));
    if (action === 'getLogHariIni')   return res.json(await getLogHariIni(params));
    if (action === 'getAktivitasGuruHariIni') return res.json(await getAktivitasGuruHariIni());
    // BARU: jadwal & guru piket BESOK -- dipakai tab "Besok" di modal
    // "Cek Aktivitas Guru" (selagi jam operasional), dan di panel Rekap
    // Harian (bagian "📅 Jadwal Besok") begitu jam operasional sudah
    // berakhir, supaya guru yang buka aplikasi malam hari tetap bisa
    // lihat jadwal & piket besok. Read-only, publik, sama seperti
    // getAktivitasGuruHariIni() di atas.
    if (action === 'getJadwalBesok')      return res.json(await getJadwalBesok());
    // BARU: versi "hari ini" dari getJadwalBesok() di atas -- dipakai
    // panel sidebar saat Mode Menunggu Mulai (jam sudah masuk hari baru,
    // tapi belum sampai jamMulai), lihat getJadwalHariIni() & catatan
    // lengkapnya di dekat definisinya.
    if (action === 'getJadwalHariIni')    return res.json(await getJadwalHariIni());
    if (action === 'verifikasiGuruPiket') return res.json(await verifikasiGuruPiket(params));
    if (action === 'inputTanpaKartu')     return res.json(await inputTanpaKartu(params));
    if (action === 'absenKelasUsername')  return res.json(await absenKelasUsername(params));
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
  // Jam pulang efektif HARI INI — bisa berbeda dari nilai global kalau
  // admin sudah override-nya khusus untuk hari ini di Pengaturan Semester.
  const jamPulangEfektif = await getJamPulangEfektif(hari, jamSetting);
  const jamSelesai = jamPulangEfektif.jamPulangSelesai;

  // Ambil sesi piket hari ini
  const { data: sesiList } = await supabase
    .from('sesi_piket')
    .select('*')
    .eq('tanggal', today)
    .order('jam_scan');

  const adaGuru = sesiList && sesiList.length > 0;

  // Info jadwal piket hari ini (buat ditampilkan di scan.html, misalnya
  // "menunggu Bu Ani (piket terjadwal)" atau "slot pengganti dibuka jam..")
  const { data: jadwalHariIni } = await supabase
    .from('jadwal_piket')
    .select('id_guru,nama_guru')
    .eq('hari', hari);

  const idTerjadwal = (jadwalHariIni || []).map(j => j.id_guru);
  const sudahScanIds = (sesiList || []).map(s => s.id_guru);
  const terjadwalSudahHadir = idTerjadwal.some(id => sudahScanIds.includes(id));
  const toleransiPiket = Number(jamSetting['TOLERANSI_PIKET_MENIT'] || 15);
  const batasPengganti = tambahMenit(jamMulai, toleransiPiket);

  return {
    success: true,
    bisaAbsen: true,
    // BARU (perbaikan keamanan): token sesi kiosk berumur pendek, wajib
    // disertakan klien di setiap scanKartu/inputTanpaKartu berikutnya --
    // lihat catatan lengkap di generateKioskToken()/verifyKioskToken()
    // di _db.js dan AKSI_BUTUH_KIOSK_TOKEN di atas.
    kioskToken: generateKioskToken(),
    adaGuru,
    guruPiket: sesiList || [],
    jam,
    jamMulai,
    jamSelesai,
    // Dipakai scan.html untuk auto-switch mode Datang/Pulang — SEBELUMNYA
    // scan.html hardcode '14:00' sendiri di client, tidak sinkron kalau
    // hari ini jam pulangnya di-override. Sekarang ambil dari sini.
    jamPulangMulai: jamPulangEfektif.jamPulangMulai,
    jamPulangSelesai: jamPulangEfektif.jamPulangSelesai,
    jamPulangOverride: jamPulangEfektif.override,
    hari,
    tanggal: today,
    semester: semester.nama,
    jadwalPiketHariIni: jadwalHariIni || [],
    slotPenggantiTerbuka: idTerjadwal.length > 0 && !terjadwalSudahHadir && jam >= batasPengganti,
    batasPengganti
  };
}

// ── SCAN KARTU (admin, guru, atau siswa) ─────────────────────────
// konfirmasiPiket: true dikirim scan.html pada percobaan KEDUA, setelah
// guru menekan "Ya" di dialog konfirmasi jadi guru piket pengganti.
async function scanKartu({ identifier, mode, konfirmasiPiket, pilihan }) {
  if (!identifier) return { success: false, message: 'QR tidak valid' };

  const today = todayStr();
  const jam   = jamSekarang();
  const hari  = hariIni();
  // Format QR siswa: "SW_ID|NISN" — ambil bagian sebelum "|"
  const raw   = identifier.trim();
  const id    = raw.includes('|') && !raw.startsWith('ADMIN|') && !raw.startsWith('GURU_LOGIN|') && !raw.startsWith('GR')
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
        // PENTING (perbaikan bug "Sesi admin tidak valid"): qrToken WAJIB
        // disertakan di sini. index.html menyisipkan APP.user.qrToken
        // sebagai adminToken di SETIAP request admin berikutnya (lihat
        // fungsi api() di index.html) -- kalau field ini tidak ada,
        // scan.html menyimpan sesi tanpa qrToken sama sekali, sehingga
        // begitu masuk dashboard, semua aksi admin (tambah/ubah/hapus data)
        // ditolak server dengan "Sesi admin tidak valid. Silakan login
        // ulang." meski baru saja login. Login lewat username/password
        // (api/auth.js) sudah benar dari awal karena qrToken memang
        // disertakan di sana -- bug ini KHUSUS untuk login lewat scan
        // kartu QR admin.
        admin: { username: admin.username, nama: admin.nama, qrToken: admin.qr_token }
      };
    }

    return {
      success: false,
      tipe: 'admin',
      message: 'Admin tidak dikenali'
    };
  }
  // ===========================================================================

  // ========== 1b. CEK GURU LOGIN — QR HALAMAN BELAKANG KARTU GURU ==========
  // Format QR: "GURU_LOGIN|qr_token". Beda dari QR halaman depan kartu guru
  // (yang isinya cuma guru.id, untuk absen piket) — QR ini isinya token acak
  // pendek yang unik per guru (lihat generateGuruQrToken di _db.js), dipakai
  // untuk bypass login cepat ke akun guru itu sendiri, sama seperti cara
  // kerja QR bypass admin di atas. Fungsinya login, BUKAN absensi/piket.
  if (id.startsWith('GURU_LOGIN|')) {
    const parts = id.split('|');
    const qrToken = parts[1];

    if (!qrToken) {
      return { success: false, tipe: 'guru_login', message: 'QR login guru tidak valid' };
    }

    const { data: guruLogin } = await supabase
      .from('guru')
      .select('id, nama, jabatan, username, status, qr_token, role')
      .eq('qr_token', qrToken)
      .maybeSingle();

    if (!guruLogin || guruLogin.qr_token !== qrToken) {
      return { success: false, tipe: 'guru_login', message: 'QR login guru tidak valid' };
    }
    if (guruLogin.status !== 'Aktif') {
      return { success: false, tipe: 'guru_login', message: 'Akun guru tidak aktif' };
    }

    return {
      success: true,
      tipe: 'guru_login',
      message: `Login sebagai ${guruLogin.nama}`,
      guru: {
        id: guruLogin.id, nama: guruLogin.nama,
        jabatan: guruLogin.jabatan, username: guruLogin.username,
        // role menentukan sidebar mana yang dibuka scan.html setelah
        // redirect ke index.html (lihat handleScanResult di scan.html):
        // 'kepsek' -> kepsekNav (read-only), selain itu -> guruNav.
        role: guruLogin.role === 'kepsek' ? 'kepsek' : 'guru',
        // PENTING (perbaikan bug "Sesi guru tidak valid" / "Sesi admin
        // tidak valid" setelah login lewat scan kartu): qrToken WAJIB
        // disertakan, sama seperti perbaikan di blok ADMIN| di atas.
        // Tanpa ini, index.html tidak bisa menyisipkan guruToken otomatis
        // di request berikutnya (lihat fungsi api() di index.html),
        // sehingga aksi guru yang butuh verifikasi identitas (mis. input
        // keterangan siswa, lihat riwayat piket sendiri) selalu ditolak
        // server sampai guru login ulang lewat username/password.
        qrToken: guruLogin.qr_token
      }
    };
  }
  // ===========================================================================

  // ========== 1c. CEK APAKAH QR KEPSEK — KARTU DEPAN, LOGIN LANGSUNG ==========
  // PERBAIKAN: sebelumnya kartu DEPAN Kepala Sekolah (formatnya sama dengan
  // kartu depan guru biasa, "GR...") ikut lolos ke bawah dan diproses lewat
  // alur absen piket seperti guru pada umumnya, lalu SELALU ditolak oleh
  // cekIzinPiket() dengan pesan "Akun Kepala Sekolah tidak diperbolehkan
  // tercatat sebagai guru piket..." — sesuatu yang di sisi kiosk tampil
  // sebagai "Gagal diproses". Itu memang benar kalau tujuannya mencatat
  // piket, tapi salah kalau kartu ini justru dipakai kepsek untuk LOGIN ke
  // akunnya sendiri (mis. buka menu pengawasan piket / riwayat).
  //
  // Sekarang disamakan persis dengan pola kartu admin (poin 1) dan QR
  // belakang guru "GURU_LOGIN|" (poin 1b): begitu id "GR..." ini terdeteksi
  // milik akun ber-role 'kepsek', LANGSUNG login ke akunnya — APAPUN
  // KONDISINYA (di luar jam operasional, sudah ada/belum ada guru piket
  // hari ini, dst) — tanpa pernah masuk ke cekIzinPiket()/logika piket sama
  // sekali. Sengaja dicek DI SINI, SEBELUM validasi jam operasional di
  // bawah, supaya kartu kepsek juga tidak ikut tertahan jam absensi seperti
  // guru/siswa (sama seperti QR admin yang juga dicek sebelum validasi jam).
  // PERBAIKAN PERFORMA: hasil query guru di sini (guruCard) SEKARANG DISIMPAN
  // di variabel luar dan dipakai ulang di langkah 2 (CEK APAKAH QR GURU) di
  // bawah, BUKAN di-query ulang dari nol. Sebelumnya setiap kartu guru yang
  // discan (dan bukan kepsek) memicu DUA query persis ke tabel `guru` dengan
  // `id` yang sama -- satu di sini untuk cek apakah ini kartu kepsek, satu
  // lagi nanti (langkah 2) untuk ambil data guru dipakai logika piket/
  // mengajar. select() di sini sudah mencakup semua kolom yang dibutuhkan
  // langkah 2 (id, nama, jabatan, status, role), jadi query kedua yang lama
  // dihapus sama sekali -- tidak ada logika/hasil yang berubah, cuma sumber
  // datanya dipakai ulang.
  let guruCard = null;
  if (id.startsWith('GR')) {
    const { data: calonKepsek } = await supabase
      .from('guru')
      .select('id, nama, jabatan, username, status, role, qr_token')
      .eq('id', id)
      .maybeSingle();
    guruCard = calonKepsek;

    if (calonKepsek && calonKepsek.role === 'kepsek') {
      if (calonKepsek.status !== 'Aktif') {
        return { success: false, tipe: 'guru_login', message: 'Akun guru tidak aktif' };
      }
      return {
        success: true,
        tipe: 'guru_login',
        message: `Login sebagai ${calonKepsek.nama}`,
        guru: {
          id: calonKepsek.id, nama: calonKepsek.nama,
          jabatan: calonKepsek.jabatan, username: calonKepsek.username,
          role: 'kepsek',
          // qrToken di sini bukan token QR belakang (guru ini belum tentu
          // punya qr_token belakang di-generate) -- dipakai index.html
          // hanya sebagai guruToken verifikasi identitas berikutnya, sama
          // seperti dipakai di alur GURU_LOGIN| di atas.
          qrToken: calonKepsek.qr_token
        }
      };
    }
    // Bukan kepsek -> lanjut normal ke validasi jam & logika guru biasa
    // (poin 2) di bawah, TIDAK ADA YANG DIUBAH dari sini.
  }
  // ===========================================================================

  // ========== 1d. CEK QR BELAKANG ADMIN — URL DASHBOARD MONITORING ==========
  // Format QR: URL lengkap ".../admin-monitor/TOKEN" (lihat buildAdminCardBackHTML
  // di index.html). BEDA dari QR DEPAN admin ("ADMIN|user|token", poin 1) yang
  // fungsinya LOGIN -- QR BELAKANG ini fungsinya membuka dashboard monitoring
  // PUBLIK read-only (admin-monitor.html), bukan login. Normalnya QR ini dibuka
  // langsung sebagai link lewat kamera HP biasa, TAPI kalau kebetulan discan
  // lewat kamera utama kiosk, sebelumnya identifier (URL lengkap) tidak cocok
  // format manapun di atas, jatuh ke alur absensi biasa, dan pengguna cuma
  // melihat pesan jam operasional yang membingungkan (seolah "tidak dikenali").
  // Sekarang dikenali eksplisit di sini, SEBELUM validasi jam operasional,
  // supaya kiosk tetap mengarahkan ke dashboard monitoring -- konsisten
  // dengan kartu kepsek (depan = login, belakang = selalu dikenali & terarah
  // ke tujuannya, bukan jatuh ke alur absensi).
  if (raw.includes('/admin-monitor/')) {
    const token = (raw.split('/admin-monitor/')[1] || '').split(/[?#]/)[0].trim();

    if (!token) {
      return { success: false, tipe: 'admin_monitor', message: 'QR dashboard monitoring tidak valid' };
    }

    const { data: adminMon } = await supabase
      .from('admin')
      .select('username, qr_token')
      .eq('qr_token', token)
      .maybeSingle();

    if (adminMon && adminMon.qr_token === token) {
      return {
        success: true,
        tipe: 'admin_monitor',
        message: 'Membuka dashboard monitoring...',
        redirectUrl: '/admin-monitor/' + token
      };
    }

    return { success: false, tipe: 'admin_monitor', message: 'Token dashboard monitoring tidak dikenali' };
  }
  // ===========================================================================

  // ── VALIDASI JAM OPERASIONAL UNTUK GURU & SISWA ──
  // PERBAIKAN PERFORMA: sebelumnya getJamSetting() dan getJamPulangEfektif()
  // di-await BERURUTAN, padahal query pengaturan_hari_kerja di dalam
  // getJamPulangEfektif() sama sekali tidak butuh hasil getJamSetting() --
  // jamSetting cuma dipakai belakangan sebagai fallback (lihat
  // computeJamPulangEfektif() di _db.js). Sekarang keduanya di-Promise.all()
  // supaya cuma menunggu SATU kali round-trip, bukan dua kali berurutan.
  const [jamSetting, jamPulangOverride] = await Promise.all([
    getJamSetting(),
    fetchJamPulangOverride(hari)
  ]);
  const jamMulai       = jamSetting['JAM_DATANG_MULAI']   || '06:00';
  // Jam pulang efektif hari ini (override per-hari kalau ada, atau ikut
  // nilai global) — dipakai berulang di fungsi ini, dihitung sekali saja.
  const jamPulangHariIni = computeJamPulangEfektif(jamSetting, jamPulangOverride);
  const jamSelesaiOp   = jamPulangHariIni.jamPulangSelesai;

  if (jam < jamMulai || jam > jamSelesaiOp) {
    return { 
      success: false, 
      message: `Absensi hanya ${jamMulai} - ${jamSelesaiOp}` 
    };
  }

  // ── 2. CEK APAKAH QR GURU ───────────────────────────────────────
  if (id.startsWith('GR')) {
    // PERBAIKAN PERFORMA: pakai ulang guruCard dari langkah 1c di atas
    // (query tabel `guru` dengan id yang sama persis), BUKAN query ulang.
    // guruCard sudah pasti sudah diisi (atau null) di titik ini karena
    // kita masuk cabang id.startsWith('GR') yang sama seperti di 1c.
    const guru = guruCard;

    if (!guru) return { success: false, message: 'Guru tidak ditemukan', tipe: 'guru' };
    if (guru.status !== 'Aktif') return { success: false, message: 'Akun guru tidak aktif', tipe: 'guru' };

    // ── ABSEN MENGAJAR VS PIKET ────────────────────────────────────
    // SEBELUMNYA (Langkah C): setiap kartu guru discan di sini SELALU
    // menampilkan modal "Absen untuk apa?" (mengajar/piket), walau kiosk
    // sudah punya tombol "📚 Absen Kelas" sendiri yang jadi pintu masuk
    // eksplisit ke absen mengajar (lihat mulaiAbsenKelas()/
    // processScanGuruAbsenKelas() di scan.html, yang mengirim
    // pilihan:'mengajar' langsung tanpa modal). Akibatnya kartu guru yang
    // discan lewat kamera UTAMA (bukan lewat tombol itu) tetap ditanya
    // ulang mengajar/piket -- padahal scan di kamera utama memang cuma
    // untuk piket, dan absen mengajar sudah punya pintu sendiri.
    //
    // Sekarang disederhanakan: kartu guru yang discan di kamera utama
    // (pilihan tidak dikirim / bukan 'mengajar') SELALU diproses sebagai
    // ABSEN PIKET langsung, sama seperti sebelum Langkah C ada. Absen
    // mengajar HANYA bisa dipicu lewat tombol "📚 Absen Kelas", yang
    // mengirim pilihan:'mengajar' secara eksplisit dan ditangani di bawah.
    if (pilihan === 'mengajar') {
      // Guru sudah pilih "Mengajar" di modal -> catat sesi mengajar lewat
      // scanSesiMengajar (api/mengajar.js), TIDAK diproses sebagai piket
      // sama sekali walau guru ini kebetulan guru piket terjadwal hari ini.
      // guru.id yang dipakai di sini hasil query server di atas (bukan
      // idGuru mentah dari body request), jadi tetap memenuhi aturan
      // "identitas guru selalu diverifikasi server, bukan lewat klaim
      // klien" -- di kiosk ini, verifikasinya lewat pencocokan id kartu
      // ke tabel guru, sama seperti jalur piket yang sudah ada.
      // PERBAIKAN PERFORMA: jamSetting kirim yang SUDAH diambil di atas
      // (Promise.all validasi jam operasional), supaya scanSesiMengajar
      // di mengajar.js tidak query ulang tabel pengaturan dari nol untuk
      // nilai yang sama persis (TOLERANSI_MENGAJAR_MENIT dibaca dari objek
      // yang sama). Lihat parameter jamSetting (opsional) di scanSesiMengajar.
      const hasil = await scanSesiMengajarInternal({
        guruIdTerverifikasi: guru.id, tanggal: today, jam, hari, jamSetting
      });
      return {
        ...hasil,
        tipe: 'mengajar',
        guru: { id: guru.id, nama: guru.nama, jabatan: guru.jabatan }
      };
    }
    // pilihan === 'piket' -> lanjut ke logika piket asli di bawah,
    // TIDAK ADA YANG DIUBAH dari sini sampai akhir blok piket.

    // Cek jadwal piket: hanya guru terjadwal yang boleh langsung, guru
    // lain ditawari konfirmasi jadi pengganti (lihat cekIzinPiket di atas).
    // guruRole dikirim supaya akun Kepala Sekolah SELALU ditolak di sini,
    // termasuk sebagai pengganti otomatis.
    const izin = await cekIzinPiket({ guruId: guru.id, guruRole: guru.role, hari, today, jam });
    let pengganti = false;

    if (!izin.boleh) {
      // Guru ini bukan yang terjadwal dan slot belum dikonfirmasi olehnya
      // pada percobaan ini -> minta konfirmasi dulu, JANGAN catat apapun.
      if (izin.perluKonfirmasi && !konfirmasiPiket) {
        return {
          success: false,
          tipe: 'guru',
          perluKonfirmasi: true,
          sebelumToleransi: izin.sebelumToleransi,
          message: izin.message,
          guru: { id: guru.id, nama: guru.nama, jabatan: guru.jabatan }
        };
      }
      // Ditolak murni (jadwal sudah tertutup/sudah ada piket lain) —
      // termasuk kalau kondisinya berubah di antara scan pertama dan saat
      // guru menekan "Ya" (mis. ada guru lain yang keburu terkonfirmasi).
      if (!(izin.perluKonfirmasi && konfirmasiPiket)) {
        return { success: false, tipe: 'guru', message: izin.message };
      }
      // Sudah dikonfirmasi guru ini ("Ya" ditekan) -> lanjut daftar sebagai
      // pengganti di bawah, langsung mengunci slot untuk sisa hari itu.
      pengganti = true;
    }

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
    if (error) {
      // Kode 23505 = unique_violation. Bisa terjadi kalau 2 perangkat scan
      // guru piket yang sama nyaris bersamaan — constraint UNIQUE(tanggal,
      // id_guru) di database yang mencegahnya. Perlakukan sebagai duplikat
      // (sama seperti penanganan di processSingleScan() / api/sync.js),
      // BUKAN error mentah dari database.
      if (error.code === '23505') {
        return {
          success: false, tipe: 'guru',
          message: `${guru.nama} sudah tercatat sebagai guru piket hari ini`
        };
      }
      return { success: false, message: 'Gagal simpan sesi piket: ' + error.message, tipe: 'guru' };
    }

    // Update semua absensi hari ini yang nama_guru_piket kosong
    await supabase
      .from('absensi')
      .update({ nama_guru_piket: guru.nama, id_guru_piket: guru.id })
      .eq('tanggal', today)
      .or('nama_guru_piket.is.null,nama_guru_piket.eq.');

    return {
      success: true,
      tipe: 'guru',
      message: pengganti
        ? `✅ ${guru.nama} tercatat sebagai guru piket PENGGANTI (dikonfirmasi menggantikan guru terjadwal)`
        : `✅ ${guru.nama} tercatat sebagai guru piket`,
      guru: { nama: guru.nama, jabatan: guru.jabatan, jam: jam, pengganti }
    };
  }

  // ── 3. CEK APAKAH QR SISWA ──────────────────────────────────────
  // PERBAIKAN PERFORMA (INTI dari perbaikan kecepatan scan siswa):
  // sebelumnya 4 query di bawah ini (sesi_piket, isHariLibur,
  // getSemesterAktif, cari siswa) di-await SATU PER SATU secara
  // berurutan, padahal SATU PUN dari keempatnya tidak butuh hasil query
  // yang lain -- keempatnya independen. Pencarian siswa juga sebelumnya
  // dilakukan bertahap (query by id, BARU kalau kosong query by nisn),
  // padahal keduanya bisa langsung dijalankan bersamaan sekalian (query
  // ekstra ini nyaris tanpa biaya tambahan karena tetap dalam satu
  // round-trip paralel yang sama).
  //
  // Sekarang SEMUA query ini dijalankan lewat Promise.all() -- total
  // waktu tunggu jadi sama dengan query PALING LAMBAT di antara mereka
  // (bukan JUMLAH kelimanya). Urutan pengecekan/pesan error di bawah
  // TETAP SAMA PERSIS seperti sebelumnya (guru piket -> libur -> semester
  // -> siswa ditemukan -> siswa aktif), cuma cara AMBIL datanya yang
  // berubah jadi paralel.
  const [
    { data: sesiList },
    cekLibur,
    semester,
    { data: siswaById },
    { data: siswaByNisn }
  ] = await Promise.all([
    supabase.from('sesi_piket').select('*').eq('tanggal', today).order('jam_scan'),
    isHariLibur(today),
    getSemesterAktif(),
    supabase.from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status').eq('id', id).maybeSingle(),
    supabase.from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status').eq('nisn', id).maybeSingle()
  ]);

  // Cek ada guru piket dulu
  if (!sesiList || sesiList.length === 0) {
    return {
      success: false,
      tipe: 'siswa',
      message: 'Guru piket belum scan kartu. Minta guru piket scan kartunya dulu.'
    };
  }

  // Cek libur
  if (cekLibur.libur)
    return { success: false, tipe: 'siswa', message: `Hari ini libur: ${cekLibur.keterangan}` };

  // Cek semester
  if (!semester)
    return { success: false, tipe: 'siswa', message: 'Tidak ada semester aktif' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: false, tipe: 'siswa', message: `Di luar periode semester (${semester.nama})` };

  const toleransi      = Number(jamSetting['TOLERANSI_MENIT'] || 0);
  const jamBatasDatang = tambahMenit(jamSetting['JAM_DATANG_SELESAI'] || '08:00', toleransi);
  // Pakai jam pulang efektif hari ini (override per-hari kalau admin
  // sudah atur di Pengaturan Semester, kalau tidak ikut global) —
  // sudah dihitung sekali di awal fungsi (jamPulangHariIni).
  const jamPulangMulai = jamPulangHariIni.jamPulangMulai;

  // Nama guru piket — pakai yang terakhir scan
  const guruPiketAktif = sesiList[sesiList.length - 1];
  const namaGuru = guruPiketAktif.nama_guru;
  const idGuru   = guruPiketAktif.id_guru;

  // Siswa (by ID atau NISN) sudah diambil bersamaan di Promise.all di atas.
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
    if (absenHariIni.jam_pulang) {
      // (BARU) Bedakan pesan: kalau sebelumnya sudah ditandai "pulang
      // cepat" (Sakit/Izin, lihat tandaiPulangCepat di api/kehadiran.js),
      // pesannya harus jelas menyebut itu -- bukan seolah dia baru saja
      // absen pulang biasa lewat scan kartu.
      const statusPC = absenHariIni.status_pulang;
      const sudahPulangCepat = statusPC && statusPC !== 'Pulang';
      return {
        success: false, tipe: 'siswa',
        message: sudahPulangCepat
          ? `${siswa.nama} sudah dipulangkan lebih awal karena ${statusPC} pukul ${absenHariIni.jam_pulang} — bukan absen pulang biasa`
          : `${siswa.nama} sudah absen pulang pukul ${absenHariIni.jam_pulang}`
      };
    }

    // PERBAIKAN RACE CONDITION: sebelumnya UPDATE ini tidak punya syarat
    // apa pun selain `id` -- kalau 2 perangkat scan pulang siswa yang sama
    // nyaris bersamaan, keduanya bisa lolos pengecekan `absenHariIni.jam_pulang`
    // di atas (dua-duanya masih melihat kondisi "belum pulang" sebelum salah
    // satu sempat menyimpan), lalu dua-duanya sukses UPDATE tanpa ada yang
    // ditolak. Tidak merusak data (hasil akhirnya tetap satu nilai jam_pulang
    // yang konsisten), tapi kedua device sama-sama menampilkan "sukses"
    // padahal cuma salah satu yang seharusnya. `.is('jam_pulang', null)` di
    // sini membuat UPDATE hanya benar-benar mengenai baris kalau jam_pulang
    // MASIH kosong PERSIS SAAT database mengeksekusinya (bukan cuma saat kita
    // SELECT di atas) -- kalau ada perangkat lain yang menang duluan,
    // `.select()` di bawah akan mengembalikan array kosong, dan itu jadi
    // sinyal untuk memperlakukannya sebagai duplikat (sama seperti pola
    // 23505 di jalur lain).
    const { data: pulangUpdated, error: pulangError } = await supabase
      .from('absensi')
      .update({
        jam_pulang: jam, status_pulang: 'Pulang',
        nama_guru_piket: namaGuru, id_guru_piket: idGuru
      })
      .eq('id', absenHariIni.id)
      .is('jam_pulang', null)
      .select('jam_pulang');

    if (pulangError) {
      return { success: false, tipe: 'siswa', message: 'Gagal simpan: ' + pulangError.message };
    }

    if (!pulangUpdated || pulangUpdated.length === 0) {
      // Kalah race -- perangkat lain sudah lebih dulu mengisi jam_pulang
      // di antara SELECT absenHariIni di atas dan UPDATE ini. Ambil ulang
      // nilai jam_pulang yang sebenarnya tersimpan supaya pesannya akurat.
      const { data: absenTerbaru } = await supabase
        .from('absensi').select('jam_pulang,status_pulang').eq('id', absenHariIni.id).maybeSingle();
      const statusPCTerbaru = absenTerbaru?.status_pulang;
      const sudahPulangCepatTerbaru = statusPCTerbaru && statusPCTerbaru !== 'Pulang';
      return {
        success: false, tipe: 'siswa',
        message: sudahPulangCepatTerbaru
          ? `${siswa.nama} sudah dipulangkan lebih awal karena ${statusPCTerbaru} pukul ${absenTerbaru?.jam_pulang || '-'} — bukan absen pulang biasa`
          : `${siswa.nama} sudah absen pulang pukul ${absenTerbaru?.jam_pulang || '-'}`
      };
    }

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
  if (error) {
    // Kode 23505 = unique_violation. Bisa terjadi kalau 2 perangkat scan
    // siswa yang sama nyaris bersamaan — constraint UNIQUE(id_siswa,
    // tanggal) di database yang mencegahnya. Perlakukan sebagai duplikat
    // (sama seperti penanganan di processSingleScan() / api/sync.js),
    // BUKAN error mentah dari database.
    if (error.code === '23505') {
      return { success: false, tipe: 'siswa', message: `${siswa.nama} sudah absen datang hari ini` };
    }
    return { success: false, tipe: 'siswa', message: 'Gagal simpan: ' + error.message };
  }

  return {
    success: true, tipe: 'siswa', status: statusDatang,
    message: statusDatang === 'Terlambat'
      ? `⚠️ ${siswa.nama} TERLAMBAT - ${jam}`
      : `✅ ${siswa.nama} absen datang - ${jam}`,
    siswa: { nama: siswa.nama, kelas: siswa.kelas, nisn: siswa.nisn }
  };
}

// ── VERIFIKASI GURU PIKET (dipakai fitur "Input Tanpa Kartu") ────
// Guru piket yang scan kartu di awal hari sudah tercatat di sesi_piket.
// Fitur "input tanpa kartu" (untuk siswa yang kartunya hilang/rusak/
// ketinggalan) HANYA boleh dipakai oleh guru yang memang tercatat piket
// hari itu (baik yang terjadwal maupun pengganti).
//
// PENTING — DIPERBAIKI (celah keamanan): sebelumnya fungsi ini HANYA
// mencocokkan `username` yang diketik bebas di scan.html, TANPA password
// sama sekali. Username BUKAN rahasia (gampang diketahui/ditebak siapa
// saja di lingkungan sekolah), jadi siapa pun yang tahu username seorang
// guru piket bisa membuat catatan hadir palsu untuk siswa manapun lewat
// endpoint publik ini (baik lewat UI maupun langsung lewat API), tanpa
// perlu tahu password guru tersebut sama sekali. Ini sama persis dengan
// pola celah yang sudah pernah ditemukan & diperbaiki di api/absensi.js
// (lihat komentar action 'datang'/'pulang' di sana). Sekarang password
// guru WAJIB diverifikasi juga (bcrypt, lewat verifyPassword() yang sama
// dipakai auth.js), sehingga identitas guru benar-benar dibuktikan --
// bukan cuma diklaim.
async function cekGuruPiketHariIni(username, password) {
  if (!username) return { ok: false, message: 'Username wajib diisi' };
  if (!password) return { ok: false, message: 'Password wajib diisi' };

  // PERBAIKAN BUG: sebelumnya pakai .ilike() (case-insensitive, TAPI juga
  // mengaktifkan wildcard SQL LIKE seperti '%' dan '_' di input pengguna)
  // -- tidak konsisten dengan login utama (api/auth.js -> login()) yang
  // memakai .eq() case-sensitive biasa. Selain rawan salah paham (username
  // "budi%" atau "_udi" bisa cocok ke baris yang tidak seharusnya cocok),
  // ini juga cara yang salah untuk mencari 1 username spesifik. Disamakan
  // ke .eq() seperti auth.js -- exact match, tanpa arti khusus untuk
  // karakter wildcard apapun.
  const { data: guru } = await supabase
    .from('guru')
    .select('id,nama,username,status,password')
    .eq('username', username.trim())
    .maybeSingle();

  if (!guru) return { ok: false, message: 'Username atau password salah' };
  if (guru.status !== 'Aktif') return { ok: false, message: 'Akun guru tidak aktif' };

  const cekPass = await verifyPassword(password, guru.password);
  if (!cekPass.valid) return { ok: false, message: 'Username atau password salah' };

  const today = todayStr();
  const { data: sesiHariIni } = await supabase
    .from('sesi_piket')
    .select('id_guru')
    .eq('tanggal', today);

  const idPiketHariIni = (sesiHariIni || []).map(s => s.id_guru);
  if (!idPiketHariIni.includes(guru.id)) {
    return { ok: false, message: `${guru.nama} belum tercatat sebagai guru piket hari ini. Scan kartu guru piket dulu.` };
  }

  return { ok: true, guru: { id: guru.id, nama: guru.nama } };
}

async function verifikasiGuruPiket({ username, password }) {
  const cek = await cekGuruPiketHariIni(username, password);
  if (!cek.ok) return { success: false, message: cek.message };
  return { success: true, guru: cek.guru };
}

// ── CEK PASSWORD GURU (GENERIK, TANPA SYARAT PIKET) ──────────────────
// BARU: dipakai khusus oleh absenKelasUsername() di bawah. BEDA dari
// cekGuruPiketHariIni() -- fungsi itu MEWAJIBKAN guru sudah tercatat di
// sesi_piket hari ini (tabel piket harian), yang tidak relevan untuk
// Absen Kelas (mengajar per jam pelajaran, dicek lewat jadwal_mengajar,
// bukan jadwal piket). Di sini hanya membuktikan identitas & status akun
// aktif -- validasi "apakah memang ada jadwal mengajar jam ini" tetap
// sepenuhnya di scanKartu()/scanSesiMengajarInternal(), TIDAK diduplikasi
// di sini, supaya aturannya selalu sama persis dengan jalur scan kartu
// fisik.
async function cekPasswordGuru(username, password) {
  if (!username) return { ok: false, message: 'Username wajib diisi' };
  if (!password) return { ok: false, message: 'Password wajib diisi' };

  const { data: guru } = await supabase
    .from('guru')
    .select('id,nama,username,status,password,role')
    .eq('username', username.trim())
    .maybeSingle();

  if (!guru) return { ok: false, message: 'Username atau password salah' };
  if (guru.status !== 'Aktif') return { ok: false, message: 'Akun guru tidak aktif' };

  const cekPass = await verifyPassword(password, guru.password);
  if (!cekPass.valid) return { ok: false, message: 'Username atau password salah' };

  // Akun Kepala Sekolah tidak boleh tercatat sebagai absen mengajar --
  // sama seperti aturan guruRole yang sudah dicek di scanKartu() lewat
  // cekIzinPiket() untuk jalur piket. scanKartu() sendiri sebetulnya akan
  // tetap login-kan kartu "GR..." milik kepsek sebagai tipe 'guru_login'
  // (lihat poin 1c) APAPUN pilihan yang dikirim -- jadi baris ini murni
  // mempercepat pesan errornya di sini, bukan satu-satunya penjaga.
  if (guru.role === 'kepsek') {
    return { ok: false, message: 'Akun Kepala Sekolah tidak bisa dipakai untuk Absen Kelas.' };
  }

  return { ok: true, guru: { id: guru.id, nama: guru.nama } };
}

// ── ABSEN KELAS LEWAT USERNAME (BARU) ─────────────────────────────────
// Pengganti scan kartu fisik guru di mode "Absen Kelas" (scan.html ->
// #menungguAbsenKelasBox -> "🪪 Tidak bawa kartu?"), untuk guru yang lupa/
// ketinggalan kartunya. Sengaja TIDAK menulis ulang validasi jadwal
// mengajar/jam operasional/dsb di sini -- begitu identitas guru terbukti
// lewat password, langsung panggil scanKartu() yang SAMA PERSIS dipakai
// jalur scan kartu fisik (identifier = guru.id, pilihan:'mengajar'),
// supaya kedua jalur selalu berperilaku identik dan aturan baru di
// scanKartu() otomatis berlaku juga di sini tanpa perlu disalin manual.
async function absenKelasUsername({ username, password, mode }) {
  const cek = await cekPasswordGuru(username, password);
  if (!cek.ok) return { success: false, message: cek.message };
  return scanKartu({ identifier: cek.guru.id, mode, pilihan: 'mengajar' });
}

// ── INPUT KEHADIRAN TANPA KARTU ───────────────────────────────────
// Untuk siswa yang kartunya hilang/rusak/ketinggalan. HANYA bisa dipakai
// guru piket hari ini (dicek ulang di server, jangan percaya status
// terverifikasi dari sisi client saja). Guru piket mencentang siswa yang
// tidak bawa kartu dari daftar "belum hadir", lalu disimpan sekaligus.
async function inputTanpaKartu({ username, password, siswaIds, mode }) {
  const cek = await cekGuruPiketHariIni(username, password);
  if (!cek.ok) return { success: false, message: cek.message };
  const guru = cek.guru;

  if (!Array.isArray(siswaIds) || siswaIds.length === 0) {
    return { success: false, message: 'Pilih minimal satu siswa' };
  }

  const today = todayStr();
  const jam   = jamSekarang();
  const hari  = hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur) return { success: false, message: `Hari ini libur: ${cekLibur.keterangan}` };

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif) return { success: false, message: `${hari} bukan hari sekolah` };

  const semester = await getSemesterAktif();
  if (!semester) return { success: false, message: 'Tidak ada semester aktif' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (today < tglMulai || today > tglSelesai)
    return { success: false, message: `Di luar periode semester (${semester.nama})` };

  const jamSetting     = await getJamSetting();
  const toleransi      = Number(jamSetting['TOLERANSI_MENIT'] || 0);
  const jamBatasDatang = tambahMenit(jamSetting['JAM_DATANG_SELESAI'] || '08:00', toleransi);
  // Jam pulang efektif hari ini — override per-hari (Pengaturan Semester)
  // kalau ada, kalau tidak ikut global (Pengaturan Jam).
  const jamPulangMulai = (await getJamPulangEfektif(hari, jamSetting)).jamPulangMulai;

  if (mode === 'pulang' && jam < jamPulangMulai) {
    return { success: false, message: `Absensi pulang baru bisa dilakukan mulai ${jamPulangMulai}` };
  }

  let berhasil = 0, gagal = 0;
  const detail = [];

  for (const idSiswa of siswaIds) {
    const { data: siswa } = await supabase
      .from('siswa').select('id,nisn,nama,kelas,status')
      .eq('id', idSiswa).maybeSingle();

    if (!siswa)                    { gagal++; detail.push({ id: idSiswa, success: false, message: 'Siswa tidak ditemukan' }); continue; }
    if (siswa.status !== 'Aktif')  { gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: 'Siswa tidak aktif' }); continue; }

    const { data: absenHariIni } = await supabase
      .from('absensi').select('*')
      .eq('id_siswa', siswa.id).eq('tanggal', today).maybeSingle();

    if (mode === 'pulang') {
      if (!absenHariIni)           { gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: 'Belum absen datang' }); continue; }
      if (absenHariIni.jam_pulang) {
        const statusPCBatch = absenHariIni.status_pulang;
        const msgBatch = (statusPCBatch && statusPCBatch !== 'Pulang')
          ? `Sudah dipulangkan lebih awal karena ${statusPCBatch} pukul ${absenHariIni.jam_pulang}`
          : `Sudah absen pulang pukul ${absenHariIni.jam_pulang}`;
        gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: msgBatch }); continue;
      }

      const { error } = await supabase.from('absensi').update({
        jam_pulang: jam, status_pulang: 'Pulang',
        nama_guru_piket: guru.nama, id_guru_piket: guru.id,
        metode: 'Manual (Tanpa Kartu)'
      }).eq('id', absenHariIni.id);

      if (error) { gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: error.message }); continue; }
      berhasil++; detail.push({ id: idSiswa, nama: siswa.nama, success: true, message: `Pulang - ${jam}` });
      continue;
    }

    // Mode datang
    if (absenHariIni?.jam_datang) { gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: `Sudah absen datang pukul ${absenHariIni.jam_datang}` }); continue; }

    // Jaga-jaga kondisi balapan (race condition): siswa yang barusan
    // diinput Sakit/Izin oleh guru piket/admin lain persis saat checklist
    // "Tanpa Kartu" ini sedang diisi -- frontend sudah menyaring daftar
    // checklist dari belumHadir (lihat getLogHariIni), tapi tetap dicek
    // ulang di server supaya tidak ada siswa sakit/izin yang kecatat
    // "Hadir" gara-gara data checklist di HP guru sempat basi beberapa detik.
    const { data: ketHariIni } = await supabase
      .from('keterangan_absensi').select('status')
      .eq('id_siswa', siswa.id).eq('tanggal', today).maybeSingle();
    if (ketHariIni) {
      gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: `Sudah diinput ${ketHariIni.status} hari ini` });
      continue;
    }

    const statusDatang = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
    const absenId = generateID('AB');
    const { error } = await supabase.from('absensi').insert({
      id: absenId, id_siswa: siswa.id, nisn: siswa.nisn,
      nama_siswa: siswa.nama, kelas: siswa.kelas,
      tanggal: today, hari, jam_datang: jam,
      status_datang: statusDatang,
      id_guru_piket: guru.id, nama_guru_piket: guru.nama,
      metode: 'Manual (Tanpa Kartu)'
    });

    if (error) {
      if (error.code === '23505') { gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: 'Sudah absen datang hari ini' }); continue; }
      gagal++; detail.push({ id: idSiswa, nama: siswa.nama, success: false, message: error.message }); continue;
    }
    berhasil++; detail.push({ id: idSiswa, nama: siswa.nama, success: true, message: `${statusDatang} - ${jam}` });
  }

  return {
    success: true,
    guru: guru.nama,
    berhasil, gagal, detail,
    message: `${berhasil} siswa berhasil dicatat${gagal ? `, ${gagal} gagal` : ''}`
  };
}

// ── GET LOG ABSENSI HARI INI ──────────────────────────────────────
// PENTING — DIPERBAIKI: sebelumnya fungsi ini SAMA SEKALI tidak
// membaca tabel keterangan_absensi (tempat guru piket/admin input
// sakit/izin lewat menu "Kehadiran Hari Ini", api/kehadiran.js).
// Akibatnya siswa yang sudah diinput Sakit/Izin tetap muncul di
// tab "Belum Hadir" halaman scan, dan bisa ikut tercentang di modal
// "Tanpa Kartu" (yang mengambil sumber data dari sini juga) seolah-
// olah dia belum ada keterangan apapun. Sekarang dipisah jadi 3
// kelompok, konsisten dengan pola yang sudah dipakai getSiswaKehadiran
// (api/kehadiran.js) dan dashboard() (api/absensi.js):
//   1. hadir      -> sudah ada jam_datang di tabel absensi
//   2. izinSakit  -> belum absen, TAPI sudah ada baris di
//                    keterangan_absensi hari ini (Sakit/Izin/dst)
//   3. belumHadir -> belum absen DAN belum ada keterangan apapun
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

  // Ambil keterangan sakit/izin hari ini (sudah diinput guru piket/admin)
  let qKet = supabase.from('keterangan_absensi').select('*').eq('tanggal', today);
  if (kelas) qKet = qKet.eq('kelas', kelas);
  const { data: ketData } = await qKet;

  const absenMap = {};
  (absenData || []).forEach(a => { absenMap[a.id_siswa] = a; });

  const ketMap = {};
  (ketData || []).forEach(k => { ketMap[k.id_siswa] = k; });

  const hadir      = [];
  const izinSakit  = [];
  const belumHadir = [];

  (siswaSemua || []).forEach(s => {
    const absen = absenMap[s.id];
    const ket   = ketMap[s.id];

    if (absen && absen.jam_datang) {
      hadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama, kelas: s.kelas,
        jamDatang: absen.jam_datang, statusDatang: absen.status_datang,
        jamPulang: absen.jam_pulang || null
      });
    } else if (ket) {
      izinSakit.push({
        id: s.id, nisn: s.nisn, nama: s.nama, kelas: s.kelas,
        status: ket.status, keterangan: ket.keterangan || null,
        diinputOleh: ket.diinput_oleh || null
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
    totalIzinSakit: izinSakit.length,
    totalBelum: belumHadir.length,
    hadir, izinSakit, belumHadir
  };
}

// ── CEK AKTIVITAS GURU HARI INI (BARU) ────────────────────────────
// Dipanggil dari tombol "Cek Aktivitas Guru" di scan.html (persis di
// bawah tombol "Absen Kelas"). Publik/read-only seperti getLogHariIni
// di atas -- tidak butuh kioskToken karena tidak membuat/mengubah data
// apapun, cuma meringkas: guru mana yang SUDAH mengajar (+ berapa siswa
// sudah terverifikasi di sesi itu, dari kolom
// absensi_mengajar.jumlah_siswa_terverifikasi -- lihat schema.sql), dan
// guru mana yang jadwalnya hari ini tapi BELUM tercatat mengajar sama
// sekali (dibedakan lagi: belum waktunya / sedang berlangsung tapi
// belum discan / sudah lewat jamnya tapi belum discan -- supaya guru
// piket bisa langsung tahu siapa yang perlu ditindaklanjuti).
async function getAktivitasGuruHariIni() {
  const today = todayStr();
  const hari  = hariIni();
  const jamNow = jamSekarang();

  const cekLibur = await isHariLibur(today);
  const hariAktif = !cekLibur.libur && await isHariKerja(hari);

  const [
    { data: jadwalHariIni },
    { data: jamPelajaranHariIni },
    { data: absensiMengajarHariIni }
  ] = await Promise.all([
    supabase.from('jadwal_mengajar')
      .select('id,id_guru,nama_guru,jam_ke_mulai,jam_ke_selesai,kelas,mapel')
      .eq('hari', hari),
    supabase.from('jam_pelajaran')
      .select('jam_ke,jam_mulai,jam_selesai')
      .eq('hari', hari).order('jam_ke'),
    supabase.from('absensi_mengajar')
      .select('id_jadwal_mengajar,nama_guru,kelas,mapel,jam_scan,status,jumlah_siswa_terverifikasi,status_verifikasi')
      .eq('tanggal', today)
  ]);

  const jpMap = {};
  (jamPelajaranHariIni || []).forEach(j => { jpMap[j.jam_ke] = j; });
  const tercatatMap = {};
  (absensiMengajarHariIni || []).forEach(a => { tercatatMap[a.id_jadwal_mengajar] = a; });

  const sudahMengajar  = [];
  const belumMengajar  = [];

  (jadwalHariIni || []).forEach(j => {
    const jpMulai   = jpMap[j.jam_ke_mulai];
    const jpSelesai = jpMap[j.jam_ke_selesai] || jpMulai;
    const jamMulai   = jpMulai   ? jpMulai.jam_mulai     : null;
    const jamSelesai = jpSelesai ? jpSelesai.jam_selesai : null;

    const tercatat = tercatatMap[j.id];
    if (tercatat) {
      sudahMengajar.push({
        namaGuru: j.nama_guru, kelas: j.kelas, mapel: j.mapel,
        jamMulai, jamSelesai,
        jamScan: tercatat.jam_scan,
        statusAbsen: tercatat.status,                                   // 'Hadir' (status telat sudah dihapus, lihat api/mengajar.js)
        jumlahSiswaTerverifikasi: tercatat.jumlah_siswa_terverifikasi || 0,
        statusVerifikasi: tercatat.status_verifikasi || 'Perlu Ditinjau' // 'Perlu Ditinjau' | 'Terverifikasi'
      });
      return;
    }

    // Belum tercatat -- tentukan status waktunya supaya guru piket tahu
    // mana yang masih wajar (belum waktunya) vs perlu ditindaklanjuti
    // (jam pelajarannya sudah lewat tapi belum ada catatan mengajar).
    let statusWaktu = 'belum-waktunya';
    if (jamMulai && jamSelesai) {
      if (jamNow > jamSelesai) statusWaktu = 'terlewat';
      else if (jamNow >= jamMulai) statusWaktu = 'berlangsung';
    }
    belumMengajar.push({
      namaGuru: j.nama_guru, kelas: j.kelas, mapel: j.mapel,
      jamMulai, jamSelesai, statusWaktu
    });
  });

  // Urutkan: yang paling perlu perhatian (terlewat) tampil duluan.
  const urutanStatus = { terlewat: 0, berlangsung: 1, 'belum-waktunya': 2 };
  belumMengajar.sort((a, b) => (urutanStatus[a.statusWaktu] - urutanStatus[b.statusWaktu]) || (a.jamMulai || '').localeCompare(b.jamMulai || ''));
  sudahMengajar.sort((a, b) => (a.jamScan || '').localeCompare(b.jamScan || ''));

  const totalSiswaTerverifikasi = sudahMengajar.reduce((sum, g) => sum + (g.jumlahSiswaTerverifikasi || 0), 0);

  return {
    success: true,
    tanggal: today, hari, jamSekarang: jamNow,
    hariSekolah: hariAktif,
    keteranganLibur: cekLibur.libur ? (cekLibur.keterangan || 'Hari libur') : null,
    ringkasan: {
      totalSesi: (jadwalHariIni || []).length,
      totalSudahMengajar: sudahMengajar.length,
      totalBelumMengajar: belumMengajar.length,
      totalSiswaTerverifikasi
    },
    sudahMengajar,
    belumMengajar
  };
}

// ── JADWAL BESOK (BARU) ────────────────────────────────────────────
// Dipakai tab "📅 Besok" di modal "Cek Aktivitas Guru" (selagi jam
// operasional masih berjalan), dan bagian "📅 Jadwal Besok" di panel
// Rekap Harian scan.html begitu jam operasional hari ini sudah berakhir
// -- supaya guru yang membuka aplikasi malam hari tetap bisa melihat
// siapa guru piket besok dan jadwal mengajar besok, tanpa perlu
// menunggu sampai besok paginya. Read-only/publik seperti
// getAktivitasGuruHariIni() -- TIDAK ada status "sudah/belum mengajar"
// di sini karena itu baru berarti kalau harinya sudah berjalan.
//
// BARU: logika intinya sekarang di getJadwalUntukTanggal() (di bawah),
// dipakai bareng oleh getJadwalBesok() (tanggal = besok) DAN
// getJadwalHariIni() (tanggal = hari ini) -- lihat catatan lengkap di
// getJadwalUntukTanggal(). Bentuk hasil (shape) SENGAJA dibuat identik
// supaya scan.html bisa pakai satu fungsi render untuk keduanya, cuma
// beda label teksnya saja (lihat renderBesokSideRail(mode) di scan.html).
async function getJadwalUntukTanggal(tanggal, hari) {
  const cekLibur  = await isHariLibur(tanggal);
  const hariAktif = !cekLibur.libur && await isHariKerja(hari);

  // Kalau harinya bukan hari sekolah (libur kalender ATAU memang tidak
  // aktif di Pengaturan Hari Kerja), tidak perlu query jadwal sama
  // sekali -- langsung kembalikan status liburnya saja.
  if (!hariAktif) {
    return {
      success: true,
      tanggal, hari,
      hariSekolah: false,
      keteranganLibur: cekLibur.libur ? (cekLibur.keterangan || 'Hari libur') : `${hari} bukan hari sekolah`,
      guruPiket: [],
      jadwalMengajar: []
    };
  }

  const [
    { data: jadwalPiket },
    { data: jadwalMengajar },
    { data: jamPelajaran }
  ] = await Promise.all([
    supabase.from('jadwal_piket')
      .select('id_guru,nama_guru')
      .eq('hari', hari),
    supabase.from('jadwal_mengajar')
      .select('id_guru,nama_guru,jam_ke_mulai,jam_ke_selesai,kelas,mapel')
      .eq('hari', hari),
    supabase.from('jam_pelajaran')
      .select('jam_ke,jam_mulai,jam_selesai')
      .eq('hari', hari).order('jam_ke')
  ]);

  const jpMap = {};
  (jamPelajaran || []).forEach(j => { jpMap[j.jam_ke] = j; });

  const jadwalMengajarHasil = (jadwalMengajar || []).map(j => {
    const jpMulai   = jpMap[j.jam_ke_mulai];
    const jpSelesai = jpMap[j.jam_ke_selesai] || jpMulai;
    return {
      namaGuru: j.nama_guru, kelas: j.kelas, mapel: j.mapel,
      jamMulai:   jpMulai   ? jpMulai.jam_mulai     : null,
      jamSelesai: jpSelesai ? jpSelesai.jam_selesai : null
    };
  }).sort((a, b) => (a.jamMulai || '').localeCompare(b.jamMulai || ''));

  return {
    success: true,
    tanggal, hari,
    hariSekolah: true,
    keteranganLibur: null,
    guruPiket: (jadwalPiket || []).map(g => ({ namaGuru: g.nama_guru })),
    jadwalMengajar: jadwalMengajarHasil
  };
}

async function getJadwalBesok() {
  return getJadwalUntukTanggal(tanggalBesok(), hariBesok());
}

// BARU: sama persis dengan getJadwalBesok(), tapi untuk HARI INI --
// dipakai scan.html saat mode "Menunggu Mulai" (jam sekarang sudah masuk
// hari baru tapi belum sampai jamMulai, lihat masukModeMenungguMulai()
// di scan.html). Supaya panel "Info Besok" yang tadi malam menampilkan
// jadwal besok, begitu tanggal berganti otomatis berubah jadi "Info Hari
// Ini" dengan DATA YANG SAMA (karena "besok" kemarin malam = "hari ini"
// sekarang) tapi label teksnya relevan.
async function getJadwalHariIni() {
  return getJadwalUntukTanggal(todayStr(), hariIni());
}

// CATATAN: fungsi getSesiPiket() yang dulu ada di sini SUDAH DIHAPUS karena
// tidak pernah dipanggil dari scan.html/index.html (kode mati). Data sesi
// piket hari ini sudah tersedia lewat action 'getStatus' di atas
// (field guruPiket), jadi tidak ada fitur yang hilang.
