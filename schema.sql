-- ============================================================
-- SIABSEN - Schema Database Supabase
-- Jalankan di Supabase SQL Editor (satu kali saja)
-- ============================================================

-- ─── TABEL ADMIN ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  nama TEXT NOT NULL,
  email TEXT,
  role TEXT DEFAULT 'admin',
  qr_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── TABEL GURU ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guru (
  id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  jenis_kelamin TEXT,
  jabatan TEXT,
  nip TEXT,
  no_hp TEXT,
  email TEXT,
  alamat TEXT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  status TEXT DEFAULT 'Aktif',
  qr_token TEXT,
  role TEXT DEFAULT 'guru',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Untuk database yang sudah ada sebelum kolom ini ditambahkan. Kolom ini
-- dipakai untuk QR login di halaman BELAKANG kartu guru (bypass login
-- cepat ke akun guru itu sendiri, mirip qr_token di tabel admin) —
-- berbeda dari QR di halaman depan yang isinya guru.id untuk absen piket.
ALTER TABLE guru ADD COLUMN IF NOT EXISTS qr_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_guru_qr_token ON guru(qr_token);

-- ── ROLE AKUN (guru biasa vs kepala sekolah) ─────────────────────
-- PENTING: ini adalah ROLE AKUN, terpisah sepenuhnya dari kolom `jabatan`
-- (yang cuma label tampilan bebas seperti "Kepala Sekolah", "Guru BK",
-- dsb — lihat jabatanList di api/settings.js). Sebelum kolom ini ada,
-- akun Kepala Sekolah TIDAK BISA dibedakan dari guru biasa oleh sistem:
-- dashboard-nya sama, bisa muncul di jadwal piket, dan bisa tercatat
-- sebagai guru piket pengganti otomatis lewat scan kartu. Kolom ini
-- dipakai backend (api/scan.js, api/sync.js) untuk MENOLAK akun kepsek
-- dari jalur piket, dan oleh frontend (index.html) untuk menampilkan
-- menu khusus pengawasan (read-only) alih-alih menu operasional guru.
-- Nilai yang valid hanya 'guru' atau 'kepsek'.
ALTER TABLE guru ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'guru';
UPDATE guru SET role = 'guru' WHERE role IS NULL;

-- ── PASSWORD TERENKRIPSI (REVERSIBLE) UNTUK KARTU GURU ───────────────
-- Kolom `password` di atas berisi hash bcrypt SATU ARAH (untuk login,
-- tidak bisa dibalikin ke teks asli). Kolom BARU ini menyimpan password
-- yang sama tapi dienkripsi AES-256-GCM (bisa dibalikin, lihat
-- encryptPassword/decryptPassword di api/_db.js), khusus supaya admin
-- bisa mencetak ulang password guru di kartu identitas (termasuk saat
-- download kartu massal) tanpa perlu reset password dulu.
-- PERHATIAN KEAMANAN: berbeda dari kolom `password`, kolom ini bisa
-- dibaca ulang kalau database + kunci enkripsi (env var
-- PASSWORD_ENC_KEY / SUPABASE_SERVICE_KEY) sama-sama bocor. Guru lama
-- yang dibuat SEBELUM kolom ini ada akan bernilai NULL di sini sampai
-- password mereka di-set ulang (edit/reset) minimal sekali.
ALTER TABLE guru ADD COLUMN IF NOT EXISTS password_enc TEXT;

-- ─── TABEL SISWA ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS siswa (
  id TEXT PRIMARY KEY,
  nisn TEXT UNIQUE NOT NULL,
  nama TEXT NOT NULL,
  jenis_kelamin TEXT,
  tempat_lahir TEXT,
  tanggal_lahir DATE,
  agama TEXT,
  kelas TEXT,
  tahun_masuk INTEGER,
  nama_ortu TEXT,
  no_hp_ortu TEXT,
  alamat TEXT,
  status TEXT DEFAULT 'Aktif',
  riwayat_token TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Untuk database yang sudah ada sebelum kolom ini ditambahkan
ALTER TABLE siswa ADD COLUMN IF NOT EXISTS riwayat_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_siswa_riwayat_token ON siswa(riwayat_token);

-- ─── TABEL ABSENSI ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS absensi (
  id TEXT PRIMARY KEY,
  id_siswa TEXT REFERENCES siswa(id),
  nisn TEXT,
  nama_siswa TEXT,
  kelas TEXT,
  tanggal DATE NOT NULL,
  hari TEXT,
  jam_datang TEXT,
  status_datang TEXT,
  jam_pulang TEXT,
  status_pulang TEXT,
  id_guru_piket TEXT,
  nama_guru_piket TEXT,
  keterangan TEXT,
  metode TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Mencegah 1 siswa punya lebih dari 1 baris absensi di tanggal yang
  -- sama, sebagai pengaman level database (bukan cuma cek di kode).
  CONSTRAINT uniq_absensi_siswa_tanggal UNIQUE (id_siswa, tanggal)
);

-- ─── TABEL SESI PIKET (guru yang scan sebagai guru piket) ──
CREATE TABLE IF NOT EXISTS sesi_piket (
  id TEXT PRIMARY KEY,
  tanggal DATE NOT NULL,
  id_guru TEXT REFERENCES guru(id),
  nama_guru TEXT,
  jabatan TEXT,
  jam_scan TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_sesipiket_tanggal_guru UNIQUE (tanggal, id_guru)
);
CREATE INDEX IF NOT EXISTS idx_sesi_piket_tanggal ON sesi_piket(tanggal);

-- ─── TABEL SEMESTER ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS semester (
  id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  tahun_ajaran TEXT,
  tanggal_mulai DATE NOT NULL,
  tanggal_selesai DATE NOT NULL,
  aktif BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- TABEL FITUR "JADWAL MENGAJAR" (ditambahkan belakangan setelah tabel-
-- tabel di atas -- sebelumnya TIDAK ada di schema.sql sama sekali walau
-- sudah dipakai aktif oleh api/mengajar.js, api/sync.js (sinkron
-- offline), api/monitor.js, dan api/riwayat.js. Definisi di bawah
-- direkonstruksi dari kolom yang benar-benar dibaca/ditulis kode
-- tersebut, bukan tebakan -- kalau kamu setup database baru dari nol
-- dengan schema.sql versi lama, fitur Jadwal Mengajar & Status
-- Perangkat (dashboard admin) akan error karena tabel-tabel ini belum
-- ada sama sekali.
-- ═══════════════════════════════════════════════════════════

-- ─── TABEL JAM PELAJARAN (master jam ke-1, ke-2, dst per hari) ──
CREATE TABLE IF NOT EXISTS jam_pelajaran (
  id TEXT PRIMARY KEY,
  hari TEXT NOT NULL,
  jam_ke INTEGER NOT NULL,
  jam_mulai TEXT NOT NULL,
  jam_selesai TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- 1 hari cuma boleh punya 1 baris untuk jam ke-N yang sama. simpanJamPelajaran()
  -- di api/mengajar.js sudah menghapus baris lama per-hari sebelum insert baru,
  -- constraint ini pengaman tambahan di level database.
  CONSTRAINT uniq_jampelajaran_hari_jamke UNIQUE (hari, jam_ke)
);
CREATE INDEX IF NOT EXISTS idx_jampelajaran_hari ON jam_pelajaran(hari);

-- ─── TABEL JADWAL MENGAJAR (jadwal tetap guru: hari, blok jam, kelas, mapel) ──
CREATE TABLE IF NOT EXISTS jadwal_mengajar (
  id TEXT PRIMARY KEY,
  id_guru TEXT REFERENCES guru(id),
  nama_guru TEXT,
  hari TEXT NOT NULL,
  jam_ke_mulai INTEGER NOT NULL,
  jam_ke_selesai INTEGER NOT NULL,
  kelas TEXT NOT NULL,
  mapel TEXT NOT NULL,
  id_semester TEXT REFERENCES semester(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jadwalmengajar_guru ON jadwal_mengajar(id_guru);
CREATE INDEX IF NOT EXISTS idx_jadwalmengajar_hari ON jadwal_mengajar(hari);

-- ─── TABEL ABSENSI MENGAJAR (guru scan kartu sendiri saat mulai sesi) ──
CREATE TABLE IF NOT EXISTS absensi_mengajar (
  id TEXT PRIMARY KEY,
  id_jadwal_mengajar TEXT REFERENCES jadwal_mengajar(id),
  id_guru TEXT REFERENCES guru(id),
  nama_guru TEXT,
  kelas TEXT,
  mapel TEXT,
  tanggal DATE NOT NULL,
  hari TEXT,
  jam_scan TEXT,
  status TEXT,                                    -- 'Hadir' | 'Telat'
  jumlah_siswa_terverifikasi INTEGER DEFAULT 0,
  status_verifikasi TEXT DEFAULT 'Perlu Ditinjau', -- 'Perlu Ditinjau' | 'Terverifikasi'
  metode TEXT,                                     -- 'online' | dari sync offline
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- 1 sesi jadwal cuma boleh discan 1x per tanggal. scanSesiMengajar() di
  -- api/mengajar.js & processMengajarOffline() di api/sync.js sama-sama
  -- menangkap kode error 23505 dari constraint ini untuk kasus "sudah
  -- tercatat hari ini" / race 2 perangkat.
  CONSTRAINT uniq_absensimengajar_jadwal_tanggal UNIQUE (id_jadwal_mengajar, tanggal)
);
CREATE INDEX IF NOT EXISTS idx_absensimengajar_tanggal ON absensi_mengajar(tanggal);
CREATE INDEX IF NOT EXISTS idx_absensimengajar_guru    ON absensi_mengajar(id_guru);
CREATE INDEX IF NOT EXISTS idx_absensimengajar_kelas    ON absensi_mengajar(kelas);

-- ─── TABEL KEHADIRAN SISWA PER MAPEL (verifikasi siswa scan saat sesi guru berlangsung) ──
CREATE TABLE IF NOT EXISTS kehadiran_siswa_mapel (
  id TEXT PRIMARY KEY,
  id_absensi_mengajar TEXT REFERENCES absensi_mengajar(id),
  id_siswa TEXT REFERENCES siswa(id),
  nisn TEXT,
  nama_siswa TEXT,
  kelas TEXT,
  tanggal DATE NOT NULL,
  jam_scan TEXT,
  metode TEXT,
  -- BARU: sebelumnya baris di sini SELALU berarti "Hadir" (satu-satunya
  -- cara masuk ke tabel ini adalah scan kartu fisik). Sekarang tabel ini
  -- juga menampung hasil checklist manual guru untuk siswa yang TIDAK
  -- scan kartu (lihat simpanAbsensiKelasManual di api/mengajar.js) --
  -- jadi butuh kolom status sendiri: 'Hadir' (default, termasuk semua
  -- baris lama & hasil scan kartu), 'Izin', 'Sakit', atau 'Alpa'.
  status TEXT NOT NULL DEFAULT 'Hadir',
  keterangan TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- 1 siswa cuma boleh terverifikasi 1x per sesi mengajar. scanSiswaMapel()
  -- di api/mengajar.js menangkap kode 23505 dari constraint ini untuk
  -- pesan "sudah discan untuk sesi ini".
  CONSTRAINT uniq_kehadiransiswamapel_sesi_siswa UNIQUE (id_absensi_mengajar, id_siswa)
);
CREATE INDEX IF NOT EXISTS idx_kehadiransiswamapel_siswa   ON kehadiran_siswa_mapel(id_siswa);
CREATE INDEX IF NOT EXISTS idx_kehadiransiswamapel_tanggal ON kehadiran_siswa_mapel(tanggal);
-- MIGRASI (kalau tabel ini sudah ada sebelumnya di database production,
-- CREATE TABLE IF NOT EXISTS di atas TIDAK menambah kolom baru ke tabel
-- yang sudah ada -- jalankan manual ini sekali di Supabase SQL Editor):
--   ALTER TABLE kehadiran_siswa_mapel ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Hadir';
--   ALTER TABLE kehadiran_siswa_mapel ADD COLUMN IF NOT EXISTS keterangan TEXT;

-- ─── TABEL KETERANGAN MENGAJAR (Izin/Sakit guru, manual oleh admin/TU atau guru sendiri) ──
CREATE TABLE IF NOT EXISTS keterangan_mengajar (
  id TEXT PRIMARY KEY,
  id_jadwal_mengajar TEXT REFERENCES jadwal_mengajar(id),
  id_guru TEXT REFERENCES guru(id),
  tanggal DATE NOT NULL,
  jenis TEXT NOT NULL, -- 'Izin' | 'Sakit'
  keterangan TEXT,
  diinput_oleh TEXT,   -- 'admin' | 'guru'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uniq_keteranganmengajar_jadwal_tanggal UNIQUE (id_jadwal_mengajar, tanggal)
);
CREATE INDEX IF NOT EXISTS idx_keteranganmengajar_tanggal ON keterangan_mengajar(tanggal);

-- ── ALUR PERSETUJUAN IZIN/SAKIT (approval workflow) ──────────────
-- Sebelumnya kolom di atas langsung dihitung final begitu disimpan, tanpa
-- verifikasi apa pun -- baik diinput admin/TU maupun oleh guru sendiri untuk
-- dirinya. Kolom-kolom baru ini menambahkan alur persetujuan KHUSUS untuk
-- laporan yang diinput guru sendiri (diinput_oleh = 'guru'): status default
-- jadi 'Menunggu Persetujuan' dan baru dihitung final di rekap
-- (getRekapKehadiranGuru) setelah disetujui akun Kepala Sekolah (role
-- 'kepsek'). Laporan yang diinput admin/TU tetap langsung 'Disetujui'
-- (admin dianggap sudah melakukan verifikasi manual sebelum menginput).
ALTER TABLE keterangan_mengajar ADD COLUMN IF NOT EXISTS status_persetujuan TEXT NOT NULL DEFAULT 'Disetujui';
-- Nilai valid: 'Menunggu Persetujuan' | 'Disetujui' | 'Ditolak'
ALTER TABLE keterangan_mengajar ADD COLUMN IF NOT EXISTS bukti_url TEXT; -- foto/scan surat sakit/izin, base64 data-URL
ALTER TABLE keterangan_mengajar ADD COLUMN IF NOT EXISTS disetujui_oleh TEXT REFERENCES guru(id); -- id akun kepsek yang memutuskan
ALTER TABLE keterangan_mengajar ADD COLUMN IF NOT EXISTS disetujui_pada TIMESTAMPTZ;
ALTER TABLE keterangan_mengajar ADD COLUMN IF NOT EXISTS catatan_penolakan TEXT; -- alasan kepsek kalau ditolak
CREATE INDEX IF NOT EXISTS idx_keteranganmengajar_statuspersetujuan ON keterangan_mengajar(status_persetujuan);

-- ─── TABEL STATUS PERANGKAT (heartbeat kiosk scan, untuk Dashboard Admin) ──
-- Diisi lewat upsert onConflict:'device_id' (lihat heartbeat() di
-- api/sync.js), jadi 1 baris = 1 perangkat, terus diperbarui -- bukan
-- menumpuk baris baru tiap heartbeat.
CREATE TABLE IF NOT EXISTS perangkat_status (
  device_id TEXT PRIMARY KEY,
  label TEXT,
  antrian_pending INTEGER DEFAULT 0,
  user_agent TEXT,
  last_heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_perangkatstatus_heartbeat ON perangkat_status(last_heartbeat);

-- ─── TABEL LOG RIWAYAT HEARTBEAT (BARU) — untuk fitur "Cek Kesehatan
-- Sistem" di Dashboard Admin/Kepsek. BEDA dari `perangkat_status` di
-- atas: tabel itu HANYA punya 1 baris per perangkat (ditimpa terus,
-- riwayatnya hilang), jadi tidak bisa menjawab "apakah perangkat ini
-- online jam sekian TADI PAGI". Tabel ini menumpuk baris baru tiap
-- heartbeat (bukan upsert), supaya riwayat konektivitas dari waktu ke
-- waktu bisa ditelusuri ke belakang -- dipakai untuk mendeteksi celah
-- waktu yang tidak wajar (indikasi kemungkinan gangguan aplikasi/kiosk)
-- saat admin/kepsek menekan tombol "Cek Kesehatan Sistem".
-- Dibuat ringan (cuma kolom penting) karena akan terus bertambah baris
-- tiap ~30 detik per perangkat aktif.
CREATE TABLE IF NOT EXISTS perangkat_status_log (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  label TEXT,
  antrian_pending INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_perangkatstatuslog_created ON perangkat_status_log(created_at);
CREATE INDEX IF NOT EXISTS idx_perangkatstatuslog_device_created ON perangkat_status_log(device_id, created_at);

-- Pembersihan otomatis opsional (biar tabel ini tidak tumbuh tanpa
-- batas): baris lebih tua dari 1 semester (± 6 bulan) aman dihapus,
-- karena filter terjauh di fitur "Cek Kesehatan Sistem" adalah
-- "semester". Jalankan manual/berkala lewat Supabase SQL editor kalau
-- perlu, BUKAN otomatis dari kode aplikasi (supaya tidak ada penghapusan
-- data tak terduga tanpa sepengetahuan admin):
--   DELETE FROM perangkat_status_log WHERE created_at < NOW() - INTERVAL '6 months';


-- jam_pulang_mulai / jam_pulang_selesai: override jam pulang KHUSUS hari
-- itu (mis. Jumat pulang lebih awal). NULL/kosong = ikuti nilai global
-- di jam_setting (JAM_PULANG_MULAI/JAM_PULANG_SELESAI, menu Pengaturan
-- Jam). Diedit dari menu Pengaturan Semester, dibaca oleh
-- getJamPulangEfektif() di api/_db.js supaya seluruh sistem (scan
-- barcode, validasi absen pulang, dsb.) konsisten pakai sumber yang sama.
CREATE TABLE IF NOT EXISTS pengaturan_hari_kerja (
  hari TEXT PRIMARY KEY,
  aktif BOOLEAN DEFAULT true,
  jam_pulang_mulai TEXT,
  jam_pulang_selesai TEXT
);

-- Kalau tabel sudah ada dari sebelumnya (setup lama), tambahkan kolom
-- yang belum ada tanpa mengubah data yang sudah tersimpan.
ALTER TABLE pengaturan_hari_kerja ADD COLUMN IF NOT EXISTS jam_pulang_mulai TEXT;
ALTER TABLE pengaturan_hari_kerja ADD COLUMN IF NOT EXISTS jam_pulang_selesai TEXT;

-- ─── TABEL KETERANGAN ABSENSI (sakit/izin, dst) ─────────────
CREATE TABLE IF NOT EXISTS keterangan_absensi (
  id TEXT PRIMARY KEY,
  id_siswa TEXT REFERENCES siswa(id),
  nisn TEXT,
  nama_siswa TEXT,
  kelas TEXT,
  tanggal DATE NOT NULL,
  status TEXT,
  keterangan TEXT,
  diinput_oleh TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_keterangan_absensi_tanggal ON keterangan_absensi(tanggal);
CREATE INDEX IF NOT EXISTS idx_keterangan_absensi_siswa   ON keterangan_absensi(id_siswa);

-- ─── PERBAIKAN BUG (BARU): keterangan_absensi TIDAK PUNYA pengaman
-- UNIQUE di level database, berbeda dari SEMUA tabel "1 baris per hari"
-- lain di file ini (absensi, sesi_piket, absensi_mengajar,
-- kehadiran_siswa_mapel, keterangan_mengajar -- lihat CONSTRAINT
-- uniq_... masing-masing di atas). api/kehadiran.js (inputKeterangan)
-- memakai pola yang SAMA PERSIS dengan tabel-tabel itu (SELECT cek ada/
-- tidak, baru INSERT/UPDATE) -- tapi tanpa UNIQUE constraint ini, dua
-- request yang nyaris bersamaan (mis. tap ganda di koneksi lambat, atau
-- admin & guru piket menginput keterangan untuk siswa yang sama hampir
-- bersamaan) bisa SAMA-SAMA lolos cek "belum ada" lalu SAMA-SAMA insert
-- baris baru -- menghasilkan 2 baris keterangan_absensi untuk siswa+
-- tanggal yang sama. Baris dobel ini merusak semua statistik yang
-- MENGHITUNG JUMLAH BARIS keterangan_absensi (dashboard admin di
-- api/absensi.js, live/rekap kepsek & admin di _db.js, dan evaluasi
-- kehadiran semester di api/kehadiran.js) -- siswa yang sama bisa
-- terhitung 2x sebagai Sakit/Izin.
--
-- 1) Bersihkan dulu duplikat yang MUNGKIN SUDAH ADA di database
--    production (kalau bug ini sudah sempat kejadian sebelum perbaikan
--    ini dipasang), supaya ALTER TABLE di bawah tidak gagal karena data
--    yang sudah tidak unik. Baris yang dipertahankan adalah yang paling
--    baru (created_at terbesar, id sebagai tie-breaker).
DELETE FROM keterangan_absensi a
USING keterangan_absensi b
WHERE a.id_siswa IS NOT NULL
  AND a.id_siswa = b.id_siswa
  AND a.tanggal  = b.tanggal
  AND (a.created_at, a.id) < (b.created_at, b.id);

-- 2) Pasang UNIQUE constraint-nya, idempotent (aman dijalankan berkali-
--    kali) memakai DO block karena Postgres tidak punya sintaks
--    "ADD CONSTRAINT IF NOT EXISTS" bawaan seperti ADD COLUMN.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniq_keteranganabsensi_siswa_tanggal'
  ) THEN
    ALTER TABLE keterangan_absensi
      ADD CONSTRAINT uniq_keteranganabsensi_siswa_tanggal UNIQUE (id_siswa, tanggal);
  END IF;
END $$;

-- ─── FITUR BARU: PULANG CEPAT (Sakit/Izin mendadak setelah hadir) ──
-- Kasus: siswa sudah absen datang (Hadir/Terlambat), tapi di tengah hari
-- (mis. jam 10 pagi) ternyata sakit dan harus dipulangkan lebih awal --
-- SEBELUM jam absen pulang resmi dan sebelum dia sempat scan pulang
-- sendiri. Sebelumnya tidak ada cara mencatat ini: begitu jam_datang
-- terisi, siswa dianggap "Hadir" penuh titik, dan satu-satunya tempat
-- mencatat Sakit/Izin (tabel keterangan_absensi) hanya dipakai untuk
-- siswa yang MEMANG TIDAK datang sama sekali.
--
-- Solusi: TIDAK bikin baris/tabel baru. Pakai ulang kolom yang sudah ada
-- di `absensi` -- jam_pulang menyimpan JAM dia dipulangkan karena sakit/
-- izin, status_pulang diisi status selain 'Pulang' (mis. 'Sakit', 'Izin',
-- 'Urusan Keluarga', 'Izin Lainnya') supaya beda jelas dari absen pulang
-- normal di semua tempat yang MENGHITUNG status_pulang = 'Pulang'
-- (rekapBulanan/rekapBulananRange di api/absensi.js) -- baris "pulang
-- cepat" otomatis TIDAK ikut terhitung sebagai pulang biasa tanpa perlu
-- ubah kode lain. Hasilnya 1 baris absensi/siswa/hari tetap menyimpan
-- cerita lengkap: Hadir 06:45 lalu Sakit 10:15.
-- keterangan_pulang_cepat (BARU) menyimpan alasan/catatan sakit-nya --
-- terpisah dari kolom `keterangan` yang sudah dipakai untuk alasan
-- TERLAMBAT (updateKeteranganTerlambat di api/kehadiran.js), supaya dua
-- keterangan yang beda konteks tidak saling menimpa kalau siswa yang
-- sama kebetulan terlambat DAN pulang cepat di hari yang sama.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'absensi' AND column_name = 'keterangan_pulang_cepat'
  ) THEN
    ALTER TABLE absensi ADD COLUMN keterangan_pulang_cepat TEXT;
  END IF;
END $$;

-- ─── TABEL JADWAL PIKET ────────────────────────────────────
CREATE TABLE IF NOT EXISTS jadwal_piket (
  id TEXT PRIMARY KEY,
  hari TEXT NOT NULL,
  id_guru TEXT REFERENCES guru(id),
  nama_guru TEXT,
  jabatan TEXT
);

-- ─── TABEL HARI KERJA ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS hari_kerja (
  tanggal DATE PRIMARY KEY,
  keterangan TEXT,
  tipe TEXT DEFAULT 'Libur'
);

-- ─── TABEL JAM SETTING ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS jam_setting (
  kunci TEXT PRIMARY KEY,
  nilai TEXT,
  deskripsi TEXT
);

-- ─── DATA DEFAULT JAM SETTING ──────────────────────────────
INSERT INTO jam_setting (kunci, nilai, deskripsi) VALUES
  ('JAM_DATANG_MULAI',   '06:30', 'Jam mulai absensi datang'),
  ('JAM_DATANG_SELESAI', '08:00', 'Batas jam datang'),
  ('JAM_PULANG_MULAI',   '14:00', 'Jam mulai absensi pulang'),
  ('JAM_PULANG_SELESAI', '16:00', 'Batas jam absensi pulang'),
  ('TOLERANSI_MENIT',    '15',    'Toleransi keterlambatan menit'),
  ('TOLERANSI_PIKET_MENIT', '15', 'Menit setelah jam mulai datang sebelum guru pengganti (di luar jadwal piket) diizinkan scan, jika guru piket terjadwal belum hadir'),
  ('NAMA_SEKOLAH',       'SMA NEGERI 1', 'Nama Sekolah'),
  ('ALAMAT_SEKOLAH',     'Jl. Pendidikan No.1', 'Alamat Sekolah'),
  ('TAHUN_AJARAN',       '2024/2025', 'Tahun Ajaran Aktif'),
  ('NPSN',               '', 'NPSN Sekolah'),
  ('TELP_SEKOLAH',       '', 'Telepon Sekolah'),
  ('EMAIL_SEKOLAH',      '', 'Email Sekolah'),
  ('LOGO_URL',           '', 'URL Logo Sekolah'),
  ('RESET_ABSENSI_TERAKHIR', '', 'Timestamp ISO kapan riwayat absensi terakhir kali dihapus total (lewat Reset Absensi "Hapus Semua" atau Reset Total). Dipakai api/sync.js untuk menolak item antrian offline yang direkam SEBELUM waktu ini, supaya data lama yang baru sinkron belakangan tidak "menghidupkan kembali" riwayat yang sudah sengaja dihapus admin.'),
  ('BUKTI_IZIN_SAKIT_WAJIB', 'opsional', 'Apakah guru WAJIB melampirkan bukti (foto surat sakit/izin) saat menginput izin/sakit untuk dirinya sendiri. Nilai: "wajib" atau "opsional". Hanya berlaku untuk laporan yang diinput guru sendiri -- admin/TU tetap boleh input tanpa lampiran.')
ON CONFLICT (kunci) DO NOTHING;

-- ─── ADMIN DEFAULT (password: admin123) ────────────────────
-- Password di-hash SHA-256: admin123
INSERT INTO admin (username, password, nama, email, role) VALUES
  ('admin', 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3', 'Administrator', 'admin@sekolah.sch.id', 'admin')
ON CONFLICT (username) DO NOTHING;

-- ─── INDEX UNTUK PERFORMA ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_absensi_tanggal ON absensi(tanggal);
CREATE INDEX IF NOT EXISTS idx_absensi_siswa   ON absensi(id_siswa);
CREATE INDEX IF NOT EXISTS idx_siswa_kelas     ON siswa(kelas);
CREATE INDEX IF NOT EXISTS idx_siswa_status    ON siswa(status);
CREATE INDEX IF NOT EXISTS idx_guru_status     ON guru(status);

-- ─── ROW LEVEL SECURITY (nonaktifkan untuk simplicity) ─────
-- Karena autentikasi dihandle di API layer
ALTER TABLE admin         DISABLE ROW LEVEL SECURITY;
ALTER TABLE guru          DISABLE ROW LEVEL SECURITY;
ALTER TABLE siswa         DISABLE ROW LEVEL SECURITY;
ALTER TABLE absensi       DISABLE ROW LEVEL SECURITY;
ALTER TABLE jadwal_piket  DISABLE ROW LEVEL SECURITY;
ALTER TABLE sesi_piket    DISABLE ROW LEVEL SECURITY;
ALTER TABLE semester      DISABLE ROW LEVEL SECURITY;
ALTER TABLE pengaturan_hari_kerja DISABLE ROW LEVEL SECURITY;
ALTER TABLE keterangan_absensi    DISABLE ROW LEVEL SECURITY;
ALTER TABLE hari_kerja    DISABLE ROW LEVEL SECURITY;
ALTER TABLE jam_setting   DISABLE ROW LEVEL SECURITY;
ALTER TABLE jam_pelajaran         DISABLE ROW LEVEL SECURITY;
ALTER TABLE jadwal_mengajar       DISABLE ROW LEVEL SECURITY;
ALTER TABLE absensi_mengajar      DISABLE ROW LEVEL SECURITY;
ALTER TABLE kehadiran_siswa_mapel DISABLE ROW LEVEL SECURITY;
ALTER TABLE keterangan_mengajar   DISABLE ROW LEVEL SECURITY;
ALTER TABLE perangkat_status      DISABLE ROW LEVEL SECURITY;
ALTER TABLE perangkat_status_log  DISABLE ROW LEVEL SECURITY;
