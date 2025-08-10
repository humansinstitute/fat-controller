import sqlite3 from 'sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { up } from './migrations/003_add_pinned.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  const dataDir = join(__dirname, '../../data');
  mkdirSync(dataDir, { recursive: true });
  
  const dbPath = join(dataDir, 'posts.db');
  const db = new sqlite3.Database(dbPath);
  
  try {
    console.log('🔧 Running pinned column migration...');
    await up(db);
    console.log('✅ Pinned migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    db.close();
  }
}

runMigration();