// api/_db.js — Shared Supabase client untuk semua API functions

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── HASH PASSWORD (SHA-256 sederhana via crypto) ──────────
const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// ── GENERATE ID ───────────────────────────────────────────
function generateID(prefix) {
  const now = new Date();
  const ts = now.getFullYear().toString().slice(-2)
    + String(now.getMonth()+1).padStart(2,'0')
    + String(now.getDate()).padStart(2,'0')
    + String(now.getHours()).padStart(2,'0')
    + String(now.getMinutes()).padStart(2,'0')
    + String(now.getSeconds()).padStart(2,'0');
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}${ts}${rand}`;
}

// ── GENERATE USERNAME ─────────────────────────────────────
async function generateUsername(nama) {
  const base = nama.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,8);
  let username = base;
  let counter = 1;
  while (true) {
    const { data } = await supabase.from('guru').select('id').eq('username', username).single();
    if (!data) break;
    username = base + counter++;
  }
  return username;
}

// ── GENERATE PASSWORD ─────────────────────────────────────
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 8; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
  return pass;
}

// ── CORS HEADERS ──────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── JAM SETTING ───────────────────────────────────────────
async function getJamSetting() {
  const { data } = await supabase.from('jam_setting').select('*');
  const result = {};
  (data || []).forEach(row => { result[row.kunci] = row.nilai; });
  return result;
}

// ── TODAY STRING ──────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── JAM SEKARANG ──────────────────────────────────────────
function jamSekarang() {
  const now = new Date();
  // Konversi ke WIB (UTC+7)
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().split('T')[1].substring(0, 5);
}

function hariIni() {
  const days = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const wib = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  return days[wib.getDay()];
}

module.exports = {
  supabase, hashPassword, generateID, generateUsername,
  generatePassword, setCors, getJamSetting, todayStr,
  jamSekarang, hariIni
};
