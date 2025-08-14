import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools';
import PostDatabase from './database/db.js';
import { PostScheduler } from './scheduler.js';
import { storeNsecInKeychain, deleteNsecFromKeychain, generateKeychainReference, isKeychainAvailable, getNsecFromKeychain } from './keychain.service.js';
import StatsSchedulerService from './services/stats-scheduler.service.js';
import StatsCollectionService from './services/stats-collection.service.js';
import BackgroundJobService from './services/background-jobs.service.js';
import SigningQueueService from './services/signing-queue.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class WebServer {
  private app: express.Application;
  private db: PostDatabase;
  private port: number;
  private scheduler: PostScheduler | null = null;
  private statsScheduler: StatsSchedulerService | null = null;
  private signingQueue: SigningQueueService | null = null;

  constructor(port: number = 3001, scheduler?: PostScheduler, statsScheduler?: StatsSchedulerService, signingQueue?: SigningQueueService) {
    this.app = express();
    this.db = new PostDatabase();
    this.port = port;
    this.scheduler = scheduler || null;
    this.statsScheduler = statsScheduler || null;
    this.signingQueue = signingQueue || null;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  /**
   * Trigger signing queue processing (fire and forget)
   */
  private triggerSigningQueue(): void {
    if (this.signingQueue) {
      this.signingQueue.triggerProcessing().catch(error => {
        console.error('⚠️ Failed to trigger signing queue:', error);
      });
    }
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
          
          // Trigger signing queue processing
          this.triggerSigningQueue();
          
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
        
        // Trigger signing queue processing if available
        this.triggerSigningQueue();
        
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
        
        // Trigger signing queue processing if not published immediately
        if (!isImmediate) {
          this.triggerSigningQueue();
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
        
        // Trigger signing queue processing for batch posts
        this.triggerSigningQueue();
        
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
        
        // Trigger signing queue processing for custom batch posts
        this.triggerSigningQueue();
        
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

    // Get configuration for frontend
    this.app.get('/api/config', (req, res) => {
      const satPayValue = process.env.SAT_PAY || 'LINK';
      console.log('🔧 Config endpoint called - SAT_PAY env value:', process.env.SAT_PAY);
      console.log('🔧 Config endpoint returning - satPay:', satPayValue);
      
      res.json({
        giphyApiKey: process.env.GIPHY_API_KEY || null,
        satelliteApiUrl: process.env.SATELLITE_CDN_API || 'https://api.satellite.earth',
        features: {
          satPay: satPayValue
        }
      });
    });

    // Get user's media from Satellite CDN
    this.app.get('/api/satellite/media', async (req, res) => {
      console.log('🛰️ Satellite media request received for accountId:', req.query.accountId);
      
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        
        if (!accountId) {
          console.log('❌ No account ID provided');
          return res.status(400).json({ error: 'Account ID is required' });
        }

        console.log('🔍 Looking up account:', accountId);
        // Get the account
        const account = await this.db.getAccount(accountId);
        if (!account) {
          console.log('❌ Account not found:', accountId);
          return res.status(404).json({ error: 'Account not found' });
        }

        console.log('✅ Account found:', account.name, 'Method:', account.publish_method);

        // Get the nsec from keychain or database
        let nsec: string | undefined = account.nsec || undefined;
        if (account.keychain_ref) {
          console.log('🔐 Attempting to get nsec from keychain for account:', accountId);
          const keychainNsec = await getNsecFromKeychain(accountId);
          if (keychainNsec) {
            nsec = keychainNsec;
            console.log('✅ Retrieved nsec from keychain');
          } else {
            console.log('⚠️ Failed to retrieve nsec from keychain');
          }
        } else if (nsec) {
          console.log('✅ Using nsec from database');
        }

        if (!nsec) {
          console.log('❌ No private key available for account:', accountId);
          return res.status(400).json({ error: 'No private key available for this account' });
        }

        console.log('🔑 Decoding private key...');
        // Decode the private key
        const { data: privkey } = nip19.decode(nsec);
        const pubkey = getPublicKey(privkey as Uint8Array);
        console.log('✅ Public key derived:', pubkey.substring(0, 16) + '...');
        
        // Create the authentication event
        const authEvent = {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: 'Authenticate User',
          pubkey: pubkey
        };

        console.log('📝 Creating auth event:', { 
          kind: authEvent.kind, 
          content: authEvent.content, 
          pubkey: authEvent.pubkey.substring(0, 16) + '...',
          created_at: authEvent.created_at
        });

        // Sign the event
        const signedEvent = finalizeEvent(authEvent, privkey as Uint8Array);
        console.log('✅ Event signed with ID:', signedEvent.id.substring(0, 16) + '...');
        
        // Encode the event for the API call
        const authParam = encodeURIComponent(JSON.stringify(signedEvent));
        console.log('📦 Auth param length:', authParam.length);
        
        // Call the Satellite API
        const satelliteApiUrl = process.env.SATELLITE_CDN_API || 'https://api.satellite.earth';
        const fullUrl = `${satelliteApiUrl}/v1/media/account?auth=${authParam}`;
        console.log('🌐 Calling Satellite API:', satelliteApiUrl);
        
        const response = await fetch(fullUrl);
        console.log('📡 Satellite API response:', response.status, response.statusText);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.log('❌ Satellite API error response:', errorText);
          
          if (response.status === 403) {
            return res.status(403).json({ 
              error: 'Authentication failed with Satellite CDN',
              details: errorText
            });
          }
          throw new Error(`Satellite API returned ${response.status}: ${errorText}`);
        }

        const accountData = await response.json() as any;
        console.log('✅ Satellite API response data:', {
          filesCount: accountData.files?.length || 0,
          storageTotal: accountData.storageTotal,
          creditTotal: accountData.creditTotal
        });
        
        // Return the files array with relevant metadata
        const files = accountData.files || [];
        const formattedFiles = files.map((file: any) => ({
          url: file.url,
          name: file.name,
          size: file.size,
          type: file.type,
          created: file.created,
          sha256: file.sha256,
          label: file.label
        }));

        console.log('📋 Returning', formattedFiles.length, 'formatted files');

        res.json({
          files: formattedFiles,
          storageTotal: accountData.storageTotal,
          creditTotal: accountData.creditTotal,
          paidThrough: accountData.paidThrough
        });
        
      } catch (error) {
        console.error('💥 Error fetching Satellite media:', error);
        console.error('💥 Error stack:', error instanceof Error ? error.stack : 'No stack trace');
        res.status(500).json({ 
          error: 'Failed to fetch media from Satellite CDN',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Test endpoint for debugging
    this.app.post('/api/test', (req, res) => {
      console.log('🧪 Test endpoint hit with body:', req.body);
      res.json({ message: 'Test endpoint working', body: req.body });
    });

    // Upload file to Satellite CDN
    this.app.post('/api/satellite/upload', async (req, res) => {
      console.log('🛰️ Satellite upload request received for accountId:', req.query.accountId);
      console.log('🛰️ Request body:', req.body);
      
      // Ensure we always send JSON response
      res.setHeader('Content-Type', 'application/json');
      
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        
        if (!accountId) {
          console.log('❌ No account ID provided');
          return res.status(400).json({ error: 'Account ID is required' });
        }

        // Get the account
        const account = await this.db.getAccount(accountId);
        if (!account) {
          console.log('❌ Account not found:', accountId);
          return res.status(404).json({ error: 'Account not found' });
        }

        console.log('✅ Account found:', account.name);

        // Get the nsec from keychain or database
        let nsec: string | undefined = account.nsec || undefined;
        if (account.keychain_ref) {
          console.log('🔐 Attempting to get nsec from keychain for account:', accountId);
          const keychainNsec = await getNsecFromKeychain(accountId);
          if (keychainNsec) {
            nsec = keychainNsec;
            console.log('✅ Retrieved nsec from keychain');
          } else {
            console.log('⚠️ Failed to retrieve nsec from keychain');
          }
        }

        if (!nsec) {
          console.log('❌ No private key available for account:', accountId);
          return res.status(400).json({ error: 'No private key available for this account' });
        }

        // Get file details from request body
        const { fileName, fileSize, fileType, label } = req.body;
        
        if (!fileName || !fileSize || !fileType) {
          return res.status(400).json({ error: 'File details are required' });
        }

        // Check file size limit (100MB)
        const maxSize = 100 * 1024 * 1024; // 100MB in bytes
        if (fileSize > maxSize) {
          return res.status(400).json({ 
            error: 'File too large',
            details: `File size (${Math.round(fileSize / 1024 / 1024)}MB) exceeds limit of 100MB`
          });
        }

        console.log('🔑 Decoding private key...');
        // Decode the private key
        const { data: privkey } = nip19.decode(nsec);
        const pubkey = getPublicKey(privkey as Uint8Array);
        console.log('✅ Public key derived:', pubkey.substring(0, 16) + '...');
        
        // Create the upload authorization event
        const authTags = [
          ['name', fileName],
          ['size', fileSize.toString()]
        ];
        
        if (label && label.trim()) {
          authTags.push(['label', label.trim()]);
        }
        
        const authEvent = {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: authTags,
          content: 'Authorize Upload',
          pubkey: pubkey
        };

        console.log('📝 Creating upload auth event:', { 
          kind: authEvent.kind, 
          content: authEvent.content, 
          tags: authEvent.tags,
          pubkey: authEvent.pubkey.substring(0, 16) + '...',
          created_at: authEvent.created_at
        });

        // Sign the event
        const signedEvent = finalizeEvent(authEvent, privkey as Uint8Array);
        console.log('✅ Event signed with ID:', signedEvent.id.substring(0, 16) + '...');
        
        // Return the signed auth event for frontend to use
        res.json({
          auth: signedEvent,
          uploadUrl: (process.env.SATELLITE_CDN_API || 'https://api.satellite.earth') + '/v1/media/item'
        });
        
      } catch (error) {
        console.error('💥 Error preparing Satellite upload:', error);
        res.status(500).json({ 
          error: 'Failed to prepare upload',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Request storage credit from Satellite CDN
    this.app.post('/api/satellite/credit/request', async (req, res) => {
      console.log('💳 Satellite credit request received for accountId:', req.query.accountId);
      
      // Ensure we always send JSON response
      res.setHeader('Content-Type', 'application/json');
      
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const { gbMonths } = req.body;
        
        if (!accountId) {
          console.log('❌ No account ID provided');
          return res.status(400).json({ error: 'Account ID is required' });
        }

        if (!gbMonths || gbMonths < 1) {
          return res.status(400).json({ error: 'GB months must be at least 1' });
        }

        // Get the account
        const account = await this.db.getAccount(accountId);
        if (!account) {
          console.log('❌ Account not found:', accountId);
          return res.status(404).json({ error: 'Account not found' });
        }

        console.log('✅ Account found:', account.name);

        // Get the nsec from keychain or database
        let nsec: string | undefined = account.nsec || undefined;
        if (account.keychain_ref) {
          console.log('🔐 Attempting to get nsec from keychain for account:', accountId);
          const keychainNsec = await getNsecFromKeychain(accountId);
          if (keychainNsec) {
            nsec = keychainNsec;
            console.log('✅ Retrieved nsec from keychain');
          }
        }

        if (!nsec) {
          console.log('❌ No private key available for account:', accountId);
          return res.status(400).json({ error: 'No private key available for this account' });
        }

        console.log('🔑 Decoding private key...');
        // Decode the private key
        const { data: privkey } = nip19.decode(nsec);
        const pubkey = getPublicKey(privkey as Uint8Array);
        console.log('✅ Public key derived:', pubkey.substring(0, 16) + '...');
        
        // Create the storage request event
        const requestEvent = {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['gb_months', gbMonths.toString()]],
          content: 'Request Storage',
          pubkey: pubkey
        };

        console.log('📝 Creating storage request event:', { 
          kind: requestEvent.kind, 
          content: requestEvent.content, 
          tags: requestEvent.tags,
          pubkey: requestEvent.pubkey.substring(0, 16) + '...',
          created_at: requestEvent.created_at
        });

        // Sign the event
        const signedEvent = finalizeEvent(requestEvent, privkey as Uint8Array);
        console.log('✅ Event signed with ID:', signedEvent.id.substring(0, 16) + '...');
        
        // Request storage credit from Satellite API
        const authParam = encodeURIComponent(JSON.stringify(signedEvent));
        const satelliteApiUrl = process.env.SATELLITE_CDN_API || 'https://api.satellite.earth';
        const creditUrl = `${satelliteApiUrl}/v1/media/account/credit?auth=${authParam}`;
        
        console.log('🌐 Requesting storage credit from Satellite API...');
        const response = await fetch(creditUrl);
        console.log('📡 Satellite credit API response:', response.status, response.statusText);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.log('❌ Satellite credit API error response:', errorText);
          
          if (response.status === 403) {
            return res.status(403).json({ 
              error: 'Authentication failed with Satellite CDN',
              details: errorText
            });
          }
          throw new Error(`Satellite API returned ${response.status}: ${errorText}`);
        }

        const creditData = await response.json() as any;
        console.log('✅ Satellite credit response:', {
          amount: creditData.amount,
          callback: creditData.callback,
          hasOffer: !!creditData.offer
        });
        
        // Return the offer details
        res.json({
          offer: creditData.offer,
          amount: creditData.amount, // amount in millisats
          callback: creditData.callback,
          rateFiat: creditData.rateFiat,
          gbMonths: gbMonths
        });
        
      } catch (error) {
        console.error('💥 Error requesting Satellite credit:', error);
        res.status(500).json({ 
          error: 'Failed to request storage credit',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Generate Lightning invoice for Satellite storage
    this.app.post('/api/satellite/credit/invoice', async (req, res) => {
      console.log('⚡ Satellite invoice request received for accountId:', req.query.accountId);
      
      // Ensure we always send JSON response
      res.setHeader('Content-Type', 'application/json');
      
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const { offer, amount, callback } = req.body;
        
        if (!accountId) {
          return res.status(400).json({ error: 'Account ID is required' });
        }

        if (!offer || !amount || !callback) {
          return res.status(400).json({ error: 'Offer, amount, and callback are required' });
        }

        // Get the account
        const account = await this.db.getAccount(accountId);
        if (!account) {
          return res.status(404).json({ error: 'Account not found' });
        }

        // Get the nsec from keychain or database
        let nsec: string | undefined = account.nsec || undefined;
        if (account.keychain_ref) {
          const keychainNsec = await getNsecFromKeychain(accountId);
          if (keychainNsec) {
            nsec = keychainNsec;
          }
        }

        if (!nsec) {
          return res.status(400).json({ error: 'No private key available for this account' });
        }

        // Decode the private key
        const { data: privkey } = nip19.decode(nsec);
        const pubkey = getPublicKey(privkey as Uint8Array);
        
        const npub = nip19.npubEncode(pubkey);
        console.log('🔑 Payment being made by pubkey:', pubkey);
        console.log('🔑 Payment being made by npub:', npub);
        console.log('🔑 This should match your Satellite account pubkey/npub');
        
        // Create a zap request (kind 9734) based on the offer (kind 9733)
        const zapRequest = {
          kind: 9734,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['relays', 'wss://relay.damus.io'], // Add at least one relay
            ['amount', amount.toString()],
            ['p', pubkey], // recipient pubkey
            ['e', offer.id] // reference to the offer event
          ],
          content: '',
          pubkey: pubkey
        };
        
        const signedPayment = finalizeEvent(zapRequest, privkey as Uint8Array);
        console.log('✅ Zap request signed with ID:', signedPayment.id.substring(0, 16) + '...');
        
        // Request Lightning invoice
        const invoiceUrl = `${callback}?amount=${amount}&nostr=${encodeURIComponent(JSON.stringify(signedPayment))}`;
        
        console.log('⚡ Requesting Lightning invoice...');
        const invoiceResponse = await fetch(invoiceUrl);
        console.log('📡 Invoice API response:', invoiceResponse.status, invoiceResponse.statusText);
        
        if (!invoiceResponse.ok) {
          const errorText = await invoiceResponse.text();
          console.log('❌ Invoice API error response:', errorText);
          throw new Error(`Invoice generation failed (${invoiceResponse.status}): ${errorText}`);
        }

        const invoiceData = await invoiceResponse.json() as any;
        console.log('✅ Lightning invoice response:', {
          hasInvoice: !!(invoiceData.pr || invoiceData.payment_request || invoiceData.invoice),
          responseKeys: Object.keys(invoiceData),
          status: invoiceData.status,
          reason: invoiceData.reason,
          hasVerifyUrl: !!invoiceData.verify,
          fullResponse: invoiceData
        });
        
        // Include the verify URL in the response for payment verification
        res.json({
          ...invoiceData,
          accountId: accountId // Include account ID for verification
        });
        
      } catch (error) {
        console.error('💥 Error generating Lightning invoice:', error);
        res.status(500).json({ 
          error: 'Failed to generate Lightning invoice',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Verify Lightning payment status
    this.app.post('/api/satellite/credit/verify', async (req, res) => {
      console.log('🔍 Lightning payment verification request for accountId:', req.query.accountId);
      
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        const { verifyUrl } = req.body;
        
        if (!accountId) {
          return res.status(400).json({ error: 'Account ID is required' });
        }

        if (!verifyUrl) {
          return res.status(400).json({ error: 'Verify URL is required' });
        }

        console.log('⚡ Checking payment status at verify URL:', verifyUrl);
        
        // Check payment status using the verify URL
        const verifyResponse = await fetch(verifyUrl);
        
        if (!verifyResponse.ok) {
          console.log('❌ Payment verification failed:', verifyResponse.status, verifyResponse.statusText);
          return res.status(400).json({ 
            paid: false, 
            error: `Verification failed: ${verifyResponse.status}` 
          });
        }

        const verifyData = await verifyResponse.json() as any;
        console.log('🔍 Payment verification response:', verifyData);
        
        // Check if payment is confirmed
        const isPaid = verifyData.settled === true || verifyData.paid === true || verifyData.status === 'paid';
        
        if (isPaid) {
          console.log('✅ Payment confirmed! Refreshing account status...');
          
          // Wait longer for Satellite to detect and process the payment
          console.log('⏳ Waiting 10 seconds for Satellite to detect payment...');
          await new Promise(resolve => setTimeout(resolve, 10000));
          
          // Get updated account status to confirm credit was added (with retry)
          let accountData: any = null;
          let retryCount = 0;
          const maxRetries = 3;
          
          while (retryCount < maxRetries && (!accountData || accountData.creditTotal === 0)) {
            try {
              const account = await this.db.getAccount(accountId);
              if (account) {
                let nsec: string | undefined = account.nsec || undefined;
                if (account.keychain_ref) {
                  const keychainNsec = await getNsecFromKeychain(accountId);
                  if (keychainNsec) {
                    nsec = keychainNsec;
                  }
                }

                if (nsec) {
                  const { data: privkey } = nip19.decode(nsec);
                  const pubkey = getPublicKey(privkey as Uint8Array);
                  
                  const authEvent = {
                    kind: 22242,
                    created_at: Math.floor(Date.now() / 1000),
                    tags: [],
                    content: 'Authenticate User',
                    pubkey: pubkey
                  };

                  const signedEvent = finalizeEvent(authEvent, privkey as Uint8Array);
                  
                  const authParam = encodeURIComponent(JSON.stringify(signedEvent));
                  const satelliteApiUrl = process.env.SATELLITE_CDN_API || 'https://api.satellite.earth';
                  const statusUrl = `${satelliteApiUrl}/v1/media/account?auth=${authParam}`;
                  
                  const statusResponse = await fetch(statusUrl);
                  if (statusResponse.ok) {
                    accountData = await statusResponse.json() as any;
                    console.log(`💰 Account status check ${retryCount + 1}/${maxRetries}:`, {
                      creditTotal: accountData.creditTotal,
                      storageTotal: accountData.storageTotal,
                      paidThrough: accountData.paidThrough,
                      timeRemaining: accountData.timeRemaining
                    });
                    
                    if (accountData.creditTotal > 0) {
                      console.log('✅ Credit detected! Payment successfully processed by Satellite');
                      console.log('🔍 Account auth details - pubkey:', pubkey.substring(0, 16) + '...');
                      
                      return res.json({
                        paid: true,
                        verified: true,
                        accountStatus: {
                          creditTotal: accountData.creditTotal,
                          storageTotal: accountData.storageTotal,
                          usageTotal: accountData.usageTotal,
                          files: accountData.files?.length || 0
                        }
                      });
                    } else if (retryCount < maxRetries - 1) {
                      console.log(`⏳ Credit not yet detected, waiting 15 seconds before retry ${retryCount + 2}...`);
                      await new Promise(resolve => setTimeout(resolve, 15000));
                    }
                  }
                }
              }
            } catch (statusError) {
              console.log(`⚠️ Could not refresh account status after payment (attempt ${retryCount + 1}):`, statusError);
            }
            
            retryCount++;
          }
          
          return res.json({ paid: true, verified: true });
        } else {
          console.log('⏳ Payment not yet confirmed');
          return res.json({ 
            paid: false, 
            status: verifyData.status || 'pending',
            message: 'Payment not yet confirmed'
          });
        }
        
      } catch (error) {
        console.error('💥 Error verifying Lightning payment:', error);
        res.status(500).json({ 
          error: 'Failed to verify payment',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Check account storage status
    this.app.get('/api/satellite/account/status', async (req, res) => {
      console.log('📊 Satellite account status request for accountId:', req.query.accountId);
      
      try {
        const accountId = req.query.accountId ? parseInt(req.query.accountId as string) : undefined;
        
        if (!accountId) {
          return res.status(400).json({ error: 'Account ID is required' });
        }

        // Get the account
        const account = await this.db.getAccount(accountId);
        if (!account) {
          return res.status(404).json({ error: 'Account not found' });
        }

        // Get the nsec from keychain or database
        let nsec: string | undefined = account.nsec || undefined;
        if (account.keychain_ref) {
          const keychainNsec = await getNsecFromKeychain(accountId);
          if (keychainNsec) {
            nsec = keychainNsec;
          }
        }

        if (!nsec) {
          return res.status(400).json({ error: 'No private key available for this account' });
        }

        // Decode the private key
        const { data: privkey } = nip19.decode(nsec);
        const pubkey = getPublicKey(privkey as Uint8Array);
        
        const npub = nip19.npubEncode(pubkey);
        console.log('🔑 Checking account status for pubkey:', pubkey);
        console.log('🔑 Checking account status for npub:', npub);
        console.log('🔑 This pubkey/npub should match your Satellite CDN account');
        
        // Create the authentication event
        const authEvent = {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: 'Authenticate User',
          pubkey: pubkey
        };

        // Sign the event
        const signedEvent = finalizeEvent(authEvent, privkey as Uint8Array);
        
        // Get account status from Satellite API
        const authParam = encodeURIComponent(JSON.stringify(signedEvent));
        const satelliteApiUrl = process.env.SATELLITE_CDN_API || 'https://api.satellite.earth';
        const statusUrl = `${satelliteApiUrl}/v1/media/account?auth=${authParam}`;
        
        const response = await fetch(statusUrl);
        
        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 403) {
            return res.status(403).json({ 
              error: 'Authentication failed with Satellite CDN',
              details: errorText
            });
          }
          throw new Error(`Satellite API returned ${response.status}: ${errorText}`);
        }

        const accountData = await response.json() as any;
        
        res.json({
          creditTotal: accountData.creditTotal,
          storageTotal: accountData.storageTotal,
          usageTotal: accountData.usageTotal,
          paidThrough: accountData.paidThrough,
          timeRemaining: accountData.timeRemaining,
          rateFiat: accountData.rateFiat,
          files: accountData.files?.length || 0
        });
        
      } catch (error) {
        console.error('💥 Error getting Satellite account status:', error);
        res.status(500).json({ 
          error: 'Failed to get account status',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
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