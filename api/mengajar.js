// api/mengajar.js — Absensi Mengajar Guru + Verifikasi Kehadiran Siswa per Mapel
//
// FILE BARU, terpisah dari api/scan.js, api/absensi.js, dan api/sync.js yang
// sudah ada. Belum diintegrasikan ke scan.html (itu langkah berikutnya) —
// file ini baru menyediakan endpoint-endpointnya, supaya bisa dites sendiri
// dulu sebelum disambungkan ke alur scan kartu yang sudah berjalan.
//
// PENTING soal gaji: sekolah ini menggaji guru BULANAN (gaji tetap). Data di
// sini BUKAN dasar hitung nominal gaji otomatis -- fungsinya jadi bahan
// pertimbangan keputusan (dashboard kehadiran per guru untuk kepsek/admin,
// dan guru sendiri bisa lihat rekapnya). Makanya action rekap di bawah
// dinamai getRekapKehadiranGuru, bukan "rekap honor".
const {
  supabase, generateID, setCors, todayStr, jamSekarang, hariIni,
  tambahMenit, isHariLibur, isHariKerja, requireAdminToken,
  resolveGuruIdFromToken, getJamSetting, getSemesterAktif,
  generateSesiToken, verifySesiToken, buatResolverJamPelajaran, hitungDefaultJamPelajaran
} = require('./_db');

// Action yang MENGUBAH data master/pengaturan -> wajib admin.
const AKSI_ADMIN_SAJA = new Set([
  'simpanJamPelajaran',
  // BARU: pengecualian jam pelajaran per Hari + Kelas
  'simpanJamPelajaranKelas', 'hapusJamPelajaranKelas',
  'tambahJadwalMengajar', 'editJadwalMengajar', 'hapusJadwalMengajar',
  'importJadwalMengajar', 'resetJadwalMengajarHari',
  'hapusKeteranganMengajar',
  'resetSemua'
]);

const handler = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action, adminToken, guruToken, ...params } = req.body || {};

  // Identitas guru (kalau ada) WAJIB lewat guruToken, sama seperti pola di
  // api/kehadiran.js -- idGuru yang dikirim mentah oleh klien tidak pernah
  // dipakai untuk urusan otorisasi, cuma untuk memilih data mana yang mau
  // dibaca (dan itu pun dibatasi lagi di masing-masing fungsi di bawah).
  const guruIdTerverifikasi = guruToken ? await resolveGuruIdFromToken(guruToken) : null;
  let roleTerverifikasi = null;
  if (guruIdTerverifikasi) {
    const { data: g } = await supabase.from('guru').select('role').eq('id', guruIdTerverifikasi).maybeSingle();
    roleTerverifikasi = g ? (g.role || 'guru') : 'guru';
  }

  if (AKSI_ADMIN_SAJA.has(action)) {
    const valid = await requireAdminToken(adminToken);
    if (!valid) return res.status(401).json({ success: false, message: 'Sesi admin tidak valid. Silakan login ulang.' });
  }

  try {
    if (action === 'getJamPelajaran')       return res.json(await getJamPelajaran(params));
    if (action === 'simpanJamPelajaran')    return res.json(await simpanJamPelajaran(params));
    // BARU: pengecualian jam pelajaran per Hari + Kelas (override di atas jam default)
    if (action === 'simpanJamPelajaranKelas') return res.json(await simpanJamPelajaranKelas(params));
    if (action === 'hapusJamPelajaranKelas')  return res.json(await hapusJamPelajaranKelas(params));

    // BARU: getJadwalMengajar sebelumnya bisa dipanggil siapa saja tanpa
    // otorisasi sama sekali (beda dengan endpoint baca lain di file ini
    // yang sudah membatasi guru hanya lihat data sendiri). Sekarang
    // disamakan: admin/kepsek bebas (dipakai halaman admin "Jadwal
    // Mengajar" utk lihat semua guru), guru wajib kirim idGuru = dirinya
    // sendiri (dipakai halaman "Jadwal Mengajar Saya").
    if (action === 'getJadwalMengajar') {
      const adminValid = await requireAdminToken(adminToken);
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        if (!guruIdTerverifikasi || !params.idGuru || guruIdTerverifikasi !== params.idGuru) {
          return res.status(401).json({ success: false, message: 'Anda hanya bisa melihat jadwal mengajar Anda sendiri.' });
        }
      }
      return res.json(await getJadwalMengajar(params));
    }
    if (action === 'tambahJadwalMengajar')  return res.json(await tambahJadwalMengajar(params));
    if (action === 'editJadwalMengajar')    return res.json(await editJadwalMengajar(params));
    if (action === 'hapusJadwalMengajar')   return res.json(await hapusJadwalMengajar(params));
    if (action === 'importJadwalMengajar')  return res.json(await importJadwalMengajar(params));
    // BARU: reset semua jadwal mengajar utk SATU hari saja (tombol "Reset
    // Jadwal Hari Ini" di tab hari yang sedang aktif)
    if (action === 'resetJadwalMengajarHari') return res.json(await resetJadwalMengajarHari(params));

    if (action === 'scanSesiMengajar')      return res.json(await scanSesiMengajar({ ...params, guruIdTerverifikasi }));
    if (action === 'scanSiswaMapel')        return res.json(await scanSiswaMapel(params));
    if (action === 'selesaiVerifikasi')     return res.json(await selesaiVerifikasi(params));
    // BARU: checklist absensi kelas -- lanjutan setelah ambang verifikasi
    // (MIN_VERIFIKASI_SISWA) terpenuhi. Dilindungi sesiToken yang SAMA
    // dengan scanSiswaMapel/selesaiVerifikasi (lihat verifySesiToken di
    // masing-masing fungsi di bawah), bukan guruToken/adminToken --
    // konsisten dengan pola sesi "terbuka" yang sudah dipakai di kiosk.
    if (action === 'daftarSiswaKelasSesi')  return res.json(await daftarSiswaKelasSesi(params));
    if (action === 'simpanAbsensiKelasManual') return res.json(await simpanAbsensiKelasManual(params));

    if (action === 'inputKeteranganMengajar') {
      // Boleh admin, ATAU guru yang melapor untuk DIRINYA SENDIRI saja
      // (bukan guru lain) -- sesuai keputusan "admin/TU dan guru sendiri".
      const adminValid = await requireAdminToken(adminToken);
      if (!adminValid) {
        if (!guruIdTerverifikasi || guruIdTerverifikasi !== params.idGuru) {
          return res.status(401).json({ success: false, message: 'Hanya admin atau guru yang bersangkutan yang bisa mengisi keterangan ini.' });
        }
      }
      return res.json(await inputKeteranganMengajar({ ...params, diinputOleh: adminValid ? (params.diinputOleh || 'admin') : 'guru' }));
    }
    if (action === 'hapusKeteranganMengajar') return res.json(await hapusKeteranganMengajar(params));

    // ── PERSETUJUAN IZIN/SAKIT — KHUSUS AKUN KEPSEK ──────────────────
    // Sesuai keputusan: "hanya akun kepsek yang akan menyetujui itu" --
    // BUKAN admin, jadi ketiga action ini sengaja TIDAK dimasukkan ke
    // AKSI_ADMIN_SAJA (yang menerima adminToken), melainkan diverifikasi
    // manual di sini lewat roleTerverifikasi (berasal dari guruToken).
    if (action === 'setujuiKeteranganMengajar') {
      if (roleTerverifikasi !== 'kepsek')
        return res.status(401).json({ success: false, message: 'Hanya akun Kepala Sekolah yang bisa menyetujui izin/sakit.' });
      return res.json(await setujuiKeteranganMengajar({ ...params, idKepsek: guruIdTerverifikasi }));
    }
    if (action === 'tolakKeteranganMengajar') {
      if (roleTerverifikasi !== 'kepsek')
        return res.status(401).json({ success: false, message: 'Hanya akun Kepala Sekolah yang bisa menolak izin/sakit.' });
      return res.json(await tolakKeteranganMengajar({ ...params, idKepsek: guruIdTerverifikasi }));
    }
    if (action === 'getKeteranganMenungguPersetujuan') {
      const adminValid = await requireAdminToken(adminToken);
      if (!adminValid && roleTerverifikasi !== 'kepsek')
        return res.status(401).json({ success: false, message: 'Hanya admin atau akun Kepala Sekolah yang bisa melihat daftar ini.' });
      return res.json(await getKeteranganMenungguPersetujuan(params));
    }

    if (action === 'resetSemua')            return res.json(await resetSemua());

    if (action === 'getRekapKehadiranGuru') {
      // Akses: admin (adminToken), kepsek (role kepsek, guru manapun), atau
      // guru itu sendiri (idGuru yang diminta harus sama dengan identitas
      // terverifikasi). Ini persis pola pembatasan yang disepakati:
      // "guru cuma bisa lihat data dirinya sendiri, kepsek/admin bebas".
      const adminValid = await requireAdminToken(adminToken);
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        if (!guruIdTerverifikasi || guruIdTerverifikasi !== params.idGuru) {
          return res.status(401).json({ success: false, message: 'Anda hanya bisa melihat rekap kehadiran Anda sendiri.' });
        }
      }
      return res.json(await getRekapKehadiranGuru(params));
    }

    // BARU: daftar kombinasi mapel+kelas yang diampu guru (dipakai halaman
    // "Riwayat Kehadiran Siswa"), dan detail riwayat+rangkuman kehadiran
    // siswa untuk salah satu kombinasi itu. Otorisasi sama persis dengan
    // getRekapKehadiranGuru di atas: admin/kepsek bebas, guru hanya bisa
    // lihat datanya sendiri.
    if (action === 'getDaftarMapelKelasGuru') {
      const adminValid = await requireAdminToken(adminToken);
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        if (!guruIdTerverifikasi || guruIdTerverifikasi !== params.idGuru) {
          return res.status(401).json({ success: false, message: 'Anda hanya bisa melihat data mengajar Anda sendiri.' });
        }
      }
      return res.json(await getDaftarMapelKelasGuru(params));
    }
    if (action === 'getRekapKehadiranSiswaMapel') {
      const adminValid = await requireAdminToken(adminToken);
      if (!adminValid && roleTerverifikasi !== 'kepsek') {
        if (!guruIdTerverifikasi || guruIdTerverifikasi !== params.idGuru) {
          return res.status(401).json({ success: false, message: 'Anda hanya bisa melihat rekap kehadiran siswa untuk kelas yang Anda ampu sendiri.' });
        }
      }
      return res.json(await getRekapKehadiranSiswaMapel(params));
    }

    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// Export default handler HTTP-nya PERSIS SEPERTI SEBELUMNYA (tidak ada
// yang berubah untuk siapa pun yang memanggil lewat POST /api/mengajar).
// Tambahan di bawah cuma menempelkan beberapa fungsi internal sebagai
// properti pada handler ini, supaya api/scan.js bisa memakainya langsung
// (in-process, tanpa lewat HTTP/guruToken) untuk jalur kiosk guru scan
// kartu -- lihat komentar di scan.js. Ini "tambahan", bukan "modifikasi
// ke jalur lama": scanSesiMengajar/scanSiswaMapel/selesaiVerifikasi di
// bawah SAMA PERSIS dengan yang sudah dites di Langkah A, tidak diubah.
module.exports = handler;
module.exports.scanSesiMengajar = scanSesiMengajar;
module.exports.scanSiswaMapel   = scanSiswaMapel;
module.exports.selesaiVerifikasi = selesaiVerifikasi;
// BARU: diekspor supaya api/guru.js dan api/siswa.js bisa memanggilnya
// langsung (in-process) saat resetSemua guru/siswa, tanpa duplikasi logika
// urutan hapus anak->induk di tabel-tabel mengajar. Lihat komentar di
// resetSemua() di bawah dan di api/guru.js / api/siswa.js.
module.exports.resetSemua = resetSemua;

// ════════════════════════════════════════════════════════════════
// JAM PELAJARAN (master jam ke-1, ke-2, dst per hari)
// ════════════════════════════════════════════════════════════════
async function getJamPelajaran({ hari } = {}) {
  let q = supabase.from('jam_pelajaran').select('*').order('hari').order('jam_ke');
  if (hari) q = q.eq('hari', hari);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(j => ({
      id: j.id, hari: j.hari, jamKe: j.jam_ke,
      jamMulai: j.jam_mulai, jamSelesai: j.jam_selesai,
      // BARU: kelas='' berarti baris default/global (berlaku semua kelas
      // yang tidak punya override sendiri); kelas terisi = override khusus
      // kelas itu saja utk hari ini.
      kelas: j.kelas || ''
    }))
  };
}

// simpanJamPelajaran: upsert banyak baris sekaligus (halaman admin biasanya
// mengatur jam ke-1..ke-N untuk satu hari dalam satu form, lalu simpan semua
// sekaligus). rows: [{ hari, jamKe, jamMulai, jamSelesai }, ...]
//
// BARU: semantik diganti jadi "ganti semua jam pelajaran untuk hari yang
// dikirim" (hapus dulu baris lama utk hari-hari itu, baru insert baris
// baru) -- bukan lagi upsert satu-per-satu per jam-ke. Alasannya dua:
// 1) Kalau admin mengurangi jumlah jam pelajaran (hapus baris terakhir di
//    UI) lalu simpan, cara upsert lama TIDAK PERNAH menghapus baris jam-ke
//    yang sudah tidak ada di form -- baris itu tetap nyangkut di DB
//    selamanya. Cara baru ini otomatis membersihkannya.
// 2) Sekarang jam pelajaran "default" bisa disiarkan ke banyak hari
//    sekaligus dalam satu panggilan (lihat simpanJamPelajaranDefault() di
//    index.html) -- lebih efisien dihapus per-hari dulu baru insert massal,
//    dibanding query cek-lalu-update/insert satu per satu seperti sebelumnya.
//
// BARU (pengecualian per Kelas): fungsi ini SEKARANG HANYA mengelola baris
// DEFAULT (kelas=''). Delete-nya sengaja discope `.eq('kelas', '')` supaya
// TIDAK ikut menghapus baris override per-kelas milik hari yang sama (yang
// dikelola terpisah lewat simpanJamPelajaranKelas() di bawah) -- kalau
// tidak, menyimpan jam default untuk suatu hari akan diam-diam menghapus
// semua pengecualian kelas yang sudah dibuat utk hari itu.
async function simpanJamPelajaran({ rows }) {
  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return { success: false, message: 'Tidak ada data jam pelajaran untuk disimpan' };

  for (const r of rows) {
    if (!r.hari || !r.jamKe || !r.jamMulai || !r.jamSelesai)
      return { success: false, message: 'Setiap baris wajib punya hari, jamKe, jamMulai, jamSelesai' };
  }

  const hariList = [...new Set(rows.map(r => r.hari))];

  const { error: eDel } = await supabase.from('jam_pelajaran').delete().in('hari', hariList).eq('kelas', '');
  if (eDel) return { success: false, message: 'Gagal membersihkan jam pelajaran lama: ' + eDel.message };

  const toInsert = rows.map(r => ({
    id: generateID('JPL'), hari: r.hari, jam_ke: r.jamKe,
    jam_mulai: r.jamMulai, jam_selesai: r.jamSelesai, kelas: ''
  }));
  const { error: eIns } = await supabase.from('jam_pelajaran').insert(toInsert);
  if (eIns) return { success: false, message: 'Gagal simpan jam pelajaran: ' + eIns.message };

  return { success: true, message: 'Jam pelajaran berhasil disimpan' };
}

// ── PENGECUALIAN JAM PELAJARAN PER HARI + KELAS (BARU) ──────────────
// simpanJamPelajaranKelas: sama seperti simpanJamPelajaran (hapus lalu
// insert ulang), tapi DISCOPE ke satu (hari, kelas) tertentu saja -- tidak
// menyentuh baris default maupun override kelas lain di hari yang sama.
// rows: [{ jamKe, jamMulai, jamSelesai }, ...] (hari & kelas dikirim
// terpisah, sama utk semua baris).
async function simpanJamPelajaranKelas({ hari, kelas, rows }) {
  if (!hari || !kelas)
    return { success: false, message: 'Hari dan Kelas wajib diisi' };
  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return { success: false, message: 'Tidak ada data jam pelajaran untuk disimpan' };
  for (const r of rows) {
    if (!r.jamKe || !r.jamMulai || !r.jamSelesai)
      return { success: false, message: 'Setiap baris wajib punya jamKe, jamMulai, jamSelesai' };
  }

  const { error: eDel } = await supabase.from('jam_pelajaran')
    .delete().eq('hari', hari).eq('kelas', kelas);
  if (eDel) return { success: false, message: 'Gagal membersihkan pengecualian lama: ' + eDel.message };

  const toInsert = rows.map(r => ({
    id: generateID('JPL'), hari, jam_ke: r.jamKe,
    jam_mulai: r.jamMulai, jam_selesai: r.jamSelesai, kelas
  }));
  const { error: eIns } = await supabase.from('jam_pelajaran').insert(toInsert);
  if (eIns) return { success: false, message: 'Gagal simpan pengecualian: ' + eIns.message };

  return { success: true, message: `Pengecualian jam untuk ${kelas} di hari ${hari} berhasil disimpan` };
}

// hapusJamPelajaranKelas: hapus semua baris override utk 1 (hari, kelas) --
// kelas itu otomatis kembali memakai jam default hari itu lagi (lewat
// resolver di buatResolverJamPelajaran(), bukan karena baris disalin balik).
async function hapusJamPelajaranKelas({ hari, kelas }) {
  if (!hari || !kelas)
    return { success: false, message: 'Hari dan Kelas wajib diisi' };
  const { error } = await supabase.from('jam_pelajaran')
    .delete().eq('hari', hari).eq('kelas', kelas);
  if (error) return { success: false, message: 'Gagal menghapus pengecualian: ' + error.message };
  return { success: true, message: `Pengecualian untuk ${kelas} di hari ${hari} dihapus, kembali memakai jam default` };
}

// ════════════════════════════════════════════════════════════════
// JADWAL MENGAJAR
// ════════════════════════════════════════════════════════════════
async function getJadwalMengajar({ idGuru, hari, idSemester } = {}) {
  let q = supabase.from('jadwal_mengajar').select('*').order('hari').order('jam_ke_mulai');
  if (idGuru) q = q.eq('id_guru', idGuru);
  if (hari) q = q.eq('hari', hari);
  if (idSemester) q = q.eq('id_semester', idSemester);
  const { data, error } = await q;
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(j => ({
      id: j.id, idGuru: j.id_guru, namaGuru: j.nama_guru, hari: j.hari,
      jamKeMulai: j.jam_ke_mulai, jamKeSelesai: j.jam_ke_selesai,
      kelas: j.kelas, mapel: j.mapel, idSemester: j.id_semester
    }))
  };
}

async function simpanSatuJadwal({ idGuru, hari, jamKeMulai, jamKeSelesai, kelas, mapel, idSemester }) {
  if (!idGuru || !hari || !jamKeMulai || !kelas || !mapel)
    return { error: 'idGuru, hari, jamKeMulai, kelas, dan mapel wajib diisi' };
  const { data: guru } = await supabase.from('guru').select('id,nama').eq('id', idGuru).maybeSingle();
  if (!guru) return { error: `Guru dengan id ${idGuru} tidak ditemukan` };
  return {
    row: {
      id_guru: idGuru, nama_guru: guru.nama, hari,
      jam_ke_mulai: jamKeMulai, jam_ke_selesai: jamKeSelesai || jamKeMulai,
      kelas, mapel, id_semester: idSemester || null
    }
  };
}

async function tambahJadwalMengajar(params) {
  const { error, row } = await simpanSatuJadwal(params);
  if (error) return { success: false, message: error };
  const { error: dbErr } = await supabase.from('jadwal_mengajar').insert({ id: generateID('JM'), ...row });
  if (dbErr) return { success: false, message: dbErr.message };
  return { success: true, message: 'Jadwal mengajar berhasil ditambahkan' };
}

async function editJadwalMengajar({ id, ...params }) {
  if (!id) return { success: false, message: 'ID jadwal wajib diisi' };
  const { error, row } = await simpanSatuJadwal(params);
  if (error) return { success: false, message: error };
  const { error: dbErr } = await supabase.from('jadwal_mengajar').update(row).eq('id', id);
  if (dbErr) return { success: false, message: dbErr.message };
  return { success: true, message: 'Jadwal mengajar berhasil diperbarui' };
}

async function hapusJadwalMengajar({ id }) {
  if (!id) return { success: false, message: 'ID jadwal wajib diisi' };
  const { error } = await supabase.from('jadwal_mengajar').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Jadwal mengajar berhasil dihapus' };
}

// ── RESET JADWAL MENGAJAR PER HARI (BARU) ─────────────────────────
// Dipakai tombol "Reset Jadwal Hari Ini" di tab hari yang sedang aktif
// (menu Jadwal Mengajar Guru) -- hapus SEMUA baris jadwal_mengajar utk 1
// hari itu saja, hari lain tidak tersentuh.
//
// Sama seperti resetSemua() di bawah, urutan hapus WAJIB anak dulu baru
// induk supaya tidak kena FK constraint (kehadiran_siswa_mapel ->
// absensi_mengajar -> jadwal_mengajar, dan keterangan_mengajar ->
// jadwal_mengajar) -- BEDANYA di sini discope ke jadwal_mengajar milik
// hari yang dikirim saja, bukan seluruh tabel. Riwayat absensi/keterangan
// mengajar yang sudah tercatat utk jadwal hari itu (mis. bulan lalu) IKUT
// terhapus -- ini konsekuensi wajar dari "reset jadwal hari ini", sama
// seperti semantik resetSemua() yang sudah ada, jadi sengaja tidak dibuat
// beda perilakunya.
async function resetJadwalMengajarHari({ hari }) {
  if (!hari) return { success: false, message: 'Hari wajib diisi' };

  const { data: jadwalHariIni, error: eSel } = await supabase
    .from('jadwal_mengajar').select('id').eq('hari', hari);
  if (eSel) return { success: false, message: 'Gagal membaca jadwal mengajar: ' + eSel.message };

  const idJadwal = (jadwalHariIni || []).map(j => j.id);
  if (idJadwal.length === 0) {
    return { success: true, message: `Tidak ada jadwal mengajar di hari ${hari} untuk dihapus`, jumlahDihapus: 0 };
  }

  const { data: absensiHariIni, error: eSelAbsensi } = await supabase
    .from('absensi_mengajar').select('id').in('id_jadwal_mengajar', idJadwal);
  if (eSelAbsensi) return { success: false, message: 'Gagal membaca absensi mengajar: ' + eSelAbsensi.message };
  const idAbsensi = (absensiHariIni || []).map(a => a.id);

  if (idAbsensi.length) {
    const { error: e1 } = await supabase.from('kehadiran_siswa_mapel').delete().in('id_absensi_mengajar', idAbsensi);
    if (e1) return { success: false, message: 'Gagal hapus riwayat verifikasi kehadiran siswa per mapel: ' + e1.message };
  }

  const { error: e2 } = await supabase.from('absensi_mengajar').delete().in('id_jadwal_mengajar', idJadwal);
  if (e2) return { success: false, message: 'Gagal hapus riwayat absensi mengajar guru: ' + e2.message };

  const { error: e3 } = await supabase.from('keterangan_mengajar').delete().in('id_jadwal_mengajar', idJadwal);
  if (e3) return { success: false, message: 'Gagal hapus keterangan izin/sakit mengajar: ' + e3.message };

  const { error: e4 } = await supabase.from('jadwal_mengajar').delete().eq('hari', hari);
  if (e4) return { success: false, message: 'Gagal hapus jadwal mengajar: ' + e4.message };

  return {
    success: true,
    message: `Jadwal mengajar hari ${hari} berhasil dihapus (${idJadwal.length} jadwal)`,
    jumlahDihapus: idJadwal.length
  };
}

// importJadwalMengajar: dipanggil setelah frontend parse file Excel jadi
// array baris. Guru dicocokkan lewat NAMA (namaGuru) ATAU nip/username kalau
// dikirim, supaya sekolah bisa export data guru dulu, isi kolom jadwal, lalu
// import balik tanpa perlu tahu id internal. Baris yang gurunya tidak
// ditemukan TIDAK menggagalkan seluruh import -- dilaporkan di `gagal` biar
// admin bisa perbaiki satu-satu, baris yang valid tetap masuk.
async function importJadwalMengajar({ rows }) {
  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return { success: false, message: 'Tidak ada baris untuk diimport' };

  const { data: semuaGuru } = await supabase.from('guru').select('id,nama,nip,username');
  const cariGuru = (r) => {
    if (r.idGuru) return (semuaGuru || []).find(g => g.id === r.idGuru);
    const target = String(r.namaGuru || '').trim().toLowerCase();
    return (semuaGuru || []).find(g =>
      (g.nama || '').trim().toLowerCase() === target ||
      (g.nip && String(g.nip).trim() === String(r.nip || '').trim()) ||
      (g.username && g.username.trim().toLowerCase() === target)
    );
  };

  let berhasil = 0;
  const gagal = [];

  for (const [i, r] of rows.entries()) {
    const guru = cariGuru(r);
    if (!guru) { gagal.push({ baris: i + 1, alasan: `Guru "${r.namaGuru || r.idGuru}" tidak ditemukan` }); continue; }
    if (!r.hari || !r.jamKeMulai || !r.kelas || !r.mapel) {
      gagal.push({ baris: i + 1, alasan: 'Kolom hari/jamKeMulai/kelas/mapel wajib diisi' });
      continue;
    }
    const { error } = await supabase.from('jadwal_mengajar').insert({
      id: generateID('JM'), id_guru: guru.id, nama_guru: guru.nama,
      hari: r.hari, jam_ke_mulai: r.jamKeMulai, jam_ke_selesai: r.jamKeSelesai || r.jamKeMulai,
      kelas: r.kelas, mapel: r.mapel, id_semester: r.idSemester || null
    });
    if (error) gagal.push({ baris: i + 1, alasan: error.message });
    else berhasil++;
  }

  return { success: true, total: rows.length, berhasil, gagal, message: `${berhasil} dari ${rows.length} baris berhasil diimport` };
}

// ════════════════════════════════════════════════════════════════
// SCAN SESI MENGAJAR (guru scan kartu sendiri di kelas)
// ════════════════════════════════════════════════════════════════
// Belum dipanggil dari scan.html (itu langkah integrasi berikutnya). Fungsi
// ini mencari sesi jadwal_mengajar guru yang SEDANG BERLANGSUNG sekarang
// (dicocokkan lewat jam_pelajaran), lalu mencatat absensi_mengajar. Kalau
// tidak ada sesi yang cocok saat ini, ditolak dengan pesan jelas -- bukan
// asal dicatat, sesuai keputusan sebelumnya.
// PERBAIKAN PERFORMA: parameter jamSetting sekarang OPSIONAL. Kalau
// pemanggil (mis. scanKartu di scan.js, yang sudah lebih dulu mengambil
// jamSetting untuk validasi jam operasional) sudah punya nilainya, kirim di
// sini supaya tidak query tabel pengaturan dari nol lagi untuk baca satu
// angka toleransi (TOLERANSI_MENGAJAR_MENIT). Kalau tidak dikirim (mis.
// dipanggil lewat endpoint HTTP /api/mengajar action scanSesiMengajar
// langsung, tanpa lewat scan.js), tetap di-fetch sendiri seperti sebelumnya
// -- tidak ada perilaku yang berubah untuk jalur itu.
async function scanSesiMengajar({ guruIdTerverifikasi, tanggal, jam, hari, jamSetting: jamSettingDikirim }) {
  if (!guruIdTerverifikasi)
    return { success: false, message: 'Identitas guru tidak terverifikasi. Silakan login ulang.' };

  const today = tanggal || todayStr();
  const jamNow = jam || jamSekarang();
  const hariNow = hari || hariIni();

  // PERBAIKAN PERFORMA: isHariLibur dan isHariKerja tidak saling butuh hasil
  // satu sama lain (keduanya cuma perlu `today`/`hariNow` yang sudah ada),
  // jadi dijalankan paralel lewat Promise.all, bukan berurutan seperti
  // sebelumnya. Konsekuensinya: pada hari libur (kasus jarang), isHariKerja
  // tetap ikut ter-query walau akhirnya tidak dipakai (karena sudah ditolak
  // duluan oleh cekLibur.libur) -- pertukaran yang wajar demi memangkas satu
  // round-trip di HARI SEKOLAH BIASA (kasus jauh lebih sering terjadi).
  const [cekLibur, hariAktif] = await Promise.all([
    isHariLibur(today),
    isHariKerja(hariNow)
  ]);
  if (cekLibur.libur) return { success: false, message: `Hari ini libur (${cekLibur.keterangan || '-'})` };
  if (!hariAktif) return { success: false, message: `${hariNow} bukan hari sekolah` };

  // 1. Cari jadwal_mengajar guru ini hari ini DULU (tiap baris sudah punya
  //    kelasnya sendiri), baru resolve jam efektif tiap baris (pakai
  //    pengecualian per Hari+Kelas kalau ada, kalau tidak baru jam
  //    default) dan cek mana yang sedang berlangsung sekarang.
  //
  //    PERBAIKAN (sadar kelas): SEBELUMNYA jam_ke "sekarang" ditentukan
  //    lebih dulu dari jam_pelajaran GLOBAL saja (tanpa tahu kelas), baru
  //    dicocokkan ke jadwal_mengajar guru -- akibatnya pengecualian jam
  //    per kelas (mis. Kamis kelas X-1 pulang lebih cepat) tidak pernah
  //    ikut terpakai di sini, karena kelasnya belum diketahui saat jam_ke
  //    dicari. Sekarang dibalik: kelas didapat lebih dulu dari jadwal
  //    guru, baru jam efektifnya di-resolve.
  const jamSetting = jamSettingDikirim || await getJamSetting();
  const toleransi = Number(jamSetting['TOLERANSI_MENGAJAR_MENIT'] || 15);

  const [{ data: jadwalGuruHariIni }, { data: jamPelajaranSemua }] = await Promise.all([
    supabase.from('jadwal_mengajar').select('*')
      .eq('id_guru', guruIdTerverifikasi).eq('hari', hariNow),
    // BARU: ambil SEMUA hari (bukan cuma .eq('hari', hariNow)) supaya
    // resolveJp() di bawah bisa fallback ke jam default hasil hitung
    // sinyal mayoritas antar-hari (hitungDefaultJamPelajaran()) kalau
    // hari ini kebetulan belum punya baris jam_pelajaran defaultnya
    // sendiri -- lihat catatan lengkap di buatResolverJamPelajaran()
    // (api/_db.js). Ini perbaikan bug: sebelumnya guru yang jadwalnya
    // terlihat benar di form Tambah Jadwal (karena form itu memakai jam
    // default hasil hitung yang sama) tetap gagal absen scan dengan pesan
    // "Bukan jam pelajaran sekarang", karena query di sini HANYA melihat
    // baris literal utk hariNow -- yang ternyata belum pernah disalin ke
    // hari itu (mis. hari baru diaktifkan di Pengaturan Hari Kerja).
    supabase.from('jam_pelajaran').select('hari,jam_ke,jam_mulai,jam_selesai,kelas').order('jam_ke')
  ]);

  if (!jadwalGuruHariIni || jadwalGuruHariIni.length === 0) {
    return { success: false, message: 'Tidak ada jadwal mengajar Anda pada jam ini.' };
  }

  const jamPelajaranHariIni = (jamPelajaranSemua || []).filter(j => j.hari === hariNow);
  const fallbackDefault = hitungDefaultJamPelajaran(jamPelajaranSemua);
  const resolveJp = buatResolverJamPelajaran(jamPelajaranHariIni, fallbackDefault);
  let jadwal = null, jamKeSekarang = null;
  for (const kandidat of jadwalGuruHariIni) {
    const jpMulai = resolveJp(kandidat.jam_ke_mulai, kandidat.kelas);
    const jpSelesai = resolveJp(kandidat.jam_ke_selesai, kandidat.kelas) || jpMulai;
    if (!jpMulai || !jpSelesai) continue;
    if (jamNow >= jpMulai.jam_mulai && jamNow <= tambahMenit(jpSelesai.jam_selesai, toleransi)) {
      jadwal = kandidat; jamKeSekarang = jpMulai; break;
    }
  }

  if (!jadwal) {
    return { success: false, message: 'Bukan jam pelajaran sekarang. Absen mengajar hanya bisa dilakukan saat sesi berlangsung.' };
  }

  // 3. Cek belum pernah scan untuk sesi jadwal ini hari ini (constraint DB
  //    juga menjaga ini, tapi dicek dulu supaya pesannya ramah).
  const { data: sudahAda } = await supabase
    .from('absensi_mengajar').select('id,status,jumlah_siswa_terverifikasi,status_verifikasi')
    .eq('id_jadwal_mengajar', jadwal.id).eq('tanggal', today).maybeSingle();

  if (sudahAda) {
    return {
      success: true, sudahScan: true,
      idAbsensiMengajar: sudahAda.id, status: sudahAda.status,
      jumlahSiswaTerverifikasi: sudahAda.jumlah_siswa_terverifikasi,
      statusVerifikasi: sudahAda.status_verifikasi,
      jadwal: { kelas: jadwal.kelas, mapel: jadwal.mapel },
      message: 'Sesi ini sudah tercatat hari ini.',
      // BARU: sesiToken tetap diterbitkan ulang di sini (bukan cuma saat
      // sesi baru dibuat) supaya kiosk yang reconnect/reload di tengah
      // sesi yang sama tetap dapat token yang sah untuk lanjut verifikasi.
      sesiToken: generateSesiToken(sudahAda.id)
    };
  }

  // Status telat DIHAPUS (sengaja tidak dihitung lagi): selama guru masih
  // bisa scan sama sekali, jam operasional pasti belum selesai (tombol
  // scan absen kelas otomatis disembunyikan begitu jam operasional habis
  // -- lihat scan.html). Jadi begitu ada scan yang tercatat, itu sudah
  // cukup dianggap Hadir mengajar hari itu, tanpa perlu bedakan telat
  // atau tidak.
  const status = 'Hadir';

  const id = generateID('AM');
  const { error } = await supabase.from('absensi_mengajar').insert({
    id, id_jadwal_mengajar: jadwal.id, id_guru: guruIdTerverifikasi,
    nama_guru: jadwal.nama_guru, kelas: jadwal.kelas, mapel: jadwal.mapel,
    tanggal: today, hari: hariNow, jam_scan: jamNow, status,
    jumlah_siswa_terverifikasi: 0, status_verifikasi: 'Perlu Ditinjau', metode: 'online'
  });
  if (error) {
    if (error.code === '23505') {
      return { success: false, message: 'Sesi ini sudah tercatat hari ini (kemungkinan discan dari perangkat lain).' };
    }
    return { success: false, message: 'Gagal simpan absensi mengajar: ' + error.message };
  }

  return {
    success: true, sudahScan: false, idAbsensiMengajar: id, status,
    jadwal: { kelas: jadwal.kelas, mapel: jadwal.mapel },
    message: `Absen mengajar tercatat. Silakan lanjut scan kartu siswa untuk verifikasi kehadiran di kelas.`,
    // BARU: lihat catatan sesiToken di api/_db.js -- ini "tiket" yang wajib
    // dibawa balik saat scanSiswaMapel/selesaiVerifikasi untuk sesi ini.
    sesiToken: generateSesiToken(id)
  };
}

// ════════════════════════════════════════════════════════════════
// VERIFIKASI KEHADIRAN SISWA PER SESI
// ════════════════════════════════════════════════════════════════
async function scanSiswaMapel({ idAbsensiMengajar, idSiswa, sesiToken }) {
  if (!idAbsensiMengajar || !idSiswa)
    return { success: false, message: 'Sesi mengajar dan ID siswa wajib diisi' };

  // BARU: idAbsensiMengajar+idSiswa saja bukan rahasia (bukan qr_token),
  // jadi tanpa ini siapa pun bisa memalsukan verifikasi lewat panggilan
  // API langsung dari luar kiosk. sesiToken cuma diterbitkan oleh
  // scanSesiMengajar yang sah -- lihat catatan lengkap di api/_db.js.
  if (!verifySesiToken(idAbsensiMengajar, sesiToken))
    return { success: false, message: 'Sesi verifikasi tidak valid atau kedaluwarsa. Mulai ulang absen mengajar.' };

  const { data: sesi } = await supabase
    .from('absensi_mengajar').select('*').eq('id', idAbsensiMengajar).maybeSingle();
  if (!sesi) return { success: false, message: 'Sesi mengajar tidak ditemukan' };

  const { data: siswa } = await supabase.from('siswa').select('id,nisn,nama,kelas').eq('id', idSiswa).maybeSingle();
  if (!siswa) return { success: false, message: 'Siswa tidak ditemukan' };

  // PERBAIKAN BUG (verifikasi tidak memfilter kelas): SEBELUMNYA siswa dari
  // KELAS MANAPUN langsung diterima & dihitung sebagai kehadiran untuk
  // sesi kelas ini, selama ID-nya valid -- tidak ada pengecekan sama
  // sekali terhadap sesi.kelas (kelas yang sedang diajar guru itu). Guru
  // yang salah/keliru scan kartu siswa dari kelas lain (atau siswa iseng
  // menyodorkan kartunya sendiri walau bukan kelas yang sedang diajar)
  // akan ikut tercatat terverifikasi hadir di mapel/kelas yang bukan
  // kelasnya -- merusak rekap kehadiran. Sekarang ditolak tegas di sini,
  // SEBELUM sempat insert ke kehadiran_siswa_mapel, dengan pesan yang
  // jelas supaya guru langsung tahu kartu siapa yang salah scan.
  if (siswa.kelas !== sesi.kelas) {
    return {
      success: false,
      message: `${siswa.nama} adalah siswa kelas ${siswa.kelas || '-'} (Tidak sesuai - Verifikasi ditolak)`
    };
  }

  const id = generateID('KS');
  const { error } = await supabase.from('kehadiran_siswa_mapel').insert({
    id, id_absensi_mengajar: idAbsensiMengajar, id_siswa: idSiswa,
    nisn: siswa.nisn, nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal: sesi.tanggal, jam_scan: jamSekarang(), metode: 'online',
    status: 'Hadir'
  });
  if (error) {
    if (error.code === '23505') {
      return { success: false, message: `${siswa.nama} sudah discan untuk sesi ini.` };
    }
    return { success: false, message: error.message };
  }

  const jumlahBaru = await hitungUlangStatusVerifikasi(sesi);

  return { success: true, jumlahSiswaTerverifikasi: jumlahBaru.jumlah, statusVerifikasi: jumlahBaru.status, nama: siswa.nama };
}

// Ambang verifikasi: MIN_VERIFIKASI_SISWA, atau jumlah siswa hadir hari itu
// di kelas tersebut kalau itu lebih kecil (kelas kecil/siswa banyak absen).
async function hitungUlangStatusVerifikasi(sesi) {
  const { count } = await supabase
    .from('kehadiran_siswa_mapel').select('id', { count: 'exact', head: true })
    .eq('id_absensi_mengajar', sesi.id);
  const jumlah = count || 0;

  const jamSetting = await getJamSetting();
  const ambangSetting = Number(jamSetting['MIN_VERIFIKASI_SISWA'] || 5);

  const { count: hadirKelasHariItu } = await supabase
    .from('absensi').select('id', { count: 'exact', head: true })
    .eq('kelas', sesi.kelas).eq('tanggal', sesi.tanggal).not('jam_datang', 'is', null);

  const ambangEfektif = Math.min(ambangSetting, hadirKelasHariItu || ambangSetting);
  const status = jumlah >= ambangEfektif ? 'Terverifikasi' : 'Perlu Ditinjau';

  // BARU: hitung ulang & PERSISTEN-kan kelengkapan absensi kelas (apakah
  // SEMUA siswa aktif sudah tercatat) setiap kali status verifikasi
  // dihitung ulang. Fungsi ini dipanggil dari scanSiswaMapel,
  // simpanAbsensiKelasManual, selesaiVerifikasi -- DAN dari jalur
  // sinkronisasi offline (scanSiswaMapelInternal di api/sync.js), jadi
  // kolom kehadiran_lengkap ikut ter-update juga untuk sesi yang discan
  // sepenuhnya offline. PENTING: ini cuma mencatat status kelengkapan,
  // BUKAN mengganti keharusan checklist -- checklist yang menolak menutup
  // sesi (lihat selesaiVerifikasi) cuma bisa jalan saat online karena
  // butuh daftar siswa real-time dari server. Jadi sesi yang ditutup
  // sepenuhnya offline (tanpa pernah lewat checklist) TETAP bisa lolos
  // tanpa mengisi checklist, TAPI kelihatan "belum lengkap" di rekap
  // admin/guru alih-alih hilang tanpa jejak -- lihat getRekapKehadiranGuru
  // & getRekapKehadiranSiswaMapel yang menampilkan kolom ini.
  const kelengkapan = await cekKelengkapanKehadiranSesi(sesi);

  await supabase.from('absensi_mengajar')
    .update({
      jumlah_siswa_terverifikasi: jumlah, status_verifikasi: status,
      kehadiran_lengkap: kelengkapan.lengkap,
      jumlah_siswa_belum_tercatat: kelengkapan.belum.length
    })
    .eq('id', sesi.id);

  return { jumlah, status, lengkap: kelengkapan.lengkap, belum: kelengkapan.belum };
}

// ════════════════════════════════════════════════════════════════
// CHECKLIST ABSENSI KELAS (BARU) — lanjutan setelah ambang verifikasi
// terpenuhi. Siswa yang TIDAK ikut scan kartu ditampilkan di sini supaya
// guru bisa langsung menandai kehadiran mereka (Hadir/Alpa) atau
// Izin/Sakit, SEKALIAN jadi absensi kehadiran siswa di kelas itu --
// bukan cuma soal verifikasi guru mengajar lagi.
//
// SINKRONISASI (poin penting): Izin/Sakit di sini TIDAK punya tabelnya
// sendiri -- ditulis ke `keterangan_absensi`, tabel PUSAT yang sama
// persis dipakai guru piket (lihat inputKeterangan di api/kehadiran.js)
// dan dibaca di SEMUA rekap/riwayat siswa (dashboard admin di api/
// absensi.js, riwayat siswa di api/riwayat.js, live monitor di api/
// scan.js). Jadi begitu diinput di sini, otomatis ikut muncul di semua
// tempat itu -- tidak ada data ganda/terpisah.
//
// ATURAN "piket duluan": kalau guru piket SUDAH menginput Izin/Sakit
// untuk siswa itu hari ini (baris keterangan_absensi sudah ada), guru
// mengajar TIDAK menimpanya -- daftarSiswaKelasSesi menandai baris itu
// sebagai "sudahDiinputPiket" (read-only di UI), dan simpanAbsensiKelasManual
// menolak status Izin/Sakit baru untuk siswa itu (hanya boleh menyalin
// status yang sudah ada supaya tercatat juga di riwayat sesi ini).
// ════════════════════════════════════════════════════════════════
async function daftarSiswaKelasSesi({ idAbsensiMengajar, sesiToken }) {
  if (!verifySesiToken(idAbsensiMengajar, sesiToken))
    return { success: false, message: 'Sesi verifikasi tidak valid atau kedaluwarsa. Mulai ulang absen mengajar.' };

  const { data: sesi } = await supabase
    .from('absensi_mengajar').select('*').eq('id', idAbsensiMengajar).maybeSingle();
  if (!sesi) return { success: false, message: 'Sesi mengajar tidak ditemukan' };

  const [{ data: siswaKelas }, { data: sudahScan }, { data: keteranganHariIni }] = await Promise.all([
    supabase.from('siswa').select('id,nisn,nama,kelas').eq('kelas', sesi.kelas).eq('status', 'Aktif').order('nama'),
    supabase.from('kehadiran_siswa_mapel').select('id_siswa').eq('id_absensi_mengajar', idAbsensiMengajar),
    supabase.from('keterangan_absensi').select('id_siswa,status,keterangan').eq('tanggal', sesi.tanggal)
  ]);

  const idSudahScan = new Set((sudahScan || []).map(r => r.id_siswa));
  const ketMap = new Map((keteranganHariIni || []).map(k => [k.id_siswa, k]));

  // BARU: sebelumnya siswa yang sudah scan kartu sendiri DIFILTER KELUAR
  // total dari daftar ini -- guru tidak pernah melihat mereka di checklist.
  // Sekarang tetap disertakan (ditandai sudahScanKartu:true) supaya
  // checklist menampilkan SATU daftar lengkap kelas itu: yang masih perlu
  // diisi guru di atas, yang sudah scan kartu read-only di bawah -- guru
  // tidak perlu menebak siapa saja yang sudah/belum tercatat.
  const daftar = (siswaKelas || [])
    .map(s => {
      const ket = ketMap.get(s.id);
      return {
        idSiswa: s.id, nisn: s.nisn, nama: s.nama,
        sudahScanKartu: idSudahScan.has(s.id),
        sudahDiinputPiket: !!ket,
        statusPiket: ket ? ket.status : null,
        keteranganPiket: ket ? (ket.keterangan || '') : ''
      };
    })
    // Urutan tampilan: yang masih wajib diisi guru (belum scan & belum
    // piket) duluan, lalu yang sudah diinput piket (read-only), lalu yang
    // sudah scan kartu sendiri paling akhir (read-only) -- diurutkan di
    // server supaya konsisten walau daftar dimuat ulang.
    .sort((a, b) => {
      const rank = x => x.sudahScanKartu ? 2 : (x.sudahDiinputPiket ? 1 : 0);
      return rank(a) - rank(b);
    });

  return {
    success: true,
    kelas: sesi.kelas, tanggal: sesi.tanggal,
    jumlahSudahScan: idSudahScan.size,
    daftar
  };
}

async function simpanAbsensiKelasManual({ idAbsensiMengajar, sesiToken, entries }) {
  if (!verifySesiToken(idAbsensiMengajar, sesiToken))
    return { success: false, message: 'Sesi verifikasi tidak valid atau kedaluwarsa. Mulai ulang absen mengajar.' };
  if (!Array.isArray(entries) || !entries.length)
    return { success: false, message: 'Tidak ada data siswa untuk disimpan.' };

  const { data: sesi } = await supabase
    .from('absensi_mengajar').select('*').eq('id', idAbsensiMengajar).maybeSingle();
  if (!sesi) return { success: false, message: 'Sesi mengajar tidak ditemukan' };

  const STATUS_VALID = new Set(['Hadir', 'Izin', 'Sakit', 'Alpa']);
  const hasilPerSiswa = [];

  for (const entry of entries) {
    const { idSiswa, status, keterangan } = entry || {};
    if (!idSiswa || !STATUS_VALID.has(status)) {
      hasilPerSiswa.push({ idSiswa, sukses: false, pesan: 'Status tidak valid' });
      continue;
    }

    const { data: siswa } = await supabase.from('siswa').select('id,nisn,nama,kelas').eq('id', idSiswa).maybeSingle();
    if (!siswa) { hasilPerSiswa.push({ idSiswa, sukses: false, pesan: 'Siswa tidak ditemukan' }); continue; }
    if (siswa.kelas !== sesi.kelas) {
      hasilPerSiswa.push({ idSiswa, sukses: false, pesan: `${siswa.nama} bukan siswa kelas ${sesi.kelas}` });
      continue;
    }

    let statusFinal = status, keteranganFinal = keterangan || '';

    if (status === 'Izin' || status === 'Sakit') {
      const { data: ketAda } = await supabase
        .from('keterangan_absensi').select('id,status,keterangan')
        .eq('id_siswa', idSiswa).eq('tanggal', sesi.tanggal).maybeSingle();

      if (ketAda) {
        // Piket/admin sudah input duluan -- IKUTI data itu, jangan
        // ditimpa oleh input guru mengajar (lihat aturan sinkronisasi di
        // komentar atas fungsi daftarSiswaKelasSesi).
        statusFinal = ketAda.status;
        keteranganFinal = ketAda.keterangan || '';
      } else {
        // Belum ada -- guru mengajar yang menginput duluan. Cek dulu
        // siswa belum tercatat hadir fisik pagi ini (sama seperti guard
        // di inputKeterangan/api/kehadiran.js), supaya tidak bikin data
        // yang saling bertentangan (Hadir pagi TAPI Izin/Sakit siang).
        const { data: absenTglIni } = await supabase
          .from('absensi').select('jam_datang,status_datang')
          .eq('id_siswa', idSiswa).eq('tanggal', sesi.tanggal).maybeSingle();
        if (absenTglIni?.jam_datang) {
          hasilPerSiswa.push({
            idSiswa, sukses: false,
            pesan: `${siswa.nama} sudah tercatat ${absenTglIni.status_datang} pagi ini -- tidak bisa ditandai ${status}. Tandai "Hadir" saja untuk sesi ini.`
          });
          continue;
        }
        const { error: eKet } = await supabase.from('keterangan_absensi').upsert({
          id: generateID('KT'), id_siswa: idSiswa, nisn: siswa.nisn, nama_siswa: siswa.nama,
          kelas: siswa.kelas, tanggal: sesi.tanggal, status, keterangan: keteranganFinal,
          diinput_oleh: 'guru_mengajar'
        }, { onConflict: 'id_siswa,tanggal' });
        if (eKet) { hasilPerSiswa.push({ idSiswa, sukses: false, pesan: 'Gagal simpan keterangan: ' + eKet.message }); continue; }
      }
    }

    const { error: eKS } = await supabase.from('kehadiran_siswa_mapel').insert({
      id: generateID('KS'), id_absensi_mengajar: idAbsensiMengajar, id_siswa: idSiswa,
      nisn: siswa.nisn, nama_siswa: siswa.nama, kelas: siswa.kelas,
      tanggal: sesi.tanggal, jam_scan: jamSekarang(), metode: 'manual',
      status: statusFinal, keterangan: keteranganFinal
    });
    if (eKS) {
      if (eKS.code === '23505') {
        hasilPerSiswa.push({ idSiswa, sukses: false, pesan: `${siswa.nama} sudah tercatat untuk sesi ini (mungkin baru saja discan).` });
      } else {
        hasilPerSiswa.push({ idSiswa, sukses: false, pesan: eKS.message });
      }
      continue;
    }

    hasilPerSiswa.push({ idSiswa, sukses: true, status: statusFinal, nama: siswa.nama });
  }

  const jumlahBaru = await hitungUlangStatusVerifikasi(sesi);
  const gagal = hasilPerSiswa.filter(h => !h.sukses);

  return {
    success: true,
    disimpan: hasilPerSiswa.filter(h => h.sukses).length,
    gagal,
    jumlahSiswaTerverifikasi: jumlahBaru.jumlah,
    statusVerifikasi: jumlahBaru.status,
    message: gagal.length
      ? `Tersimpan sebagian (${hasilPerSiswa.length - gagal.length}/${hasilPerSiswa.length}) -- ada ${gagal.length} yang gagal, lihat detail.`
      : 'Absensi kelas berhasil disimpan.'
  };
}

// BARU: cek kelengkapan absensi kelas -- SEMUA siswa AKTIF di kelas sesi ini
// wajib sudah tercatat di kehadiran_siswa_mapel (baik lewat scan kartu
// sendiri MAUPUN checklist manual guru di simpanAbsensiKelasManual) sebelum
// sesi boleh benar-benar ditutup. Ini yang membuat data kehadiran_siswa_mapel
// bisa dipakai sebagai riwayat kehadiran siswa per mapel yang LENGKAP --
// bukan cuma daftar siswa yang kebetulan sempat scan kartu.
async function cekKelengkapanKehadiranSesi(sesi) {
  const [{ data: siswaKelas }, { data: sudahTercatat }] = await Promise.all([
    supabase.from('siswa').select('id,nisn,nama').eq('kelas', sesi.kelas).eq('status', 'Aktif'),
    supabase.from('kehadiran_siswa_mapel').select('id_siswa').eq('id_absensi_mengajar', sesi.id)
  ]);
  const idTercatat = new Set((sudahTercatat || []).map(r => r.id_siswa));
  const belum = (siswaKelas || [])
    .filter(s => !idTercatat.has(s.id))
    .map(s => ({ idSiswa: s.id, nisn: s.nisn, nama: s.nama }));
  return { lengkap: belum.length === 0, totalSiswaKelas: (siswaKelas || []).length, belum };
}

async function selesaiVerifikasi({ idAbsensiMengajar, sesiToken }) {
  if (!verifySesiToken(idAbsensiMengajar, sesiToken))
    return { success: false, message: 'Sesi verifikasi tidak valid atau kedaluwarsa.' };

  const { data: sesi } = await supabase.from('absensi_mengajar').select('*').eq('id', idAbsensiMengajar).maybeSingle();
  if (!sesi) return { success: false, message: 'Sesi mengajar tidak ditemukan' };

  // hitungUlangStatusVerifikasi() sekarang sekalian menghitung & menyimpan
  // kelengkapan (kehadiran_lengkap) -- lihat definisinya. Jadi tidak perlu
  // query cekKelengkapanKehadiranSesi terpisah lagi di sini.
  const hasil = await hitungUlangStatusVerifikasi(sesi);

  // BARU: tolak menutup sesi kalau absensi kelas belum mencakup semua
  // siswa aktif -- kembalikan belumLengkap:true + daftar siswa yang masih
  // kosong, supaya klien (scan.html) membuka kembali checklist absensi
  // kelas alih-alih menutup sesi verifikasi begitu saja.
  if (!hasil.lengkap) {
    return {
      success: true, belumLengkap: true, daftarBelum: hasil.belum,
      jumlahSiswaTerverifikasi: hasil.jumlah, statusVerifikasi: hasil.status,
      message: `Absensi kelas belum lengkap -- masih ada ${hasil.belum.length} siswa yang belum tercatat kehadirannya (scan kartu atau checklist manual). Lengkapi dulu sebelum menutup sesi.`
    };
  }

  return {
    success: true, belumLengkap: false,
    jumlahSiswaTerverifikasi: hasil.jumlah, statusVerifikasi: hasil.status,
    message: hasil.status === 'Terverifikasi'
      ? 'Absensi kelas lengkap & verifikasi selesai, kehadiran terverifikasi.'
      : 'Absensi kelas lengkap, tapi jumlah siswa yang scan kartu sendiri belum memenuhi ambang minimal verifikasi guru. Ditandai "Perlu Ditinjau" untuk dicek admin/kepsek.'
  };
}

// ════════════════════════════════════════════════════════════════
// KETERANGAN MENGAJAR (Izin / Sakit — manual, oleh admin/TU atau guru)
// ════════════════════════════════════════════════════════════════
// PENTING (alur persetujuan): kalau yang menginput adalah guru sendiri
// (diinputOleh === 'guru'), status_persetujuan dimulai sebagai 'Menunggu
// Persetujuan' -- BELUM dihitung final sebagai Izin/Sakit di rekap sampai
// disetujui akun kepsek (lihat getRekapKehadiranGuru). Kalau admin/TU yang
// menginput, dianggap sudah diverifikasi manual sehingga langsung
// 'Disetujui', PERSIS seperti perilaku lama (tidak ada perubahan untuk
// alur admin). Wajib/opsionalnya lampiran bukti diatur admin lewat
// jam_setting BUKTI_IZIN_SAKIT_WAJIB, dan HANYA berlaku untuk guru sendiri.
async function inputKeteranganMengajar({ idJadwalMengajar, idGuru, tanggal, jenis, keterangan, diinputOleh, buktiUrl }) {
  if (!idJadwalMengajar || !tanggal || !jenis)
    return { success: false, message: 'Jadwal, tanggal, dan jenis wajib diisi' };
  if (!['Izin', 'Sakit'].includes(jenis))
    return { success: false, message: 'Jenis harus Izin atau Sakit' };

  const olehGuruSendiri = diinputOleh === 'guru';

  if (olehGuruSendiri) {
    const jamSetting = await getJamSetting();
    const wajibBukti = (jamSetting.BUKTI_IZIN_SAKIT_WAJIB || 'opsional') === 'wajib';
    if (wajibBukti && !buktiUrl)
      return { success: false, message: 'Bukti (foto surat sakit/izin) wajib dilampirkan. Hubungi admin kalau tidak bisa upload.' };
  }

  const statusPersetujuan = olehGuruSendiri ? 'Menunggu Persetujuan' : 'Disetujui';

  const { data: existing } = await supabase
    .from('keterangan_mengajar').select('id')
    .eq('id_jadwal_mengajar', idJadwalMengajar).eq('tanggal', tanggal).maybeSingle();

  if (existing) {
    const { error } = await supabase.from('keterangan_mengajar')
      .update({
        jenis, keterangan: keterangan || '', diinput_oleh: diinputOleh || '',
        bukti_url: buktiUrl || null, status_persetujuan: statusPersetujuan,
        disetujui_oleh: null, disetujui_pada: null, catatan_penolakan: null
      })
      .eq('id', existing.id);
    if (error) return { success: false, message: error.message };
    return {
      success: true,
      message: olehGuruSendiri
        ? 'Keterangan berhasil diperbarui, menunggu persetujuan Kepala Sekolah'
        : 'Keterangan berhasil diperbarui'
    };
  }

  const { error } = await supabase.from('keterangan_mengajar').insert({
    id: generateID('KM'), id_jadwal_mengajar: idJadwalMengajar, id_guru: idGuru || null,
    tanggal, jenis, keterangan: keterangan || '', diinput_oleh: diinputOleh || '',
    bukti_url: buktiUrl || null, status_persetujuan: statusPersetujuan
  });
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    message: olehGuruSendiri
      ? 'Keterangan berhasil disimpan, menunggu persetujuan Kepala Sekolah'
      : 'Keterangan berhasil disimpan'
  };
}

async function hapusKeteranganMengajar({ id }) {
  if (!id) return { success: false, message: 'ID keterangan wajib diisi' };
  const { error } = await supabase.from('keterangan_mengajar').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan berhasil dihapus' };
}

// ── PERSETUJUAN IZIN/SAKIT OLEH KEPSEK ────────────────────────────
async function setujuiKeteranganMengajar({ id, idKepsek }) {
  if (!id) return { success: false, message: 'ID keterangan wajib diisi' };
  const { data: existing } = await supabase.from('keterangan_mengajar').select('id,status_persetujuan').eq('id', id).maybeSingle();
  if (!existing) return { success: false, message: 'Keterangan tidak ditemukan' };
  if (existing.status_persetujuan !== 'Menunggu Persetujuan')
    return { success: false, message: 'Keterangan ini sudah diproses sebelumnya (' + existing.status_persetujuan + ')' };

  const { error } = await supabase.from('keterangan_mengajar').update({
    status_persetujuan: 'Disetujui', disetujui_oleh: idKepsek || null,
    disetujui_pada: new Date().toISOString(), catatan_penolakan: null
  }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Izin/sakit disetujui' };
}

async function tolakKeteranganMengajar({ id, idKepsek, catatan }) {
  if (!id) return { success: false, message: 'ID keterangan wajib diisi' };
  const { data: existing } = await supabase.from('keterangan_mengajar').select('id,status_persetujuan').eq('id', id).maybeSingle();
  if (!existing) return { success: false, message: 'Keterangan tidak ditemukan' };
  if (existing.status_persetujuan !== 'Menunggu Persetujuan')
    return { success: false, message: 'Keterangan ini sudah diproses sebelumnya (' + existing.status_persetujuan + ')' };

  const { error } = await supabase.from('keterangan_mengajar').update({
    status_persetujuan: 'Ditolak', disetujui_oleh: idKepsek || null,
    disetujui_pada: new Date().toISOString(), catatan_penolakan: catatan || ''
  }).eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Izin/sakit ditolak. Sesi ini akan tercatat sebagai Alpa pada rekap kehadiran guru.' };
}

// Daftar semua laporan izin/sakit (dari guru sendiri) yang masih menunggu
// keputusan kepsek -- dipakai halaman "Persetujuan Izin/Sakit". Sengaja
// tidak difilter per guru (kepsek perlu lihat semua guru), diurutkan
// terlama dulu supaya yang sudah lama menunggu tidak tenggelam.
async function getKeteranganMenungguPersetujuan({ status } = {}) {
  const statusFilter = status || 'Menunggu Persetujuan';
  const { data, error } = await supabase
    .from('keterangan_mengajar').select('*, jadwal_mengajar(kelas,mapel,hari,jam_ke_mulai,jam_ke_selesai), guru!id_guru(nama)')
    .eq('status_persetujuan', statusFilter)
    .eq('diinput_oleh', 'guru')
    .order('tanggal', { ascending: true });
  if (error) return { success: false, message: error.message };
  return {
    success: true,
    data: (data || []).map(k => ({
      id: k.id,
      idGuru: k.id_guru,
      namaGuru: k.guru ? k.guru.nama : '-',
      tanggal: k.tanggal,
      jenis: k.jenis,
      keterangan: k.keterangan,
      buktiUrl: k.bukti_url,
      kelas: k.jadwal_mengajar ? k.jadwal_mengajar.kelas : '-',
      mapel: k.jadwal_mengajar ? k.jadwal_mengajar.mapel : '-',
      hari: k.jadwal_mengajar ? k.jadwal_mengajar.hari : '-',
      jamKeMulai: k.jadwal_mengajar ? k.jadwal_mengajar.jam_ke_mulai : null,
      jamKeSelesai: k.jadwal_mengajar ? k.jadwal_mengajar.jam_ke_selesai : null,
      diajukanPada: k.created_at
    }))
  };
}

// ── RESET SEMUA DATA JADWAL & ABSENSI MENGAJAR ────────────────────
// Sebelumnya menu "Reset Data" tidak punya kartu untuk fitur mengajar
// sama sekali -- jadwal_mengajar, jam_pelajaran, absensi_mengajar,
// kehadiran_siswa_mapel, dan keterangan_mengajar tidak pernah ikut
// terhapus lewat Reset Absensi/Siswa/Guru/Semester/Total manapun.
// Urutan hapus WAJIB anak dulu baru induk (sama pola dengan
// resetSemua() di api/guru.js untuk sesi_piket->guru):
//   kehadiran_siswa_mapel  -> punya id_absensi_mengajar (FK ke absensi_mengajar)
//   absensi_mengajar       -> punya id_guru (FK ke guru)
//   keterangan_mengajar    -> punya id_jadwal_mengajar (FK ke jadwal_mengajar)
//   jadwal_mengajar        -> punya id_guru (FK ke guru)
//   jam_pelajaran          -> tidak ada FK ke tabel lain, aman dihapus kapan saja
// Fungsi ini dipakai berdiri sendiri (kartu "Reset Jadwal Mengajar") MAUPUN
// dipanggil ulang secara implisit lewat resetSemua() di guru.js/siswa.js/
// resetAbsensi() di absensi.js -- aman dijalankan berkali-kali (idempotent,
// delete ke tabel yang sudah kosong tidak menghasilkan error).
async function resetSemua() {
  const { error: e1 } = await supabase.from('kehadiran_siswa_mapel').delete().neq('id', 'x');
  if (e1) return { success: false, message: 'Gagal hapus riwayat verifikasi kehadiran siswa per mapel: ' + e1.message };

  const { error: e2 } = await supabase.from('absensi_mengajar').delete().neq('id', 'x');
  if (e2) return { success: false, message: 'Gagal hapus riwayat absensi mengajar guru: ' + e2.message };

  const { error: e3 } = await supabase.from('keterangan_mengajar').delete().neq('id', 'x');
  if (e3) return { success: false, message: 'Gagal hapus keterangan izin/sakit mengajar: ' + e3.message };

  const { error: e4 } = await supabase.from('jadwal_mengajar').delete().neq('id', 'x');
  if (e4) return { success: false, message: 'Gagal hapus jadwal mengajar: ' + e4.message };

  const { error: e5 } = await supabase.from('jam_pelajaran').delete().neq('id', 'x');
  if (e5) return { success: false, message: 'Gagal hapus jam pelajaran: ' + e5.message };

  return {
    success: true,
    message: 'Semua jadwal mengajar, jam pelajaran, riwayat absensi mengajar guru, dan riwayat verifikasi kehadiran siswa per mapel berhasil dihapus'
  };
}

// ════════════════════════════════════════════════════════════════
// REKAP / DASHBOARD KEHADIRAN GURU (per bulan)
// ════════════════════════════════════════════════════════════════
// Alpa TIDAK disimpan sebagai baris di database -- dihitung di sini dengan
// membandingkan semua sesi yang SEHARUSNYA ada (jadwal_mengajar x tanggal
// dalam bulan itu, dikurangi hari libur) terhadap absensi_mengajar (yang
// benar-benar discan) dan keterangan_mengajar (Izin/Sakit yang dilaporkan).
// Hanya tanggal sampai HARI INI yang dihitung -- sesi di masa depan (bulan
// berjalan yang belum lewat) tidak mungkin "Alpa" karena belum terjadi.
async function getRekapKehadiranGuru({ idGuru, bulan, tahun }) {
  if (!idGuru) return { success: false, message: 'ID guru wajib diisi' };

  const now = new Date();
  const th = Number(tahun) || now.getFullYear();
  const bl = Number(bulan) || (now.getMonth() + 1); // 1-12

  const { data: guru } = await supabase.from('guru').select('id,nama').eq('id', idGuru).maybeSingle();
  if (!guru) return { success: false, message: 'Guru tidak ditemukan' };

  const { data: jadwalGuru } = await supabase.from('jadwal_mengajar').select('*').eq('id_guru', idGuru);
  if (!jadwalGuru || jadwalGuru.length === 0) {
    return {
      success: true, guru: { id: guru.id, nama: guru.nama }, bulan: bl, tahun: th,
      totalSesiTerjadwal: 0, totalHadir: 0, totalIzin: 0, totalSakit: 0, totalAlpa: 0, totalMenunggu: 0,
      persentaseKehadiran: null, rincian: [], tren: [],
      message: 'Guru ini belum punya jadwal mengajar.'
    };
  }
  const jadwalPerHari = {};
  jadwalGuru.forEach(j => { (jadwalPerHari[j.hari] = jadwalPerHari[j.hari] || []).push(j); });

  const today = todayStr();
  const hariNamaList = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const jumlahHariDiBulan = new Date(th, bl, 0).getDate();
  const awalBulan = `${th}-${String(bl).padStart(2,'0')}-01`;
  const akhirBulan = `${th}-${String(bl).padStart(2,'0')}-${String(jumlahHariDiBulan).padStart(2,'0')}`;
  let batasAwal = awalBulan;
  let batasAkhir = akhirBulan < today ? akhirBulan : today; // jangan hitung tanggal yang belum lewat

  // PERBAIKAN: sesi HANYA mungkin ada di dalam periode semester (di luar itu
  // scan absen memang ditolak sistem -- lihat absensi.js/scan.js/sync.js).
  // Sebelumnya rekap ini mulai menghitung dari tanggal 1 di bulan itu tanpa
  // peduli semester baru mulai tanggal berapa, sehingga hari-hari sebelum
  // semester aktif (yang memang tidak mungkin diabsen) ikut dihitung sebagai
  // sesi terjadwal dan salah jatuh sebagai "Alpa". Sempitkan rentang ke
  // irisan dengan semester yang berlaku pada bulan tsb.
  const { data: semesterOverlap } = await supabase
    .from('semester').select('tanggal_mulai,tanggal_selesai')
    .lte('tanggal_mulai', akhirBulan).gte('tanggal_selesai', awalBulan);
  if (semesterOverlap && semesterOverlap.length > 0) {
    const tglMulaiSemester = semesterOverlap
      .map(s => String(s.tanggal_mulai).substring(0, 10))
      .sort()[0];
    const tglSelesaiSemester = semesterOverlap
      .map(s => String(s.tanggal_selesai).substring(0, 10))
      .sort().slice(-1)[0];
    if (tglMulaiSemester > batasAwal) batasAwal = tglMulaiSemester;
    if (tglSelesaiSemester < batasAkhir) batasAkhir = tglSelesaiSemester;
  } else {
    // Tidak ada semester yang mencakup bulan ini sama sekali -> tidak ada
    // sesi yang seharusnya terjadi (sistem menolak absen tanpa semester aktif).
    batasAwal = akhirBulan; batasAkhir = awalBulan; // range kosong (awal > akhir)
  }

  // Ambil sekali semua absensi_mengajar & keterangan_mengajar guru ini dalam
  // rentang bulan, supaya tidak query per-tanggal (bisa puluhan kali).
  const { data: absensiBulan } = await supabase
    .from('absensi_mengajar').select('*')
    .eq('id_guru', idGuru).gte('tanggal', awalBulan).lte('tanggal', akhirBulan);
  const { data: keteranganBulan } = await supabase
    .from('keterangan_mengajar').select('*')
    .eq('id_guru', idGuru).gte('tanggal', awalBulan).lte('tanggal', akhirBulan);

  const absensiMap = {};   // key: id_jadwal_mengajar|tanggal
  (absensiBulan || []).forEach(a => { absensiMap[`${a.id_jadwal_mengajar}|${a.tanggal}`] = a; });
  const keteranganMap = {};
  (keteranganBulan || []).forEach(k => { keteranganMap[`${k.id_jadwal_mengajar}|${k.tanggal}`] = k; });

  let totalSesiTerjadwal = 0, totalHadir = 0, totalIzin = 0, totalSakit = 0, totalAlpa = 0, totalMenunggu = 0;
  const rincian = [];
  const trenMap = {}; // per tanggal: { hadir, izin, sakit, alpa }

  for (let d = 1; d <= jumlahHariDiBulan; d++) {
    const tanggal = `${th}-${String(bl).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (tanggal < batasAwal) continue; // sebelum semester mulai -> belum ada sesi
    if (tanggal > batasAkhir) break; // belum terjadi / sudah lewat akhir semester

    const cekLibur = await isHariLibur(tanggal);
    if (cekLibur.libur) continue; // hari libur dikecualikan sama sekali

    const namaHari = hariNamaList[new Date(tanggal + 'T00:00:00').getDay()];
    if (!(await isHariKerja(namaHari))) continue;

    const jadwalHariItu = jadwalPerHari[namaHari] || [];
    for (const j of jadwalHariItu) {
      totalSesiTerjadwal++;
      const key = `${j.id}|${tanggal}`;
      const absen = absensiMap[key];
      const ket = keteranganMap[key];
      trenMap[tanggal] = trenMap[tanggal] || { hadir: 0, izin: 0, sakit: 0, alpa: 0 };

      // PENTING (alur persetujuan): keterangan izin/sakit yang diinput GURU
      // SENDIRI belum tentu final -- statusnya bisa 'Menunggu Persetujuan'
      // (belum diputuskan kepsek, JANGAN dihitung sebagai Izin/Sakit ATAUPUN
      // Alpa dulu), 'Ditolak' (dihitung Alpa, karena kepsek menganggap
      // laporannya tidak valid), atau 'Disetujui' (dihitung Izin/Sakit
      // seperti biasa). Keterangan yang diinput admin/TU statusnya sudah
      // langsung 'Disetujui' sejak awal (lihat inputKeteranganMengajar),
      // jadi perilaku lama untuk jalur admin tidak berubah sama sekali.
      let statusFinal;
      if (absen) {
        // Status telat sudah dihapus dari sistem (lihat catatan di
        // scanAbsenMengajar): entri lama yang kebetulan masih tercatat
        // 'Telat' di database tetap dihitung sebagai Hadir, supaya
        // riwayat lama tidak menampilkan status yang sudah tidak dipakai.
        statusFinal = 'Hadir';
        totalHadir++; trenMap[tanggal].hadir++;
      } else if (ket && ket.status_persetujuan === 'Menunggu Persetujuan') {
        statusFinal = 'Menunggu Persetujuan';
        totalMenunggu++;
      } else if (ket && ket.status_persetujuan === 'Disetujui') {
        statusFinal = ket.jenis;
        if (ket.jenis === 'Izin') { totalIzin++; trenMap[tanggal].izin++; }
        else { totalSakit++; trenMap[tanggal].sakit++; }
      } else if (ket && ket.status_persetujuan === 'Ditolak') {
        statusFinal = 'Alpa';
        totalAlpa++; trenMap[tanggal].alpa++;
      } else {
        statusFinal = 'Alpa';
        totalAlpa++; trenMap[tanggal].alpa++;
      }

      rincian.push({
        tanggal, hari: namaHari, kelas: j.kelas, mapel: j.mapel,
        idJadwalMengajar: j.id,
        jamKeMulai: j.jam_ke_mulai, jamKeSelesai: j.jam_ke_selesai,
        status: statusFinal,
        jamScan: absen ? absen.jam_scan : null,
        statusVerifikasi: absen ? absen.status_verifikasi : null,
        jumlahSiswaTerverifikasi: absen ? absen.jumlah_siswa_terverifikasi : null,
        // BARU: apakah absensi kelas sesi ini sudah mencakup semua siswa
        // aktif -- null kalau sesi ini memang belum pernah discan sama
        // sekali (absen === null), false kalau sudah discan tapi masih ada
        // siswa yang belum tercatat (termasuk sesi yang ditutup lewat
        // sinkronisasi offline tanpa sempat lewat checklist).
        kehadiranLengkap: absen ? absen.kehadiran_lengkap : null,
        jumlahSiswaBelumTercatat: absen ? absen.jumlah_siswa_belum_tercatat : null,
        keteranganText: ket ? ket.keterangan : null,
        statusPersetujuan: ket ? ket.status_persetujuan : null,
        buktiUrl: ket ? ket.bukti_url : null,
        catatanPenolakan: ket ? ket.catatan_penolakan : null
      });
    }
  }

  const dibayarSesiCount = totalHadir;
  const persentaseKehadiran = totalSesiTerjadwal > 0
    ? Math.round((dibayarSesiCount / totalSesiTerjadwal) * 1000) / 10
    : null;

  return {
    success: true,
    guru: { id: guru.id, nama: guru.nama },
    bulan: bl, tahun: th,
    totalSesiTerjadwal, totalHadir, totalIzin, totalSakit, totalAlpa, totalMenunggu,
    persentaseKehadiran,
    rincian: rincian.sort((a, b) => a.tanggal < b.tanggal ? 1 : -1), // terbaru dulu
    tren: Object.keys(trenMap).sort().map(tgl => ({ tanggal: tgl, ...trenMap[tgl] }))
  };
}

// ════════════════════════════════════════════════════════════════
// RIWAYAT & REKAP KEHADIRAN SISWA PER MAPEL/KELAS (BARU) — dipakai halaman
// "Riwayat Kehadiran Siswa" di akun guru. Kalau seorang guru mengampu LEBIH
// DARI 1 mapel (atau mapel yang sama di kelas berbeda), data SENGAJA
// dipisah per kombinasi mapel+kelas (bukan digabung semua) supaya riwayat
// kehadirannya jelas -- lihat getDaftarMapelKelasGuru untuk daftar
// kombinasinya, lalu getRekapKehadiranSiswaMapel untuk detail salah satu
// kombinasi yang dipilih.
// ════════════════════════════════════════════════════════════════
async function getDaftarMapelKelasGuru({ idGuru }) {
  if (!idGuru) return { success: false, message: 'ID guru wajib diisi' };
  const { data, error } = await supabase.from('jadwal_mengajar').select('mapel,kelas').eq('id_guru', idGuru);
  if (error) return { success: false, message: error.message };

  const map = new Map();
  (data || []).forEach(j => {
    const key = `${j.mapel}||${j.kelas}`;
    if (!map.has(key)) map.set(key, { mapel: j.mapel, kelas: j.kelas });
  });
  const daftar = Array.from(map.values())
    .sort((a, b) => a.mapel.localeCompare(b.mapel) || a.kelas.localeCompare(b.kelas));

  return { success: true, daftar };
}

// Riwayat tiap pertemuan (lengkap dengan detail kehadiran per siswa) PLUS
// rangkuman total kehadiran per siswa, untuk satu kombinasi guru+mapel+kelas.
// bulan/tahun opsional -- kalau tidak dikirim, seluruh riwayat yang ada
// dikembalikan (guru biasanya cuma mengampu 1-2 mapel/kelas jadi datanya
// tidak sebesar rekap kehadiran guru bulanan).
async function getRekapKehadiranSiswaMapel({ idGuru, mapel, kelas, bulan, tahun }) {
  if (!idGuru || !mapel || !kelas)
    return { success: false, message: 'idGuru, mapel, dan kelas wajib diisi' };

  const { data: guru } = await supabase.from('guru').select('id,nama').eq('id', idGuru).maybeSingle();
  if (!guru) return { success: false, message: 'Guru tidak ditemukan' };

  let q = supabase.from('absensi_mengajar').select('*')
    .eq('id_guru', idGuru).eq('mapel', mapel).eq('kelas', kelas)
    .order('tanggal', { ascending: false });
  if (bulan && tahun) {
    const th = Number(tahun), bl = Number(bulan);
    const jumlahHari = new Date(th, bl, 0).getDate();
    q = q.gte('tanggal', `${th}-${String(bl).padStart(2, '0')}-01`)
         .lte('tanggal', `${th}-${String(bl).padStart(2, '0')}-${String(jumlahHari).padStart(2, '0')}`);
  }
  const { data: sesiList, error } = await q;
  if (error) return { success: false, message: error.message };

  if (!sesiList || sesiList.length === 0) {
    return {
      success: true, guru: { id: guru.id, nama: guru.nama }, mapel, kelas,
      totalPertemuan: 0, pertemuan: [], rangkumanSiswa: [],
      message: 'Belum ada sesi mengajar tercatat untuk mapel & kelas ini.'
    };
  }

  const idSesiList = sesiList.map(s => s.id);
  const { data: semuaKehadiran } = await supabase
    .from('kehadiran_siswa_mapel').select('*').in('id_absensi_mengajar', idSesiList);

  const kehadiranPerSesi = {};
  (semuaKehadiran || []).forEach(k => {
    (kehadiranPerSesi[k.id_absensi_mengajar] = kehadiranPerSesi[k.id_absensi_mengajar] || []).push(k);
  });

  const rekapSiswa = new Map(); // idSiswa -> akumulator
  const pertemuan = sesiList.map(sesi => {
    const daftar = (kehadiranPerSesi[sesi.id] || [])
      .sort((a, b) => (a.nama_siswa || '').localeCompare(b.nama_siswa || ''));

    daftar.forEach(k => {
      if (!rekapSiswa.has(k.id_siswa)) {
        rekapSiswa.set(k.id_siswa, {
          idSiswa: k.id_siswa, nisn: k.nisn, nama: k.nama_siswa,
          hadir: 0, izin: 0, sakit: 0, alpa: 0, total: 0
        });
      }
      const r = rekapSiswa.get(k.id_siswa);
      r.total++;
      if (k.status === 'Hadir') r.hadir++;
      else if (k.status === 'Izin') r.izin++;
      else if (k.status === 'Sakit') r.sakit++;
      else if (k.status === 'Alpa') r.alpa++;
    });

    return {
      idAbsensiMengajar: sesi.id, tanggal: sesi.tanggal, hari: sesi.hari,
      jamScan: sesi.jam_scan, statusVerifikasi: sesi.status_verifikasi,
      jumlahSiswaTerverifikasi: sesi.jumlah_siswa_terverifikasi,
      // BARU: kelengkapan absensi kelas pertemuan ini -- lihat catatan di
      // hitungUlangStatusVerifikasi() di api/mengajar.js. Kalau false,
      // riwayat pertemuan ini kemungkinan tidak mencakup semua siswa
      // (misalnya sesi yang ditutup lewat sinkronisasi offline).
      kehadiranLengkap: sesi.kehadiran_lengkap,
      jumlahSiswaBelumTercatat: sesi.jumlah_siswa_belum_tercatat,
      jumlahTercatat: daftar.length,
      daftarKehadiran: daftar.map(k => ({
        idSiswa: k.id_siswa, nisn: k.nisn, nama: k.nama_siswa,
        status: k.status, keterangan: k.keterangan, jamScan: k.jam_scan, metode: k.metode
      }))
    };
  });

  const rangkumanSiswa = Array.from(rekapSiswa.values())
    .map(r => ({ ...r, persentaseHadir: r.total > 0 ? Math.round((r.hadir / r.total) * 1000) / 10 : null }))
    .sort((a, b) => a.nama.localeCompare(b.nama));

  return {
    success: true, guru: { id: guru.id, nama: guru.nama }, mapel, kelas,
    totalPertemuan: pertemuan.length, pertemuan, rangkumanSiswa
  };
}
