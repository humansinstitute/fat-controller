import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import { up } from './migrations/004_add_master_accounts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMasterAccountsMigration() {
  const dataDir = join(__dirname, '../../data');
  mkdirSync(dataDir, { recursive: true });
  
  const dbPath = join(dataDir, 'posts.db');
  const db = new sqlite3.Database(dbPath);
  
  console.log('🚀 Running Master Accounts migration...');
  
  try {
    await up(db);
    console.log('✅ Master Accounts migration completed successfully!');
    
    // Verify tables were created
    await new Promise<void>((resolve, reject) => {
      db.all(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name IN ('master_accounts', 'sessions', 'audit_log', 'signing_keys')
      `, (err, tables) => {
        if (err) {
          reject(err);
          return;
        }
        
        console.log('📋 Created tables:', (tables as any[]).map(t => t.name));
        resolve();
      });
    });
    
    db.close();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    db.close();
    process.exit(1);
  }
}

runMasterAccountsMigration().catch(console.error);