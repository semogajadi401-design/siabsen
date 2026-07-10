// api/monitor.js — Dashboard Pengawasan Kepala Sekolah (PUBLIK, diakses via
// QR halaman BELAKANG kartu kepsek).
//
// LATAR: sebelumnya QR belakang kartu kepsek sama persis fungsinya dengan
// QR belakang kartu guru biasa -- "GURU_LOGIN|token" untuk bypass login ke
// akun kepsek. Sekarang diganti KHUSUS untuk role kepsek: QR-nya jadi URL
// "https://.../monitor/TOKEN" yang membuka halaman ringkasan keadaan
// sekolah saat ini (read-only, tanpa perlu login manual sama sekali) --
// jalan pintas kepsek untuk lihat: kehadiran siswa, siapa piket & sudah
// lapor/belum, siapa guru sedang/sudah/belum mengajar, dan rekap kehadiran
// siswa per minggu/bulan.
//
// KEAMANAN (sama pola dengan api/riwayat.js untuk siswa):
//  - Kepsek dicari lewat guru.qr_token acak (kolom yang sama dipakai untuk
//    QR login guru biasa), BUKAN lewat id/username, supaya tidak bisa
//    ditebak-tebak.
//  - HANYA guru dengan role === 'kepsek' yang boleh lewat sini. Token guru
//    biasa yang kebetulan valid tetap DITOLAK -- endpoint ini tidak pernah
//    dipakai untuk bypass login akun apapun (beda dari GURU_LOGIN di
//    scan.js/auth.js), jadi aman diakses siapapun yang menemukan kartu
//    kepsek tercecer: paling jauh cuma bisa lihat ringkasan sekolah, tidak
//    bisa masuk ke akun kepsek.
//  - Data yang dikembalikan cuma agregat/ringkasan (jumlah, nama, kelas,
//    jam), tidak pernah data sensitif seperti alamat/no HP ortu/password.
const {
  supabase, setCors, todayStr, hariIni, jamSekarang, tambahMenit,
  isHariLibur, isHariKerja, getJamSetting, resolveGuruIdFromToken
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getInfo')         return res.json(await getInfo(params));
    if (action === 'getLiveHariIni')  return res.json(await getLiveHariIni(params));
    if (action === 'getRekapPeriode') return res.json(await getRekapPeriode(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── VALIDASI TOKEN: HARUS guru aktif DENGAN role kepsek ───────────
async function findKepsekByToken(token) {
  const idGuru = await resolveGuruIdFromToken(token);
  if (!idGuru) return null;
  const { data: guru } = await supabase
    .from('guru').select('id,nama,role,status').eq('id', idGuru).maybeSingle();
  if (!guru || guru.role !== 'kepsek' || guru.status !== 'Aktif') return null;
  return guru;
}

async function getInfo({ token }) {
  const kepsek = await findKepsekByToken(token);
  if (!kepsek) return { success: false, message: 'Kode QR tidak valid atau bukan kartu Kepala Sekolah' };
  const settings = await getJamSetting();
  return {
    success: true,
    kepsek: { nama: kepsek.nama },
    namaSekolah: settings['NAMA_SEKOLAH'] || 'Sekolah'
  };
}

// ════════════════════════════════════════════════════════════════
// LIVE HARI INI — kehadiran siswa, piket, & status mengajar guru
// SAAT INI JUGA (real-time), TIDAK dipengaruhi filter minggu/bulan.
// ════════════════════════════════════════════════════════════════
async function getLiveHariIni({ token }) {
  const kepsek = await findKepsekByToken(token);
  if (!kepsek) return { success: false, message: 'Kode QR tidak valid atau bukan kartu Kepala Sekolah' };

  const today  = todayStr();
  const hari   = hariIni();
  const jamNow = jamSekarang();
  const settings = await getJamSetting();
  const cekLibur = await isHariLibur(today);
  const hariSekolah = !cekLibur.libur && await isHariKerja(hari);

  const [
    { count: totalSiswa },
    { data: absenHariIni },
    { data: ketHariIni },
    { data: jadwalPiket },
    { data: sesiPiketHariIni },
    { data: jadwalMengajarHariIni },
    { data: jamPelajaranHariIni },
    { data: absensiMengajarHariIni }
  ] = await Promise.all([
    supabase.from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('absensi').select('nama_siswa,kelas,jam_datang,status_datang,jam_pulang,status_pulang').eq('tanggal', today),
    supabase.from('keterangan_absensi').select('nama_siswa,kelas,status,keterangan').eq('tanggal', today),
    supabase.from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari),
    supabase.from('sesi_piket').select('id_guru,nama_guru,jam_scan').eq('tanggal', today),
    supabase.from('jadwal_mengajar').select('id,id_guru,nama_guru,jam_ke_mulai,jam_ke_selesai,kelas,mapel').eq('hari', hari),
    supabase.from('jam_pelajaran').select('jam_ke,jam_mulai,jam_selesai').eq('hari', hari).order('jam_ke'),
    supabase.from('absensi_mengajar').select('id_jadwal_mengajar,id_guru,nama_guru,kelas,mapel,jam_scan,status').eq('tanggal', today)
  ]);

  // ── Kehadiran siswa hari ini (sama logika dengan dashboard admin) ──
  const hadirHariIni     = (absenHariIni || []).filter(a => a.status_datang === 'Hadir' || a.status_datang === 'Terlambat').length;
  const terlambatHariIni = (absenHariIni || []).filter(a => a.status_datang === 'Terlambat').length;
  const sakitHariIni     = (ketHariIni || []).filter(k => k.status === 'Sakit').length;
  const izinHariIni      = (ketHariIni || []).filter(k => k.status !== 'Sakit').length;
  const alphaHariIni     = Math.max(0, (totalSiswa || 0) - hadirHariIni - sakitHariIni - izinHariIni);
  const daftarSakitIzin  = (ketHariIni || []).map(k => ({ nama: k.nama_siswa, kelas: k.kelas, status: k.status, keterangan: k.keterangan || null }));

  // ── Piket hari ini: terjadwal vs yang sudah lapor (scan) ──
  const idSudahLapor = new Set((sesiPiketHariIni || []).map(s => s.id_guru));
  const daftarPiket = (jadwalPiket || []).map(p => ({
    namaGuru: p.nama_guru, jabatan: p.jabatan,
    sudahLapor: idSudahLapor.has(p.id_guru),
    jamLapor: (sesiPiketHariIni || []).find(s => s.id_guru === p.id_guru)?.jam_scan || null
  }));
  // Guru yang scan piket TAPI tidak termasuk jadwal (pengganti dadakan)
  const idTerjadwalPiket = new Set((jadwalPiket || []).map(p => p.id_guru));
  (sesiPiketHariIni || []).forEach(s => {
    if (!idTerjadwalPiket.has(s.id_guru)) {
      daftarPiket.push({ namaGuru: s.nama_guru, jabatan: 'Piket Pengganti', sudahLapor: true, jamLapor: s.jam_scan });
    }
  });

  // ── Status mengajar guru saat ini (real-time) ──
  // Untuk setiap blok jadwal_mengajar hari ini, cari jam mulai (dari jam_ke_mulai)
  // & jam selesai (dari jam_ke_selesai) lewat tabel jam_pelajaran, lalu
  // dibandingkan dengan jam sekarang untuk menentukan status blok itu.
  const jpMap = {};
  (jamPelajaranHariIni || []).forEach(j => { jpMap[j.jam_ke] = j; });
  const tercatatMap = {}; // id_jadwal_mengajar -> absensi_mengajar row
  (absensiMengajarHariIni || []).forEach(a => { tercatatMap[a.id_jadwal_mengajar] = a; });

  const guruMap = {}; // id_guru -> { namaGuru, sesi: [...] }
  (jadwalMengajarHariIni || []).forEach(j => {
    const jpMulai   = jpMap[j.jam_ke_mulai];
    const jpSelesai = jpMap[j.jam_ke_selesai] || jpMulai;
    if (!jpMulai || !jpSelesai) return; // jam pelajaran belum diatur admin utk hari ini
    let statusSesi = 'belum-mulai';
    if (jamNow > jpSelesai.jam_selesai) statusSesi = 'selesai';
    else if (jamNow >= jpMulai.jam_mulai) statusSesi = 'berlangsung';

    if (!guruMap[j.id_guru]) guruMap[j.id_guru] = { idGuru: j.id_guru, namaGuru: j.nama_guru, sesi: [] };
    guruMap[j.id_guru].sesi.push({
      kelas: j.kelas, mapel: j.mapel,
      jamMulai: jpMulai.jam_mulai, jamSelesai: jpSelesai.jam_selesai,
      status: statusSesi,
      tercatat: !!tercatatMap[j.id],
      statusAbsen: tercatatMap[j.id] ? tercatatMap[j.id].status : null
    });
  });

  const sedangMengajar = [], sudahSelesai = [], belumMulai = [];
  Object.values(guruMap).forEach(g => {
    const adaBerlangsung = g.sesi.some(s => s.status === 'berlangsung');
    const semuaSelesai   = g.sesi.every(s => s.status === 'selesai');
    const belumAda       = g.sesi.every(s => s.status === 'belum-mulai');
    if (adaBerlangsung) {
      const sesiAktif = g.sesi.find(s => s.status === 'berlangsung');
      sedangMengajar.push({ namaGuru: g.namaGuru, kelas: sesiAktif.kelas, mapel: sesiAktif.mapel, tercatatAbsen: sesiAktif.tercatat });
    } else if (semuaSelesai) {
      sudahSelesai.push({ namaGuru: g.namaGuru, totalSesi: g.sesi.length, adaYangTidakTercatat: g.sesi.some(s => !s.tercatat) });
    } else if (belumAda) {
      const sesiBerikut = g.sesi.sort((a,b)=>a.jamMulai.localeCompare(b.jamMulai))[0];
      belumMulai.push({ namaGuru: g.namaGuru, kelas: sesiBerikut.kelas, mapel: sesiBerikut.mapel, jamMulai: sesiBerikut.jamMulai });
    }
  });

  return {
    success: true,
    tanggal: today, hari, jamSekarang: jamNow,
    namaSekolah: settings['NAMA_SEKOLAH'] || 'Sekolah',
    hariSekolah,
    keteranganLibur: cekLibur.libur ? (cekLibur.keterangan || 'Hari libur') : null,
    kehadiranSiswa: {
      totalSiswa: totalSiswa || 0, hadir: hadirHariIni, terlambat: terlambatHariIni,
      sakit: sakitHariIni, izin: izinHariIni, alpha: alphaHariIni,
      daftarSakitIzin
    },
    piket: daftarPiket,
    mengajar: { sedangMengajar, sudahSelesai, belumMulai }
  };
}

// ════════════════════════════════════════════════════════════════
// REKAP PERIODE — kehadiran siswa & kepatuhan piket untuk rentang
// minggu (7 hari terakhir termasuk hari ini) atau bulan (1 s/d hari
// ini bulan berjalan).
// ════════════════════════════════════════════════════════════════
async function getRekapPeriode({ token, rentang }) {
  const kepsek = await findKepsekByToken(token);
  if (!kepsek) return { success: false, message: 'Kode QR tidak valid atau bukan kartu Kepala Sekolah' };
  if (!['minggu', 'bulan'].includes(rentang)) return { success: false, message: 'Rentang harus "minggu" atau "bulan"' };

  const today = todayStr();
  let start;
  if (rentang === 'minggu') {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 6);
    start = d.toISOString().substring(0, 10);
  } else {
    start = today.substring(0, 7) + '-01';
  }
  const end = today;

  const { count: totalSiswa } = await supabase
    .from('siswa').select('*', { count: 'exact', head: true }).eq('status', 'Aktif');

  const [
    { data: absenRange },
    { data: ketRange },
    { data: liburRows },
    { data: hariKerjaSetting },
    { data: jadwalPiketAll },
    { data: sesiPiketRange }
  ] = await Promise.all([
    supabase.from('absensi').select('tanggal,status_datang').gte('tanggal', start).lte('tanggal', end),
    supabase.from('keterangan_absensi').select('tanggal,status').gte('tanggal', start).lte('tanggal', end),
    supabase.from('hari_kerja').select('tanggal').gte('tanggal', start).lte('tanggal', end),
    supabase.from('pengaturan_hari_kerja').select('*'),
    supabase.from('jadwal_piket').select('hari,id_guru,nama_guru'),
    supabase.from('sesi_piket').select('tanggal,id_guru,nama_guru').gte('tanggal', start).lte('tanggal', end)
  ]);

  const liburSet = new Set((liburRows || []).map(r => String(r.tanggal).substring(0, 10)));
  const hariAktifMap = {};
  (hariKerjaSetting || []).forEach(h => { hariAktifMap[h.hari] = h.aktif; });
  const namaHariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  // Hitung berapa hari sekolah efektif dalam rentang (utk hitung Alpha total)
  let jumlahHariSekolah = 0;
  const cur = new Date(start + 'T00:00:00Z');
  const akhir = new Date(end + 'T00:00:00Z');
  while (cur <= akhir) {
    const tgl = cur.toISOString().substring(0, 10);
    const namaHari = namaHariArr[cur.getUTCDay()];
    const aktif = hariAktifMap.hasOwnProperty(namaHari) ? hariAktifMap[namaHari] : false;
    if (aktif && !liburSet.has(tgl)) jumlahHariSekolah++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const hadirTotal     = (absenRange || []).filter(a => a.status_datang === 'Hadir' || a.status_datang === 'Terlambat').length;
  const terlambatTotal = (absenRange || []).filter(a => a.status_datang === 'Terlambat').length;
  const sakitTotal      = (ketRange || []).filter(k => k.status === 'Sakit').length;
  const izinTotal       = (ketRange || []).filter(k => k.status !== 'Sakit').length;
  const totalKemungkinanHadir = jumlahHariSekolah * (totalSiswa || 0);
  const alphaTotal = Math.max(0, totalKemungkinanHadir - hadirTotal - sakitTotal - izinTotal);
  const persentaseKehadiran = totalKemungkinanHadir > 0
    ? Math.round((hadirTotal / totalKemungkinanHadir) * 1000) / 10 : 0;

  // ── Kepatuhan piket dalam rentang (sama pola dgn getLaporanKepatuhanPiket) ──
  const jadwalPerHari = {};
  (jadwalPiketAll || []).forEach(j => {
    if (!jadwalPerHari[j.hari]) jadwalPerHari[j.hari] = [];
    jadwalPerHari[j.hari].push({ idGuru: j.id_guru, namaGuru: j.nama_guru });
  });
  const sesiPerTanggal = {};
  (sesiPiketRange || []).forEach(s => {
    if (!sesiPerTanggal[s.tanggal]) sesiPerTanggal[s.tanggal] = [];
    sesiPerTanggal[s.tanggal].push(s);
  });
  const rekapGuru = {};
  function ambil(idGuru, namaGuru) {
    if (!rekapGuru[idGuru]) rekapGuru[idGuru] = { namaGuru, hadirTepat: 0, tanpaPiket: 0, digantikan: 0 };
    return rekapGuru[idGuru];
  }
  const cur2 = new Date(start + 'T00:00:00Z');
  while (cur2 <= akhir) {
    const tgl = cur2.toISOString().substring(0, 10);
    const namaHari = namaHariArr[cur2.getUTCDay()];
    const terjadwal = jadwalPerHari[namaHari] || [];
    const sesiHariItu = sesiPerTanggal[tgl] || [];
    terjadwal.forEach(t => {
      const r = ambil(t.idGuru, t.namaGuru);
      const scanSendiri = sesiHariItu.find(s => s.id_guru === t.idGuru);
      if (scanSendiri) r.hadirTepat++;
      else if (sesiHariItu.length) r.digantikan++;
      else r.tanpaPiket++;
    });
    cur2.setUTCDate(cur2.getUTCDate() + 1);
  }
  const kepatuhanPiket = Object.values(rekapGuru).sort((a, b) => a.namaGuru.localeCompare(b.namaGuru));

  return {
    success: true,
    rentang, tanggalMulai: start, tanggalSelesai: end, jumlahHariSekolah,
    kehadiranSiswa: {
      totalSiswa: totalSiswa || 0, hadir: hadirTotal, terlambat: terlambatTotal,
      sakit: sakitTotal, izin: izinTotal, alpha: alphaTotal, persentaseKehadiran
    },
    kepatuhanPiket
  };
}
