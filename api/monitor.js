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
// ════════════════════════════════════════════════════════════════
// CATATAN PENGGABUNGAN (BARU): Dashboard Admin (QR belakang kartu admin)
// SENGAJA digabung ke file INI (bukan file api/admin-monitor.js
// terpisah) karena Vercel plan Hobby membatasi maksimal 12 Serverless
// Functions -- 1 file di /api (selain yang diawali "_") = 1 function.
// Actions untuk admin diberi AWALAN "admin" supaya tidak pernah
// bentrok nama dengan action kepsek di atas, dan validasi tokennya
// (findAdminByToken, ke tabel admin) sengaja dipisah total dari
// findKepsekByToken (ke tabel guru) supaya token kepsek tidak pernah
// bisa dipakai buka dashboard admin ataupun sebaliknya.
// ════════════════════════════════════════════════════════════════
const {
  supabase, setCors, todayStr, getJamSetting, resolveGuruIdFromToken,
  ringkasanLiveHariIni, ringkasanRekapPeriode
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getInfo')         return res.json(await getInfo(params));
    if (action === 'getLiveHariIni')  return res.json(await getLiveHariIni(params));
    if (action === 'getRekapPeriode') return res.json(await getRekapPeriode(params));
    // ── Dashboard Admin (lihat catatan penggabungan di atas) ──
    if (action === 'adminGetInfo')            return res.json(await adminGetInfo(params));
    if (action === 'adminGetLiveHariIni')     return res.json(await adminGetLiveHariIni(params));
    if (action === 'adminGetRekapPeriode')    return res.json(await adminGetRekapPeriode(params));
    if (action === 'adminGetRingkasanMaster') return res.json(await adminGetRingkasanMaster(params));
    if (action === 'adminGetStatusPerangkat') return res.json(await adminGetStatusPerangkat(params));
    if (action === 'adminGetAktivitasTerbaru') return res.json(await adminGetAktivitasTerbaru(params));
    // Dipakai admin & kepsek (lihat findAksesKesehatanSistem) -- satu
    // action untuk 2 dashboard, tidak perlu duplikasi adminCek.../ cek...
    if (action === 'cekKesehatanSistem') return res.json(await cekKesehatanSistem(params));
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
  const data = await ringkasanLiveHariIni();
  return { success: true, ...data };
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
  const data = await ringkasanRekapPeriode(rentang);
  return { success: true, ...data };
}

// ════════════════════════════════════════════════════════════════
// DASHBOARD ADMIN — QR halaman BELAKANG kartu admin (lihat catatan
// penggabungan di bagian atas file). Lebih lengkap dari dashboard
// kepsek: selain ringkasan sekolah yang sama, ada ringkasan data
// master, status sinkronisasi/antrian offline semua perangkat, dan
// aktivitas terbaru (piket & absen mengajar).
//
// KEAMANAN:
//  - Token divalidasi lewat admin.qr_token, KOLOM YANG SAMA yang juga
//    dipakai QR di halaman DEPAN kartu admin untuk bypass login penuh
//    (lihat buildAdminCardHTML() & api/auth.js -> requireAdminToken).
//    Sengaja TIDAK dibuatkan token baru -- siapa pun yang memegang kartu
//    admin fisik SUDAH BISA login penuh lewat QR depan, jadi dashboard
//    read-only di QR belakang (pakai token yang sama) tidak menambah
//    risiko baru sama sekali dibanding yang sudah ada.
//  - SEMUA action di bawah ini hanya membaca data agregat/ringkasan.
//    Tidak ada satupun yang mengubah data (bukan pengganti halaman
//    admin sungguhan, yang tetap wajib login).
// ════════════════════════════════════════════════════════════════

async function findAdminByToken(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('admin').select('id,nama,username')
    .eq('qr_token', String(token).trim()).limit(1);
  return (data && data[0]) || null;
}

const PESAN_TOKEN_ADMIN_INVALID = 'Kode QR tidak valid atau bukan kartu Administrator';

async function adminGetInfo({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_ADMIN_INVALID };
  const settings = await getJamSetting();
  return { success: true, admin: { nama: admin.nama }, namaSekolah: settings['NAMA_SEKOLAH'] || 'Sekolah' };
}

async function adminGetLiveHariIni({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_ADMIN_INVALID };
  const data = await ringkasanLiveHariIni();
  return { success: true, ...data };
}

async function adminGetRekapPeriode({ token, rentang }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_ADMIN_INVALID };
  if (!['minggu', 'bulan'].includes(rentang)) return { success: false, message: 'Rentang harus "minggu" atau "bulan"' };
  const data = await ringkasanRekapPeriode(rentang);
  return { success: true, ...data };
}

// ── RINGKASAN DATA MASTER — jumlah guru/siswa/kelas aktif & semester
// yang sedang berjalan. Murni hitungan, tidak ada data individu.
async function adminGetRingkasanMaster({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_ADMIN_INVALID };

  const [
    { count: guruAktif },
    { count: guruTidakAktif },
    { data: siswaAktifRows },
    { data: semesterAktifRows }
  ] = await Promise.all([
    supabase.from('guru').select('*', { count: 'exact', head: true }).eq('status', 'Aktif'),
    supabase.from('guru').select('*', { count: 'exact', head: true }).neq('status', 'Aktif'),
    supabase.from('siswa').select('kelas').eq('status', 'Aktif'),
    supabase.from('semester').select('nama,tahun_ajaran,tanggal_mulai,tanggal_selesai').eq('aktif', true).limit(1)
  ]);

  const siswaAktif = (siswaAktifRows || []).length;
  const kelasSet = new Set((siswaAktifRows || []).map(s => s.kelas).filter(Boolean));
  const sem = (semesterAktifRows && semesterAktifRows[0]) || null;

  return {
    success: true,
    guruAktif: guruAktif || 0,
    guruTidakAktif: guruTidakAktif || 0,
    siswaAktif,
    jumlahKelasAktif: kelasSet.size,
    semesterAktif: sem ? {
      nama: sem.nama, tahunAjaran: sem.tahun_ajaran,
      mulai: sem.tanggal_mulai, selesai: sem.tanggal_selesai
    } : null
  };
}

// ── STATUS PERANGKAT — sinkronisasi & antrian offline semua device
// yang pernah kirim heartbeat (lihat scan.html -> kirimHeartbeat() dan
// api/sync.js -> action 'heartbeat'). Device dianggap "online" kalau
// heartbeat terakhirnya masih dalam AMBANG_ONLINE_DETIK terakhir --
// device yang benar-benar offline otomatis berhenti kirim heartbeat
// sehingga "basi" dan otomatis ditandai offline di sini.
const AMBANG_ONLINE_DETIK = 90;
const SEMBUNYIKAN_SETELAH_HARI = 30; // device tak aktif >30 hari dianggap sudah tidak dipakai

async function adminGetStatusPerangkat({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_ADMIN_INVALID };

  const batasTampil = new Date(Date.now() - SEMBUNYIKAN_SETELAH_HARI * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await supabase
    .from('perangkat_status')
    .select('device_id,label,antrian_pending,last_heartbeat')
    .gte('last_heartbeat', batasTampil)
    .order('last_heartbeat', { ascending: false });

  const now = Date.now();
  const perangkat = (rows || []).map(r => {
    const detikLalu = Math.max(0, Math.floor((now - new Date(r.last_heartbeat).getTime()) / 1000));
    return {
      deviceId: r.device_id,
      label: r.label || 'Perangkat Scan',
      online: detikLalu <= AMBANG_ONLINE_DETIK,
      antrianPending: r.antrian_pending || 0,
      detikSejakLapor: detikLalu
    };
  });

  return {
    success: true,
    perangkat,
    ringkasan: {
      totalPerangkat: perangkat.length,
      online: perangkat.filter(p => p.online).length,
      offline: perangkat.filter(p => !p.online).length,
      totalAntrianPending: perangkat.reduce((a, p) => a + p.antrianPending, 0)
    }
  };
}

// ── AKTIVITAS TERBARU — gabungan scan piket & scan absen mengajar 3
// hari terakhir, diurutkan dari yang paling baru. Versi RINGAN: cuma
// menampilkan aktivitas yang memang sudah otomatis tercatat sistem
// (bukan audit-log perubahan data guru/siswa/dst, yang belum ada).
async function adminGetAktivitasTerbaru({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_ADMIN_INVALID };

  const today = todayStr();
  const batas = new Date(today + 'T00:00:00Z');
  batas.setUTCDate(batas.getUTCDate() - 3);
  const batasStr = batas.toISOString().substring(0, 10);

  const [
    { data: piketRows },
    { data: mengajarRows }
  ] = await Promise.all([
    supabase.from('sesi_piket')
      .select('nama_guru,jabatan,tanggal,jam_scan')
      .gte('tanggal', batasStr).order('tanggal', { ascending: false }).limit(50),
    supabase.from('absensi_mengajar')
      .select('nama_guru,kelas,mapel,tanggal,jam_scan,status')
      .gte('tanggal', batasStr).order('tanggal', { ascending: false }).limit(50)
  ]);

  const feed = [];
  (piketRows || []).forEach(r => feed.push({
    urut: `${r.tanggal}T${r.jam_scan || '00:00'}`,
    tanggal: r.tanggal, jam: r.jam_scan || null,
    tipe: 'piket',
    teks: `${r.nama_guru || 'Guru'} lapor piket${r.jabatan ? ' (' + r.jabatan + ')' : ''}`
  }));
  (mengajarRows || []).forEach(r => feed.push({
    urut: `${r.tanggal}T${r.jam_scan || '00:00'}`,
    tanggal: r.tanggal, jam: r.jam_scan || null,
    tipe: 'mengajar',
    teks: `${r.nama_guru || 'Guru'} absen mengajar ${r.mapel || ''} di ${r.kelas || '-'}${r.status ? ' • ' + r.status : ''}`
  }));

  feed.sort((a, b) => b.urut.localeCompare(a.urut));

  return { success: true, aktivitas: feed.slice(0, 25) };
}

// ════════════════════════════════════════════════════════════════
// CEK KESEHATAN SISTEM (BARU) — dipakai admin & kepsek, murni ON-DEMAND
// (tidak ada job/polling otomatis apapun -- fungsi ini hanya jalan saat
// action ini dipanggil, yaitu saat tombol "Cek Kesehatan Sistem" ditekan
// di admin-monitor.html / monitor.html, sesuai permintaan supaya tidak
// membebani aplikasi kalau menunya tidak dibuka).
//
// LATAR: kalau guru piket beralasan "kendala sistem/tidak bisa buka
// aplikasi" atas keterlambatannya, admin/kepsek butuh cara mengecek
// klaim itu tanpa harus buka Supabase manual. Fitur ini menggabungkan
// 2 sumber bukti OBJEKTIF (bukan opini/alasan manual siapa pun):
//   1. Riwayat heartbeat kiosk (perangkat_status_log) -- celah waktu
//      yang tidak wajar antar heartbeat = indikasi kiosk offline/mati
//      di jam tersebut.
//   2. Status insiden RESMI dari penyedia layanan (Vercel & Supabase)
//      pada rentang waktu yang sama -- ini bukti pihak ketiga yang
//      tidak bisa direkayasa siapa pun di sekolah.
// PENTING (jujur ke pengguna): ini INDIKASI/sinyal, bukan bukti mutlak.
// Kiosk yang memang sengaja dimatikan di luar jam sekolah juga akan
// muncul sebagai "celah", jadi tetap perlu penilaian manusia.

async function findAksesKesehatanSistem(token) {
  // Dua jalur token yang diizinkan: kepsek (guru.qr_token, role kepsek)
  // ATAU admin (admin.qr_token) -- sama seperti pola getInfo/adminGetInfo
  // di atas, tapi digabung di satu action supaya bisa dipanggil dari
  // monitor.html (kepsek) maupun admin-monitor.html (admin) tanpa
  // duplikasi action.
  const kepsek = await findKepsekByToken(token);
  if (kepsek) return { ok: true, peran: 'kepsek', nama: kepsek.nama };
  const admin = await findAdminByToken(token);
  if (admin) return { ok: true, peran: 'admin', nama: admin.nama };
  return { ok: false };
}

function hitungRentangWaktu(rentang, semesterAktif) {
  const now = new Date();
  let mulai;
  switch (rentang) {
    case 'jam':    mulai = new Date(now.getTime() - 6 * 60 * 60 * 1000); break;       // 6 jam terakhir
    case 'hari':   mulai = new Date(now); mulai.setHours(0, 0, 0, 0); break;          // sejak 00:00 hari ini
    case 'minggu': mulai = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;  // 7 hari terakhir
    case 'bulan':  mulai = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break; // 30 hari terakhir
    case 'semester': {
      if (semesterAktif && semesterAktif.tanggal_mulai) {
        mulai = new Date(semesterAktif.tanggal_mulai + 'T00:00:00');
      } else {
        mulai = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); // fallback: 90 hari kalau tidak ada semester aktif
      }
      break;
    }
    default: mulai = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
  return { mulai, selesai: now };
}

// Ambang celah dianggap "kemungkinan gangguan": heartbeat normal tiap
// ~30 detik (lihat kirimHeartbeat() di scan.html), jadi celah > 5 menit
// tanpa heartbeat cukup jelas menandakan kiosk offline/mati/gangguan --
// bukan cuma jeda wajar antar heartbeat biasa.
const AMBANG_GANGGUAN_DETIK = 5 * 60;
// Celah yang dianggap layak ditampilkan (biar tidak penuh gangguan super
// singkat yang tidak relevan untuk konteks "guru telat scan").
const CELAH_MINIMAL_DITAMPILKAN_MENIT = 5;

async function deteksiGangguanPerangkat(mulaiISO, selesaiISO) {
  const { data: rows, error } = await supabase
    .from('perangkat_status_log')
    .select('device_id,label,created_at')
    .gte('created_at', mulaiISO).lte('created_at', selesaiISO)
    .order('device_id', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(20000); // batas aman, cukup untuk rentang semester dgn beberapa device

  if (error) return { gangguan: [], totalHeartbeat: 0, totalPerangkat: 0, error: error.message };

  const perDevice = new Map();
  (rows || []).forEach(r => {
    if (!perDevice.has(r.device_id)) perDevice.set(r.device_id, { label: r.label || 'Perangkat Scan', waktu: [] });
    perDevice.get(r.device_id).waktu.push(new Date(r.created_at).getTime());
  });

  const gangguan = [];
  perDevice.forEach((info, deviceId) => {
    const w = info.waktu;
    for (let i = 1; i < w.length; i++) {
      const celahDetik = (w[i] - w[i - 1]) / 1000;
      if (celahDetik >= AMBANG_GANGGUAN_DETIK) {
        const durasiMenit = Math.round(celahDetik / 60);
        if (durasiMenit >= CELAH_MINIMAL_DITAMPILKAN_MENIT) {
          gangguan.push({
            deviceId, label: info.label,
            mulai: new Date(w[i - 1]).toISOString(),
            selesai: new Date(w[i]).toISOString(),
            durasiMenit
          });
        }
      }
    }
  });
  gangguan.sort((a, b) => b.durasiMenit - a.durasiMenit);

  return {
    gangguan: gangguan.slice(0, 100),
    totalHeartbeat: (rows || []).length,
    totalPerangkat: perDevice.size
  };
}

// Bucket jumlah heartbeat per rentang waktu, untuk grafik aktivitas
// sederhana di frontend (bukan grafik rumit -- cukup untuk terlihat
// "kapan ada aktivitas, kapan sepi/kosong").
function buatTimelineHeartbeat(mulai, selesai, jumlahBucketTarget = 16) {
  const totalMs = selesai.getTime() - mulai.getTime();
  const bucketMs = Math.max(60 * 1000, Math.ceil(totalMs / jumlahBucketTarget));
  const jumlahBucket = Math.min(60, Math.ceil(totalMs / bucketMs)); // batas atas 60 bucket biar tidak berat
  return { bucketMs, jumlahBucket };
}

// Insiden resmi dari status page Vercel & Supabase (statuspage.io,
// endpoint publik, tidak butuh API key). Best-effort murni: kalau gagal
// fetch (mis. rate limit atau layanan status itu sendiri lambat),
// jangan gagalkan seluruh hasil cek kesehatan -- cukup tandai kosong.
async function ambilInsidenEksternal(mulai, selesai) {
  const sumberList = [
    { nama: 'Vercel (hosting aplikasi)', url: 'https://www.vercel-status.com/api/v2/incidents.json' },
    { nama: 'Supabase (database)', url: 'https://status.supabase.com/api/v2/incidents.json' }
  ];

  const hasil = await Promise.all(sumberList.map(async (sumber) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(sumber.url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const data = await res.json();
      const insidenList = data.incidents || [];
      return insidenList
        .filter(inc => {
          const waktuInsiden = new Date(inc.created_at || inc.updated_at).getTime();
          return waktuInsiden >= mulai.getTime() && waktuInsiden <= selesai.getTime();
        })
        .map(inc => ({
          sumber: sumber.nama,
          judul: inc.name,
          dampak: inc.impact || 'none', // none|minor|major|critical
          status: inc.status,
          mulai: inc.created_at,
          shortlink: inc.shortlink || null
        }));
    } catch (e) {
      return []; // best-effort, diamkan
    }
  }));

  return hasil.flat().sort((a, b) => new Date(b.mulai) - new Date(a.mulai)).slice(0, 30);
}

async function cekKesehatanSistem({ token, rentang }) {
  const akses = await findAksesKesehatanSistem(token);
  if (!akses.ok) return { success: false, message: 'Kode QR tidak valid untuk membuka Cek Kesehatan Sistem' };

  const rentangValid = ['jam', 'hari', 'minggu', 'bulan', 'semester'];
  if (!rentangValid.includes(rentang)) return { success: false, message: 'Rentang harus salah satu dari: jam, hari, minggu, bulan, semester' };

  const { data: semesterRows } = await supabase
    .from('semester').select('tanggal_mulai,tanggal_selesai').eq('aktif', true).limit(1);
  const semesterAktif = (semesterRows && semesterRows[0]) || null;

  const { mulai, selesai } = hitungRentangWaktu(rentang, semesterAktif);
  const mulaiISO = mulai.toISOString();
  const selesaiISO = selesai.toISOString();

  const [{ gangguan, totalHeartbeat, totalPerangkat }, insidenEksternal] = await Promise.all([
    deteksiGangguanPerangkat(mulaiISO, selesaiISO),
    ambilInsidenEksternal(mulai, selesai)
  ]);

  const { bucketMs, jumlahBucket } = buatTimelineHeartbeat(mulai, selesai);

  // Timeline dihitung dari baris yang sama (query ringan tambahan,
  // hanya created_at) supaya grafik & deteksi gangguan konsisten dari
  // sumber data yang sama.
  const { data: timelineRows } = await supabase
    .from('perangkat_status_log')
    .select('created_at')
    .gte('created_at', mulaiISO).lte('created_at', selesaiISO)
    .limit(20000);

  const buckets = new Array(jumlahBucket).fill(0);
  (timelineRows || []).forEach(r => {
    const idx = Math.min(jumlahBucket - 1, Math.floor((new Date(r.created_at).getTime() - mulai.getTime()) / bucketMs));
    if (idx >= 0) buckets[idx]++;
  });
  const timeline = buckets.map((jumlah, i) => ({
    waktu: new Date(mulai.getTime() + i * bucketMs).toISOString(),
    jumlah
  }));

  return {
    success: true,
    rentang, mulai: mulaiISO, selesai: selesaiISO,
    ringkasan: {
      totalHeartbeat,
      totalPerangkat,
      totalGangguanTerdeteksi: gangguan.length,
      totalInsidenEksternal: insidenEksternal.length
    },
    timeline,
    gangguanTerdeteksi: gangguan,
    insidenEksternal
  };
}
