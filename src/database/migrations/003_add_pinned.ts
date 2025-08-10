import sqlite3 from 'sqlite3';

export function up(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Add pinned column to notes table
      db.run(`
        ALTER TABLE notes ADD COLUMN pinned BOOLEAN DEFAULT 0
      `, (err) => {
        if (err) {
          // Check if column already exists
          if (err.message.includes('duplicate column name')) {
            console.log('Pinned column already exists, skipping migration');
            resolve();
          } else {
            reject(err);
          }
          return;
        }
        
        // Create index for better performance when filtering pinned notes
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned)
        `, (err) => {
          if (err) {
            reject(err);
          } else {
            console.log('Successfully added pinned support to database');
            resolve();
          }
        });
      });
    });
  });
}

export function down(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Drop the index
      db.run(`DROP INDEX IF EXISTS idx_notes_pinned`, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Note: SQLite doesn't support dropping columns easily
        // In production, we'd need to recreate the table without the column
        console.log('Note: Pinned column not removed (SQLite limitation)');
        resolve();
      });
    });
  });
}