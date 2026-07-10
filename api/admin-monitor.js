// api/admin-monitor.js — Dashboard Sistem untuk Administrator (PUBLIK,
// diakses via QR halaman BELAKANG kartu admin).
//
// LATAR: sama pola dengan api/monitor.js (dashboard kepsek), tapi lebih
// lengkap karena memang ditujukan untuk admin -- selain ringkasan sekolah
// yang sama dengan kepsek (kehadiran siswa, piket, status mengajar guru),
// ditambahkan 3 hal yang relevan untuk admin: ringkasan data master,
// status sinkronisasi/antrian offline semua perangkat, dan aktivitas
// terbaru (piket & absen mengajar).
//
// KEAMANAN:
//  - Token divalidasi lewat admin.qr_token, KOLOM YANG SAMA yang juga
//    dipakai QR di halaman DEPAN kartu admin untuk bypass login penuh
//    (lihat buildAdminCardHTML() & api/auth.js -> requireAdminToken).
//    Sengaja TIDAK dibuatkan token baru -- siapa pun yang memegang kartu
//    admin fisik SUDAH BISA login penuh lewat QR depan, jadi dashboard
//    read-only di QR belakang (pakai token yang sama) tidak menambah
//    risiko baru sama sekali dibanding yang sudah ada.
//  - SEMUA endpoint di bawah ini hanya membaca data agregat/ringkasan.
//    Tidak ada satupun action yang mengubah data (bukan pengganti
//    halaman admin yang sebenarnya, yang tetap wajib login).
//  - Karena dashboard ini memang untuk admin (bukan kepsek), datanya boleh
//    lebih lengkap -- tapi tetap tidak pernah menampilkan data sensitif
//    seperti alamat/no HP siswa/ortu atau password siapapun.
const {
  supabase, setCors, todayStr, getJamSetting,
  ringkasanLiveHariIni, ringkasanRekapPeriode
} = require('./_db');

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, ...params } = req.body || {};
  try {
    if (action === 'getInfo')             return res.json(await getInfo(params));
    if (action === 'getLiveHariIni')       return res.json(await getLiveHariIni(params));
    if (action === 'getRekapPeriode')      return res.json(await getRekapPeriode(params));
    if (action === 'getRingkasanMaster')   return res.json(await getRingkasanMaster(params));
    if (action === 'getStatusPerangkat')   return res.json(await getStatusPerangkat(params));
    if (action === 'getAktivitasTerbaru')  return res.json(await getAktivitasTerbaru(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── VALIDASI TOKEN: HARUS ada di tabel admin ──────────────────────
async function findAdminByToken(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('admin').select('id,nama,username')
    .eq('qr_token', String(token).trim()).limit(1);
  return (data && data[0]) || null;
}

const PESAN_TOKEN_INVALID = 'Kode QR tidak valid atau bukan kartu Administrator';

async function getInfo({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_INVALID };
  const settings = await getJamSetting();
  return { success: true, admin: { nama: admin.nama }, namaSekolah: settings['NAMA_SEKOLAH'] || 'Sekolah' };
}

async function getLiveHariIni({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_INVALID };
  const data = await ringkasanLiveHariIni();
  return { success: true, ...data };
}

async function getRekapPeriode({ token, rentang }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_INVALID };
  if (!['minggu', 'bulan'].includes(rentang)) return { success: false, message: 'Rentang harus "minggu" atau "bulan"' };
  const data = await ringkasanRekapPeriode(rentang);
  return { success: true, ...data };
}

// ════════════════════════════════════════════════════════════════
// RINGKASAN DATA MASTER — jumlah guru/siswa/kelas aktif & semester
// yang sedang berjalan. Murni hitungan, tidak ada data individu.
// ════════════════════════════════════════════════════════════════
async function getRingkasanMaster({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_INVALID };

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

// ════════════════════════════════════════════════════════════════
// STATUS PERANGKAT — sinkronisasi & antrian offline semua device yang
// pernah kirim heartbeat (lihat scan.html -> kirimHeartbeat() dan
// api/sync.js -> action 'heartbeat'). Device dianggap "online" kalau
// heartbeat terakhirnya masih dalam AMBANG_ONLINE_DETIK terakhir --
// device yang benar-benar offline otomatis berhenti kirim heartbeat
// sehingga "basi" dan otomatis ditandai offline di sini.
// ════════════════════════════════════════════════════════════════
const AMBANG_ONLINE_DETIK = 90;
const SEMBUNYIKAN_SETELAH_HARI = 30; // device tak aktif >30 hari dianggap sudah tidak dipakai

async function getStatusPerangkat({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_INVALID };

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

// ════════════════════════════════════════════════════════════════
// AKTIVITAS TERBARU — gabungan scan piket & scan absen mengajar 3 hari
// terakhir, diurutkan dari yang paling baru. Versi RINGAN: cuma
// menampilkan aktivitas yang memang sudah otomatis tercatat sistem
// (bukan audit-log perubahan data guru/siswa/dst, yang belum ada).
// ════════════════════════════════════════════════════════════════
async function getAktivitasTerbaru({ token }) {
  const admin = await findAdminByToken(token);
  if (!admin) return { success: false, message: PESAN_TOKEN_INVALID };

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
