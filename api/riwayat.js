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
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

async function findSiswaByToken(token) {
  if (!token || !String(token).trim()) return null;
  const { data } = await supabase
    .from('siswa')
    .select('id,nisn,nama,kelas,jenis_kelamin,status,riwayat_token')
    .eq('riwayat_token', String(token).trim())
    .maybeSingle();
  return data || null;
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
  const defaultAktif = { Senin: true, Selasa: true, Rabu: true, Kamis: true, Jumat: true, Sabtu: false, Minggu: false };
  const namaHariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  const rowsMap = {};
  (absenData || []).forEach(a => {
    rowsMap[a.tanggal] = {
      tanggal: a.tanggal, hari: a.hari,
      jamDatang: a.jam_datang, statusDatang: a.status_datang,
      jamPulang: a.jam_pulang, statusPulang: a.status_pulang,
      keterangan: a.keterangan || null
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
      const aktif = hariAktifMap.hasOwnProperty(namaHari) ? hariAktifMap[namaHari] : defaultAktif[namaHari];
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

  const totalIzinList = ['Izin', 'Urusan Keluarga', 'Izin Lainnya'];
  const statistik = {
    totalHadir:      allRows.filter(r => r.statusDatang === 'Hadir').length,
    totalTerlambat:  allRows.filter(r => r.statusDatang === 'Terlambat').length,
    totalSakit:      allRows.filter(r => r.statusDatang === 'Sakit').length,
    totalIzin:       allRows.filter(r => totalIzinList.includes(r.statusDatang)).length,
    totalAlpha:      allRows.filter(r => r.statusDatang === 'Alpha').length,
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
