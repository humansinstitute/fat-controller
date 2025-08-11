import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { nip19 } from 'nostr-tools';
import PostDatabase from './database/db.js';
import { PostScheduler } from './scheduler.js';
import { storeNsecInKeychain, deleteNsecFromKeychain, generateKeychainReference, isKeychainAvailable } from './keychain.service.js';
import StatsSchedulerService from './services/stats-scheduler.service.js';
import StatsCollectionService from './services/stats-collection.service.js';
import BackgroundJobService from './services/background-jobs.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class WebServer {
  private app: express.Application;
  private db: PostDatabase;
  private port: number;
  private scheduler: PostScheduler | null = null;
  private statsScheduler: StatsSchedulerService | null = null;

  constructor(port: number = 3001, scheduler?: PostScheduler, statsScheduler?: StatsSchedulerService) {
    this.app = express();
    this.db = new PostDatabase();
    this.port = port;
    this.scheduler = scheduler || null;
    this.statsScheduler = statsScheduler || null;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  private setupRoutes() {
    // Note Management Endpoints
    
    // Get all notes with counts
    this.app.get('/api/notes', async (req, res) => {
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const notes = await this.db.getNotesWithCounts(accountId);
        res.json(notes);
      } catch (error) {
        console.error('Error fetching notes:', error);
        res.status(500).json({ error: 'Failed to fetch notes' });
      }
    });

    // Get notes by tags (must come before /api/notes/:id)
    this.app.get('/api/notes/by-tags', async (req, res) => {
      try {
        console.log('GET /api/notes/by-tags called with query:', req.query);
        const { tags, logic, accountId } = req.query;
        
        if (!tags) {
          return res.status(400).json({ error: 'Tags parameter is required' });
        }
        
        const tagArray = Array.isArray(tags) ? tags as string[] : (tags as string).split(',');
        const filterLogic = (logic === 'AND' || logic === 'OR') ? logic : 'OR';
        const account = accountId ? parseInt(accountId as string) : undefined;
        
        console.log('Calling getNotesByTags with:', { tagArray, filterLogic, account });
        const notes = await this.db.getNotesByTags(tagArray, filterLogic, account);
        console.log('getNotesByTags returned:', notes.length, 'notes');
        res.json(notes);
      } catch (error) {
        console.error('Error fetching notes by tags:', error);
        res.status(500).json({ error: 'Failed to fetch notes by tags' });
      }
    });

    // Get untagged notes (must come before /api/notes/:id)
    this.app.get('/api/notes/untagged', async (req, res) => {
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const notes = await this.db.getUntaggedNotes(accountId);
        res.json(notes);
      } catch (error) {
        console.error('Error fetching untagged notes:', error);
        res.status(500).json({ error: 'Failed to fetch untagged notes' });
      }
    });

    // Get specific note with its posts and stats
    this.app.get('/api/notes/:id', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        const data = await this.db.getNoteWithPosts(noteId);
        if (!data.note) {
          return res.status(404).json({ error: 'Note not found' });
        }

        // Get posts with stats
        const postsWithStats = await this.db.getAllPostsWithStats(noteId);
        
        // Get aggregate stats
        const aggregateStats = await this.db.getAggregateStats(noteId);

        res.json({
          note: data.note,
          posts: postsWithStats,
          aggregate_stats: aggregateStats
        });
      } catch (error) {
        console.error('Error fetching note:', error);
        res.status(500).json({ error: 'Failed to fetch note' });
      }
    });

    // Create new note
    this.app.post('/api/notes', async (req, res) => {
      try {
        const { content, title, accountId, metadata, tags, scheduleImmediately, scheduledFor } = req.body;
        
        if (!content || !accountId) {
          return res.status(400).json({ error: 'Content and accountId are required' });
        }
        
        // Create note
        const noteId = await this.db.addNote(content, title || null, accountId, metadata, tags);
        
        // Optionally schedule immediately
        if (scheduleImmediately && scheduledFor) {
          const postId = await this.db.schedulePostFromNote(
            noteId,
            new Date(scheduledFor),
            accountId
          );
          
          res.json({ 
            noteId, 
            postId,
            message: 'Note created and post scheduled successfully' 
          });
        } else {
          res.json({ noteId, message: 'Note created successfully' });
        }
      } catch (error) {
        console.error('Error creating note:', error);
        res.status(500).json({ error: 'Failed to create note' });
      }
    });

    // Schedule post from existing note
    this.app.post('/api/notes/:id/schedule', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        const { scheduledFor, accountId, apiEndpoint, publishMethod } = req.body;
        
        if (!scheduledFor || !accountId) {
          return res.status(400).json({ error: 'scheduledFor and accountId are required' });
        }
        
        // Validate that the scheduled date is not in the past
        const scheduledDate = new Date(scheduledFor);
        const now = new Date();
        if (scheduledDate < now) {
          return res.status(400).json({ error: 'Cannot schedule posts in the past' });
        }
        
        const postId = await this.db.schedulePostFromNote(
          noteId,
          scheduledDate,
          accountId,
          apiEndpoint,
          publishMethod as 'api' | 'nostrmq' | 'direct'
        );
        
        res.json({ postId, message: 'Post scheduled successfully' });
      } catch (error) {
        console.error('Error scheduling post:', error);
        res.status(500).json({ error: 'Failed to schedule post' });
      }
    });

    // Get all posts for a specific note
    this.app.get('/api/notes/:id/posts', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        const data = await this.db.getNoteWithPosts(noteId);
        res.json(data.posts);
      } catch (error) {
        console.error('Error fetching posts for note:', error);
        res.status(500).json({ error: 'Failed to fetch posts' });
      }
    });

    // Delete note (and all its posts)
    this.app.delete('/api/notes/:id', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        await this.db.deleteNote(noteId);
        res.json({ message: 'Note and all associated posts deleted successfully' });
      } catch (error) {
        console.error('Error deleting note:', error);
        res.status(500).json({ error: 'Failed to delete note' });
      }
    });

    // Update note tags
    this.app.put('/api/notes/:id/tags', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        const { tags } = req.body;
        
        if (!Array.isArray(tags)) {
          return res.status(400).json({ error: 'Tags must be an array' });
        }
        
        await this.db.updateNoteTags(noteId, tags);
        res.json({ message: 'Tags updated successfully', tags });
      } catch (error) {
        console.error('Error updating tags:', error);
        res.status(500).json({ error: 'Failed to update tags' });
      }
    });

    // Pin/Unpin note endpoints
    this.app.put('/api/notes/:id/pin', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        await this.db.pinNote(noteId);
        res.json({ message: 'Note pinned successfully' });
      } catch (error) {
        console.error('Error pinning note:', error);
        res.status(500).json({ error: 'Failed to pin note' });
      }
    });

    this.app.put('/api/notes/:id/unpin', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        await this.db.unpinNote(noteId);
        res.json({ message: 'Note unpinned successfully' });
      } catch (error) {
        console.error('Error unpinning note:', error);
        res.status(500).json({ error: 'Failed to unpin note' });
      }
    });

    // Get pinned notes
    this.app.get('/api/notes/pinned', async (req, res) => {
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const notes = await this.db.getPinnedNotes(accountId);
        res.json(notes);
      } catch (error) {
        console.error('Error fetching pinned notes:', error);
        res.status(500).json({ error: 'Failed to fetch pinned notes' });
      }
    });

    // Tag Management Endpoints

    // Get all tags with usage statistics
    this.app.get('/api/tags', async (req, res) => {
      try {
        const tags = await this.db.getAllTags();
        res.json(tags);
      } catch (error) {
        console.error('Error fetching tags:', error);
        res.status(500).json({ error: 'Failed to fetch tags' });
      }
    });

    // Post Management Endpoints (Legacy compatibility)
    
    // Get all posts (optionally filtered by account)
    this.app.get('/api/posts', async (req, res) => {
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const posts = await this.db.getAllPosts(accountId);
        res.json(posts);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch posts' });
      }
    });

    // Get pending posts
    this.app.get('/api/posts/pending', async (req, res) => {
      try {
        const posts = await this.db.getUpcomingPosts();
        res.json(posts);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch pending posts' });
      }
    });

    // Create single post
    this.app.post('/api/posts', async (req, res) => {
      try {
        const { content, scheduledFor, accountId, apiEndpoint, publishMethod } = req.body;
        
        console.log('📝 Creating single post:', {
          content: content?.substring(0, 50) + '...',
          scheduledFor,
          accountId,
          apiEndpoint,
          publishMethod
        });
        
        if (!content || !scheduledFor) {
          return res.status(400).json({ error: 'Content and scheduledFor are required' });
        }
        
        const scheduledDate = new Date(scheduledFor);
        console.log(`⏰ Scheduled date parsed: ${scheduledDate.toISOString()}`);
        
        // Validate that the scheduled date is not in the past
        const now = new Date();
        if (scheduledDate < now) {
          return res.status(400).json({ error: 'Cannot schedule posts in the past' });
        }
        
        const method = publishMethod === 'nostrmq' ? 'nostrmq' : (publishMethod === 'api' ? 'api' : 'direct');
        const id = await this.db.addPost(content, scheduledDate, accountId, apiEndpoint, method);
        console.log(`✅ Created single post with ID: ${id} using method: ${method}`);
        
        // Check if this is an immediate post (scheduled within the next 2 minutes)
        const timeDiff = scheduledDate.getTime() - now.getTime();
        const isImmediate = timeDiff <= 2 * 60 * 1000; // 2 minutes in milliseconds
        
        if (isImmediate) {
          console.log(`🚀 Post ${id} is scheduled for immediate publishing (${Math.round(timeDiff/1000)}s from now)`);
          
          // Trigger immediate publishing if we have a scheduler instance
          if (this.scheduler) {
            try {
              console.log(`⚡ Publishing post ${id} immediately`);
              await this.scheduler.publishNow(id);
              console.log(`✅ Post ${id} published immediately`);
            } catch (error) {
              console.error(`❌ Failed to publish post ${id} immediately:`, error);
              // Don't fail the request if publishing fails - the post is still scheduled
            }
          } else {
            console.log(`⚠️ No scheduler instance available for immediate publishing of post ${id}`);
          }
        }
        
        res.json({ 
          id, 
          message: isImmediate ? 'Post created and published immediately' : 'Post scheduled successfully',
          scheduledFor: scheduledDate.toISOString(),
          publishedImmediately: isImmediate
        });
      } catch (error) {
        console.error('❌ Error creating single post:', error);
        res.status(500).json({ error: 'Failed to create post' });
      }
    });

    // Create batch posts (every 3 hours for 24 hours) - legacy endpoint
    this.app.post('/api/posts/batch', async (req, res) => {
      try {
        const { content, apiEndpoint, publishMethod } = req.body;
        
        if (!content) {
          return res.status(400).json({ error: 'Content is required' });
        }
        
        const now = new Date();
        const times = [0, 3, 6, 9, 12, 15, 18, 21];
        const ids = [];
        const method = publishMethod === 'nostrmq' ? 'nostrmq' : (publishMethod === 'api' ? 'api' : 'direct');
        
        for (const hours of times) {
          const scheduledFor = new Date(now);
          scheduledFor.setHours(scheduledFor.getHours() + hours);
          const id = await this.db.addPost(content, scheduledFor, undefined, apiEndpoint, method);
          ids.push(id);
        }
        
        res.json({ 
          ids,
          message: `Created ${ids.length} scheduled posts over 24 hours`
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to create batch posts' });
      }
    });

    // Create custom batch posts with flexible intervals
    this.app.post('/api/posts/batch-custom', async (req, res) => {
      try {
        const { content, startTime, intervals, intervalHours, repeatCount, accountId, apiEndpoint, publishMethod } = req.body;
        
        console.log('📝 Creating batch posts:', {
          content: content?.substring(0, 50) + '...',
          startTime,
          intervals,
          intervalHours,
          repeatCount,
          accountId,
          apiEndpoint,
          publishMethod
        });
        
        // Support both old intervals array and new intervalHours/repeatCount params
        let computedIntervals = intervals;
        if (!intervals && intervalHours !== undefined && repeatCount !== undefined) {
          // Generate intervals based on intervalHours and repeatCount
          computedIntervals = [];
          for (let i = 0; i < repeatCount; i++) {
            computedIntervals.push(i * intervalHours);
          }
        }
        
        if (!content || !startTime || !computedIntervals) {
          return res.status(400).json({ error: 'Content, startTime, and intervals (or intervalHours/repeatCount) are required' });
        }
        
        const start = new Date(startTime);
        console.log(`⏰ Start time parsed: ${start.toISOString()}`);
        
        // Validate that the start time is not in the past
        const now = new Date();
        if (start < now) {
          return res.status(400).json({ error: 'Cannot schedule posts in the past' });
        }
        
        const ids = [];
        const method = publishMethod === 'nostrmq' ? 'nostrmq' : (publishMethod === 'api' ? 'api' : 'direct');
        
        for (const hoursOffset of computedIntervals) {
          const scheduledFor = new Date(start);
          scheduledFor.setHours(scheduledFor.getHours() + hoursOffset);
          console.log(`📅 Creating post for: ${scheduledFor.toISOString()} (${hoursOffset}h offset)`);
          
          // Skip posts that would be scheduled in the past
          if (scheduledFor < now) {
            console.log(`⚠️ Skipping post scheduled for ${scheduledFor.toISOString()} (in the past)`);
            continue;
          }
          
          const id = await this.db.addPost(content, scheduledFor, accountId, apiEndpoint, method);
          console.log(`✅ Created post with ID: ${id} using method: ${method}`);
          
          ids.push({
            id,
            scheduledFor: scheduledFor.toISOString()
          });
        }
        
        console.log(`🎉 Successfully created ${ids.length} batch posts`);
        
        res.json({ 
          ids,
          message: `Created ${ids.length} scheduled posts`,
          details: ids
        });
      } catch (error) {
        console.error('❌ Error creating custom batch posts:', error);
        res.status(500).json({ error: 'Failed to create batch posts' });
      }
    });

    // Delete post
    this.app.delete('/api/posts/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        await this.db.deletePost(id);
        res.json({ message: 'Post deleted successfully' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to delete post' });
      }
    });

    // Publish post now (manual trigger)
    this.app.post('/api/posts/:id/publish', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        console.log(`\n🎯 Manual publish request received for post ${id}`);
        
        if (!this.scheduler) {
          // If no scheduler instance, create a temporary one for manual publishing
          const tempScheduler = new PostScheduler();
          await tempScheduler.publishNow(id);
          tempScheduler.stop();
        } else {
          await this.scheduler.publishNow(id);
        }
        
        res.json({ message: `Post ${id} published successfully` });
      } catch (error) {
        console.error('Error in manual publish endpoint:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: errorMessage });
      }
    });

    // Stats management endpoints
    
    // Manual refresh stats for a note
    this.app.post('/api/notes/:id/refresh-stats', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        
        if (!this.statsScheduler) {
          return res.status(503).json({ error: 'Stats service not available' });
        }

        // Verify note exists
        const { note } = await this.db.getNoteWithPosts(noteId);
        if (!note) {
          return res.status(404).json({ error: 'Note not found' });
        }

        // Queue manual refresh job
        const jobId = this.statsScheduler.triggerNoteStatsRefresh(noteId, req.body.user_id);
        
        res.json({
          message: 'Stats refresh initiated',
          job_id: jobId,
          note_id: noteId
        });
      } catch (error) {
        console.error('Error refreshing stats:', error);
        res.status(500).json({ error: 'Failed to refresh stats' });
      }
    });

    // Get aggregate stats for a note
    this.app.get('/api/notes/:id/aggregate-stats', async (req, res) => {
      try {
        const noteId = parseInt(req.params.id);
        const stats = await this.db.getAggregateStats(noteId);
        res.json(stats);
      } catch (error) {
        console.error('Error fetching aggregate stats:', error);
        res.status(500).json({ error: 'Failed to fetch aggregate stats' });
      }
    });

    // Get stats for a specific post
    this.app.get('/api/posts/:id/stats', async (req, res) => {
      try {
        const postId = parseInt(req.params.id);
        const stats = await this.db.getPostStats(postId);
        
        if (!stats) {
          return res.status(404).json({ error: 'Post stats not found' });
        }
        
        res.json(stats);
      } catch (error) {
        console.error('Error fetching post stats:', error);
        res.status(500).json({ error: 'Failed to fetch post stats' });
      }
    });

    // Get stats scheduler status (admin endpoint)
    this.app.get('/api/stats/status', async (req, res) => {
      try {
        if (!this.statsScheduler) {
          return res.json({
            stats_service_available: false,
            message: 'Stats scheduler not initialized'
          });
        }

        const status = this.statsScheduler.getSchedulerStatus();
        res.json({
          stats_service_available: true,
          ...status
        });
      } catch (error) {
        console.error('Error fetching stats status:', error);
        res.status(500).json({ error: 'Failed to fetch stats status' });
      }
    });

    // Trigger manual stats collection (admin endpoint)
    this.app.post('/api/stats/collect', async (req, res) => {
      try {
        if (!this.statsScheduler) {
          return res.status(503).json({ error: 'Stats service not available' });
        }

        const jobId = this.statsScheduler.triggerManualStatsCollection();
        
        res.json({
          message: 'Manual stats collection initiated',
          job_id: jobId
        });
      } catch (error) {
        console.error('Error triggering stats collection:', error);
        res.status(500).json({ error: 'Failed to trigger stats collection' });
      }
    });

    // Get background job status
    this.app.get('/api/stats/jobs/:id', async (req, res) => {
      try {
        const jobId = req.params.id;
        
        if (!this.statsScheduler) {
          return res.status(503).json({ error: 'Stats service not available' });
        }

        const backgroundJobs = this.statsScheduler.getBackgroundJobService();
        const job = backgroundJobs.getJob(jobId);
        
        if (!job) {
          return res.status(404).json({ error: 'Job not found' });
        }
        
        res.json(job);
      } catch (error) {
        console.error('Error fetching job status:', error);
        res.status(500).json({ error: 'Failed to fetch job status' });
      }
    });

    // List all background jobs (admin endpoint)
    this.app.get('/api/stats/jobs', async (req, res) => {
      try {
        if (!this.statsScheduler) {
          return res.status(503).json({ error: 'Stats service not available' });
        }

        const backgroundJobs = this.statsScheduler.getBackgroundJobService();
        const jobs = backgroundJobs.getAllJobs();
        
        res.json({
          jobs,
          total: jobs.length
        });
      } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
      }
    });

    // Account management endpoints
    
    // Get all accounts
    this.app.get('/api/accounts', async (req, res) => {
      try {
        const accounts = await this.db.getAccounts();
        // Convert hex nostrmq_target back to npub for display
        const accountsWithNpub = accounts.map(account => {
          if (account.publish_method === 'nostrmq' && account.nostrmq_target) {
            try {
              const npubTarget = nip19.npubEncode(account.nostrmq_target);
              return {
                ...account,
                nostrmq_target_display: npubTarget
              };
            } catch (error) {
              console.warn('Failed to convert hex to npub for display:', error);
            }
          }
          return account;
        });
        res.json(accountsWithNpub);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch accounts' });
      }
    });

    // Add new account
    this.app.post('/api/accounts', async (req, res) => {
      try {
        const { name, npub, nsec, publishMethod, apiEndpoint, nostrmqTarget, relays } = req.body;
        
        console.log('Adding new account:', { 
          name, 
          npub: npub?.substring(0, 20) + '...', 
          hasNsec: !!nsec,
          publishMethod, 
          apiEndpoint, 
          nostrmqTarget: nostrmqTarget?.substring(0, 20) + '...',
          relays: relays?.split(',').length || 0 
        });
        
        if (!name || !npub || !publishMethod) {
          return res.status(400).json({ error: 'Name, npub, and publishMethod are required' });
        }
        
        if (publishMethod === 'nostrmq' && !nostrmqTarget) {
          return res.status(400).json({ error: 'NostrMQ target is required for NostrMQ publishing method' });
        }
        
        if (publishMethod === 'direct' && !nsec) {
          return res.status(400).json({ error: 'Private key (nsec) is required for direct publishing method' });
        }
        
        let convertedTarget = nostrmqTarget;
        
        // Convert npub to hex for NostrMQ target
        if (publishMethod === 'nostrmq' && nostrmqTarget) {
          try {
            if (nostrmqTarget.startsWith('npub1')) {
              // Use a different approach - create a temporary validation and extract the hex
              try {
                const decoded = nip19.decode(nostrmqTarget);
                convertedTarget = decoded.data as unknown as string;
                console.log(`Converted npub ${nostrmqTarget.substring(0, 20)}... to hex ${convertedTarget.substring(0, 20)}...`);
              } catch (decodeError) {
                return res.status(400).json({ error: 'Invalid npub format' });
              }
            } else {
              // Assume it's already hex, validate it's a valid hex string
              if (!/^[0-9a-fA-F]{64}$/.test(nostrmqTarget)) {
                return res.status(400).json({ error: 'NostrMQ target must be a valid npub or 64-character hex string' });
              }
              convertedTarget = nostrmqTarget.toLowerCase();
            }
          } catch (error) {
            console.error('Error converting npub to hex:', error);
            return res.status(400).json({ error: 'Invalid npub format for NostrMQ target' });
          }
        }
        
        // Store nsec in keychain if provided for direct publishing
        let keychainRef: string | undefined;
        let storedInKeychain = false;
        
        if (publishMethod === 'direct' && nsec) {
          // Check if keychain is available
          const keychainAvailable = await isKeychainAvailable();
          if (!keychainAvailable) {
            console.warn('⚠️ Keychain not available, storing key in database (less secure)');
          }
        }
        
        // Add account to database first to get the ID
        const id = await this.db.addAccount(name, npub, (publishMethod as 'api' | 'nostrmq' | 'direct') || 'direct', apiEndpoint, convertedTarget, undefined, relays, undefined);
        
        // Now store the key in keychain if we have one (required for direct publishing)
        if (nsec && id) {
          const keychainAvailable = await isKeychainAvailable();
          if (keychainAvailable) {
            storedInKeychain = await storeNsecInKeychain(id, nsec);
            if (storedInKeychain) {
              keychainRef = generateKeychainReference(id);
              // Update the account with the keychain reference
              await this.db.run(
                'UPDATE nostr_accounts SET keychain_ref = ? WHERE id = ?',
                [keychainRef, id]
              );
              console.log(`✅ Private key stored securely in macOS Keychain for account ${id}`);
            }
          }
          
          // If keychain storage failed, we cannot proceed with direct publishing
          if (!storedInKeychain && publishMethod === 'direct') {
            // Delete the account since we can't store the key securely
            await this.db.run('DELETE FROM nostr_accounts WHERE id = ?', [id]);
            return res.status(500).json({ 
              error: 'Failed to store private key securely. Please ensure Keychain access is available.' 
            });
          }
        }
        
        res.json({ 
          id, 
          message: 'Account added successfully',
          keyStorageMethod: storedInKeychain ? 'keychain' : 'none'
        });
      } catch (error) {
        console.error('Error adding account:', error);
        res.status(500).json({ error: 'Failed to add account' });
      }
    });

    // Activate account
    this.app.post('/api/accounts/:id/activate', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        await this.db.setActiveAccount(id);
        res.json({ message: 'Account activated successfully' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to activate account' });
      }
    });

    // Delete account
    this.app.delete('/api/accounts/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        
        // Try to delete from keychain first
        const keychainDeleted = await deleteNsecFromKeychain(id);
        if (keychainDeleted) {
          console.log(`🗑️ Deleted private key from keychain for account ${id}`);
        }
        
        await this.db.deleteAccount(id);
        res.json({ message: 'Account deleted successfully' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to delete account' });
      }
    });

    // Health check
    this.app.get('/api/health', async (req, res) => {
      const keychainAvailable = await isKeychainAvailable();
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        keychain: {
          available: keychainAvailable,
          platform: process.platform,
          message: keychainAvailable 
            ? 'Private keys will be stored securely in macOS Keychain' 
            : 'Keychain not available - keys will be stored in database (less secure)'
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.app.listen(this.port, '0.0.0.0', () => {
        const address = server.address();
        const host = address && typeof address !== 'string' ? address.address : '0.0.0.0';
        const port = address && typeof address !== 'string' ? address.port : this.port;
        console.log(`🌐 Web UI listening on ${host}:${port}`);
        console.log(`   Access at: http://localhost:${port}`);
        resolve();
      });
    });
  }

  stop() {
    this.db.close();
  }
}