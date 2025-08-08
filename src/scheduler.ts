import cron from 'node-cron';
import PostDatabase from './database/db.js';
import { publishToNostr, initializeNostrMQReceiver, stopNostrMQReceiver } from './publisher.js';

export class PostScheduler {
  private db: PostDatabase;
  private task: cron.ScheduledTask | null = null;
  private checkInterval: string;

  constructor(checkInterval: string = '*/5 * * * *') {
    this.db = new PostDatabase();
    this.checkInterval = checkInterval;
  }

  async start() {
    console.log('🚀 Scheduler started - checking for posts every 5 minutes');
    
    // Initialize NostrMQ receiver for response monitoring
    try {
      await initializeNostrMQReceiver();
    } catch (error) {
      console.error('⚠️ Failed to initialize NostrMQ receiver, continuing without it:', error);
    }
    
    this.task = cron.schedule(this.checkInterval, async () => {
      await this.checkAndPublishPosts();
    });

    await this.checkAndPublishPosts();
  }

  private async checkAndPublishPosts() {
    console.log(`[${new Date().toISOString()}] Checking for posts to publish...`);
    const pendingPosts = await this.db.getPendingPosts();
    
    if (pendingPosts.length > 0) {
      console.log(`📝 Found ${pendingPosts.length} posts to publish`);
      
      for (const post of pendingPosts) {
        try {
          console.log(`[${new Date().toISOString()}] 🕒 Scheduled publish for post ${post.id}`);
          console.log(`📝 Content: "${post.content.substring(0, 50)}..."`);
          console.log(`⏰ Scheduled for: ${post.scheduled_for}`);
          console.log(`🔗 Account ID: ${post.account_id || 'none'}`);
          console.log(`⚙️ API endpoint: ${post.api_endpoint || 'default'}`);
          
          await publishToNostr(post.content, post.api_endpoint, post.id);
          
          await this.db.markAsPublished(post.id!);
          console.log(`✅ Post ${post.id} published successfully at ${new Date().toISOString()}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this.db.markAsFailed(post.id!, errorMessage);
          console.error(`❌ Failed to publish post ${post.id}: ${errorMessage}`);
          console.error(`  Full error:`, error);
        }
      }
    } else {
      console.log(`  No pending posts found at ${new Date().toISOString()}`);
    }
  }
  
  async publishNow(postId: number): Promise<void> {
    console.log(`[${new Date().toISOString()}] Manual publish requested for post ${postId}`);
    const posts = await this.db.getAllPosts();
    const post = posts.find(p => p.id === postId);
    
    if (!post) {
      throw new Error(`Post ${postId} not found`);
    }
    
    if (post.status !== 'pending') {
      throw new Error(`Post ${postId} is not pending (status: ${post.status})`);
    }
    
    try {
      console.log(`🎯 Manual publish trigger for post ${post.id}`);
      console.log(`📝 Content: "${post.content.substring(0, 50)}..."`);
      console.log(`🔗 Account ID: ${post.account_id || 'none'}`);
      console.log(`⚙️ API endpoint: ${post.api_endpoint || 'default'}`);
      
      await publishToNostr(post.content, post.api_endpoint, post.id);
      await this.db.markAsPublished(post.id!);
      console.log(`✅ Post ${post.id} published successfully via manual trigger`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.db.markAsFailed(post.id!, errorMessage);
      console.error(`❌ Failed to manually publish post ${post.id}: ${errorMessage}`);
      throw error;
    }
  }

  stop() {
    if (this.task) {
      this.task.stop();
      console.log('🛑 Scheduler stopped');
    }
    
    // Stop NostrMQ receiver
    stopNostrMQReceiver();
    
    this.db.close();
  }
}