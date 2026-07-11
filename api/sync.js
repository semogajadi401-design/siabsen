const {
  supabase, generateID, setCors, todayStr,
  hariIni, isHariLibur, isHariKerja, getSemesterAktif, getJamSetting, tambahMenit,
  getJamPulangEfektif, cekIzinPiket,
  // ── TAMBAHAN BARU (perbaikan keamanan) ──
  verifyKioskToken, checkRateLimit, getClientIp
} = require('./_db');

// ── REUSE FUNGSI ABSENSI MENGAJAR (Langkah C sub-langkah 5, BARU) ────
// scanSesiMengajar & scanSiswaMapel (api/mengajar.js) DIPAKAI ULANG di
// sini, SAMA PERSIS dengan pola yang sudah ada di api/scan.js untuk kartu
// guru piket -- module.exports di mengajar.js menempelkan kedua fungsi
// ini sebagai properti tambahan pada handler-nya, jadi tidak ada logika
// duplikat yang perlu dijaga sinkron manual antara jalur online dan
// jalur sinkron offline di file ini.
const scanSesiMengajarInternal = require('./mengajar').scanSesiMengajar;
const scanSiswaMapelInternal   = require('./mengajar').scanSiswaMapel;

// ── BATAS TOLERANSI TANGGAL UNTUK SYNC OFFLINE ──────────────────────
// item sync membawa `tanggal`/`jam` dari JAM PERANGKAT (HP/laptop) tempat
// scan terjadi, BUKAN dari server — ini memang perlu supaya antrian
// offline tetap mencatat waktu scan yang sebenarnya walau baru sinkron ke
// server belakangan. Tapi tanpa batas apapun, guru piket yang mengubah
// jam/tanggal perangkatnya bisa membuat siswa telat tercatat "tepat
// waktu", atau menyisipkan absensi untuk tanggal yang sudah lewat jauh
// atau bahkan tanggal yang belum terjadi. Batas di bawah TIDAK mencegah
// manipulasi kecil (mis. maju/mundur beberapa menit di hari yang sama —
// itu memang sulit dibedakan dari keterlambatan sinkron jaringan biasa),
// tapi mencegah kasus yang jelas tidak masuk akal: tanggal di masa depan,
// atau tanggal yang sudah terlalu lama lewat dari kapan pun antrian
// offline realistis tertahan (device biasanya sync begitu dapat internet;
// beberapa hari offline berturut-turut sudah kasus tidak wajar).
const MAKS_HARI_MUNDUR_SYNC = 3;

function tanggalDalamBatasWajar(tanggal) {
  const today = todayStr();
  if (!tanggal || tanggal > today) return false; // tolak tanggal masa depan
  const batasAwal = new Date(today + 'T00:00:00');
  batasAwal.setDate(batasAwal.getDate() - MAKS_HARI_MUNDUR_SYNC);
  const batasAwalStr = batasAwal.toISOString().substring(0, 10);
  return tanggal >= batasAwalStr;
}

// ── GUARD RESET ABSENSI (BARU, dipakai fungsi mengajar/siswaMapel offline
// di bawah) ──────────────────────────────────────────────────────────
// Logika SAMA PERSIS dengan blok reset-guard di dalam processSingleScan()
// di atas, cuma ditarik keluar jadi fungsi supaya bisa dipakai ulang tanpa
// menyalin-tempel dan tanpa mengubah processSingleScan() itu sendiri
// (fungsi itu sengaja tidak disentuh sama sekali).
function itemDirekamSebelumReset(jamSetting, waktuSimpan) {
  const resetTerakhir = jamSetting['RESET_ABSENSI_TERAKHIR'];
  if (!resetTerakhir || !waktuSimpan) return false;
  const waktuSimpanMs   = new Date(waktuSimpan).getTime();
  const resetTerakhirMs = new Date(resetTerakhir).getTime();
  if (Number.isNaN(waktuSimpanMs) || Number.isNaN(resetTerakhirMs)) return false;
  return waktuSimpanMs < resetTerakhirMs;
}

// BATAS JUMLAH ITEM PER PANGGILAN batchSync (BARU — perbaikan keamanan).
// Antrian offline wajar (bahkan beberapa hari penuh scan siswa/guru di
// satu perangkat) realistisnya tidak akan mendekati angka ini -- batas
// ini murni jaring pengaman supaya satu payload raksasa dari luar tidak
// bisa memaksa server memproses ribuan baris absensi dalam satu request.
const MAKS_ITEM_PER_BATCH = 500;

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, kioskToken, ...params } = req.body || {};

  // BARU (perbaikan keamanan): batchSync bisa membuat catatan hadir sama
  // seperti scanKartu() di api/scan.js, jadi dilindungi dua lapis yang
  // sama persis -- kioskToken (bukti berasal dari halaman kiosk yang
  // sah) & rate limit per IP. Lihat catatan lengkap di _db.js.
  if (action === 'batchSync') {
    const ip = getClientIp(req);
    const limit = checkRateLimit(`sync:${ip}`, { maxRequest: 20, windowMs: 60 * 1000 });
    if (!limit.allowed) {
      return res.status(429).json({
        success: false,
        message: `Terlalu banyak percobaan sinkronisasi dari perangkat/jaringan ini. Coba lagi dalam ${limit.retryAfterSec} detik.`
      });
    }
    if (!verifyKioskToken(kioskToken)) {
      return res.status(401).json({
        success: false,
        message: 'Sesi kiosk tidak valid atau kedaluwarsa. Muat ulang halaman scan lalu coba sinkron lagi.'
      });
    }
    if (Array.isArray(params.items) && params.items.length > MAKS_ITEM_PER_BATCH) {
      return res.status(400).json({
        success: false,
        message: `Terlalu banyak item dalam satu kali sinkron (maks ${MAKS_ITEM_PER_BATCH}).`
      });
    }
  }

  try {
    if (action === 'batchSync') return res.json(await batchSync(params));
    if (action === 'heartbeat') return res.json(await heartbeat(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── HEARTBEAT PERANGKAT (BARU) ────────────────────────────────────
// Dikirim berkala oleh scan.html (lihat kirimHeartbeat() di sana) supaya
// Dashboard Admin (api/admin-monitor.js -> getStatusPerangkat) bisa
// menampilkan device mana yang aktif/online dan berapa item yang masih
// menumpuk di antrian offline lokalnya. TIDAK butuh login apapun --
// device_id-nya acak & dibuat sendiri oleh browser (localStorage), jadi
// endpoint ini cuma menyimpan status "kesehatan" device, bukan data
// absensi apapun. Dipakai upsert supaya 1 device = 1 baris yang terus
// diperbarui, bukan menumpuk baris baru tiap heartbeat.
async function heartbeat({ deviceId, label, antrianPending, userAgent }) {
  const id = deviceId ? String(deviceId).trim().slice(0, 100) : '';
  if (!id) return { success: false, message: 'deviceId wajib diisi' };
  const safeLabel = String(label || 'Perangkat Scan').slice(0, 60);
  const pendingNum = Number(antrianPending);
  const pending = Number.isFinite(pendingNum) ? Math.max(0, Math.floor(pendingNum)) : 0;
  const ua = userAgent ? String(userAgent).slice(0, 200) : null;

  const { error } = await supabase.from('perangkat_status').upsert({
    device_id: id, label: safeLabel, antrian_pending: pending, user_agent: ua,
    last_heartbeat: new Date().toISOString()
  }, { onConflict: 'device_id' });

  if (error) return { success: false, message: 'Gagal mencatat heartbeat: ' + error.message };
  return { success: true };
}

// ── BATCH SYNC: terima array antrian scan dari offline ────────────
async function batchSync({ items }) {
  if (!items || !Array.isArray(items) || items.length === 0)
    return { success: false, message: 'Tidak ada data untuk disinkronkan' };

  const results = [];

  for (const item of items) {
    try {
      // BARU (Langkah C sub-langkah 5): item bertipe 'mengajarOffline' &
      // 'siswaMapelOffline' (dari Mode Verifikasi Kelas yang dimulai/putus
      // koneksi saat offline, lihat scan.html) diproses lewat fungsi baru
      // di bawah, TIDAK lewat processSingleScan() -- fungsi itu sengaja
      // TIDAK disentuh sama sekali supaya kasus lama (guru piket, siswa
      // datang/pulang) tetap persis seperti sebelumnya.
      let r;
      if (item.tipe === 'mengajarOffline') {
        r = await processMengajarOffline(item);
      } else if (item.tipe === 'siswaMapelOffline') {
        r = await processSiswaMapelOffline(item);
      } else {
        r = await processSingleScan(item);
      }
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
async function processSingleScan({ identifier, mode, tanggal, jam, hari, namaGuru, idGuru, metode, waktuSimpan }) {
  // metodeFinal: item "scan QR" tidak mengirim field metode sama sekali
  // (default 'QR-OFFLINE' seperti sebelumnya), tapi item dari fitur "Input
  // Tanpa Kartu" offline (lihat simpanTanpaKartuOffline() di scan.html)
  // mengirim metode:'Manual (Tanpa Kartu)' supaya laporan tetap bisa
  // membedakan cara absen dicatat, sama seperti jalur online (inputTanpaKartu
  // di api/scan.js).
  const metodeFinal = metode || 'QR-OFFLINE';

  if (!identifier) return { success: false, permanent: true, message: 'Identifier kosong' };

  // Tolak sinkronisasi kalau tanggal dari perangkat tidak masuk akal
  // (di masa depan, atau sudah lebih dari beberapa hari lewat dari
  // sekarang menurut jam server) — lihat komentar tanggalDalamBatasWajar
  // di atas. Ini juga tidak akan pernah berhasil kalau diulang — jam dan
  // tanggal yang tercatat di item ini sudah terkunci sejak direkam offline.
  if (!tanggalDalamBatasWajar(tanggal)) {
    return {
      success: false,
      permanent: true,
      message: `Tanggal scan (${tanggal}) tidak valid atau di luar batas wajar sinkronisasi. Periksa jam/tanggal perangkat.`
    };
  }

  // ── AMBIL JAM SETTING SEKALI DI AWAL (dipakai lagi di bawah untuk
  // toleransi jam datang/pulang) ────────────────────────────────────
  const jamSetting = await getJamSetting();

  // ── TOLAK ITEM YANG DIREKAM SEBELUM RESET ABSENSI TERAKHIR ───────
  // Celah yang ditutup: kalau admin menjalankan "Reset Absensi (Hapus
  // Semua)" atau "Reset Total" sementara ada perangkat scan yang sedang
  // offline (atau baru online lagi setelahnya membawa antrian lama),
  // item-item lama di antrian itu tetap membawa `waktuSimpan` dari SAAT
  // ITEM DIREKAM DI PERANGKAT (device time, lihat simpanKeAntrian() di
  // scan.html) — kalau waktu itu lebih lama dari RESET_ABSENSI_TERAKHIR
  // (dicatat server saat reset terjadi, lihat resetAbsensi() di
  // api/absensi.js), berarti scan ini terjadi SEBELUM data terkait
  // sengaja dihapus admin, dan TIDAK boleh "menghidupkannya kembali".
  // Ini melengkapi (bukan menggantikan) tanggalDalamBatasWajar() di atas:
  // batas 3-hari itu menolak tanggal yang jelas tidak wajar secara umum,
  // sedangkan cek ini presisi terhadap kejadian reset yang sebenarnya,
  // termasuk kasus reset terjadi kurang dari 3 hari lalu.
  // - Kalau RESET_ABSENSI_TERAKHIR kosong (belum pernah direset sejak
  //   instalasi) atau item tidak membawa waktuSimpan (versi lama
  //   scan.html sebelum field ini ditambahkan), pengecekan ini dilewati
  //   supaya tidak menolak data yang sah tanpa alasan.
  const resetTerakhir = jamSetting['RESET_ABSENSI_TERAKHIR'];
  if (resetTerakhir && waktuSimpan) {
    const waktuSimpanMs   = new Date(waktuSimpan).getTime();
    const resetTerakhirMs = new Date(resetTerakhir).getTime();
    if (!Number.isNaN(waktuSimpanMs) && !Number.isNaN(resetTerakhirMs) && waktuSimpanMs < resetTerakhirMs) {
      return {
        success: false,
        permanent: true,
        message: 'Scan ini direkam sebelum riwayat absensi terakhir kali direset oleh admin, sehingga tidak disinkronkan.'
      };
    }
  }

  // Format QR siswa: "SW_ID|NISN" — ambil bagian sebelum "|"
  const raw = identifier.trim();
  const id  = raw.includes('|') && !raw.startsWith('ADMIN|') && !raw.startsWith('GR')
    ? raw.split('|')[0]
    : raw;

  // ── CEK GURU ────────────────────────────────────────────────────
  if (id.startsWith('GR')) {
    const { data: guru } = await supabase
      .from('guru').select('id,nama,jabatan,status,role').eq('id', id).maybeSingle();

    if (!guru) return { success: false, permanent: true, message: 'Guru tidak ditemukan', tipe: 'guru' };
    if (guru.status !== 'Aktif') return { success: false, permanent: true, message: 'Akun guru tidak aktif', tipe: 'guru' };

    // PENTING: sekarang memanggil cekIzinPiket() yang SAMA PERSIS dipakai
    // scanKartu() di api/scan.js (dipindah ke _db.js) -- bukan cuma cek
    // kepsek seperti sebelumnya. Ini menutup celah guru yang TIDAK
    // terjadwal bisa lolos jadi piket kalau perangkatnya offline (lihat
    // catatan panjang di cekIzinPiket()/_db.js). Pakai `hari`/`tanggal`/`jam`
    // yang TERCATAT SAAT SCAN TERJADI (dari perangkat offline), bukan jam
    // server sekarang, supaya keputusan boleh/tidaknya konsisten dengan
    // kondisi jadwal yang berlaku persis saat scan itu terjadi.
    const izin = await cekIzinPiket({ guruId: guru.id, guruRole: guru.role, hari, today: tanggal, jam });

    if (!izin.boleh) {
      // Kasus "perluKonfirmasi" (guru pengganti yang butuh klik "Ya/Tidak")
      // SENGAJA TIDAK diotomatis-terima di jalur sync. Konfirmasi itu
      // memang ada untuk mencegah salah scan/dua device offline yang
      // sama-sama merekam guru pengganti berbeda lolos berdua. Guru yang
      // benar-benar ingin jadi pengganti harus scan ulang saat online
      // supaya bisa menekan tombol konfirmasinya secara real-time.
      const pesan = izin.perluKonfirmasi
        ? `${izin.message} (Konfirmasi ini tidak bisa dilakukan lewat sinkronisasi offline — scan ulang kartu guru saat sudah online.)`
        : izin.message;
      return { success: false, permanent: true, tipe: 'guru', message: pesan };
    }

    const { data: sudahScan } = await supabase
      .from('sesi_piket').select('id')
      .eq('tanggal', tanggal).eq('id_guru', guru.id).maybeSingle();

    if (sudahScan) return {
      success: false, permanent: true, tipe: 'guru',
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
      // database yang mencegahnya. Perlakukan sebagai duplikat permanen,
      // BUKAN kegagalan sementara, supaya item ini otomatis dihapus dari
      // antrian offline oleh scan.html.
      if (sesiError.code === '23505') {
        return {
          success: false, permanent: true, tipe: 'guru',
          message: `${guru.nama} sudah tercatat sebagai guru piket`
        };
      }
      // Error database lain (koneksi/transien) — BUKAN permanen, item
      // harus dicoba lagi nanti, bukan dibuang dari antrian.
      return { success: false, permanent: false, tipe: 'guru', message: 'Gagal simpan sesi piket: ' + sesiError.message };
    }

    // ── BACKFILL nama_guru_piket KOSONG (samakan dengan scanKartu()) ──
    // Baris absensi yang sempat kosong id_guru_piket/nama_guru_piket-nya
    // (misal siswa keburu absen sebelum guru piket sempat tercatat, lihat
    // pengecekan sesiList di bawah untuk siswa) diisi begitu guru piket
    // ini berhasil sync. Sebelumnya langkah ini HANYA ada di jalur online
    // (scan.js), tidak direplikasi di sini.
    await supabase
      .from('absensi')
      .update({ nama_guru_piket: guru.nama, id_guru_piket: guru.id })
      .eq('tanggal', tanggal)
      .or('nama_guru_piket.is.null,nama_guru_piket.eq.');

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
    return { success: false, permanent: true, tipe: 'siswa', message: `Hari ini libur: ${cekLibur.keterangan}` };

  const hariAktif = await isHariKerja(hari);
  if (!hariAktif)
    return { success: false, permanent: true, tipe: 'siswa', message: `${hari} bukan hari sekolah` };

  const semester = await getSemesterAktif();
  if (!semester)
    return { success: false, permanent: true, tipe: 'siswa', message: 'Tidak ada semester aktif' };

  const tglMulai   = String(semester.tanggal_mulai).substring(0, 10);
  const tglSelesai = String(semester.tanggal_selesai).substring(0, 10);
  if (tanggal < tglMulai || tanggal > tglSelesai)
    return { success: false, permanent: true, tipe: 'siswa', message: `Di luar periode semester (${semester.nama})` };

  // ── CEK SISWA ───────────────────────────────────────────────────
  const { data: siswaById } = await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('id', id).maybeSingle();
  const { data: siswaByNisn } = siswaById ? { data: null } : await supabase
    .from('siswa').select('id,nisn,nama,kelas,jenis_kelamin,status')
    .eq('nisn', id).maybeSingle();

  const siswa = siswaById || siswaByNisn;
  if (!siswa) return { success: false, permanent: true, tipe: 'siswa', message: 'Siswa tidak ditemukan' };
  if (siswa.status !== 'Aktif') return { success: false, permanent: true, tipe: 'siswa', message: 'Siswa tidak aktif' };

  // Ambil guru piket dari sesi hari itu
  const { data: sesiList } = await supabase
    .from('sesi_piket').select('*').eq('tanggal', tanggal).order('jam_scan');

  // ── WAJIB ADA GURU PIKET (celah baru yang ditutup) ───────────────
  // Sebelumnya kalau sesiList kosong (misal item guru piket-nya sendiri
  // gagal sync, mis. kena aturan cekIzinPiket di atas), kode tetap lanjut
  // INSERT absensi dengan id_guru_piket/nama_guru_piket KOSONG -- padahal
  // scanKartu() (jalur online) menolak KERAS kalau sesi_piket kosong untuk
  // hari itu ("Guru piket belum scan kartu."). Sekarang disamakan: DITOLAK
  // di sini juga. `namaGuru`/`idGuru` dari item offline biasanya kosong
  // (scan.html tidak pernah mengirimnya untuk item siswa -- lihat
  // processQRWithOffline()), jadi guruAktif dari sesiList adalah
  // satu-satunya sumber. permanent:false SENGAJA (bukan ditolak selamanya)
  // karena guru piket lain mungkin baru berhasil sync belakangan (dari
  // device lain) -- begitu itu terjadi, item siswa ini harus otomatis
  // ikut lolos di percobaan retry berikutnya, bukan dibuang permanen.
  if ((!sesiList || sesiList.length === 0) && !namaGuru && !idGuru) {
    return {
      success: false, permanent: false, tipe: 'siswa',
      message: 'Guru piket belum tercatat untuk tanggal ini. Akan dicoba lagi otomatis setelah ada guru piket yang berhasil sinkron.'
    };
  }

  const guruAktif  = sesiList && sesiList.length > 0 ? sesiList[sesiList.length - 1] : null;
  const namaGP     = namaGuru || guruAktif?.nama_guru || null;
  const idGP       = idGuru   || guruAktif?.id_guru   || null;

  // Cek absensi hari itu
  const { data: absenHariIni } = await supabase
    .from('absensi').select('*')
    .eq('id_siswa', siswa.id).eq('tanggal', tanggal).maybeSingle();

  // ── PAKAI JAM SETTING DARI DATABASE (bukan hardcode) ─────────────
  // Sebelumnya nilai '08:00' dan '14:00' ditulis langsung di kode, jadi
  // tidak ikut berubah kalau admin mengubah pengaturan jam di menu
  // Pengaturan > Jam Operasional. Sekarang disamakan dengan scan.js.
  // (jamSetting sudah diambil sekali di awal fungsi, dipakai ulang di sini)
  const toleransi      = Number(jamSetting['TOLERANSI_MENIT'] || 0);
  const jamBatasDatang = tambahMenit(jamSetting['JAM_DATANG_SELESAI'] || '08:00', toleransi);
  // Jam pulang efektif untuk HARI SCAN ITU TERJADI (variabel `hari` di
  // atas, dari tanggal offline-nya) — override per-hari kalau admin
  // sudah atur di Pengaturan Semester, kalau tidak ikut global.
  const jamPulangMulai = (await getJamPulangEfektif(hari, jamSetting)).jamPulangMulai;

  // ── MODE PULANG — HANYA JIKA EKSPLISIT DIPILIH SAAT SCAN ─────────
  // Sebelumnya ada `|| jam >= jamPulangMulai` yang otomatis mengganti
  // scan "datang" jadi "pulang" hanya berdasarkan jam. Itu sudah sengaja
  // dihapus di scan.js (lihat komentar di sana) karena bisa mengabaikan
  // pilihan mode yang sebenarnya dipilih guru piket saat scan — misalnya
  // siswa yang datang terlambat setelah jam 14:00 tapi modenya masih
  // "Datang" malah diproses sebagai absen pulang. Baris ini disamakan.
  if (mode === 'pulang') {
    // SAMA seperti scan.js: tolak kalau jam pulang (offline, waktu HP/laptop
    // saat scan) belum masuk JAM_PULANG_MULAI. Sebelumnya variabel
    // jamPulangMulai di atas dihitung tapi tidak pernah dipakai di sini,
    // jadi scan offline bisa lolos absen pulang sebelum jam resmi padahal
    // scan online untuk kasus yang sama akan ditolak scan.js.
    if (jam < jamPulangMulai)
      // Deterministik dari jam yang sudah tercatat saat scan (tidak
      // berubah lagi kalau diulang) -> permanen.
      return { success: false, permanent: true, tipe: 'siswa', message: `Absensi pulang baru bisa dilakukan mulai ${jamPulangMulai}` };
    if (!absenHariIni)
      // TIDAK permanen: kemungkinan item "datang" siswa ini masih tertahan
      // di antrian device lain / belum ke-sync, jadi begitu itu berhasil,
      // item "pulang" ini harus otomatis ikut lolos di percobaan berikutnya.
      return { success: false, permanent: false, tipe: 'siswa', message: `${siswa.nama} belum absen datang` };
    if (absenHariIni.jam_pulang) {
      // Kalau baris pulang yang SUDAH ADA itu justru berasal dari scan yang
      // lebih SIANG daripada scan offline yang baru sync ini (misal: siswa
      // scan pulang offline jam 14:05 di laptop belum sempat sync, lalu ada
      // yang keliru/coba scan pulang lagi di HP jam 14:30 dan itu duluan
      // masuk ke server) — koreksi ke jam yang lebih awal karena itu yang
      // benar-benar terjadi lebih dulu.
      if (jam < absenHariIni.jam_pulang) {
        // PERBAIKAN RACE CONDITION: `.eq('jam_pulang', absenHariIni.jam_pulang)`
        // ditambahkan sebagai guard optimistic-concurrency -- UPDATE ini
        // hanya benar-benar mengenai baris kalau nilai jam_pulang di database
        // MASIH SAMA PERSIS dengan yang kita baca barusan (absenHariIni).
        // Tanpa ini, kalau ADA proses sync lain yang sudah lebih dulu
        // mengoreksi/mengubah baris yang sama di antara SELECT dan UPDATE,
        // kita bisa menimpanya secara buta dengan nilai yang sudah basi.
        // Kasus ini sangat jarang (perlu 2 proses sync offline untuk siswa
        // yang sama, keduanya di rentang waktu sepersekian detik), tapi
        // kalau memang kalah race di sini, item ini ditandai TIDAK permanen
        // -- percobaan sync berikutnya (otomatis dari device) akan membaca
        // ulang nilai terbaru dan mengevaluasi lagi dari situ.
        const { data: koreksiUpdated, error: fixError } = await supabase
          .from('absensi')
          .update({
            jam_pulang: jam, status_pulang: 'Pulang',
            nama_guru_piket: namaGP, id_guru_piket: idGP
          })
          .eq('id', absenHariIni.id)
          .eq('jam_pulang', absenHariIni.jam_pulang)
          .select('jam_pulang');
        if (fixError) return { success: false, permanent: false, tipe: 'siswa', message: 'Gagal mengoreksi jam pulang: ' + fixError.message };
        if (!koreksiUpdated || koreksiUpdated.length === 0) {
          return { success: false, permanent: false, tipe: 'siswa', message: `${siswa.nama} - jam pulang berubah di perangkat lain, dicoba lagi di sinkron berikutnya` };
        }
        return {
          success: true, tipe: 'siswa', status: 'Pulang',
          message: `${siswa.nama} - jam pulang dikoreksi ke ${jam} (scan offline lebih awal)`,
          siswa: { nama: siswa.nama, kelas: siswa.kelas }
        };
      }
      return { success: false, permanent: true, tipe: 'siswa', message: `${siswa.nama} sudah absen pulang pukul ${absenHariIni.jam_pulang}` };
    }

    // PERBAIKAN RACE CONDITION: sama seperti di api/scan.js (jalur online) --
    // `.is('jam_pulang', null)` memastikan UPDATE ini hanya mengenai baris
    // kalau jam_pulang MASIH kosong PERSIS SAAT dieksekusi database, bukan
    // cuma saat absenHariIni dibaca di atas. Kalau perangkat/proses sync
    // lain sudah menang duluan, `.select()` mengembalikan array kosong dan
    // item ini ditandai TIDAK permanen supaya sync berikutnya mengevaluasi
    // ulang (bisa saja lalu masuk ke jalur "koreksi jam lebih awal" di atas
    // kalau jam offline ini ternyata lebih awal dari yang barusan menang).
    const { data: pulangUpdated, error: updError } = await supabase
      .from('absensi')
      .update({
        jam_pulang: jam, status_pulang: 'Pulang',
        nama_guru_piket: namaGP, id_guru_piket: idGP
      })
      .eq('id', absenHariIni.id)
      .is('jam_pulang', null)
      .select('jam_pulang');
    if (updError) return { success: false, permanent: false, tipe: 'siswa', message: 'Gagal simpan: ' + updError.message };
    if (!pulangUpdated || pulangUpdated.length === 0) {
      return { success: false, permanent: false, tipe: 'siswa', message: `${siswa.nama} - jam pulang sudah tercatat di perangkat lain, dicoba lagi di sinkron berikutnya` };
    }

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
        id_guru_piket: idGP, nama_guru_piket: namaGP, metode: metodeFinal
      }).eq('id', absenHariIni.id);
      if (fixError) return { success: false, permanent: false, tipe: 'siswa', message: 'Gagal mengoreksi jam absen: ' + fixError.message };
      return {
        success: true, tipe: 'siswa', status: statusKoreksi,
        message: `${siswa.nama} - jam absen dikoreksi ke ${jam} (scan offline lebih awal)`,
        siswa: { nama: siswa.nama, kelas: siswa.kelas }
      };
    }
    return { success: false, permanent: true, tipe: 'siswa', message: `${siswa.nama} sudah absen datang pukul ${absenHariIni.jam_datang}` };
  }

  const statusDatang = jam > jamBatasDatang ? 'Terlambat' : 'Hadir';
  const absenId      = generateID('AB');

  const { error: absenError } = await supabase.from('absensi').insert({
    id: absenId, id_siswa: siswa.id, nisn: siswa.nisn,
    nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal, hari, jam_datang: jam,
    status_datang: statusDatang,
    id_guru_piket: idGP, nama_guru_piket: namaGP,
    metode: metodeFinal
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
          id_guru_piket: idGP, nama_guru_piket: namaGP, metode: metodeFinal
        }).eq('id', existingRow.id);
        if (!fixError) {
          return {
            success: true, tipe: 'siswa', status: statusKoreksi,
            message: `${siswa.nama} - jam absen dikoreksi ke ${jam} (scan offline lebih awal)`,
            siswa: { nama: siswa.nama, kelas: siswa.kelas }
          };
        }
      }
      return { success: false, permanent: true, tipe: 'siswa', message: `${siswa.nama} sudah absen datang hari ini` };
    }
    return { success: false, permanent: false, tipe: 'siswa', message: 'Gagal simpan: ' + absenError.message };
  }

  return {
    success: true, tipe: 'siswa', status: statusDatang,
    message: `${siswa.nama} absen datang - ${jam} (${statusDatang})`,
    siswa: { nama: siswa.nama, kelas: siswa.kelas }
  };
}

// ════════════════════════════════════════════════════════════════
// SINKRON OFFLINE — ABSEN SESI MENGAJAR (Langkah C sub-langkah 5, BARU)
// ════════════════════════════════════════════════════════════════
// Item ini dibuat scan.html saat guru menekan "Absen Mengajar" di modal
// pilihan SAAT PERANGKAT SEDANG OFFLINE (lihat kirimUlangOfflinePilihan()
// di scan.html) -- belum ada idAbsensiMengajar asli, cuma identifier kartu
// + waktu device saat scan terjadi.
//
// PENTING soal konsistensi online/offline: guru.id di sini diverifikasi
// lewat pencocokan identifier ke tabel guru (SAMA seperti blok guru piket
// offline di processSingleScan() di atas, dan SAMA seperti kiosk online di
// api/scan.js) -- BUKAN dari klaim klien. scanSesiMengajarInternal
// (api/mengajar.js) dipakai ulang APA ADANYA, jadi validasi jam
// pelajaran/jadwal/toleransi telat sudah otomatis SAMA PERSIS dengan jalur
// online tanpa perlu ditulis ulang di sini.
async function processMengajarOffline({ identifier, tanggal, jam, hari, waktuSimpan }) {
  if (!identifier || !identifier.startsWith('GR'))
    return { success: false, permanent: true, tipe: 'mengajarOffline', message: 'Identifier guru tidak valid' };

  if (!tanggalDalamBatasWajar(tanggal)) {
    return {
      success: false, permanent: true, tipe: 'mengajarOffline',
      message: `Tanggal scan (${tanggal}) tidak valid atau di luar batas wajar sinkronisasi. Periksa jam/tanggal perangkat.`
    };
  }

  const jamSetting = await getJamSetting();
  if (itemDirekamSebelumReset(jamSetting, waktuSimpan)) {
    return {
      success: false, permanent: true, tipe: 'mengajarOffline',
      message: 'Scan ini direkam sebelum riwayat absensi terakhir kali direset oleh admin, sehingga tidak disinkronkan.'
    };
  }

  const { data: guru } = await supabase
    .from('guru').select('id,nama,jabatan,status,role').eq('id', identifier).maybeSingle();
  if (!guru) return { success: false, permanent: true, tipe: 'mengajarOffline', message: 'Guru tidak ditemukan' };
  if (guru.status !== 'Aktif') return { success: false, permanent: true, tipe: 'mengajarOffline', message: 'Akun guru tidak aktif' };

  const hasil = await scanSesiMengajarInternal({ guruIdTerverifikasi: guru.id, tanggal, jam, hari });

  if (!hasil.success) {
    // scanSesiMengajar didesain untuk jalur online/realtime, jadi tidak
    // membedakan permanent/tidak sendiri. Pesan-pesan di bawah ini
    // deterministik dari tanggal/jam yang SUDAH TERKUNCI sejak direkam
    // offline (tidak akan pernah berubah hasil kalau diulang) -> permanent.
    // Selain itu (mis. gagal simpan karena masalah transien database)
    // dibiarkan permanent:false supaya dicoba lagi otomatis.
    const pesanPermanen = [
      'Hari ini libur', 'bukan hari sekolah', 'Bukan jam pelajaran sekarang',
      'Tidak ada jadwal mengajar Anda pada jam ini', 'sudah tercatat hari ini'
    ];
    const permanent = pesanPermanen.some(p => (hasil.message || '').includes(p));
    return { success: false, permanent, tipe: 'mengajarOffline', message: hasil.message };
  }

  return {
    success: true, permanent: true, tipe: 'mengajarOffline',
    idAbsensiMengajar: hasil.idAbsensiMengajar,
    // BARU: diteruskan supaya client bisa mengisi sesiTokenMap (lihat
    // scan.html, sepasang dengan sesiIdMap) untuk item siswaMapelOffline
    // yang sesi induknya baru sinkron di batch yang sama.
    sesiToken: hasil.sesiToken,
    status: hasil.status,
    jadwal: hasil.jadwal,
    message: hasil.message,
    guru: { id: guru.id, nama: guru.nama }
  };
}

// ════════════════════════════════════════════════════════════════
// SINKRON OFFLINE — VERIFIKASI SISWA PER MAPEL (Langkah C sub-langkah 5, BARU)
// ════════════════════════════════════════════════════════════════
// idAbsensiMengajar di sini BISA berupa id asli (kalau sesi mengajarnya
// sudah lebih dulu online, tapi koneksi putus di tengah scan siswa -- lihat
// simpanScanSiswaVerifikasiOffline() di scan.html), ATAU sudah diresolusi
// oleh CLIENT dari localSesiId (lihat sesiIdMap di jalankanSync(),
// scan.html) kalau sesi mengajarnya juga baru sync di batch yang sama.
// Kalau belum ter-resolusi sama sekali (sesi induknya belum berhasil
// sync), gagal permanent:false supaya dicoba lagi otomatis nanti (retry
// berkala 30 detik / transisi online berikutnya), TIDAK dibuang dari
// antrian.
async function processSiswaMapelOffline({ idAbsensiMengajar, idSiswa, sesiToken }) {
  if (!idAbsensiMengajar) {
    return {
      success: false, permanent: false, tipe: 'siswaMapelOffline',
      message: 'Sesi mengajar induk belum tersinkron. Akan dicoba lagi otomatis.'
    };
  }
  if (!idSiswa) {
    return { success: false, permanent: true, tipe: 'siswaMapelOffline', message: 'ID siswa kosong' };
  }
  // BARU: sesiToken wajib, sama seperti jalur online -- lihat scanSiswaMapel
  // di api/mengajar.js untuk alasannya. Kalau belum ada (mis. resolusi dari
  // sesiIdMap tapi sesiTokenMap belum terisi), tolak permanent:false supaya
  // dicoba lagi (biasanya langsung terisi begitu item mengajarOffline induk
  // selesai sync, karena diproses lebih dulu dalam batch yang sama).
  if (!sesiToken) {
    return {
      success: false, permanent: false, tipe: 'siswaMapelOffline',
      message: 'Token sesi induk belum tersedia. Akan dicoba lagi otomatis.'
    };
  }

  const hasil = await scanSiswaMapelInternal({ idAbsensiMengajar, idSiswa, sesiToken });
  if (!hasil.success) {
    // "Sesi mengajar tidak ditemukan" / "Siswa tidak ditemukan" / "sudah
    // discan untuk sesi ini" -- semua deterministik dari data yang sudah
    // terkunci sejak direkam offline, tidak akan berubah kalau diulang.
    return { success: false, permanent: true, tipe: 'siswaMapelOffline', message: hasil.message };
  }
  return {
    success: true, permanent: true, tipe: 'siswaMapelOffline',
    jumlahSiswaTerverifikasi: hasil.jumlahSiswaTerverifikasi,
    statusVerifikasi: hasil.statusVerifikasi,
    nama: hasil.nama,
    message: `${hasil.nama} terverifikasi hadir (sinkron offline)`
  };
}
