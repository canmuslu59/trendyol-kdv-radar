import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'radar.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trendyol_url TEXT NOT NULL UNIQUE,
  vat_rate REAL NOT NULL DEFAULT 1,
  base_commission REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_pages INTEGER NOT NULL DEFAULT 0,
  exclude_keywords TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trendyol_product_id TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  scan_date TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rating_count INTEGER,
  review_count INTEGER,
  price REAL,
  seller_count INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  raw_note TEXT,
  UNIQUE(product_id, scan_date),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_snapshots_product_date ON snapshots(product_id, scan_date);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT 'manual',
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  progress_json TEXT,
  result_json TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status,id);
`);

const seed = db.prepare(`INSERT OR IGNORE INTO categories
(name, trendyol_url, vat_rate, base_commission, enabled, max_pages, exclude_keywords, note)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

// Initial whitelist. Commission values are editable reference/base values, not seller-specific contractual rates.
const seeds = [
  ['Gıda Takviyesi & Vitamin', 'https://www.trendyol.com/gida-takviyeleri-vitaminler-x-c105085', 1, 17.29, 1, 0, 'özel tıbbi amaçlı|special medical', 'Takviye edici gıdalar. Baz komisyon referansı düzenlenebilir.'],
  ['Türk Kahvesi', 'https://www.trendyol.com/turk-kahvesi-x-c105447', 1, 10.17, 1, 0, '', 'Paketli Türk kahvesi.'],
  ['Kahve', 'https://www.trendyol.com/kahve-x-c104978', 1, 12.20, 1, 0, '', 'Kahve ürünleri; alt kategoriye göre komisyon değişebilir.'],
  ['Kuru Gıda', 'https://www.trendyol.com/kuru-gida-x-c105064', 1, 15.25, 1, 0, '', 'Paketli kuru gıda.'],
  ['Zeytinyağı', 'https://www.trendyol.com/zeytinyagi-x-c105091', 1, 10.17, 1, 0, '', 'Paketli zeytinyağı.'],
  ['Sıvı Yağ', 'https://www.trendyol.com/sivi-yag-x-c105089', 1, 8.14, 1, 0, '', 'Paketli yemeklik sıvı yağ.']
];
for (const row of seeds) seed.run(...row);

export default db;
