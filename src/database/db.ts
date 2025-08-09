import sqlite3 from 'sqlite3';
import { ScheduledPost, NostrAccount, Note, NoteWithCounts, Post } from './schema.js';
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            keychain_ref TEXT,
            nsec TEXT,
            relays TEXT
          )
        `, (err) => {
          if (err) {
            reject(err);
            return;
          }
          
          // Create notes table
          this.db.run(`
            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              content TEXT NOT NULL,
              title TEXT,
              account_id INTEGER NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              metadata TEXT,
              FOREIGN KEY (account_id) REFERENCES nostr_accounts(id)
            )
          `, (err) => {
            if (err) {
              reject(err);
              return;
            }
            
            // Create posts table (replacing scheduled_posts)
            this.db.run(`
              CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                scheduled_for DATETIME NOT NULL,
                published_at DATETIME,
                status TEXT CHECK(status IN ('pending', 'published', 'failed')) DEFAULT 'pending',
                error_message TEXT,
                event_id TEXT,
                primal_url TEXT,
                api_endpoint TEXT,
                account_id INTEGER,
                publish_method TEXT CHECK(publish_method IN ('api', 'nostrmq', 'direct')) DEFAULT 'direct',
                FOREIGN KEY (note_id) REFERENCES notes(id),
                FOREIGN KEY (account_id) REFERENCES nostr_accounts(id)
              )
            `, (err) => {
              if (err) {
                reject(err);
                return;
              }
              
              // Create indexes
              this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_account_id ON notes(account_id)');
              this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at)');
              this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_note_id ON posts(note_id)');
              this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_event_id ON posts(event_id)');
              this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status)');
              this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_scheduled_for ON posts(scheduled_for)');
              
              resolve();
            });
          });
        });
      });
    });
  }

  // Note management methods
  addNote(content: string, title: string | null, accountId: number, metadata?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO notes (content, title, account_id, metadata) VALUES (?, ?, ?, ?)',
        [content, title, accountId, metadata || null],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  getNotesWithCounts(accountId?: number): Promise<NoteWithCounts[]> {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT 
          n.*,
          COUNT(CASE WHEN p.status = 'published' THEN 1 END) as published_count,
          COUNT(CASE WHEN p.status = 'pending' THEN 1 END) as upcoming_count
        FROM notes n
        LEFT JOIN posts p ON n.id = p.note_id
      `;
      
      const params: any[] = [];
      if (accountId) {
        query += ' WHERE n.account_id = ?';
        params.push(accountId);
      }
      
      query += ' GROUP BY n.id ORDER BY n.created_at DESC';
      
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as NoteWithCounts[]);
      });
    });
  }

  getNoteWithPosts(noteId: number): Promise<{note: Note | null, posts: Post[]}> {
    return new Promise((resolve, reject) => {
      // Get the note
      this.db.get(
        'SELECT * FROM notes WHERE id = ?',
        [noteId],
        (err, note) => {
          if (err) {
            reject(err);
            return;
          }
          
          if (!note) {
            resolve({ note: null, posts: [] });
            return;
          }
          
          // Get all posts for this note
          this.db.all(
            'SELECT * FROM posts WHERE note_id = ? ORDER BY scheduled_for ASC',
            [noteId],
            (err, posts) => {
              if (err) reject(err);
              else resolve({ note: note as Note, posts: posts as Post[] });
            }
          );
        }
      );
    });
  }

  schedulePostFromNote(noteId: number, scheduledFor: Date, accountId: number, apiEndpoint?: string, publishMethod?: 'api' | 'nostrmq' | 'direct'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO posts (note_id, scheduled_for, account_id, api_endpoint, publish_method) VALUES (?, ?, ?, ?, ?)',
        [noteId, scheduledFor.toISOString(), accountId, apiEndpoint || null, publishMethod || 'direct'],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  updatePostEventDetails(postId: number, eventId: string, primalUrl?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = primalUrl || `https://primal.net/e/${eventId}`;
      this.db.run(
        'UPDATE posts SET event_id = ?, primal_url = ? WHERE id = ?',
        [eventId, url, postId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // Legacy method - creates a note and immediately schedules a post
  addPost(content: string, scheduledFor: Date, accountId?: number, apiEndpoint?: string, publishMethod?: 'api' | 'nostrmq' | 'direct'): Promise<number> {
    console.log('💾 Database addPost called (legacy):', {
      content: content.substring(0, 50) + '...',
      scheduledFor: scheduledFor.toISOString(),
      accountId,
      apiEndpoint,
      publishMethod: publishMethod || 'direct'
    });
    
    return new Promise(async (resolve, reject) => {
      try {
        // First create a note
        const noteId = await this.addNote(content, null, accountId || 1);
        
        // Then schedule a post from that note
        const postId = await this.schedulePostFromNote(
          noteId,
          scheduledFor,
          accountId || 1,
          apiEndpoint,
          publishMethod
        );
        
        console.log(`✅ Created note ${noteId} and post ${postId}`);
        resolve(postId);
      } catch (err) {
        console.error('❌ Database insert error:', err);
        reject(err);
      }
    });
  }

  getPendingPosts(): Promise<Post[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT p.*, n.content 
         FROM posts p
         JOIN notes n ON p.note_id = n.id
         WHERE p.status = 'pending' AND datetime(p.scheduled_for) <= datetime('now')
         ORDER BY p.scheduled_for ASC`,
        [],
        (err, rows) => {
          if (err) {
            console.error('❌ Database getPendingPosts error:', err);
            reject(err);
          } else {
            // Transform to include content in post object for backward compatibility
            const posts = (rows as any[]).map(row => ({
              ...row,
              content: row.content // Add content from joined note
            }));
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

  getUpcomingPosts(): Promise<Post[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT p.*, n.content
         FROM posts p
         JOIN notes n ON p.note_id = n.id
         WHERE p.status = 'pending'
         ORDER BY p.scheduled_for ASC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else {
            // Transform to include content for backward compatibility
            const posts = (rows as any[]).map(row => ({
              ...row,
              content: row.content
            }));
            resolve(posts);
          }
        }
      );
    });
  }

  getAllPosts(accountId?: number): Promise<Post[]> {
    return new Promise((resolve, reject) => {
      let query = `SELECT p.*, n.content FROM posts p JOIN notes n ON p.note_id = n.id`;
      let params: any[] = [];
      
      if (accountId) {
        query += ` WHERE p.account_id = ?`;
        params = [accountId];
      }
      
      query += ` ORDER BY p.scheduled_for DESC`;
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          console.error('❌ Database getAllPosts error:', err);
          reject(err);
        } else {
          // Transform to include content for backward compatibility
          const posts = (rows as any[]).map(row => ({
            ...row,
            content: row.content
          }));
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
        `UPDATE posts 
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
        `UPDATE posts 
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
        'DELETE FROM posts WHERE id = ?',
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getPost(id: number): Promise<Post & {content: string} | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT p.*, n.content 
         FROM posts p 
         JOIN notes n ON p.note_id = n.id 
         WHERE p.id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row as Post & {content: string} : null);
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
      this.db.serialize(() => {
        // First delete all posts for this account
        this.db.run('DELETE FROM posts WHERE account_id = ?', [id], (err) => {
          if (err) {
            reject(err);
            return;
          }
        });
        
        // Then delete all notes for this account
        this.db.run('DELETE FROM notes WHERE account_id = ?', [id], (err) => {
          if (err) {
            reject(err);
            return;
          }
        });
        
        // Finally delete the account
        this.db.run('DELETE FROM nostr_accounts WHERE id = ?', [id], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
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