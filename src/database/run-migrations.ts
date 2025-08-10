import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const dataDir = join(__dirname, '../../data');
  mkdirSync(dataDir, { recursive: true });
  
  const dbPath = join(dataDir, 'posts.db');
  const db = new sqlite3.Database(dbPath);
  
  console.log('Running migrations...');
  
  // Add tags column if it doesn't exist
  await new Promise<void>((resolve, reject) => {
    db.run(`
      ALTER TABLE notes ADD COLUMN tags TEXT
    `, (err) => {
      if (err) {
        if (err.message.includes('duplicate column name')) {
          console.log('✅ Tags column already exists');
          resolve();
        } else {
          reject(err);
        }
      } else {
        console.log('✅ Added tags column to notes table');
        
        // Create index
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes(tags)
        `, (err) => {
          if (err) {
            console.error('Failed to create index:', err);
          } else {
            console.log('✅ Created tags index');
          }
          resolve();
        });
      }
    });
  });
  
  db.close();
  console.log('✅ Migrations complete!');
}

runMigrations().catch(console.error);