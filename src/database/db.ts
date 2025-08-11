import sqlite3 from 'sqlite3';
import { ScheduledPost, NostrAccount, Note, NoteWithCounts, Post, PostStats, AggregateStats, TagInfo } from './schema.js';
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
              tags TEXT,
              pinned BOOLEAN DEFAULT 0,
              FOREIGN KEY (account_id) REFERENCES nostr_accounts(id)
            )
          `, (err) => {
            if (err) {
              reject(err);
              return;
            }
            
            // Add pinned column to existing tables that don't have it
            this.db.run(`
              ALTER TABLE notes ADD COLUMN pinned BOOLEAN DEFAULT 0
            `, (err) => {
              // Ignore error if column already exists
              if (err && !err.message.includes('duplicate column name')) {
                console.error('Migration error adding pinned column:', err);
              }
            });
            
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
              
              // Create post_stats table
              this.db.run(`
                CREATE TABLE IF NOT EXISTS post_stats (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  post_id INTEGER NOT NULL,
                  likes INTEGER DEFAULT 0,
                  reposts INTEGER DEFAULT 0,
                  zap_amount INTEGER DEFAULT 0,
                  last_updated TEXT NOT NULL,
                  status TEXT NOT NULL CHECK (status IN ('success', 'unknown', 'error')),
                  error_message TEXT,
                  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
                  UNIQUE(post_id)
                )
              `, (err) => {
                if (err) {
                  reject(err);
                  return;
                }
                
                // Create indexes
                this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_account_id ON notes(account_id)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes(tags)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_note_id ON posts(note_id)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_event_id ON posts(event_id)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_posts_scheduled_for ON posts(scheduled_for)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_post_stats_post_id ON post_stats(post_id)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_post_stats_status ON post_stats(status)');
                this.db.run('CREATE INDEX IF NOT EXISTS idx_post_stats_last_updated ON post_stats(last_updated)');
                
                resolve();
              });
            });
          });
        });
      });
    });
  }

  // Note management methods
  addNote(content: string, title: string | null, accountId: number, metadata?: string, tags?: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO notes (content, title, account_id, metadata, tags) VALUES (?, ?, ?, ?, ?)',
        [content, title, accountId, metadata || null, tags ? JSON.stringify(tags) : null],
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
      
      query += ' GROUP BY n.id ORDER BY n.pinned DESC, n.created_at DESC';
      
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

  deleteNote(id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // First delete all posts for this note
        this.db.run('DELETE FROM posts WHERE note_id = ?', [id], (err) => {
          if (err) {
            reject(err);
            return;
          }
        });
        
        // Then delete the note
        this.db.run('DELETE FROM notes WHERE id = ?', [id], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
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

  // PostStats management methods
  createOrUpdatePostStats(postId: number, stats: Omit<PostStats, 'id' | 'post_id' | 'created_at'>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(`
        INSERT OR REPLACE INTO post_stats 
        (post_id, likes, reposts, zap_amount, last_updated, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [postId, stats.likes, stats.reposts, stats.zap_amount, stats.last_updated, stats.status, stats.error_message || null], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getPostStats(postId: number): Promise<PostStats | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM post_stats WHERE post_id = ?',
        [postId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row as PostStats || null);
        }
      );
    });
  }

  getAllPostsWithStats(noteId: number): Promise<(Post & {content: string, stats?: PostStats})[]> {
    return new Promise((resolve, reject) => {
      this.db.all(`
        SELECT 
          p.*,
          n.content,
          ps.likes,
          ps.reposts,
          ps.zap_amount,
          ps.last_updated as stats_last_updated,
          ps.status as stats_status,
          ps.error_message as stats_error
        FROM posts p
        JOIN notes n ON p.note_id = n.id
        LEFT JOIN post_stats ps ON p.id = ps.post_id
        WHERE p.note_id = ?
        ORDER BY p.scheduled_for ASC
      `, [noteId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const postsWithStats = (rows as any[]).map(row => {
            const post: Post & {content: string, stats?: PostStats} = {
              id: row.id,
              note_id: row.note_id,
              scheduled_for: row.scheduled_for,
              published_at: row.published_at,
              status: row.status,
              error_message: row.error_message,
              event_id: row.event_id,
              primal_url: row.primal_url,
              api_endpoint: row.api_endpoint,
              account_id: row.account_id,
              publish_method: row.publish_method,
              content: row.content
            };
            
            if (row.stats_status) {
              post.stats = {
                post_id: row.id,
                likes: row.likes || 0,
                reposts: row.reposts || 0,
                zap_amount: row.zap_amount || 0,
                last_updated: row.stats_last_updated,
                status: row.stats_status,
                error_message: row.stats_error
              };
            }
            
            return post;
          });
          resolve(postsWithStats);
        }
      });
    });
  }

  getAggregateStats(noteId: number): Promise<AggregateStats> {
    return new Promise((resolve, reject) => {
      this.db.get(`
        SELECT 
          ? as note_id,
          COALESCE(SUM(CASE WHEN ps.status = 'success' THEN ps.likes ELSE 0 END), 0) as total_likes,
          COALESCE(SUM(CASE WHEN ps.status = 'success' THEN ps.reposts ELSE 0 END), 0) as total_reposts,
          COALESCE(SUM(CASE WHEN ps.status = 'success' THEN ps.zap_amount ELSE 0 END), 0) as total_zap_amount,
          COUNT(ps.id) as posts_with_stats,
          (SELECT COUNT(*) FROM posts WHERE note_id = ? AND status = 'published') as total_posts,
          COALESCE(MAX(ps.last_updated), '') as last_updated
        FROM posts p
        LEFT JOIN post_stats ps ON p.id = ps.post_id
        WHERE p.note_id = ? AND p.status = 'published'
      `, [noteId, noteId, noteId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row as AggregateStats);
        }
      });
    });
  }

  getPostsForStatsCollection(maxAge?: number): Promise<Post[]> {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT p.*, n.content 
        FROM posts p
        JOIN notes n ON p.note_id = n.id
        WHERE p.status = 'published' 
        AND p.event_id IS NOT NULL
      `;
      
      const params: any[] = [];
      
      if (maxAge) {
        query += ` AND datetime(p.published_at) > datetime('now', '-${maxAge} hours')`;
      }
      
      // Exclude posts that have been successfully updated in the last hour
      query += ` AND p.id NOT IN (
        SELECT post_id FROM post_stats 
        WHERE status = 'success' 
        AND datetime(last_updated) > datetime('now', '-1 hour')
      )`;
      
      query += ` ORDER BY p.published_at DESC`;
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const posts = (rows as any[]).map(row => ({
            ...row,
            content: row.content
          }));
          resolve(posts);
        }
      });
    });
  }

  // Tag management methods
  updateNoteTags(noteId: number, tags: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE notes SET tags = ? WHERE id = ?',
        [tags.length > 0 ? JSON.stringify(tags) : null, noteId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getAllTags(): Promise<TagInfo[]> {
    return new Promise((resolve, reject) => {
      // Don't group by tags - get all notes with tags to count properly
      this.db.all(
        `SELECT tags, created_at 
         FROM notes 
         WHERE tags IS NOT NULL AND tags != '[]'`,
        [],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          
          // Parse and aggregate tags from all notes
          const tagMap = new Map<string, TagInfo>();
          
          (rows as any[]).forEach(row => {
            try {
              const tags = JSON.parse(row.tags);
              if (Array.isArray(tags)) {
                tags.forEach(tag => {
                  const existing = tagMap.get(tag);
                  if (existing) {
                    existing.count += 1;
                    if (row.created_at > (existing.lastUsed || '')) {
                      existing.lastUsed = row.created_at;
                    }
                  } else {
                    tagMap.set(tag, {
                      name: tag,
                      count: 1,
                      lastUsed: row.created_at
                    });
                  }
                });
              }
            } catch (e) {
              console.error('Error parsing tags:', e);
            }
          });
          
          const sortedTags = Array.from(tagMap.values()).sort((a, b) => b.count - a.count);
          resolve(sortedTags);
        }
      );
    });
  }

  getNotesByTags(tags: string[], logic: 'AND' | 'OR' = 'OR', accountId?: number): Promise<NoteWithCounts[]> {
    return new Promise((resolve, reject) => {
      console.log('Database getNotesByTags called with:', { tags, logic, accountId });
      let query = `
        SELECT 
          n.*,
          COUNT(CASE WHEN p.status = 'published' THEN 1 END) as published_count,
          COUNT(CASE WHEN p.status = 'pending' THEN 1 END) as upcoming_count
        FROM notes n
        LEFT JOIN posts p ON n.id = p.note_id
        WHERE 1=1
      `;
      
      const params: any[] = [];
      
      if (accountId) {
        query += ' AND n.account_id = ?';
        params.push(accountId);
      }
      
      if (tags.length > 0) {
        if (logic === 'OR') {
          // Match any of the tags
          const tagConditions = tags.map(tag => 
            `json_extract(n.tags, '$') LIKE '%"' || ? || '"%'`
          ).join(' OR ');
          query += ` AND (${tagConditions})`;
          params.push(...tags);
        } else {
          // Match all tags
          tags.forEach(tag => {
            query += ` AND json_extract(n.tags, '$') LIKE '%"' || ? || '"%'`;
            params.push(tag);
          });
        }
      }
      
      query += ' GROUP BY n.id ORDER BY n.created_at DESC';
      
      console.log('Executing SQL:', query);
      console.log('With params:', params);
      
      this.db.all(query, params, (err, rows) => {
        if (err) {
          console.error('SQL Error:', err);
          reject(err);
        } else {
          console.log('SQL returned', rows?.length, 'rows');
          resolve(rows as NoteWithCounts[]);
        }
      });
    });
  }

  getUntaggedNotes(accountId?: number): Promise<NoteWithCounts[]> {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT 
          n.*,
          COUNT(CASE WHEN p.status = 'published' THEN 1 END) as published_count,
          COUNT(CASE WHEN p.status = 'pending' THEN 1 END) as upcoming_count
        FROM notes n
        LEFT JOIN posts p ON n.id = p.note_id
        WHERE (n.tags IS NULL OR n.tags = '[]')
      `;
      
      const params: any[] = [];
      if (accountId) {
        query += ' AND n.account_id = ?';
        params.push(accountId);
      }
      
      query += ' GROUP BY n.id ORDER BY n.created_at DESC';
      
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as NoteWithCounts[]);
      });
    });
  }

  // Pin/Unpin methods
  pinNote(noteId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE notes SET pinned = 1 WHERE id = ?',
        [noteId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  unpinNote(noteId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE notes SET pinned = 0 WHERE id = ?',
        [noteId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  getPinnedNotes(accountId?: number): Promise<NoteWithCounts[]> {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT 
          n.*,
          COUNT(CASE WHEN p.status = 'published' THEN 1 END) as published_count,
          COUNT(CASE WHEN p.status = 'pending' THEN 1 END) as upcoming_count
        FROM notes n
        LEFT JOIN posts p ON n.id = p.note_id
        WHERE n.pinned = 1
      `;
      
      const params: any[] = [];
      if (accountId) {
        query += ' AND n.account_id = ?';
        params.push(accountId);
      }
      
      query += ' GROUP BY n.id ORDER BY n.created_at DESC';
      
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as NoteWithCounts[]);
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