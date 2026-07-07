// api/settings.js — Jam setting, jadwal piket, hari kerja
const { supabase, generateID, setCors, getJamSetting, hariIni, requireAdminToken } = require('./_db');

// Semua aksi "get*" tetap terbuka karena dipakai scan.html secara offline
// (getJamSetting untuk cek jam operasional) dan halaman lain tanpa sesi
// admin. Hanya aksi yang MENGUBAH pengaturan yang dikunci.
const AKSI_TERKUNCI = new Set([
  'updateJamSetting', 'setJadwalPiket',
  'setHariLibur', 'hapusHariLibur', 'updatePengaturanHari',
  'resetPengaturanAplikasi'
]);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, ...params } = req.body || {};

  if (AKSI_TERKUNCI.has(action)) {
    const valid = await requireAdminToken(adminToken);
    if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  try {
    if (action === 'getJamSetting')     return res.json(await getAll());
    if (action === 'updateJamSetting')  return res.json(await updateSetting(params));
    if (action === 'getJadwalPiket')    return res.json(await getJadwalPiket());
    if (action === 'setJadwalPiket')    return res.json(await setJadwalPiket(params));
    if (action === 'getHariKerja')      return res.json(await getHariKerjaKalender(params));
    if (action === 'setHariLibur')      return res.json(await setHariLibur(params));
    if (action === 'hapusHariLibur')    return res.json(await hapusHariLibur(params));
    if (action === 'getConstants')      return res.json(getConstants());
    if (action === 'getGuruPiket')      return res.json(await getGuruPiket());
    if (action === 'getPengaturanHari') return res.json(await getPengaturanHari());
    if (action === 'updatePengaturanHari') return res.json(await updatePengaturanHari(params));
    if (action === 'resetPengaturanAplikasi') return res.json(await resetPengaturanAplikasi());
    if (action === 'getLaporanKepatuhanPiket') return res.json(await getLaporanKepatuhanPiket(params));
    if (action === 'getRiwayatPiketGuru') return res.json(await getRiwayatPiketGuru(params));
    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch(e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// ── GET SEMUA JAM SETTING ─────────────────────────────────────────
async function getAll() {
  try {
    return { success: true, data: await getJamSetting() };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// ── UPDATE JAM SETTING / PROFIL SEKOLAH ──────────────────────────
async function updateSetting({ settings }) {
  const upserts = Object.entries(settings).map(([kunci, nilai]) => ({
    kunci, nilai, deskripsi: ''
  }));
  const { error } = await supabase
    .from('jam_setting')
    .upsert(upserts, { onConflict: 'kunci' });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Pengaturan berhasil disimpan' };
}

// ── JADWAL PIKET ──────────────────────────────────────────────────
async function getJadwalPiket() {
  const { data, error } = await supabase.from('jadwal_piket').select('*');
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(j => ({
      id: j.id, hari: j.hari,
      idGuru: j.id_guru, namaGuru: j.nama_guru, jabatan: j.jabatan
    }))
  };
}

async function setJadwalPiket({ jadwalList }) {
  // Siapkan data dulu sebelum hapus apapun
  const inserts = [];

  for (const j of jadwalList || []) {
    const guruIds = Array.isArray(j.idGuruList)
      ? j.idGuruList
      : [j.idGuru].filter(Boolean);

    for (const idGuru of guruIds) {
      const { data: guru } = await supabase
        .from('guru').select('nama,jabatan').eq('id', idGuru).single();
      if (!guru) continue;
      inserts.push({
        id:        generateID('PK'),
        hari:      j.hari,
        id_guru:   idGuru,
        nama_guru: guru.nama,
        jabatan:   guru.jabatan
      });
    }
  }

  // Baru hapus setelah data siap
  const { error: errDel } = await supabase.from('jadwal_piket').delete().neq('id', 'x');
  if (errDel) return { success: false, message: 'Gagal hapus jadwal lama: ' + errDel.message };

  if (!inserts.length)
    return { success: true, message: 'Jadwal piket dikosongkan' };

  const { error: errIns } = await supabase.from('jadwal_piket').insert(inserts);
  if (errIns) return { success: false, message: 'Gagal simpan jadwal baru: ' + errIns.message };

  return { success: true, message: 'Jadwal piket berhasil disimpan' };
}

// ── HARI KERJA KALENDER (libur nasional per tanggal) ─────────────
// Dipakai oleh halaman Kalender Hari Kerja (klik tanggal = tandai libur)
async function getHariKerjaKalender({ bulan, tahun }) {
  if (!bulan || !tahun)
    return { success: false, message: 'Bulan dan tahun wajib diisi' };

  const start = `${tahun}-${String(bulan).padStart(2, '0')}-01`;
  const end   = `${tahun}-${String(bulan).padStart(2, '0')}-31`;

  const { data, error } = await supabase
    .from('hari_kerja').select('*')
    .gte('tanggal', start).lte('tanggal', end);

  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(h => ({
      tanggal: h.tanggal,
      keterangan: h.keterangan,
      tipe: h.tipe
    }))
  };
}

async function setHariLibur({ tanggal, keterangan }) {
  const { error } = await supabase
    .from('hari_kerja')
    .upsert({ tanggal, keterangan, tipe: 'Libur' }, { onConflict: 'tanggal' });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Hari libur berhasil disimpan' };
}

async function hapusHariLibur({ tanggal }) {
  const { error } = await supabase
    .from('hari_kerja').delete().eq('tanggal', tanggal);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Hari libur berhasil dihapus' };
}

// ── PENGATURAN HARI AKTIF SEKOLAH (Senin s/d Sabtu dst) ──────────
// Dipakai oleh halaman Pengaturan Semester → Hari Sekolah Aktif
async function getPengaturanHari() {
  const urutan = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const { data, error } = await supabase
    .from('pengaturan_hari_kerja').select('*');
  if (error) return { success: false, message: error.message };

  // Jika tabel kosong (pertama kali dipakai / belum pernah diatur admin),
  // JANGAN aktifkan hari apa pun secara default. Admin wajib mencentang
  // sendiri hari sekolah aktif di menu Pengaturan Semester supaya Jadwal
  // Piket (yang mengikuti pengaturan ini) tidak salah asumsi Senin-Jumat.
  if (!data || !data.length) {
    return {
      success: true,
      data: urutan.map(h => ({ hari: h, aktif: false, jamPulangMulai: '', jamPulangSelesai: '' }))
    };
  }

  const sorted = [...data].sort(
    (a, b) => urutan.indexOf(a.hari) - urutan.indexOf(b.hari)
  );
  return {
    success: true,
    data: sorted.map(h => ({
      hari: h.hari,
      aktif: h.aktif,
      // Kosong ("") berarti ikut nilai global di Pengaturan Jam — lihat
      // getJamPulangEfektif() di api/_db.js.
      jamPulangMulai: h.jam_pulang_mulai || '',
      jamPulangSelesai: h.jam_pulang_selesai || ''
    }))
  };
}

async function updatePengaturanHari({ hariList }) {
  if (!hariList || !hariList.length)
    return { success: false, message: 'Data hari kerja kosong' };

  // PENTING: sebelumnya kode ini upsert satu-satu di dalam loop TANPA
  // pernah mengecek hasil error dari Supabase. Kalau upsert gagal (RLS,
  // koneksi, tipe data, dsb.), fungsi ini tetap mengembalikan
  // success:true seolah-olah tersimpan -- padahal tabel di database
  // tidak berubah sama sekali. Efeknya: toast bilang "berhasil
  // disimpan", tapi begitu halaman dibuka lagi, getPengaturanHari()
  // membaca tabel yang ternyata masih kosong, jadi semua centang balik
  // ke tidak aktif lagi. Sekarang upsert dilakukan sekaligus (batch)
  // dan error-nya benar-benar dicek & dilaporkan ke user.
  //
  // jamPulangMulai/jamPulangSelesai: opsional, override jam pulang KHUSUS
  // hari itu (mis. Jumat pulang lebih awal). Dikosongkan/kirim '' berarti
  // ikut nilai global di Pengaturan Jam — disimpan sebagai NULL supaya
  // getJamPulangEfektif() di api/_db.js jatuh ke fallback global.
  const rows = hariList.map(item => ({
    hari: item.hari,
    aktif: item.aktif,
    jam_pulang_mulai: item.jamPulangMulai ? item.jamPulangMulai : null,
    jam_pulang_selesai: item.jamPulangSelesai ? item.jamPulangSelesai : null
  }));
  const { error } = await supabase
    .from('pengaturan_hari_kerja')
    .upsert(rows, { onConflict: 'hari' });

  if (error) {
    return { success: false, message: 'Gagal menyimpan pengaturan hari kerja: ' + error.message };
  }
  return { success: true, message: 'Pengaturan hari kerja berhasil disimpan' };
}

// ── GURU PIKET HARI INI ───────────────────────────────────────────
async function getGuruPiket() {
  // Pakai hariIni() dari _db.js supaya konsisten dengan seluruh sistem (WITA).
  // Sebelumnya fungsi ini menghitung sendiri pakai offset WIB (UTC+7)
  // sehingga bisa beda hari dengan endpoint lain menjelang tengah malam.
  const hari = hariIni();
  const { data } = await supabase
    .from('jadwal_piket').select('id_guru,nama_guru,jabatan').eq('hari', hari);
  return {
    success: true,
    data: (data || []).map(p => ({
      idGuru: p.id_guru, namaGuru: p.nama_guru, jabatan: p.jabatan
    })),
    hari
  };
}

// ── LAPORAN KEPATUHAN PIKET GURU (fitur pengawasan untuk kepsek) ─
// Beda dari getGuruPiket() di atas (yang cuma "siapa piket HARI INI"):
// ini rekap per RENTANG TANGGAL, per guru yang PERNAH terjadwal piket,
// menghitung 4 hal:
//  - hadirTepat          : jumlah hari dia sendiri yang scan piket
//  - digantikan          : jumlah hari dia terjadwal, TAPI guru lain yang
//                          scan (indikasi dia izin/telat dan ada yang
//                          menggantikan)
//  - tanpaPiketSamaSekali: jumlah hari dia terjadwal dan TIDAK ADA
//                          siapapun yang scan piket hari itu (paling
//                          perlu ditindaklanjuti kepsek)
//  - jadiPengganti       : jumlah hari dia BUKAN yang terjadwal, tapi dia
//                          yang scan menggantikan guru lain (menunjukkan
//                          guru yang rajin/sering menutup kekosongan)
// Sengaja dibiarkan TERBUKA (tidak masuk AKSI_TERKUNCI) karena ini murni
// laporan baca, dipakai oleh akun Kepala Sekolah yang tidak punya
// adminToken sama sekali (lihat api/auth.js & schema.sql: kolom
// guru.role) -- disamakan dengan pola getGuruPiket/getJadwalPiket di atas.
async function getLaporanKepatuhanPiket({ tanggalMulai, tanggalSelesai }) {
  if (!tanggalMulai || !tanggalSelesai)
    return { success: false, message: 'Rentang tanggal (tanggalMulai, tanggalSelesai) wajib diisi' };

  const { data: jadwalList, error: eJadwal } = await supabase
    .from('jadwal_piket').select('hari,id_guru,nama_guru');
  if (eJadwal) return { success: false, message: eJadwal.message };

  if (!jadwalList || !jadwalList.length) {
    return { success: true, data: [], message: 'Belum ada jadwal piket yang diatur' };
  }

  const { data: sesiList, error: eSesi } = await supabase
    .from('sesi_piket').select('tanggal,id_guru,nama_guru')
    .gte('tanggal', tanggalMulai).lte('tanggal', tanggalSelesai);
  if (eSesi) return { success: false, message: eSesi.message };

  // Map: nama hari (Senin..Minggu) -> daftar guru terjadwal hari itu
  const jadwalPerHari = {};
  jadwalList.forEach(j => {
    if (!jadwalPerHari[j.hari]) jadwalPerHari[j.hari] = [];
    jadwalPerHari[j.hari].push({ idGuru: j.id_guru, namaGuru: j.nama_guru });
  });

  // Map: tanggal ('YYYY-MM-DD') -> daftar sesi_piket yang tercatat
  const sesiPerTanggal = {};
  (sesiList || []).forEach(s => {
    if (!sesiPerTanggal[s.tanggal]) sesiPerTanggal[s.tanggal] = [];
    sesiPerTanggal[s.tanggal].push(s);
  });

  const namaHari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const rekap = {}; // idGuru -> statistik
  function ambilRekap(idGuru, namaGuru) {
    if (!rekap[idGuru]) {
      rekap[idGuru] = {
        idGuru, namaGuru,
        hadirTepat: 0, digantikan: 0, tanpaPiketSamaSekali: 0, jadiPengganti: 0
      };
    }
    return rekap[idGuru];
  }

  // Iterasi setiap tanggal dalam rentang (dibatasi wajar oleh frontend,
  // biasanya per bulan) supaya bisa dicocokkan dengan hari dalam minggu.
  const cursor = new Date(tanggalMulai + 'T00:00:00Z');
  const akhir  = new Date(tanggalSelesai + 'T00:00:00Z');
  while (cursor <= akhir) {
    const tglStr = cursor.toISOString().split('T')[0];
    const hari   = namaHari[cursor.getUTCDay()];
    const terjadwalHariIni = jadwalPerHari[hari] || [];
    const sesiHariIni      = sesiPerTanggal[tglStr] || [];
    const idTerjadwal      = terjadwalHariIni.map(t => t.idGuru);

    if (terjadwalHariIni.length) {
      terjadwalHariIni.forEach(t => {
        const r = ambilRekap(t.idGuru, t.namaGuru);
        const scanSendiri = sesiHariIni.find(s => s.id_guru === t.idGuru);
        if (scanSendiri) r.hadirTepat++;
        else if (sesiHariIni.length) r.digantikan++;
        else r.tanpaPiketSamaSekali++;
      });

      // Guru yang scan hari itu TAPI tidak termasuk yang terjadwal ->
      // tercatat sebagai pengganti (lihat cekIzinPiket di api/scan.js).
      sesiHariIni.forEach(s => {
        if (!idTerjadwal.includes(s.id_guru)) {
          const r = ambilRekap(s.id_guru, s.nama_guru);
          r.jadiPengganti++;
        }
      });
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const data = Object.values(rekap).sort((a, b) => a.namaGuru.localeCompare(b.namaGuru));
  return { success: true, data, tanggalMulai, tanggalSelesai };
}

// ── RIWAYAT PIKET SAYA (menu akun guru sendiri) ──────────────────
// Beda dari getLaporanKepatuhanPiket() di atas (yang rekap SEMUA guru
// terjadwal, dipakai kepsek): ini rekap satu guru saja (idGuru dari akun
// yang sedang login), dengan RINCIAN PER TANGGAL supaya guru bisa lihat
// persis hari mana dia piket sendiri, hari mana digantikan (dan oleh
// siapa), hari mana kosong, dan hari mana DIA yang jadi penolong
// menggantikan guru lain di luar jadwalnya sendiri.
//
// PENTING soal "siapa guru piket yang benar": sistem ini sengaja dibuat
// fleksibel (lihat cekIzinPiket di api/scan.js) -- kalau guru yang
// TERJADWAL tidak scan, guru lain boleh scan menggantikan setelah lewat
// TOLERANSI_PIKET_MENIT. Jadi "kebenaran lapangan" selalu mengikuti data
// sesi_piket (siapa yang benar-benar scan kartu), BUKAN semata jadwal_piket
// (siapa yang seharusnya piket). Fungsi ini membandingkan keduanya per
// hari, persis prinsip yang sama dipakai getLaporanKepatuhanPiket, hanya
// difokuskan ke satu guru dan dilengkapi rincian harian.
//
// Sengaja TERBUKA (tidak masuk AKSI_TERKUNCI) karena ini laporan baca
// milik guru sendiri, dipanggil dari akun guru yang tidak punya
// adminToken sama sekali -- sama seperti pola getGuruPiket/
// getLaporanKepatuhanPiket di atas. idGuru diambil dari sesi login
// guru di frontend (APP.user.id), bukan input bebas dari form.
async function getRiwayatPiketGuru({ idGuru, tanggalMulai, tanggalSelesai }) {
  if (!idGuru)
    return { success: false, message: 'ID guru wajib diisi' };
  if (!tanggalMulai || !tanggalSelesai)
    return { success: false, message: 'Rentang tanggal (tanggalMulai, tanggalSelesai) wajib diisi' };

  const { data: jadwalList, error: eJadwal } = await supabase
    .from('jadwal_piket').select('hari,id_guru,nama_guru');
  if (eJadwal) return { success: false, message: eJadwal.message };

  // Jangan tampilkan status "Kosong" untuk hari yang belum terjadi --
  // konsisten dengan pengaman yang sama di getRiwayat() pada api/riwayat.js.
  // Tanpa ini, tanggal-tanggal di masa depan (yang tentu saja belum ada
  // guru yang scan) akan ikut ter-loop dan salah disimpulkan "kosong".
  const todayWita = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().substring(0, 10);
  if (tanggalSelesai > todayWita) tanggalSelesai = todayWita;

  const { data: sesiList, error: eSesi } = await supabase
    .from('sesi_piket').select('tanggal,id_guru,nama_guru,jam_scan')
    .gte('tanggal', tanggalMulai).lte('tanggal', tanggalSelesai);
  if (eSesi) return { success: false, message: eSesi.message };

  // Map: nama hari -> daftar guru terjadwal hari itu
  const jadwalPerHari = {};
  (jadwalList || []).forEach(j => {
    if (!jadwalPerHari[j.hari]) jadwalPerHari[j.hari] = [];
    jadwalPerHari[j.hari].push({ idGuru: j.id_guru, namaGuru: j.nama_guru });
  });

  // Map: tanggal -> daftar sesi_piket yang tercatat hari itu
  const sesiPerTanggal = {};
  (sesiList || []).forEach(s => {
    if (!sesiPerTanggal[s.tanggal]) sesiPerTanggal[s.tanggal] = [];
    sesiPerTanggal[s.tanggal].push(s);
  });

  const namaHari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];

  // Hari-hari piket guru ini SESUAI JADWAL ADMIN (jadwal_piket) -- bukan
  // hasil hitung dari sesi_piket, supaya guru bisa lihat jadwal resminya
  // apa adanya, terlepas dari riwayat scan yang sudah terjadi.
  const urutanHari = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const jadwalHariGuru = urutanHari.filter(
    h => (jadwalPerHari[h] || []).some(t => t.idGuru === idGuru)
  );

  const ringkasan = { piketSendiri: 0, digantikan: 0, kosong: 0, jadiPengganti: 0 };
  const detail = [];

  const cursor = new Date(tanggalMulai + 'T00:00:00Z');
  const akhir  = new Date(tanggalSelesai + 'T00:00:00Z');
  while (cursor <= akhir) {
    const tglStr = cursor.toISOString().split('T')[0];
    const hari   = namaHari[cursor.getUTCDay()];
    const terjadwalHariIni = jadwalPerHari[hari] || [];
    const sesiHariIni      = sesiPerTanggal[tglStr] || [];
    const akuTerjadwal     = terjadwalHariIni.some(t => t.idGuru === idGuru);
    const sesiKu           = sesiHariIni.find(s => s.id_guru === idGuru);

    if (akuTerjadwal) {
      if (sesiKu) {
        ringkasan.piketSendiri++;
        detail.push({ tanggal: tglStr, hari, status: 'sendiri', jamScan: sesiKu.jam_scan });
      } else if (sesiHariIni.length) {
        ringkasan.digantikan++;
        detail.push({
          tanggal: tglStr, hari, status: 'digantikan',
          penggantiNama: sesiHariIni.map(s => s.nama_guru).join(', '),
          jamScan: sesiHariIni[0].jam_scan
        });
      } else {
        ringkasan.kosong++;
        detail.push({ tanggal: tglStr, hari, status: 'kosong' });
      }
    } else if (sesiKu) {
      // Aku bukan yang terjadwal hari ini, tapi tetap scan piket -->
      // aku yang menutup kekosongan (guru pengganti di luar jadwal sendiri).
      ringkasan.jadiPengganti++;
      detail.push({
        tanggal: tglStr, hari, status: 'pengganti',
        jamScan: sesiKu.jam_scan,
        digantikanUntuk: terjadwalHariIni.map(t => t.namaGuru).join(', ') || null
      });
    }
    // Hari di mana guru ini tidak terjadwal dan tidak scan sama sekali
    // sengaja TIDAK dimasukkan ke detail -- tidak relevan untuk riwayat
    // piket pribadinya.

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Urutkan terbaru dulu supaya guru langsung lihat hari-hari terakhir.
  detail.sort((a, b) => b.tanggal.localeCompare(a.tanggal));

  return { success: true, ringkasan, detail, tanggalMulai, tanggalSelesai, jadwalHariGuru };
}

// ── CONSTANTS ─────────────────────────────────────────────────────
function getConstants() {
  return {
    success: true,
    jabatanList: [
      'Kepala Sekolah','Wakil Kepala Sekolah','Guru','Wali Kelas',
      'Guru BK','Guru Olahraga','Guru Agama','Staf Tata Usaha',
      'Operator','Kepala Tata Usaha','Pustakawan','Satpam','Petugas Kebersihan'
    ],
    agamaList: ['Islam','Kristen','Katolik','Hindu','Buddha','Konghucu'],
    hariList: ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'],
    kelasList: ['X-1','X-2','X-3','XI-1','XI-2','XI-3','XII-1','XII-2','XII-3']
  };
}

// ── RESET PENGATURAN APLIKASI KE DEFAULT ──────────────────────────
// Mengembalikan 3 hal ke kondisi default seperti saat instalasi pertama
// (lihat schema.sql):
//  1. jam_setting     → jam operasional, toleransi, dan profil sekolah
//  2. pengaturan_hari_kerja → hari sekolah aktif (dikosongkan, jadi
//     otomatis kembali ke default belum ada hari aktif lewat
//     getPengaturanHari(), sampai admin mencentang ulang)
//  3. hari_kerja      → kalender hari libur per tanggal (dikosongkan)
// TIDAK menyentuh jadwal_piket, siswa, guru, absensi, atau semester —
// itu domain reset masing-masing (guru.resetSemua, siswa.resetSemua,
// absensi.resetAbsensi, semester.resetSemua).
async function resetPengaturanAplikasi() {
  const NAMA_SEKOLAH_SEBELUMNYA = (await getJamSetting())['NAMA_SEKOLAH'] || '';

  const defaults = [
    { kunci: 'JAM_DATANG_MULAI',   nilai: '06:30', deskripsi: 'Jam mulai absensi datang' },
    { kunci: 'JAM_DATANG_SELESAI', nilai: '08:00', deskripsi: 'Batas jam datang' },
    { kunci: 'JAM_PULANG_MULAI',   nilai: '14:00', deskripsi: 'Jam mulai absensi pulang' },
    { kunci: 'JAM_PULANG_SELESAI', nilai: '16:00', deskripsi: 'Batas jam absensi pulang' },
    { kunci: 'TOLERANSI_MENIT',    nilai: '15',    deskripsi: 'Toleransi keterlambatan menit' },
    { kunci: 'TOLERANSI_PIKET_MENIT', nilai: '15', deskripsi: 'Menit tunggu sebelum guru pengganti di luar jadwal piket diizinkan scan' },
    // Profil sekolah (nama/alamat/NPSN/dll) SENGAJA tidak ikut direset ke
    // nilai contoh bawaan supaya identitas sekolah yang sudah diisi admin
    // tidak hilang tanpa sengaja hanya karena reset jam operasional.
  ];

  const { error: e1 } = await supabase
    .from('jam_setting')
    .upsert(defaults, { onConflict: 'kunci' });
  if (e1) return { success: false, message: 'Gagal reset jam operasional: ' + e1.message };

  const { error: e2 } = await supabase.from('pengaturan_hari_kerja').delete().neq('hari', 'x');
  if (e2) return { success: false, message: 'Gagal reset hari sekolah aktif: ' + e2.message };

  const { error: e3 } = await supabase.from('hari_kerja').delete().neq('tanggal', '1900-01-01');
  if (e3) return { success: false, message: 'Gagal reset kalender hari libur: ' + e3.message };

  return {
    success: true,
    message: `Jam operasional, hari sekolah aktif (dikembalikan ke belum ada hari aktif, mohon atur ulang di Pengaturan Semester), dan kalender hari libur berhasil direset ke default. Profil sekolah "${NAMA_SEKOLAH_SEBELUMNYA}" tetap dipertahankan.`
  };
}
