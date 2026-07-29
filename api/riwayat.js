// api/riwayat.js — Riwayat Kehadiran Siswa (PUBLIK, diakses via QR belakang kartu)
//
// PENTING: endpoint ini SENGAJA tidak butuh login, karena diakses langsung
// lewat kamera HP siapapun yang scan QR belakang kartu siswa. Karena itu:
//  - Siswa dicari berdasarkan riwayat_token acak (bukan NISN/ID biasa),
//    supaya orang tidak bisa menebak-nebak ID siswa lain.
//  - Data yang dikembalikan HANYA seputar riwayat absensi (tanggal, jam,
//    status). Tidak pernah mengembalikan alamat, no HP ortu, dll.
const { supabase, setCors } = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getInfo')    return res.json(await getInfo(params));
    if (action === 'getRiwayat') return res.json(await getRiwayat(params));
    if (action === 'getRiwayatMapel') return res.json(await getRiwayatMapel(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

async function findSiswaByToken(token) {
  if (!token || !String(token).trim()) return null;
  // PERBAIKAN: dulu pakai .maybeSingle(), yang mengembalikan ERROR (bukan
  // data) kalau ternyata ada LEBIH DARI SATU baris siswa dengan
  // riwayat_token yang sama (misal karena race saat backfill token, atau
  // constraint UNIQUE di kolom ini ternyata belum benar-benar terpasang
  // di database). Kode sebelumnya hanya membaca `data` dan mengabaikan
  // `error`, jadi token yang sebenarnya valid & cocok bisa dianggap
  // "tidak valid" padahal siswanya ada. Pola .limit(1) + ambil elemen
  // pertama array ini sama seperti requireAdminToken() dan
  // resolveGuruIdFromToken() di api/_db.js, dan tidak punya masalah ini.
  const { data } = await supabase
    .from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin,status,riwayat_token')
    .eq('riwayat_token', String(token).trim())
    .limit(1);
  return (data && data[0]) || null;
}

// ── INFO SISWA + DAFTAR SEMESTER YANG BISA DIPILIH ───────────────
async function getInfo({ token }) {
  const siswa = await findSiswaByToken(token);
  if (!siswa) return { success: false, message: 'Kode QR tidak valid atau sudah tidak berlaku' };
  if (siswa.status !== 'Aktif') return { success: false, message: 'Data siswa ini sudah tidak aktif' };

  const { data: semesters } = await supabase
    .from('semester').select('*').order('tanggal_mulai', { ascending: false });

  const today = new Date().toISOString().substring(0, 10);
  // Semester yang "punya riwayat" = semester yang sudah mulai berjalan
  // (sudah lewat tanggal mulainya), jadi pasti ada setidaknya hari
  // sekolah yang bisa ditampilkan riwayatnya.
  const semesterList = (semesters || [])
    .filter(sm => String(sm.tanggal_mulai).substring(0, 10) <= today)
    .map(sm => ({
      id: sm.id, nama: sm.nama, tahunAjaran: sm.tahun_ajaran,
      tanggalMulai: String(sm.tanggal_mulai).substring(0, 10),
      tanggalSelesai: String(sm.tanggal_selesai).substring(0, 10),
      aktif: sm.aktif
    }));

  return {
    success: true,
    siswa: { nama: siswa.nama, nisn: siswa.nisn, kelas: siswa.kelas, jenisKelamin: siswa.jenis_kelamin },
    semesters: semesterList
  };
}

// ── RIWAYAT KEHADIRAN (dengan filter semester / bulan / status) ──
async function getRiwayat({ token, semesterId, bulan, status }) {
  const siswa = await findSiswaByToken(token);
  if (!siswa) return { success: false, message: 'Kode QR tidak valid atau sudah tidak berlaku' };
  if (siswa.status !== 'Aktif') return { success: false, message: 'Data siswa ini sudah tidak aktif' };
  if (!semesterId) return { success: false, message: 'Semester wajib dipilih' };

  const { data: sm } = await supabase.from('semester').select('*').eq('id', semesterId).maybeSingle();
  if (!sm) return { success: false, message: 'Semester tidak ditemukan' };

  let start = String(sm.tanggal_mulai).substring(0, 10);
  let end   = String(sm.tanggal_selesai).substring(0, 10);

  // Persempit rentang tanggal kalau ada filter bulan (format "YYYY-MM")
  if (bulan) {
    const [y, m] = bulan.split('-');
    const bulanStart = `${y}-${m}-01`;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    const bulanEnd = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    if (bulanStart > start) start = bulanStart;
    if (bulanEnd < end) end = bulanEnd;
  }

  // Jangan tampilkan status Alpha untuk hari yang belum terjadi
  const todayStr = new Date().toISOString().substring(0, 10);
  if (end > todayStr) end = todayStr;

  if (start > end) {
    return {
      success: true,
      siswa: { nama: siswa.nama, nisn: siswa.nisn, kelas: siswa.kelas },
      semester: { id: sm.id, nama: sm.nama, tahunAjaran: sm.tahun_ajaran },
      rentang: { start, end: start },
      statistik: { totalHadir: 0, totalTerlambat: 0, totalSakit: 0, totalIzin: 0, totalAlpha: 0, totalHariSekolah: 0, persentaseKehadiran: 0 },
      riwayat: []
    };
  }

  const [
    { data: absenData },
    { data: ketData },
    { data: liburRows },
    { data: hariKerjaSetting }
  ] = await Promise.all([
    supabase.from('absensi').select('*').eq('id_siswa', siswa.id).gte('tanggal', start).lte('tanggal', end),
    supabase.from('keterangan_absensi').select('*').eq('id_siswa', siswa.id).gte('tanggal', start).lte('tanggal', end),
    supabase.from('hari_kerja').select('tanggal').gte('tanggal', start).lte('tanggal', end),
    supabase.from('pengaturan_hari_kerja').select('*')
  ]);

  const liburSet = new Set((liburRows || []).map(r => String(r.tanggal).substring(0, 10)));
  const hariAktifMap = {};
  (hariKerjaSetting || []).forEach(h => { hariAktifMap[h.hari] = h.aktif; });
  // Kalau hari belum pernah diatur admin (baris tidak ada di tabel),
  // dianggap TIDAK aktif — konsisten dengan isHariKerja() di _db.js dan
  // getPengaturanHari() di settings.js. Jangan asumsikan Senin-Jumat
  // otomatis sekolah sebelum admin benar-benar mengatur hari aktif.
  const namaHariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  const rowsMap = {};
  (absenData || []).forEach(a => {
    rowsMap[a.tanggal] = {
      tanggal: a.tanggal, hari: a.hari,
      jamDatang: a.jam_datang, statusDatang: a.status_datang,
      jamPulang: a.jam_pulang, statusPulang: a.status_pulang,
      keterangan: a.keterangan || null,
      // (BARU) Alasan pulang cepat (Sakit/Izin mendadak setelah sempat
      // hadir) -- lihat tandaiPulangCepat di api/kehadiran.js. Dikirim
      // terpisah dari `keterangan` (yang dipakai untuk alasan terlambat)
      // supaya riwayat menampilkan informasi yang tidak membingungkan:
      // frontend bisa cek statusPulang di luar 'Pulang' untuk tahu ini
      // bukan pulang biasa, lalu tampilkan keteranganPulangCepat ini.
      keteranganPulangCepat: a.keterangan_pulang_cepat || null
    };
  });
  (ketData || []).forEach(k => {
    if (!rowsMap[k.tanggal]) {
      rowsMap[k.tanggal] = {
        tanggal: k.tanggal, hari: null,
        jamDatang: null, statusDatang: k.status,
        jamPulang: null, statusPulang: null,
        keterangan: k.keterangan || null
      };
    }
  });

  // Isi hari sekolah yang lewat tanpa catatan apapun sebagai Alpha
  const cur = new Date(start + 'T00:00:00');
  const endDate = new Date(end + 'T00:00:00');
  while (cur <= endDate) {
    const tgl = cur.toISOString().substring(0, 10);
    if (!rowsMap[tgl] && !liburSet.has(tgl)) {
      const namaHari = namaHariArr[cur.getDay()];
      const aktif = hariAktifMap.hasOwnProperty(namaHari) ? hariAktifMap[namaHari] : false;
      if (aktif) {
        rowsMap[tgl] = {
          tanggal: tgl, hari: namaHari, jamDatang: null,
          statusDatang: 'Alpha', jamPulang: null, statusPulang: null, keterangan: null
        };
      }
    }
    cur.setDate(cur.getDate() + 1);
  }

  const allRows = Object.values(rowsMap).sort((a, b) => b.tanggal.localeCompare(a.tanggal));

  // (BARU) Tandai baris yang "lupa absen pulang": sudah absen datang
  // (Hadir/Terlambat) tapi jamPulang kosong, DAN bukan hari ini (hari
  // yang belum selesai belum adil disebut "lupa" -- siswa mungkin memang
  // belum waktunya pulang). Ditandai per baris (bukan cuma dihitung
  // total) supaya halaman riwayat bisa kasih highlight visual pas
  // guru/ortu/siswa lihat hari mana saja yang kejadian.
  const todayNow = new Date().toISOString().substring(0, 10);
  allRows.forEach(r => {
    r.lupaAbsenPulang = (r.statusDatang === 'Hadir' || r.statusDatang === 'Terlambat')
      && !r.jamPulang && r.tanggal !== todayNow;
  });

  const totalIzinList = ['Izin', 'Urusan Keluarga', 'Izin Lainnya'];
  const statistik = {
    totalHadir:      allRows.filter(r => r.statusDatang === 'Hadir').length,
    totalTerlambat:  allRows.filter(r => r.statusDatang === 'Terlambat').length,
    totalSakit:      allRows.filter(r => r.statusDatang === 'Sakit').length,
    totalIzin:       allRows.filter(r => totalIzinList.includes(r.statusDatang)).length,
    totalAlpha:      allRows.filter(r => r.statusDatang === 'Alpha').length,
    // (BARU) Lihat catatan r.lupaAbsenPulang di atas.
    totalLupaAbsenPulang: allRows.filter(r => r.lupaAbsenPulang).length,
    totalHariSekolah: allRows.length
  };
  statistik.persentaseKehadiran = statistik.totalHariSekolah > 0
    ? Math.round(((statistik.totalHadir + statistik.totalTerlambat) / statistik.totalHariSekolah) * 1000) / 10
    : 0;

  let riwayat = allRows;
  if (status && status !== 'Semua') {
    riwayat = status === 'Izin'
      ? riwayat.filter(r => totalIzinList.includes(r.statusDatang))
      : riwayat.filter(r => r.statusDatang === status);
  }

  return {
    success: true,
    siswa: { nama: siswa.nama, nisn: siswa.nisn, kelas: siswa.kelas },
    semester: { id: sm.id, nama: sm.nama, tahunAjaran: sm.tahun_ajaran },
    rentang: { start, end },
    statistik,
    riwayat
  };
}

// ── RIWAYAT KEHADIRAN PER MAPEL (Langkah D — BARU) ────────────────────
// Beda mendasar dari getRiwayat() di atas: itu absen datang/pulang HARIAN
// (1 baris pasti ada tiap hari sekolah, termasuk Alpha kalau tidak ada
// catatan). Ini soal VERIFIKASI KEHADIRAN PER JAM PELAJARAN (lihat
// handoff fitur "Absensi Mengajar Guru") -- guru scan kartu SEBAGIAN
// siswa (minimal MIN_VERIFIKASI_SISWA, atau semua yang hadir hari itu
// kalau kelasnya kecil) sebagai SAMPEL, bukan mendata satu-satu semua
// siswa tiap sesi. Karena itu:
//   - "sesi" di sini = baris absensi_mengajar yang kelas-nya sama dengan
//     kelas siswa ini (artinya guru memang mengajar & absen di kelas itu
//     pada jam itu).
//   - Siswa dianggap "Terverifikasi" HANYA kalau ada baris
//     kehadiran_siswa_mapel dengan id_siswa dia untuk sesi itu.
//   - SENGAJA TIDAK menyebut siswa yang tidak ada baris verifikasinya
//     sebagai "Alpa"/"Tidak Hadir" -- karena tidak discan bisa jadi cuma
//     karena guru belum sempat scan kartunya (verifikasi berbasis
//     sampel), BUKAN bukti dia bolos. Label yang dipakai "Belum
//     Terverifikasi", dan frontend WAJIB menampilkan catatan penjelas ini
//     supaya tidak disalahartikan orang tua/siswa sebagai bukti bolos.
async function getRiwayatMapel({ token, semesterId, bulan, mapel }) {
  const siswa = await findSiswaByToken(token);
  if (!siswa) return { success: false, message: 'Kode QR tidak valid atau sudah tidak berlaku' };
  if (siswa.status !== 'Aktif') return { success: false, message: 'Data siswa ini sudah tidak aktif' };
  if (!semesterId) return { success: false, message: 'Semester wajib dipilih' };

  const { data: sm } = await supabase.from('semester').select('*').eq('id', semesterId).maybeSingle();
  if (!sm) return { success: false, message: 'Semester tidak ditemukan' };

  let start = String(sm.tanggal_mulai).substring(0, 10);
  let end   = String(sm.tanggal_selesai).substring(0, 10);

  // Rentang tanggal (semester ± filter bulan) dihitung ulang di sini
  // sengaja TERPISAH dari getRiwayat() di atas -- supaya fungsi lama itu
  // tidak perlu disentuh sama sekali untuk fitur baru ini.
  if (bulan) {
    const [y, m] = bulan.split('-');
    const bulanStart = `${y}-${m}-01`;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    const bulanEnd = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    if (bulanStart > start) start = bulanStart;
    if (bulanEnd < end) end = bulanEnd;
  }
  const todayStr = new Date().toISOString().substring(0, 10);
  if (end > todayStr) end = todayStr;

  const kosong = {
    success: true,
    siswa: { nama: siswa.nama, nisn: siswa.nisn, kelas: siswa.kelas },
    semester: { id: sm.id, nama: sm.nama, tahunAjaran: sm.tahun_ajaran },
    rentang: { start, end: start > end ? start : end },
    mapelList: [],
    statistik: { totalSesi: 0, totalTerverifikasi: 0, totalBelumTerverifikasi: 0, persentaseTerverifikasi: 0 },
    riwayat: []
  };
  if (start > end) return kosong;

  // Semua sesi mengajar yang tercatat di KELAS siswa ini pada rentang
  // tanggal ini (kolom kelas/mapel/nama_guru didenormalisasi langsung di
  // absensi_mengajar saat insert -- lihat scanSesiMengajar di
  // api/mengajar.js -- jadi tidak perlu join ke jadwal_mengajar/guru).
  const { data: sesiKelas, error: errSesi } = await supabase
    .from('absensi_mengajar')
    .select('id,tanggal,hari,mapel,nama_guru,status_verifikasi,jumlah_siswa_terverifikasi')
    .eq('kelas', siswa.kelas).gte('tanggal', start).lte('tanggal', end)
    .order('tanggal', { ascending: false });
  if (errSesi) return { success: false, message: errSesi.message };

  if (!sesiKelas || !sesiKelas.length) {
    return { ...kosong, rentang: { start, end } };
  }

  const { data: verifSiswa, error: errVerif } = await supabase
    .from('kehadiran_siswa_mapel')
    .select('id_absensi_mengajar,jam_scan')
    .eq('id_siswa', siswa.id).gte('tanggal', start).lte('tanggal', end);
  if (errVerif) return { success: false, message: errVerif.message };

  const verifMap = {};
  (verifSiswa || []).forEach(v => { verifMap[v.id_absensi_mengajar] = v.jam_scan; });

  let riwayat = sesiKelas.map(s => ({
    tanggal: s.tanggal, hari: s.hari, mapel: s.mapel, namaGuru: s.nama_guru,
    terverifikasi: Object.prototype.hasOwnProperty.call(verifMap, s.id),
    jamScan: verifMap[s.id] || null,
    // Ikut disertakan sebagai konteks tambahan (bukan alasan menuduh siswa
    // bolos): kalau status_verifikasi sesi ini sendiri "Perlu Ditinjau",
    // itu tandanya guru memang belum scan cukup banyak siswa sama sekali
    // di sesi itu -- jadi "Belum Terverifikasi" untuk siswa ini makin
    // tidak bisa dianggap bukti apa-apa.
    statusVerifikasiSesi: s.status_verifikasi
  }));

  const mapelList = [...new Set(riwayat.map(r => r.mapel).filter(Boolean))].sort();

  if (mapel) riwayat = riwayat.filter(r => r.mapel === mapel);

  const totalSesi = riwayat.length;
  const totalTerverifikasi = riwayat.filter(r => r.terverifikasi).length;
  const statistik = {
    totalSesi,
    totalTerverifikasi,
    totalBelumTerverifikasi: totalSesi - totalTerverifikasi,
    persentaseTerverifikasi: totalSesi > 0 ? Math.round((totalTerverifikasi / totalSesi) * 1000) / 10 : 0
  };

  return {
    success: true,
    siswa: { nama: siswa.nama, nisn: siswa.nisn, kelas: siswa.kelas },
    semester: { id: sm.id, nama: sm.nama, tahunAjaran: sm.tahun_ajaran },
    rentang: { start, end },
    mapelList,
    statistik,
    riwayat
  };
}
