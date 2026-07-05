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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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
  ('NAMA_SEKOLAH',       'SMA NEGERI 1', 'Nama Sekolah'),
  ('ALAMAT_SEKOLAH',     'Jl. Pendidikan No.1', 'Alamat Sekolah'),
  ('TAHUN_AJARAN',       '2024/2025', 'Tahun Ajaran Aktif'),
  ('NPSN',               '', 'NPSN Sekolah'),
  ('TELP_SEKOLAH',       '', 'Telepon Sekolah'),
  ('EMAIL_SEKOLAH',      '', 'Email Sekolah'),
  ('LOGO_URL',           '', 'URL Logo Sekolah')
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
ALTER TABLE hari_kerja    DISABLE ROW LEVEL SECURITY;
ALTER TABLE jam_setting   DISABLE ROW LEVEL SECURITY;
