import sqlite3 from 'sqlite3';

export async function up(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create master_accounts table
      db.run(`
        CREATE TABLE IF NOT EXISTS master_accounts (
          npub TEXT PRIMARY KEY,
          display_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_login DATETIME,
          settings TEXT,
          status TEXT DEFAULT 'active'
        )
      `, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Create sessions table
        db.run(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            master_account_npub TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_agent TEXT,
            ip_address TEXT,
            FOREIGN KEY (master_account_npub) REFERENCES master_accounts(npub)
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          // Create audit_log table
          db.run(`
            CREATE TABLE IF NOT EXISTS audit_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              master_account_npub TEXT,
              action TEXT NOT NULL,
              entity_type TEXT,
              entity_id TEXT,
              details TEXT,
              timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
              ip_address TEXT
            )
          `, (err) => {
            if (err) {
              reject(err);
              return;
            }
            
            // Rename nostr_accounts to signing_keys
            db.run(`
              ALTER TABLE nostr_accounts RENAME TO signing_keys
            `, (err) => {
              if (err && !err.message.includes('no such table')) {
                reject(err);
                return;
              }
              
              // Add master_account_npub column to signing_keys
              db.run(`
                ALTER TABLE signing_keys ADD COLUMN master_account_npub TEXT
              `, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                  reject(err);
                  return;
                }
                
                // Add nickname column to signing_keys
                db.run(`
                  ALTER TABLE signing_keys ADD COLUMN nickname TEXT
                `, (err) => {
                  if (err && !err.message.includes('duplicate column name')) {
                    reject(err);
                    return;
                  }
                  
                  // Add is_default column to signing_keys
                  db.run(`
                    ALTER TABLE signing_keys ADD COLUMN is_default BOOLEAN DEFAULT 0
                  `, (err) => {
                    if (err && !err.message.includes('duplicate column name')) {
                      reject(err);
                      return;
                    }
                    
                    // Add master_account_npub to posts table
                    db.run(`
                      ALTER TABLE posts ADD COLUMN master_account_npub TEXT
                    `, (err) => {
                      if (err && !err.message.includes('duplicate column name')) {
                        reject(err);
                        return;
                      }
                      
                      // Add master_account_npub to notes table
                      db.run(`
                        ALTER TABLE notes ADD COLUMN master_account_npub TEXT
                      `, (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                          reject(err);
                          return;
                        }
                        
                        // Create index for better query performance
                        db.run(`
                          CREATE INDEX IF NOT EXISTS idx_signing_keys_master_account 
                          ON signing_keys(master_account_npub)
                        `, (err) => {
                          if (err) {
                            reject(err);
                            return;
                          }
                          
                          db.run(`
                            CREATE INDEX IF NOT EXISTS idx_posts_master_account 
                            ON posts(master_account_npub)
                          `, (err) => {
                            if (err) {
                              reject(err);
                              return;
                            }
                            
                            db.run(`
                              CREATE INDEX IF NOT EXISTS idx_notes_master_account 
                              ON notes(master_account_npub)
                            `, (err) => {
                              if (err) {
                                reject(err);
                                return;
                              }
                              
                              db.run(`
                                CREATE INDEX IF NOT EXISTS idx_sessions_token 
                                ON sessions(token_hash)
                              `, (err) => {
                                if (err) {
                                  reject(err);
                                  return;
                                }
                                
                                resolve();
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

export async function down(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Drop new tables
      db.run(`DROP TABLE IF EXISTS audit_log`, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        db.run(`DROP TABLE IF EXISTS sessions`, (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          db.run(`DROP TABLE IF EXISTS master_accounts`, (err) => {
            if (err) {
              reject(err);
              return;
            }
            
            // Rename signing_keys back to nostr_accounts
            db.run(`ALTER TABLE signing_keys RENAME TO nostr_accounts`, (err) => {
              if (err && !err.message.includes('no such table')) {
                reject(err);
                return;
              }
              
              resolve();
            });
          });
        });
      });
    });
  });
}