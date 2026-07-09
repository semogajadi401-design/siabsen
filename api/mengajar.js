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
  resolveGuruIdFromToken, getJamSetting
} = require('./_db');

// Action yang MENGUBAH data master/pengaturan -> wajib admin.
const AKSI_ADMIN_SAJA = new Set([
  'simpanJamPelajaran',
  'tambahJadwalMengajar', 'editJadwalMengajar', 'hapusJadwalMengajar',
  'importJadwalMengajar',
  'hapusKeteranganMengajar'
]);

module.exports = async (req, res) => {
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

    if (action === 'getJadwalMengajar')     return res.json(await getJadwalMengajar(params));
    if (action === 'tambahJadwalMengajar')  return res.json(await tambahJadwalMengajar(params));
    if (action === 'editJadwalMengajar')    return res.json(await editJadwalMengajar(params));
    if (action === 'hapusJadwalMengajar')   return res.json(await hapusJadwalMengajar(params));
    if (action === 'importJadwalMengajar')  return res.json(await importJadwalMengajar(params));

    if (action === 'scanSesiMengajar')      return res.json(await scanSesiMengajar({ ...params, guruIdTerverifikasi }));
    if (action === 'scanSiswaMapel')        return res.json(await scanSiswaMapel(params));
    if (action === 'selesaiVerifikasi')     return res.json(await selesaiVerifikasi(params));

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

    return res.status(400).json({ success: false, message: 'Action tidak dikenal' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

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
      jamMulai: j.jam_mulai, jamSelesai: j.jam_selesai
    }))
  };
}

// simpanJamPelajaran: upsert banyak baris sekaligus (halaman admin biasanya
// mengatur jam ke-1..ke-N untuk satu hari dalam satu form, lalu simpan semua
// sekaligus). rows: [{ hari, jamKe, jamMulai, jamSelesai }, ...]
async function simpanJamPelajaran({ rows }) {
  if (!rows || !Array.isArray(rows) || rows.length === 0)
    return { success: false, message: 'Tidak ada data jam pelajaran untuk disimpan' };

  for (const r of rows) {
    if (!r.hari || !r.jamKe || !r.jamMulai || !r.jamSelesai)
      return { success: false, message: 'Setiap baris wajib punya hari, jamKe, jamMulai, jamSelesai' };
  }

  for (const r of rows) {
    const { data: existing } = await supabase
      .from('jam_pelajaran').select('id')
      .eq('hari', r.hari).eq('jam_ke', r.jamKe).maybeSingle();

    if (existing) {
      const { error } = await supabase.from('jam_pelajaran')
        .update({ jam_mulai: r.jamMulai, jam_selesai: r.jamSelesai })
        .eq('id', existing.id);
      if (error) return { success: false, message: error.message };
    } else {
      const { error } = await supabase.from('jam_pelajaran').insert({
        id: generateID('JPL'), hari: r.hari, jam_ke: r.jamKe,
        jam_mulai: r.jamMulai, jam_selesai: r.jamSelesai
      });
      if (error) return { success: false, message: error.message };
    }
  }
  return { success: true, message: 'Jam pelajaran berhasil disimpan' };
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
async function scanSesiMengajar({ guruIdTerverifikasi, tanggal, jam, hari }) {
  if (!guruIdTerverifikasi)
    return { success: false, message: 'Identitas guru tidak terverifikasi. Silakan login ulang.' };

  const today = tanggal || todayStr();
  const jamNow = jam || jamSekarang();
  const hariNow = hari || hariIni();

  const cekLibur = await isHariLibur(today);
  if (cekLibur.libur) return { success: false, message: `Hari ini libur (${cekLibur.keterangan || '-'})` };
  if (!(await isHariKerja(hariNow))) return { success: false, message: `${hariNow} bukan hari sekolah` };

  // 1. Cari semua jam_pelajaran hari ini yang jam_mulai <= sekarang <= jam_selesai + toleransi
  const jamSetting = await getJamSetting();
  const toleransi = Number(jamSetting['TOLERANSI_MENGAJAR_MENIT'] || 15);

  const { data: jamPelajaranHariIni } = await supabase
    .from('jam_pelajaran').select('*').eq('hari', hariNow).order('jam_ke');

  const jamKeSekarang = (jamPelajaranHariIni || []).find(j => jamNow >= j.jam_mulai && jamNow <= tambahMenit(j.jam_selesai, toleransi));

  if (!jamKeSekarang) {
    return { success: false, message: 'Bukan jam pelajaran sekarang. Absen mengajar hanya bisa dilakukan saat sesi berlangsung.' };
  }

  // 2. Cari jadwal_mengajar guru ini yang mencakup jam_ke sekarang (blok
  //    jam_ke_mulai..jam_ke_selesai) di hari ini.
  const { data: jadwalGuru } = await supabase
    .from('jadwal_mengajar').select('*')
    .eq('id_guru', guruIdTerverifikasi).eq('hari', hariNow)
    .lte('jam_ke_mulai', jamKeSekarang.jam_ke)
    .gte('jam_ke_selesai', jamKeSekarang.jam_ke);

  if (!jadwalGuru || jadwalGuru.length === 0) {
    return { success: false, message: 'Tidak ada jadwal mengajar Anda pada jam ini.' };
  }
  const jadwal = jadwalGuru[0];

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
      message: 'Sesi ini sudah tercatat hari ini.'
    };
  }

  // 4. Telat kalau scan > toleransi menit setelah jam_mulai jam ke awal blok.
  const { data: jamMulaiBlok } = await supabase
    .from('jam_pelajaran').select('jam_mulai')
    .eq('hari', hariNow).eq('jam_ke', jadwal.jam_ke_mulai).maybeSingle();
  const batasTelat = jamMulaiBlok ? tambahMenit(jamMulaiBlok.jam_mulai, toleransi) : jamKeSekarang.jam_mulai;
  const status = jamMulaiBlok && jamNow > batasTelat ? 'Telat' : 'Hadir';

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
    message: `Absen mengajar tercatat (${status}). Silakan lanjut scan kartu siswa untuk verifikasi kehadiran di kelas.`
  };
}

// ════════════════════════════════════════════════════════════════
// VERIFIKASI KEHADIRAN SISWA PER SESI
// ════════════════════════════════════════════════════════════════
async function scanSiswaMapel({ idAbsensiMengajar, idSiswa }) {
  if (!idAbsensiMengajar || !idSiswa)
    return { success: false, message: 'Sesi mengajar dan ID siswa wajib diisi' };

  const { data: sesi } = await supabase
    .from('absensi_mengajar').select('*').eq('id', idAbsensiMengajar).maybeSingle();
  if (!sesi) return { success: false, message: 'Sesi mengajar tidak ditemukan' };

  const { data: siswa } = await supabase.from('siswa').select('id,nisn,nama,kelas').eq('id', idSiswa).maybeSingle();
  if (!siswa) return { success: false, message: 'Siswa tidak ditemukan' };

  const id = generateID('KS');
  const { error } = await supabase.from('kehadiran_siswa_mapel').insert({
    id, id_absensi_mengajar: idAbsensiMengajar, id_siswa: idSiswa,
    nisn: siswa.nisn, nama_siswa: siswa.nama, kelas: siswa.kelas,
    tanggal: sesi.tanggal, jam_scan: jamSekarang(), metode: 'online'
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

  await supabase.from('absensi_mengajar')
    .update({ jumlah_siswa_terverifikasi: jumlah, status_verifikasi: status })
    .eq('id', sesi.id);

  return { jumlah, status };
}

async function selesaiVerifikasi({ idAbsensiMengajar }) {
  const { data: sesi } = await supabase.from('absensi_mengajar').select('*').eq('id', idAbsensiMengajar).maybeSingle();
  if (!sesi) return { success: false, message: 'Sesi mengajar tidak ditemukan' };
  const hasil = await hitungUlangStatusVerifikasi(sesi);
  return {
    success: true, jumlahSiswaTerverifikasi: hasil.jumlah, statusVerifikasi: hasil.status,
    message: hasil.status === 'Terverifikasi'
      ? 'Verifikasi selesai, kehadiran terverifikasi.'
      : 'Jumlah siswa yang discan belum memenuhi ambang minimal. Ditandai "Perlu Ditinjau" untuk dicek admin/kepsek.'
  };
}

// ════════════════════════════════════════════════════════════════
// KETERANGAN MENGAJAR (Izin / Sakit — manual, oleh admin/TU atau guru)
// ════════════════════════════════════════════════════════════════
async function inputKeteranganMengajar({ idJadwalMengajar, idGuru, tanggal, jenis, keterangan, diinputOleh }) {
  if (!idJadwalMengajar || !tanggal || !jenis)
    return { success: false, message: 'Jadwal, tanggal, dan jenis wajib diisi' };
  if (!['Izin', 'Sakit'].includes(jenis))
    return { success: false, message: 'Jenis harus Izin atau Sakit' };

  const { data: existing } = await supabase
    .from('keterangan_mengajar').select('id')
    .eq('id_jadwal_mengajar', idJadwalMengajar).eq('tanggal', tanggal).maybeSingle();

  if (existing) {
    const { error } = await supabase.from('keterangan_mengajar')
      .update({ jenis, keterangan: keterangan || '', diinput_oleh: diinputOleh || '' })
      .eq('id', existing.id);
    if (error) return { success: false, message: error.message };
    return { success: true, message: 'Keterangan berhasil diperbarui' };
  }

  const { error } = await supabase.from('keterangan_mengajar').insert({
    id: generateID('KM'), id_jadwal_mengajar: idJadwalMengajar, id_guru: idGuru || null,
    tanggal, jenis, keterangan: keterangan || '', diinput_oleh: diinputOleh || ''
  });
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan berhasil disimpan' };
}

async function hapusKeteranganMengajar({ id }) {
  if (!id) return { success: false, message: 'ID keterangan wajib diisi' };
  const { error } = await supabase.from('keterangan_mengajar').delete().eq('id', id);
  if (error) return { success: false, message: error.message };
  return { success: true, message: 'Keterangan berhasil dihapus' };
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
      totalSesiTerjadwal: 0, totalHadir: 0, totalTelat: 0, totalIzin: 0, totalSakit: 0, totalAlpa: 0,
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
  const batasAkhir = akhirBulan < today ? akhirBulan : today; // jangan hitung tanggal yang belum lewat

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

  let totalSesiTerjadwal = 0, totalHadir = 0, totalTelat = 0, totalIzin = 0, totalSakit = 0, totalAlpa = 0;
  const rincian = [];
  const trenMap = {}; // per tanggal: { hadir, telat, izin, sakit, alpa }

  for (let d = 1; d <= jumlahHariDiBulan; d++) {
    const tanggal = `${th}-${String(bl).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (tanggal > batasAkhir) break; // belum terjadi

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
      trenMap[tanggal] = trenMap[tanggal] || { hadir: 0, telat: 0, izin: 0, sakit: 0, alpa: 0 };

      let statusFinal;
      if (absen) {
        statusFinal = absen.status === 'Telat' ? 'Telat' : 'Hadir';
        if (statusFinal === 'Telat') { totalTelat++; trenMap[tanggal].telat++; }
        else { totalHadir++; trenMap[tanggal].hadir++; }
      } else if (ket) {
        statusFinal = ket.jenis;
        if (ket.jenis === 'Izin') { totalIzin++; trenMap[tanggal].izin++; }
        else { totalSakit++; trenMap[tanggal].sakit++; }
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
        keteranganText: ket ? ket.keterangan : null
      });
    }
  }

  const dibayarSesiCount = totalHadir + totalTelat;
  const persentaseKehadiran = totalSesiTerjadwal > 0
    ? Math.round((dibayarSesiCount / totalSesiTerjadwal) * 1000) / 10
    : null;

  return {
    success: true,
    guru: { id: guru.id, nama: guru.nama },
    bulan: bl, tahun: th,
    totalSesiTerjadwal, totalHadir, totalTelat, totalIzin, totalSakit, totalAlpa,
    persentaseKehadiran,
    rincian: rincian.sort((a, b) => a.tanggal < b.tanggal ? 1 : -1), // terbaru dulu
    tren: Object.keys(trenMap).sort().map(tgl => ({ tanggal: tgl, ...trenMap[tgl] }))
  };
}
