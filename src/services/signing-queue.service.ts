import PostDatabase from '../database/db.js';
import { Post } from '../database/schema.js';
import { buildTextNote } from '../nostr.service.js';
import { mineEventPow } from '../pow.service.js';
import { getNsecFromKeychain } from '../keychain.service.js';
import { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';

export interface SigningJob {
  post: Post & { content: string };
  accountId: number;
  nsec?: string;
  powDifficulty: number;
}

export class SigningQueueService {
  private db: PostDatabase;
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    this.db = new PostDatabase();
  }

  /**
   * Start the signing queue processor
   */
  start(): void {
    console.log('🖊️ Signing queue service started');
    
    // Process queue every 30 seconds
    this.processingInterval = setInterval(() => {
      this.processQueue().catch(error => {
        console.error('❌ Error processing signing queue:', error);
      });
    }, 30000);

    // Process queue immediately on start
    this.processQueue().catch(error => {
      console.error('❌ Error processing signing queue on startup:', error);
    });
  }

  /**
   * Stop the signing queue processor
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    this.db.close();
    console.log('🛑 Signing queue service stopped');
  }

  /**
   * Process all posts that need signing
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing) {
      console.log('⏳ Signing queue already processing, skipping...');
      return;
    }

    this.isProcessing = true;
    
    try {
      const postsToSign = await this.db.getPostsReadyForSigning();
      
      if (postsToSign.length === 0) {
        console.log('📝 No posts ready for signing');
        return;
      }

      console.log(`🖊️ Processing ${postsToSign.length} posts for signing`);

      // Group posts by account to minimize key access
      const postsByAccount = this.groupPostsByAccount(postsToSign);

      for (const [accountId, accountPosts] of postsByAccount.entries()) {
        try {
          await this.processAccountPosts(accountId, accountPosts);
        } catch (error) {
          console.error(`❌ Error processing posts for account ${accountId}:`, error);
          
          // Mark all posts for this account as failed
          for (const post of accountPosts) {
            await this.db.markAsFailed(post.id!, `Signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }

    } catch (error) {
      console.error('❌ Error in signing queue process:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Trigger immediate processing of the queue
   */
  async triggerProcessing(): Promise<void> {
    console.log('🔄 Manually triggering signing queue processing...');
    await this.processQueue();
  }

  /**
   * Group posts by account ID for batch processing
   */
  private groupPostsByAccount(posts: (Post & { content: string })[]): Map<number, (Post & { content: string })[]> {
    const grouped = new Map<number, (Post & { content: string })[]>();
    
    for (const post of posts) {
      const accountId = post.account_id || 1; // Default to account 1 if no account specified
      
      if (!grouped.has(accountId)) {
        grouped.set(accountId, []);
      }
      
      grouped.get(accountId)!.push(post);
    }
    
    return grouped;
  }

  /**
   * Process all posts for a specific account
   */
  private async processAccountPosts(accountId: number, posts: (Post & { content: string })[]): Promise<void> {
    console.log(`🔑 Processing ${posts.length} posts for account ${accountId}`);

    // Get account details
    const account = await this.db.getAccount(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    // Get private key (try keychain first, then database fallback)
    let nsec = account.nsec;
    const keychainNsec = await getNsecFromKeychain(accountId);
    if (keychainNsec) {
      nsec = keychainNsec;
      console.log(`🔐 Using private key from macOS Keychain for account ${accountId}`);
    } else if (nsec) {
      console.log(`🔐 Using private key from database for account ${accountId}`);
    } else {
      throw new Error(`No private key found for account ${accountId}`);
    }

    // Get PoW difficulty
    const powDifficulty = process.env.POW_BITS ? parseInt(process.env.POW_BITS) : 20;

    // Create signer
    const { data: privhex } = nip19.decode(nsec);
    const signer = new NDKPrivateKeySigner(privhex as string);

    // Process each post
    for (const post of posts) {
      try {
        console.log(`🖊️ Signing post ${post.id}: "${post.content.substring(0, 50)}..."`);
        
        // Mark as signing
        await this.db.markAsSigning(post.id!);

        // Create and sign the event
        const eventData = buildTextNote(post.content);
        const event = new NDKEvent(undefined, eventData);
        
        // Sign the event
        await event.sign(signer);
        
        let finalEvent = event;
        
        // Apply proof-of-work if requested
        if (powDifficulty > 0) {
          console.log(`⛏️ Mining proof-of-work with difficulty ${powDifficulty} for post ${post.id}...`);
          const minedRawEvent = await mineEventPow(event, powDifficulty);
          finalEvent = new NDKEvent(undefined, minedRawEvent);
          await finalEvent.sign(signer); // Re-sign after mining
          console.log(`✅ Proof-of-work completed for post ${post.id}`);
        }

        // Store the signed event
        const signedEventData = finalEvent.rawEvent();
        await this.db.markAsSigned(post.id!, signedEventData);
        
        console.log(`✅ Post ${post.id} signed and stored successfully`);
        
      } catch (error) {
        console.error(`❌ Failed to sign post ${post.id}:`, error);
        await this.db.markAsFailed(post.id!, `Signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    console.log(`✅ Completed signing ${posts.length} posts for account ${accountId}`);
  }
}

export default SigningQueueService;