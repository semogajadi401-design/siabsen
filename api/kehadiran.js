// api/kehadiran.js — Kehadiran hari ini, input sakit/izin
const {
  supabase, generateID, setCors, todayStr, hariIni,
  isHariLibur, isHariKerja, requireAdminToken, isGuruPiketHariIni,
  resolveGuruIdFromToken, hitungJumlahHariSekolah
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
const AKSI_TERKUNCI = new Set(['inputKeterangan', 'hapusKeterangan']);

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
    if (action === 'rekapKeteranganRange') return res.json(await rekapKeteranganRange(params));
    // (BARU) Dipakai halaman Evaluasi Kehadiran (semester) untuk menghitung
    // % kehadiran & jumlah Alpha yang BENAR -- lihat catatan di
    // hitungJumlahHariSekolah() (_db.js) dan loadEvaluasi() (index.html).
    // Tidak membocorkan data siswa individual, jadi tidak perlu login.
    if (action === 'getJumlahHariSekolah') {
      const { tanggalMulai, tanggalSelesai } = params;
      if (!tanggalMulai || !tanggalSelesai)
        return res.json({ success: false, message: 'tanggalMulai dan tanggalSelesai wajib diisi' });
      // PERBAIKAN BUG: tanggalSelesai yang dikirim frontend adalah akhir
      // SEMESTER (mis. Desember), bukan hari ini -- kalau dipakai apa
      // adanya, hari-hari di masa depan yang belum terjadi (dan jelas
      // belum ada datanya) ikut dihitung sebagai "hari sekolah", membuat
      // Alpha meledak dan % Kehadiran anjlok padahal semester baru
      // berjalan beberapa hari. Batasi hitungan hanya sampai KEMARIN --
      // bukan sampai hari ini juga, karena hari berjalan belum tentu
      // selesai jam absennya saat laporan ini dibuka (mis. dicek jam
      // 05:41 pagi, sebelum jam masuk 06:30 -- semua siswa masih akan
      // tampak "Alpha" untuk hari yang belum benar-benar berjalan).
      const kemarin = new Date(Date.now() + 8 * 60 * 60 * 1000); // WITA, sama seperti witaNow() di _db.js
      kemarin.setUTCDate(kemarin.getUTCDate() - 1);
      const kemarinStr = kemarin.toISOString().split('T')[0];
      const efektifSelesai = tanggalSelesai > kemarinStr ? kemarinStr : tanggalSelesai;

      if (tanggalMulai > efektifSelesai) {
        // Semester belum mulai / baru mulai hari ini -- belum ada satu
        // pun hari yang "selesai" untuk dievaluasi.
        return res.json({ success: true, jumlahHariSekolah: 0 });
      }
      const jumlahHariSekolah = await hitungJumlahHariSekolah(tanggalMulai, efektifSelesai);
      return res.json({ success: true, jumlahHariSekolah });
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
      hadir.push({
        id: s.id, nisn: s.nisn, nama: s.nama,
        kelas: s.kelas, jenisKelamin: s.jenis_kelamin,
        jamDatang:    absen.jam_datang,
        statusDatang: absen.status_datang,
        jamPulang:    absen.jam_pulang    || null,
        statusPulang: absen.status_pulang || null,
        idAbsen: absen.id
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

  return {
    success: true,
    tanggal: tgl,
    statistik: {
      totalSiswa, totalHadir, totalTerlambat,
      totalSakit, totalIzin, totalAlpha,
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
