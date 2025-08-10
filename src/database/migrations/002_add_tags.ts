import sqlite3 from 'sqlite3';

export function up(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Add tags column to notes table
      db.run(`
        ALTER TABLE notes ADD COLUMN tags TEXT
      `, (err) => {
        if (err) {
          // Check if column already exists
          if (err.message.includes('duplicate column name')) {
            console.log('Tags column already exists, skipping migration');
            resolve();
          } else {
            reject(err);
          }
          return;
        }
        
        // Create tags index for better search performance
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes(tags)
        `, (err) => {
          if (err) {
            reject(err);
          } else {
            console.log('Successfully added tags support to database');
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
      db.run(`DROP INDEX IF EXISTS idx_notes_tags`, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Note: SQLite doesn't support dropping columns easily
        // In production, we'd need to recreate the table without the column
        console.log('Note: Tags column not removed (SQLite limitation)');
        resolve();
      });
    });
  });
}