import cron from 'node-cron';
import PostDatabase from './database/db.js';
import { publishToNostr, initializeNostrMQReceiver, stopNostrMQReceiver } from './publisher.js';
import { Post } from './database/schema.js';
import { send } from 'nostrmq';
import { NDKEvent } from '@nostr-dev-kit/ndk';

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

  async checkAndPublishPosts() {
    console.log(`[${new Date().toISOString()}] Checking for posts to publish...`);
    
    // First check for pre-signed posts ready to publish
    const signedPosts = await this.db.getPendingSignedPosts();
    
    if (signedPosts.length > 0) {
      console.log(`📝 Found ${signedPosts.length} pre-signed posts to publish`);
      
      for (const post of signedPosts) {
        try {
          console.log(`[${new Date().toISOString()}] 🚀 Publishing pre-signed post ${post.id}`);
          console.log(`📝 Content: "${(post as any).content.substring(0, 50)}..."`);
          console.log(`⏰ Scheduled for: ${post.scheduled_for}`);
          console.log(`🔗 Account ID: ${post.account_id || 'none'}`);
          
          const eventId = await this.publishPreSignedEvent(post as Post & { content: string });
          
          await this.db.markAsPublished(post.id!);
          
          // Update with event ID if we got one
          if (eventId) {
            await this.db.updatePostEventDetails(post.id!, eventId);
            console.log(`✅ Pre-signed post ${post.id} published with event ID: ${eventId} at ${new Date().toISOString()}`);
          } else {
            console.log(`✅ Pre-signed post ${post.id} published successfully at ${new Date().toISOString()}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this.db.markAsFailed(post.id!, errorMessage);
          console.error(`❌ Failed to publish pre-signed post ${post.id}: ${errorMessage}`);
          console.error(`  Full error:`, error);
        }
      }
    }
    
    // Fallback: Check for old-style pending posts (not pre-signed)
    const pendingPosts = await this.db.getPendingPosts();
    
    if (pendingPosts.length > 0) {
      console.log(`📝 Found ${pendingPosts.length} legacy posts to publish (will sign at publish time)`);
      
      for (const post of pendingPosts) {
        try {
          console.log(`[${new Date().toISOString()}] 🕒 Legacy publish for post ${post.id}`);
          console.log(`📝 Content: "${(post as any).content.substring(0, 50)}..."`);
          console.log(`⏰ Scheduled for: ${post.scheduled_for}`);
          console.log(`🔗 Account ID: ${post.account_id || 'none'}`);
          console.log(`⚙️ API endpoint: ${post.api_endpoint || 'default'}`);
          
          const eventId = await publishToNostr((post as any).content, post.api_endpoint, post.id);
          
          await this.db.markAsPublished(post.id!);
          
          // Update with event ID if we got one
          if (eventId) {
            await this.db.updatePostEventDetails(post.id!, eventId);
            console.log(`✅ Legacy post ${post.id} published with event ID: ${eventId} at ${new Date().toISOString()}`);
          } else {
            console.log(`✅ Legacy post ${post.id} published successfully at ${new Date().toISOString()}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this.db.markAsFailed(post.id!, errorMessage);
          console.error(`❌ Failed to publish legacy post ${post.id}: ${errorMessage}`);
          console.error(`  Full error:`, error);
        }
      }
    }
    
    if (signedPosts.length === 0 && pendingPosts.length === 0) {
      console.log(`  No posts ready to publish at ${new Date().toISOString()}`);
    }
  }

  /**
   * Publish a pre-signed event using the stored signed_event data
   */
  private async publishPreSignedEvent(post: Post & { content: string }): Promise<string | undefined> {
    if (!post.signed_event) {
      throw new Error('Post does not have a pre-signed event');
    }

    let signedEventData;
    try {
      signedEventData = JSON.parse(post.signed_event);
    } catch (error) {
      throw new Error('Invalid signed event JSON data');
    }

    const db = new PostDatabase();
    let endpoint = post.api_endpoint || process.env.NOSTR_API_ENDPOINT || 'http://localhost:3000/post/note';
    let publishMethod: 'api' | 'nostrmq' | 'direct' = post.publish_method || 'direct';
    let nostrmqTarget: string | undefined;
    let npub: string | undefined;

    try {
      if (post.account_id) {
        const account = await db.getAccount(post.account_id);
        if (account) {
          npub = account.npub;
          endpoint = account.api_endpoint || endpoint;
          nostrmqTarget = account.nostrmq_target;
          publishMethod = post.publish_method || account.publish_method;
          console.log(`Using account: ${account.name} (${account.npub.substring(0, 20)}...) - Method: ${publishMethod}`);
        }
      }
    } catch (error) {
      console.error('Error getting account info:', error);
    } finally {
      db.close();
    }

    console.log('\n🔄 PUBLISHING PRE-SIGNED EVENT');
    console.log('================================');
    console.log(`Method: ${publishMethod.toUpperCase()}`);
    console.log(`Event ID: ${signedEventData.id}`);
    console.log(`NPUB: ${npub ? npub.substring(0, 20) + '...' : 'NOT SET'}`);

    let eventId: string | undefined;

    if (publishMethod === 'direct') {
      // For direct publishing, we need to recreate the NDK event and publish to relays
      const account = await db.getAccount(post.account_id!);
      const relays = account?.relays?.split(',').map(r => r.trim()).filter(r => r);
      
      console.log(`Direct Publishing Mode (Pre-signed)`);
      console.log(`Relays: ${relays?.join(', ') || 'Using defaults'}`);

      try {
        // Import the direct publishing logic
        const { publishSignedEventToRelays } = await import('./nostr.service.js');
        const result = await publishSignedEventToRelays(signedEventData, relays);
        
        eventId = result.id;
        console.log(`✅ Successfully published pre-signed event via direct relay connection!`);
        console.log(`📋 Event ID: ${eventId}`);
        console.log(`🌐 Published to ${result.relays.length} relay(s): ${result.relays.join(', ')}`);
        console.log('================================\n');
      } catch (error) {
        console.error('❌ ERROR during direct publishing of pre-signed event:', error);
        console.log('================================\n');
        throw error;
      }
    } else if (publishMethod === 'nostrmq') {
      if (!nostrmqTarget) {
        throw new Error('NostrMQ target not set for NostrMQ publishing method');
      }

      console.log(`NostrMQ Target: ${nostrmqTarget.substring(0, 20)}...`);

      const payload = {
        action: "/relay/event",
        data: {
          event: signedEventData,
          timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS) : 10000
        }
      };

      try {
        console.log(`📤 Sending pre-signed event via NostrMQ to target: ${nostrmqTarget}`);
        const mqEventId = await send({
          target: nostrmqTarget,
          payload: payload
        });

        eventId = mqEventId;
        console.log(`✅ NostrMQ send() completed successfully!`);
        console.log(`📋 Event ID: ${eventId}`);
        console.log('================================\n');
      } catch (error) {
        console.error('❌ ERROR during NostrMQ send() call for pre-signed event:', error);
        console.log('================================\n');
        throw error;
      }
    } else {
      // API publishing method
      console.log(`API Endpoint: ${endpoint}`);

      const requestBody = {
        event: signedEventData,
        timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS) : undefined
      };

      console.log(`📤 Making POST request with pre-signed event to: ${endpoint}`);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        });

        console.log(`📥 Response status: ${response.status} ${response.statusText}`);

        const responseText = await response.text();
        console.log(`Response body: ${responseText.substring(0, 500)}${responseText.length > 500 ? '...' : ''}`);

        if (!response.ok) {
          console.error(`❌ API returned error: ${response.status} - ${responseText}`);
          throw new Error(`Failed to publish: ${response.status} - ${responseText}`);
        }

        let result;
        try {
          result = JSON.parse(responseText);
          // Try to extract event ID from various possible response formats
          if (result.eventId) {
            eventId = result.eventId;
          } else if (result.event_id) {
            eventId = result.event_id;
          } else if (result.id) {
            eventId = result.id;
          } else if (typeof result === 'string' && result.length === 64) {
            eventId = result;
          }
        } catch (e) {
          console.log('Response is not JSON, raw text:', responseText);
          result = responseText;
          if (typeof responseText === 'string' && responseText.length === 64) {
            eventId = responseText;
          }
        }

        // Use the event ID from the signed event if we didn't get one from the response
        eventId = eventId || signedEventData.id;

        console.log('✅ Successfully published pre-signed event to API!');
        if (eventId) {
          console.log(`📋 Event ID: ${eventId}`);
        }
        console.log('Full response:', JSON.stringify(result, null, 2));
        console.log('================================\n');
      } catch (error) {
        console.error('❌ ERROR during API call for pre-signed event:', error);
        console.log('================================\n');
        throw error;
      }
    }

    return eventId || signedEventData.id;
  }
  
  async publishNow(postId: number): Promise<void> {
    console.log(`[${new Date().toISOString()}] Manual publish requested for post ${postId}`);
    const post = await this.db.getPost(postId);
    
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
      
      const eventId = await publishToNostr(post.content, post.api_endpoint, post.id);
      await this.db.markAsPublished(post.id!);
      
      // Update with event ID if we got one
      if (eventId) {
        await this.db.updatePostEventDetails(post.id!, eventId);
        console.log(`✅ Post ${post.id} published with event ID: ${eventId}`);
      } else {
        console.log(`✅ Post ${post.id} published successfully via manual trigger`);
      }
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