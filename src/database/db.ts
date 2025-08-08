import sqlite3 from 'sqlite3';
import { ScheduledPost, NostrAccount } from './schema.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class PostDatabase {
  private db: sqlite3.Database;

  constructor(dbPath?: string) {
    const dataDir = join(__dirname, '../../data');
    mkdirSync(dataDir, { recursive: true });
    
    const path = dbPath || join(dataDir, 'posts.db');
    this.db = new sqlite3.Database(path);
    this.initialize();
  }

  private initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Create accounts table
        this.db.run(`
          CREATE TABLE IF NOT EXISTS nostr_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            npub TEXT NOT NULL UNIQUE,
            api_endpoint TEXT,
            publish_method TEXT CHECK(publish_method IN ('api', 'nostrmq', 'direct')) DEFAULT 'direct',
            nostrmq_target TEXT,
            is_active BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          // Migration: Add new columns if they don't exist
          this.migrateDatabase().then(() => {
            
            // Create posts table with account reference
            this.db.run(`
              CREATE TABLE IF NOT EXISTS scheduled_posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                scheduled_for DATETIME NOT NULL,
                published_at DATETIME,
                status TEXT CHECK(status IN ('pending', 'published', 'failed')) DEFAULT 'pending',
                error_message TEXT,
                api_endpoint TEXT,
                account_id INTEGER,
                publish_method TEXT CHECK(publish_method IN ('api', 'nostrmq', 'direct')) DEFAULT 'direct',
                FOREIGN KEY (account_id) REFERENCES nostr_accounts(id)
              )
            `, (err) => {
              if (err) {
                reject(err);
                return;
              }
              
              // Check if we need to migrate from env var to default account
              this.migrateDefaultAccount().then(() => {
                resolve();
              }).catch(reject);
            });
          }).catch(reject);
        });
      });
    });
  }

  private async migrateDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if publish_method column exists
      this.db.get("PRAGMA table_info(nostr_accounts)", [], (err, result) => {
        if (err) {
          console.log('Error checking table schema:', err);
          resolve(); // Continue even if we can't check
          return;
        }
        
        // Add missing columns if they don't exist
        this.db.serialize(() => {
          this.db.run("ALTER TABLE nostr_accounts ADD COLUMN publish_method TEXT DEFAULT 'direct'", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add publish_method column (may already exist):', err.message);
            }
          });
          
          this.db.run("ALTER TABLE nostr_accounts ADD COLUMN nostrmq_target TEXT", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add nostrmq_target column (may already exist):', err.message);
            }
          });
          
          this.db.run("ALTER TABLE nostr_accounts ADD COLUMN nsec TEXT", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add nsec column (may already exist):', err.message);
            }
          });
          
          this.db.run("ALTER TABLE nostr_accounts ADD COLUMN relays TEXT", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add relays column (may already exist):', err.message);
            }
          });
          
          this.db.run("ALTER TABLE nostr_accounts ADD COLUMN keychain_ref TEXT", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add keychain_ref column (may already exist):', err.message);
            }
          });
          
          // Also migrate scheduled_posts table to add account_id column if missing
          this.db.run("ALTER TABLE scheduled_posts ADD COLUMN account_id INTEGER", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add account_id column to scheduled_posts (may already exist):', err.message);
            } else if (!err) {
              console.log('✅ Added account_id column to scheduled_posts table');
            }
          });
          
          // Add publish_method column to scheduled_posts if missing
          this.db.run("ALTER TABLE scheduled_posts ADD COLUMN publish_method TEXT DEFAULT 'direct'", (err) => {
            if (err && !err.message.includes('duplicate column')) {
              console.log('Could not add publish_method column to scheduled_posts (may already exist):', err.message);
            } else if (!err) {
              console.log('✅ Added publish_method column to scheduled_posts table');
            }
          });
          
          resolve();
        });
      });
    });
  }

  private async migrateDefaultAccount(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if any accounts exist
      this.db.get('SELECT COUNT(*) as count FROM nostr_accounts', [], (err, row: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        if (row.count === 0 && process.env.NOSTR_NPUB) {
          // Create default account from env var
          this.db.run(
            'INSERT INTO nostr_accounts (name, npub, api_endpoint, publish_method, is_active) VALUES (?, ?, ?, ?, ?)',
            ['Default Account', process.env.NOSTR_NPUB, process.env.NOSTR_API_ENDPOINT, 'api', 1],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        } else {
          resolve();
        }
      });
    });
  }

  addPost(content: string, scheduledFor: Date, accountId?: number, apiEndpoint?: string, publishMethod?: 'api' | 'nostrmq' | 'direct'): Promise<number> {
    console.log('💾 Database addPost called:', {
      content: content.substring(0, 50) + '...',
      scheduledFor: scheduledFor.toISOString(),
      accountId,
      apiEndpoint,
      publishMethod: publishMethod || 'direct'
    });
    
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO scheduled_posts (content, scheduled_for, account_id, api_endpoint, publish_method) VALUES (?, ?, ?, ?, ?)`,
        [content, scheduledFor.toISOString(), accountId || null, apiEndpoint || null, publishMethod || 'direct'],
        function(err) {
          if (err) {
            console.error('❌ Database insert error:', err);
            reject(err);
          } else {
            console.log(`✅ Database insert success, ID: ${this.lastID}`);
            resolve(this.lastID);
          }
        }
      );
    });
  }

  getPendingPosts(): Promise<ScheduledPost[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM scheduled_posts 
         WHERE status = 'pending' AND datetime(scheduled_for) <= datetime('now')
         ORDER BY scheduled_for ASC`,
        [],
        (err, rows) => {
          if (err) {
            console.error('❌ Database getPendingPosts error:', err);
            reject(err);
          } else {
            const posts = rows as ScheduledPost[];
            console.log(`🔍 getPendingPosts found ${posts.length} posts ready to publish`);
            if (posts.length > 0) {
              posts.forEach(post => {
                console.log(`  - Post ${post.id}: "${post.content.substring(0, 30)}..." (scheduled: ${post.scheduled_for})`);
              });
            }
            resolve(posts);
          }
        }
      );
    });
  }

  getUpcomingPosts(): Promise<ScheduledPost[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM scheduled_posts 
         WHERE status = 'pending'
         ORDER BY scheduled_for ASC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows as ScheduledPost[]);
        }
      );
    });
  }

  getAllPosts(accountId?: number): Promise<ScheduledPost[]> {
    return new Promise((resolve, reject) => {
      let query = `SELECT * FROM scheduled_posts`;
      let params: any[] = [];
      
      if (accountId) {
        query += ` WHERE account_id = ?`;
        params = [accountId];
      }
      
      query += ` ORDER BY scheduled_for DESC`;
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          console.error('❌ Database getAllPosts error:', err);
          reject(err);
        } else {
          const posts = rows as ScheduledPost[];
          const filterMsg = accountId ? ` for account ${accountId}` : '';
          console.log(`📊 getAllPosts found ${posts.length} posts${filterMsg} in database`);
          resolve(posts);
        }
      });
    });
  }

  markAsPublished(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE scheduled_posts 
         SET status = 'published', published_at = datetime('now')
         WHERE id = ?`,
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  markAsFailed(id: number, errorMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE scheduled_posts 
         SET status = 'failed', error_message = ?
         WHERE id = ?`,
        [errorMessage, id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  deletePost(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM scheduled_posts WHERE id = ?',
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // Account management methods
  addAccount(name: string, npub: string, publishMethod: 'api' | 'nostrmq' | 'direct' = 'direct', apiEndpoint?: string, nostrmqTarget?: string, nsec?: string, relays?: string, keychainRef?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO nostr_accounts (name, npub, api_endpoint, publish_method, nostrmq_target, nsec, relays, keychain_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [name, npub, apiEndpoint || null, publishMethod, nostrmqTarget || null, nsec || null, relays || null, keychainRef || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getAccounts(): Promise<NostrAccount[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM nostr_accounts ORDER BY created_at ASC',
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows as NostrAccount[]);
        }
      );
    });
  }

  getAccount(id: number): Promise<NostrAccount | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM nostr_accounts WHERE id = ?',
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row as NostrAccount || null);
        }
      );
    });
  }

  setActiveAccount(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Deactivate all accounts
        this.db.run('UPDATE nostr_accounts SET is_active = 0', [], (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          // Activate the selected account
          this.db.run(
            'UPDATE nostr_accounts SET is_active = 1 WHERE id = ?',
            [id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      });
    });
  }

  getActiveAccount(): Promise<NostrAccount | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM nostr_accounts WHERE is_active = 1 LIMIT 1',
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row as NostrAccount || null);
        }
      );
    });
  }

  deleteAccount(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // First delete all posts for this account
      this.db.run(
        'DELETE FROM scheduled_posts WHERE account_id = ?',
        [id],
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          // Then delete the account
          this.db.run(
            'DELETE FROM nostr_accounts WHERE id = ?',
            [id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        }
      );
    });
  }

  run(sql: string, params: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  close(): void {
    this.db.close();
  }
}

export default PostDatabase;