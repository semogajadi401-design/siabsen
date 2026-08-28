// api/honor.js — Honor/Insentif Mengajar per Pertemuan
//
// TERPISAH SENGAJA dari getRekapKehadiranGuru di api/mengajar.js: rekap di
// sana adalah dashboard evaluasi kehadiran (BUKAN dasar gaji, karena guru
// digaji bulanan tetap -- lihat catatan di kepala api/mengajar.js). File
// INI justru sebaliknya: khusus menghitung RUPIAH honor/insentif per 1x
// pertemuan mengajar, terpisah dari gaji pokok bulanan. Dua konsep beda,
// jangan digabung supaya tidak membingungkan mana yang "gaji" mana yang
// "honor tambahan".
//
// ATURAN HONOR (disepakati dengan kepsek):
//   1. Satu tarif rupiah GLOBAL berlaku untuk semua guru/mapel/kelas (belum
//      ada kebutuhan tarif berbeda per mapel/guru -- kalau nanti perlu,
//      tinggal tambah kolom id_guru/mapel opsional di tarif_honor_mengajar).
//   2. Sesi yang DIHITUNG honornya HANYA sesi yang kehadiran_lengkap = true
//      di absensi_mengajar -- artinya SEMUA siswa aktif di kelas itu sudah
//      tercatat kehadirannya untuk sesi tsb (lihat definisi kolom ini di
//      schema.sql & hitungUlangStatusVerifikasi() di api/mengajar.js).
//      Sesi yang belum lengkap / belum pernah discan TIDAK dihitung.
//   3. Kalau 1 hari ada 3x pertemuan (3 baris di absensi_mengajar yang
//      lolos syarat #2), maka otomatis terhitung 3x tarif -- karena honor
//      dihitung PER BARIS SESI, bukan per hari.
//   4. Tarif terkunci per periode: lihat catatan panjang di schema.sql
//      pada tabel tarif_honor_mengajar. Intinya, honor sebuah sesi TANGGAL
//      X selalu pakai tarif yang berlaku_mulai <= X (yang paling baru di
//      antara yang memenuhi itu) -- bukan tarif yang aktif SEKARANG. Jadi
//      kalau admin menaikkan tarif bulan ini, rekap bulan lalu tidak ikut
//      berubah.
const {
  supabase, generateID, setCors, todayStr, requireAdminToken, resolveGuruIdFromToken
} = require('./_db');

// Aksi yang mengubah data tarif -- dikunci admin saja.
const AKSI_ADMIN_SAJA = new Set(['setTarifHonor', 'hapusTarifHonor']);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, guruToken, ...params } = req.body || {};

  // Tentukan identitas & role dari guruToken (dipakai guru lihat honor diri
  // sendiri, atau kepsek lihat rekap semua guru -- pola sama seperti di
  // api/mengajar.js: adminToken ATAU guruToken dengan role kepsek).
  const guruIdTerverifikasi = guruToken ? await resolveGuruIdFromToken(guruToken) : null;
  let roleTerverifikasi = null;
  if (guruIdTerverifikasi) {
    const { data: g } = await supabase.from('guru').select('role').eq('id', guruIdTerverifikasi).maybeSingle();
    roleTerverifikasi = g ? (g.role || 'guru') : 'guru';
  }
  const adminValid = adminToken ? await requireAdminToken(adminToken) : false;

  if (AKSI_ADMIN_SAJA.has(action) && !adminValid) {
    return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  try {
    if (action === 'getTarifAktif') return res.json(await getTarifAktif());

    if (action === 'getRiwayatTarif') {
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        return res.status(403).json({ success: false, message: 'Tidak punya akses.' });
      }
      return res.json(await getRiwayatTarif());
    }

    if (action === 'setTarifHonor') return res.json(await setTarifHonor(params));
    if (action === 'hapusTarifHonor') return res.json(await hapusTarifHonor(params));

    if (action === 'getRekapHonorGuru') {
      // Sama seperti getRekapKehadiranGuru: admin & kepsek bebas lihat
      // guru manapun; guru cuma boleh lihat dirinya sendiri (dibuktikan
      // lewat guruToken, bukan sekadar idGuru yang dikirim klien).
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        if (!guruIdTerverifikasi || guruIdTerverifikasi !== params.idGuru) {
          return res.status(403).json({ success: false, message: 'Tidak punya akses ke data guru ini.' });
        }
      }
      return res.json(await getRekapHonorGuru(params));
    }

    if (action === 'getRekapHonorSemuaGuru') {
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        return res.status(403).json({ success: false, message: 'Tidak punya akses.' });
      }
      return res.json(await getRekapHonorSemuaGuru(params));
    }

    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── AMBIL SEMUA RIWAYAT TARIF (terurut lama -> baru) ──────────────
async function ambilSemuaTarif() {
  const { data, error } = await supabase
    .from('tarif_honor_mengajar').select('*').order('berlaku_mulai', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// ── CARI TARIF YANG BERLAKU UNTUK 1 TANGGAL ────────────────────────
// Baris dengan berlaku_mulai TERBESAR yang masih <= tanggal. `daftarTarif`
// harus sudah terurut ascending (lihat ambilSemuaTarif). null kalau belum
// ada tarif yang berlaku sama sekali di tanggal itu (misalnya sesi terjadi
// sebelum tarif honor pertama kali diset admin).
function cariTarifBerlaku(daftarTarif, tanggal) {
  let hasil = null;
  for (const t of daftarTarif) {
    const berlaku = String(t.berlaku_mulai).substring(0, 10);
    if (berlaku <= tanggal) hasil = t; else break;
  }
  return hasil;
}

// ── GET TARIF AKTIF (yang berlaku hari ini) ─────────────────────────
async function getTarifAktif() {
  const daftar = await ambilSemuaTarif();
  const today = todayStr();
  const aktif = cariTarifBerlaku(daftar, today);
  if (!aktif) {
    return { success: true, ada: false, message: 'Tarif honor belum pernah diset admin.' };
  }
  return {
    success: true, ada: true,
    nilai: aktif.nilai, berlakuMulai: String(aktif.berlaku_mulai).substring(0, 10),
    keterangan: aktif.keterangan || ''
  };
}

// ── GET RIWAYAT TARIF (untuk halaman admin) ─────────────────────────
async function getRiwayatTarif() {
  const daftar = await ambilSemuaTarif();
  const today = todayStr();
  return {
    success: true,
    riwayat: daftar
      .slice().sort((a, b) => (a.berlaku_mulai < b.berlaku_mulai ? 1 : -1)) // terbaru dulu
      .map(t => ({
        id: t.id, nilai: t.nilai,
        berlakuMulai: String(t.berlaku_mulai).substring(0, 10),
        keterangan: t.keterangan || '', dibuatOleh: t.dibuat_oleh || '',
        statusSaatIni: String(t.berlaku_mulai).substring(0, 10) <= today ? 'Berlaku/Sudah Lewat' : 'Terjadwal (belum berlaku)'
      }))
  };
}

// ── TAMBAH TARIF BARU (admin) ────────────────────────────────────────
async function setTarifHonor({ nilai, berlakuMulai, keterangan, namaAdmin }) {
  const nilaiNum = Number(nilai);
  if (!nilaiNum || nilaiNum <= 0) return { success: false, message: 'Nilai tarif harus lebih dari 0.' };

  const today = todayStr();
  const tanggal = berlakuMulai ? String(berlakuMulai).substring(0, 10) : today;
  // SENGAJA tidak boleh backdate: tarif yang berlaku_mulai-nya sudah lewat
  // tidak boleh diubah/dihapus (lihat catatan di schema.sql) supaya rekap
  // bulan yang sudah tampil ke guru tidak diam-diam berubah. Untuk koreksi
  // tarif yang salah tapi BELUM berlaku, pakai hapusTarifHonor dulu.
  if (tanggal < today) {
    return { success: false, message: 'Tanggal berlaku tidak boleh mundur ke hari yang sudah lewat. Tarif lama yang sudah berjalan tidak boleh diubah retroaktif.' };
  }

  const { error } = await supabase.from('tarif_honor_mengajar').insert({
    id: generateID(), nilai: nilaiNum, berlaku_mulai: tanggal,
    keterangan: keterangan || '', dibuat_oleh: namaAdmin || 'Admin'
  });
  if (error) {
    if (error.code === '23505') {
      return { success: false, message: 'Sudah ada tarif dengan tanggal berlaku yang sama. Pilih tanggal lain atau hapus dulu yang lama (kalau belum berlaku).' };
    }
    return { success: false, message: error.message };
  }
  return { success: true, message: `Tarif Rp${nilaiNum.toLocaleString('id-ID')} per pertemuan disimpan, berlaku mulai ${tanggal}.` };
}

// ── HAPUS TARIF (admin) — HANYA yang belum berlaku (masa depan) ─────
async function hapusTarifHonor({ id }) {
  if (!id) return { success: false, message: 'ID tarif wajib diisi.' };
  const { data: row } = await supabase.from('tarif_honor_mengajar').select('*').eq('id', id).maybeSingle();
  if (!row) return { success: false, message: 'Data tarif tidak ditemukan.' };

  const today = todayStr();
  if (String(row.berlaku_mulai).substring(0, 10) <= today) {
    return { success: false, message: 'Tarif yang sudah berlaku tidak boleh dihapus (supaya histori honor yang sudah dihitung tidak berubah). Tambahkan tarif baru dengan tanggal berlaku hari ini/mendatang kalau ingin mengubahnya.' };
  }
  const { error } = await supabase.from('tarif_honor_mengajar').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Tarif terjadwal berhasil dihapus.' };
}

// ── REKAP HONOR 1 GURU / 1 BULAN ─────────────────────────────────────
async function getRekapHonorGuru({ idGuru, bulan, tahun }) {
  if (!idGuru) return { success: false, message: 'ID guru wajib diisi' };

  const now = new Date();
  const th = Number(tahun) || now.getFullYear();
  const bl = Number(bulan) || (now.getMonth() + 1);

  const { data: guru } = await supabase.from('guru').select('id,nama').eq('id', idGuru).maybeSingle();
  if (!guru) return { success: false, message: 'Guru tidak ditemukan' };

  const jumlahHariDiBulan = new Date(th, bl, 0).getDate();
  const awalBulan = `${th}-${String(bl).padStart(2, '0')}-01`;
  const akhirBulan = `${th}-${String(bl).padStart(2, '0')}-${String(jumlahHariDiBulan).padStart(2, '0')}`;

  const [{ data: sesiHonor }, daftarTarif] = await Promise.all([
    supabase.from('absensi_mengajar').select('*')
      .eq('id_guru', idGuru).eq('kehadiran_lengkap', true)
      .gte('tanggal', awalBulan).lte('tanggal', akhirBulan)
      .order('tanggal', { ascending: false }),
    ambilSemuaTarif()
  ]);

  let totalRupiah = 0;
  let sesiTanpaTarif = 0; // sesi yang terjadi sebelum tarif pertama kali diset
  const rincian = (sesiHonor || []).map(s => {
    const tanggal = String(s.tanggal).substring(0, 10);
    const tarif = cariTarifBerlaku(daftarTarif, tanggal);
    const rupiah = tarif ? tarif.nilai : 0;
    if (!tarif) sesiTanpaTarif++;
    totalRupiah += rupiah;
    return {
      tanggal, hari: s.hari, kelas: s.kelas, mapel: s.mapel,
      jamScan: s.jam_scan, tarifSaatItu: tarif ? tarif.nilai : null, rupiah
    };
  });

  return {
    success: true,
    guru: { id: guru.id, nama: guru.nama },
    bulan: bl, tahun: th,
    totalSesiHonor: rincian.length,
    totalRupiah,
    sesiTanpaTarif, // > 0 berarti ada sesi lengkap tapi belum ada tarif yang berlaku saat itu
    rincian
  };
}

// ── REKAP HONOR SEMUA GURU / 1 BULAN (untuk halaman admin/kepsek) ───
async function getRekapHonorSemuaGuru({ bulan, tahun }) {
  const now = new Date();
  const th = Number(tahun) || now.getFullYear();
  const bl = Number(bulan) || (now.getMonth() + 1);

  const jumlahHariDiBulan = new Date(th, bl, 0).getDate();
  const awalBulan = `${th}-${String(bl).padStart(2, '0')}-01`;
  const akhirBulan = `${th}-${String(bl).padStart(2, '0')}-${String(jumlahHariDiBulan).padStart(2, '0')}`;

  const [{ data: guruList }, { data: sesiHonor }, daftarTarif] = await Promise.all([
    supabase.from('guru').select('id,nama,role').neq('role', 'kepsek').order('nama', { ascending: true }),
    supabase.from('absensi_mengajar').select('id_guru,nama_guru,tanggal')
      .eq('kehadiran_lengkap', true).gte('tanggal', awalBulan).lte('tanggal', akhirBulan),
    ambilSemuaTarif()
  ]);

  const perGuru = {}; // id_guru -> { totalSesi, totalRupiah }
  (sesiHonor || []).forEach(s => {
    const tanggal = String(s.tanggal).substring(0, 10);
    const tarif = cariTarifBerlaku(daftarTarif, tanggal);
    const rupiah = tarif ? tarif.nilai : 0;
    if (!perGuru[s.id_guru]) perGuru[s.id_guru] = { totalSesi: 0, totalRupiah: 0 };
    perGuru[s.id_guru].totalSesi++;
    perGuru[s.id_guru].totalRupiah += rupiah;
  });

  const rekap = (guruList || []).map(g => ({
    idGuru: g.id, nama: g.nama,
    totalSesi: perGuru[g.id]?.totalSesi || 0,
    totalRupiah: perGuru[g.id]?.totalRupiah || 0
  }));

  return {
    success: true, bulan: bl, tahun: th,
    totalRupiahSemuaGuru: rekap.reduce((a, g) => a + g.totalRupiah, 0),
    rekap: rekap.sort((a, b) => b.totalRupiah - a.totalRupiah)
  };
}
