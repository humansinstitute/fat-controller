import PostDatabase from '../database/db.js';
import { Post, PostStats } from '../database/schema.js';
import { PrimalClient, PrimalHttpClient, EventStats } from './primal-client.js';
import { RelayStatsCollector, RelayStatsConfig } from './relay-stats-collector.js';

export interface StatsCollectionResult {
  success: boolean;
  post_id: number;
  event_id: string;
  stats?: PostStats;
  error?: string;
  retry_count?: number;
}

export interface CollectionJobResult {
  job_id: string;
  started_at: string;
  completed_at?: string;
  total_posts: number;
  successful_updates: number;
  failed_updates: number;
  unknown_updates: number;
  errors: Array<{
    post_id: number;
    event_id: string;
    error_type: string;
    error_message: string;
  }>;
  duration_ms?: number;
}

export class StatsCollectionService {
  private db: PostDatabase;
  private primalClient: PrimalClient;
  private httpFallback: PrimalHttpClient;
  private relayCollector: RelayStatsCollector;
  private maxRetries: number;
  private retryDelay: number;
  private useRelayStats: boolean;

  constructor(
    db?: PostDatabase,
    primalWsUrl?: string,
    primalHttpUrl?: string,
    maxRetries: number = 3,
    retryDelay: number = 1000,
    relayConfig?: RelayStatsConfig,
    useRelayStats: boolean = true
  ) {
    this.db = db || new PostDatabase();
    this.primalClient = new PrimalClient(primalWsUrl);
    this.httpFallback = new PrimalHttpClient(primalHttpUrl);
    this.relayCollector = new RelayStatsCollector(relayConfig);
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
    this.useRelayStats = useRelayStats;
  }

  async collectStatsForPost(post: Post, retryCount: number = 0): Promise<StatsCollectionResult> {
    if (!post.event_id) {
      return {
        success: false,
        post_id: post.id!,
        event_id: '',
        error: 'Post has no event_id'
      };
    }

    try {
      let stats: EventStats | null = null;
      
      if (this.useRelayStats) {
        // Use relay-based stats collection (primary method)
        console.log(`📡 Collecting stats from Nostr relays for ${post.event_id.substring(0, 20)}...`);
        try {
          stats = await this.relayCollector.getEventStats(post.event_id);
        } catch (relayError) {
          console.log(`🔄 Relay collection failed for ${post.event_id.substring(0, 20)}, trying Primal fallback...`);
          // Fallback to Primal API
          try {
            stats = await this.primalClient.getEventStats(post.event_id);
          } catch (wsError) {
            try {
              stats = await this.httpFallback.getEventStats(post.event_id);
            } catch (httpError) {
              throw new Error(`All methods failed - Relay: ${relayError}; WS: ${wsError}; HTTP: ${httpError}`);
            }
          }
        }
      } else {
        // Use Primal API (legacy method)
        try {
          stats = await this.primalClient.getEventStats(post.event_id);
        } catch (wsError) {
          console.log(`🔄 WebSocket failed for ${post.event_id}, trying HTTP fallback...`);
          try {
            stats = await this.httpFallback.getEventStats(post.event_id);
          } catch (httpError) {
            throw new Error(`Both WebSocket and HTTP failed: ${wsError}; ${httpError}`);
          }
        }
      }

      const now = new Date().toISOString();
      let status: 'success' | 'unknown' | 'error' = 'unknown';
      let errorMessage: string | undefined;

      if (stats) {
        status = 'success';
        
        // Create or update PostStats record
        const postStats: Omit<PostStats, 'id' | 'post_id' | 'created_at'> = {
          likes: stats.likes,
          reposts: stats.reposts,
          zap_amount: stats.zap_amount_sats,
          last_updated: now,
          status: 'success'
        };

        await this.db.createOrUpdatePostStats(post.id!, postStats);

        return {
          success: true,
          post_id: post.id!,
          event_id: post.event_id,
          stats: {
            id: undefined,
            post_id: post.id!,
            ...postStats
          }
        };
      } else {
        // Event not found - this is normal for new events
        status = 'unknown';
        errorMessage = 'Event not found on Primal (may not have propagated yet)';
      }

      // Store unknown status (preserving previous values if they exist)
      const existingStats = await this.db.getPostStats(post.id!);
      const postStats: Omit<PostStats, 'id' | 'post_id' | 'created_at'> = {
        likes: existingStats?.likes || 0,
        reposts: existingStats?.reposts || 0,
        zap_amount: existingStats?.zap_amount || 0,
        last_updated: now,
        status,
        error_message: errorMessage
      };

      await this.db.createOrUpdatePostStats(post.id!, postStats);

      return {
        success: false,
        post_id: post.id!,
        event_id: post.event_id,
        error: errorMessage,
        retry_count: retryCount
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Error collecting stats for post ${post.id} (${post.event_id}):`, errorMessage);

      // Retry logic with exponential backoff
      if (retryCount < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        console.log(`🔄 Retrying in ${delay}ms... (attempt ${retryCount + 1}/${this.maxRetries})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.collectStatsForPost(post, retryCount + 1);
      }

      // Max retries exceeded - store error status
      try {
        const existingStats = await this.db.getPostStats(post.id!);
        const postStats: Omit<PostStats, 'id' | 'post_id' | 'created_at'> = {
          likes: existingStats?.likes || 0,
          reposts: existingStats?.reposts || 0,
          zap_amount: existingStats?.zap_amount || 0,
          last_updated: new Date().toISOString(),
          status: 'error',
          error_message: errorMessage
        };

        await this.db.createOrUpdatePostStats(post.id!, postStats);
      } catch (dbError) {
        console.error(`❌ Failed to store error status for post ${post.id}:`, dbError);
      }

      return {
        success: false,
        post_id: post.id!,
        event_id: post.event_id,
        error: errorMessage,
        retry_count: retryCount
      };
    }
  }

  async collectStatsForPosts(posts: Post[]): Promise<CollectionJobResult> {
    const jobId = `collection_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const startTime = Date.now();
    const result: CollectionJobResult = {
      job_id: jobId,
      started_at: new Date().toISOString(),
      total_posts: posts.length,
      successful_updates: 0,
      failed_updates: 0,
      unknown_updates: 0,
      errors: []
    };

    console.log(`🚀 Starting stats collection job ${jobId} for ${posts.length} posts`);

    // Process posts in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < posts.length; i += batchSize) {
      const batch = posts.slice(i, i + batchSize);
      console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(posts.length / batchSize)}`);

      // Process batch in parallel
      const batchPromises = batch.map(post => this.collectStatsForPost(post));
      const batchResults = await Promise.allSettled(batchPromises);

      // Process results
      batchResults.forEach((promiseResult, index) => {
        const post = batch[index];
        
        if (promiseResult.status === 'fulfilled') {
          const collectionResult = promiseResult.value;
          
          if (collectionResult.success) {
            result.successful_updates++;
            console.log(`✅ Updated stats for post ${post.id}`);
          } else {
            if (collectionResult.error?.includes('not found')) {
              result.unknown_updates++;
              console.log(`❓ Unknown status for post ${post.id}`);
            } else {
              result.failed_updates++;
              result.errors.push({
                post_id: post.id!,
                event_id: post.event_id || 'unknown',
                error_type: 'collection_failed',
                error_message: collectionResult.error || 'Unknown error'
              });
              console.log(`❌ Failed to update stats for post ${post.id}: ${collectionResult.error}`);
            }
          }
        } else {
          result.failed_updates++;
          result.errors.push({
            post_id: post.id!,
            event_id: post.event_id || 'unknown',
            error_type: 'promise_rejected',
            error_message: promiseResult.reason?.message || 'Promise rejected'
          });
          console.error(`❌ Promise rejected for post ${post.id}:`, promiseResult.reason);
        }
      });

      // Add delay between batches
      if (i + batchSize < posts.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const endTime = Date.now();
    result.completed_at = new Date().toISOString();
    result.duration_ms = endTime - startTime;

    console.log(`🎉 Completed stats collection job ${jobId}`);
    console.log(`   Duration: ${result.duration_ms}ms`);
    console.log(`   Successful: ${result.successful_updates}`);
    console.log(`   Failed: ${result.failed_updates}`);
    console.log(`   Unknown: ${result.unknown_updates}`);
    console.log(`   Errors: ${result.errors.length}`);

    return result;
  }

  async collectStatsForNote(noteId: number): Promise<CollectionJobResult> {
    console.log(`📝 Collecting stats for all posts in note ${noteId}`);
    
    const { posts } = await this.db.getNoteWithPosts(noteId);
    const publishedPosts = posts.filter(post => 
      post.status === 'published' && post.event_id
    );

    if (publishedPosts.length === 0) {
      console.log(`ℹ️  No published posts with event_id found for note ${noteId}`);
      return {
        job_id: `note_${noteId}_${Date.now()}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        total_posts: 0,
        successful_updates: 0,
        failed_updates: 0,
        unknown_updates: 0,
        errors: [],
        duration_ms: 0
      };
    }

    return this.collectStatsForPosts(publishedPosts);
  }

  async collectStatsForRecentPosts(maxAgeHours: number = 48): Promise<CollectionJobResult> {
    console.log(`🕒 Collecting stats for posts published in the last ${maxAgeHours} hours`);
    
    const posts = await this.db.getPostsForStatsCollection(maxAgeHours);
    
    if (posts.length === 0) {
      console.log(`ℹ️  No eligible posts found for stats collection`);
      return {
        job_id: `recent_${Date.now()}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        total_posts: 0,
        successful_updates: 0,
        failed_updates: 0,
        unknown_updates: 0,
        errors: [],
        duration_ms: 0
      };
    }

    return this.collectStatsForPosts(posts);
  }

  disconnect(): void {
    this.primalClient.disconnect();
    this.relayCollector.disconnect();
    console.log('🔌 Stats collection service disconnected');
  }
}

export default StatsCollectionService;