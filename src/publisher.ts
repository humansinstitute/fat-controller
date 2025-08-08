import PostDatabase from './database/db.js';
import { send, receive, MessageTracker, createMessageTracker } from 'nostrmq';
import { publishTextNote } from './nostr.service.js';
import { getNsecFromKeychain } from './keychain.service.js';

// Create a global message tracker for deduplication
const messageTracker = createMessageTracker();
let receiveSubscription: any = null;

// Initialize NostrMQ receiver to listen for responses
export async function initializeNostrMQReceiver(): Promise<void> {
  if (receiveSubscription) {
    console.log('🎧 NostrMQ receiver already initialized');
    return;
  }

  try {
    console.log('🚀 Initializing NostrMQ receiver for response monitoring...');
    
    // Initialize the message tracker
    await messageTracker.initialize();
    
    receiveSubscription = receive({
      onMessage: async (payload: any, sender: string, rawEvent: any) => {
        // Check if this is a duplicate message using the correct API
        if (messageTracker.hasProcessed(rawEvent.id, rawEvent.created_at)) {
          console.log('⚠️ Duplicate NostrMQ response received, ignoring:', rawEvent.id.substring(0, 20));
          return;
        }

        // Track this message to prevent duplicates
        await messageTracker.markProcessed(rawEvent.id, rawEvent.created_at);

        console.log('📨 NOSTRMQ RESPONSE RECEIVED');
        console.log('================================');
        console.log(`📤 From: ${sender.substring(0, 20)}...`);
        console.log(`📋 Event ID: ${rawEvent.id}`);
        console.log(`⏰ Timestamp: ${new Date(rawEvent.created_at * 1000).toISOString()}`);
        console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));
        
        // Log specific response details if it's a post/note response
        if (typeof payload === 'object' && payload !== null) {
          const p = payload as any;
          if (p.status) {
            console.log(`✅ Status: ${p.status}`);
          }
          if (p.error) {
            console.log(`❌ Error: ${p.error}`);
          }
          if (p.noteId) {
            console.log(`🆔 Note ID: ${p.noteId}`);
          }
          if (p.published) {
            console.log(`📅 Published: ${p.published}`);
          }
          if (p.success !== undefined) {
            console.log(`🎯 Success: ${p.success}`);
          }
        }
        
        console.log('================================\n');
      }
    });

    console.log('✅ NostrMQ receiver initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize NostrMQ receiver:', error);
  }
}

// Stop the NostrMQ receiver
export function stopNostrMQReceiver(): void {
  if (receiveSubscription) {
    console.log('🛑 Stopping NostrMQ receiver...');
    receiveSubscription.close();
    receiveSubscription = null;
  }
}

export async function publishToNostr(content: string, apiEndpoint?: string, postId?: number): Promise<void> {
  const db = new PostDatabase();
  let npub: string | undefined;
  let nsec: string | undefined;
  let relays: string[] | undefined;
  let endpoint = apiEndpoint || process.env.NOSTR_API_ENDPOINT || 'http://localhost:3000/post/note';
  let publishMethod: 'api' | 'nostrmq' | 'direct' = 'api';
  let nostrmqTarget: string | undefined;
  
  try {
    if (postId) {
      // Get the post to find its associated account and publish method
      const posts = await db.getAllPosts();
      const post = posts.find(p => p.id === postId);
      
      if (post) {
        // Use post-level publish method if specified
        if (post.publish_method) {
          publishMethod = post.publish_method;
          console.log(`Using post-level publish method: ${publishMethod}`);
        }
        
        if (post.account_id) {
          const account = await db.getAccount(post.account_id);
          if (account) {
            npub = account.npub;
            nsec = account.nsec;
            relays = account.relays?.split(',').map(r => r.trim()).filter(r => r);
            // Only use account's publish method if post doesn't specify one
            if (!post.publish_method) {
              publishMethod = account.publish_method;
            }
            endpoint = account.api_endpoint || endpoint;
            nostrmqTarget = account.nostrmq_target;
            console.log(`Using account: ${account.name} (${account.npub.substring(0, 20)}...) - Method: ${publishMethod}`);
          }
        }
      }
    }
    
    // Fallback to active account or env var
    if (!npub) {
      const activeAccount = await db.getActiveAccount();
      if (activeAccount) {
        npub = activeAccount.npub;
        nsec = activeAccount.nsec;
        relays = activeAccount.relays?.split(',').map(r => r.trim()).filter(r => r);
        // Only use account method as fallback if not already set
        if (publishMethod === 'api' && !postId) {
          publishMethod = activeAccount.publish_method;
        }
        endpoint = activeAccount.api_endpoint || endpoint;
        nostrmqTarget = activeAccount.nostrmq_target;
        console.log(`Using active account: ${activeAccount.name} (${activeAccount.npub.substring(0, 20)}...) - Method: ${publishMethod}`);
      } else {
        npub = process.env.NOSTR_NPUB;
        console.log('Using NPUB from environment variable - Method: api');
      }
    }
  } catch (error) {
    console.error('Error getting account info:', error);
    npub = process.env.NOSTR_NPUB;
  } finally {
    db.close();
  }
  
  console.log('\n🔄 ATTEMPTING TO PUBLISH TO NOSTR');
  console.log('================================');
  console.log(`Method: ${publishMethod.toUpperCase()}`);
  console.log(`NPUB: ${npub ? npub.substring(0, 20) + '...' : 'NOT SET'}`);
  
  if (!npub) {
    console.error('❌ No NPUB found in accounts or environment variables');
    throw new Error('No NPUB found in accounts or environment variables');
  }
  
  if (publishMethod === 'direct') {
    // Try to get nsec from keychain first
    let finalNsec = nsec;
    let keySource = 'database';
    
    // Get the account ID from the post or active account
    let accountId: number | undefined;
    if (postId) {
      const posts = await db.getAllPosts();
      const post = posts.find(p => p.id === postId);
      accountId = post?.account_id;
    }
    if (!accountId) {
      const activeAccount = await db.getActiveAccount();
      accountId = activeAccount?.id;
    }
    
    // Try keychain first if we have an account ID
    if (accountId) {
      const keychainNsec = await getNsecFromKeychain(accountId);
      if (keychainNsec) {
        finalNsec = keychainNsec;
        keySource = 'keychain';
        console.log(`🔐 Retrieved private key from macOS Keychain`);
      }
    }
    
    if (!finalNsec) {
      console.error('❌ No private key (nsec) found for direct publishing');
      throw new Error('No private key (nsec) found for direct publishing');
    }
    
    console.log(`Direct Publishing Mode`);
    console.log(`Key Source: ${keySource}`);
    console.log(`Relays: ${relays?.join(', ') || 'Using defaults'}`);
    
    try {
      const powDifficulty = process.env.POW_BITS ? parseInt(process.env.POW_BITS) : 20;
      console.log(`⛏️ Proof-of-work difficulty: ${powDifficulty}`);
      
      const result = await publishTextNote(content, finalNsec, relays, powDifficulty);
      
      console.log(`✅ Successfully published via direct relay connection!`);
      console.log(`📋 Event ID: ${result.id}`);
      console.log(`🌐 Published to ${result.relays.length} relay(s): ${result.relays.join(', ')}`);
      console.log('================================\n');
    } catch (error) {
      console.error('❌ ERROR during direct publishing:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
      console.log('================================\n');
      throw error;
    }
  } else if (publishMethod === 'nostrmq') {
    if (!nostrmqTarget) {
      console.error('❌ NostrMQ target not set for NostrMQ publishing method');
      throw new Error('NostrMQ target not set for NostrMQ publishing method');
    }
    
    console.log(`NostrMQ Target: ${nostrmqTarget.substring(0, 20)}...`);
    
    // Ensure NostrMQ receiver is initialized when we use NostrMQ
    if (!receiveSubscription) {
      console.log('🔧 NostrMQ receiver not initialized, starting it now...');
      try {
        await initializeNostrMQReceiver();
      } catch (error) {
        console.error('⚠️ Failed to initialize NostrMQ receiver during publish:', error);
      }
    }
    
    const payload = {
      action: "/post/note",
      data: {
        npub: npub,
        content: content,
        powBits: process.env.POW_BITS ? parseInt(process.env.POW_BITS) : 0,
        timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS) : 10000
      }
    };
    
    console.log('NostrMQ payload:', JSON.stringify({
      action: payload.action,
      data: {
        ...payload.data,
        npub: payload.data.npub.substring(0, 20) + '...',
        content: payload.data.content.substring(0, 50) + '...'
      }
    }, null, 2));
    
    try {
      console.log(`📤 Sending via NostrMQ to target: ${nostrmqTarget}`);
      console.log('📦 Full NostrMQ send parameters:');
      console.log(JSON.stringify({
        target: nostrmqTarget,
        payload: payload
      }, null, 2));
      
      console.log('🔄 Calling NostrMQ send() function...');
      const eventId = await send({
        target: nostrmqTarget,
        payload: payload
      });
      
      console.log(`✅ NostrMQ send() completed successfully!`);
      console.log(`📋 Returned Event ID: ${eventId}`);
      console.log(`🎯 Target: ${nostrmqTarget}`);
      console.log(`📝 Action: ${payload.action}`);
      console.log(`💬 Content: "${payload.data.content.substring(0, 100)}${payload.data.content.length > 100 ? '...' : ''}"`);
      
      if (typeof eventId === 'string') {
        console.log(`🔗 Event ID type: string, length: ${eventId.length}`);
      } else {
        console.log(`🔗 Event ID type: ${typeof eventId}, value:`, eventId);
      }
      
      console.log('================================\n');
    } catch (error) {
      console.error('❌ ERROR during NostrMQ send() call:');
      console.error('🚨 Error details:', error);
      
      if (error instanceof Error) {
        console.error('📛 Error name:', error.name);
        console.error('💬 Error message:', error.message);
        console.error('📍 Error stack:', error.stack);
      }
      
      // Log the parameters that failed
      console.error('🔧 Failed parameters:');
      console.error('   Target:', nostrmqTarget);
      console.error('   Payload action:', payload.action);
      console.error('   Payload data keys:', Object.keys(payload.data));
      
      console.log('================================\n');
      throw error;
    }
  } else {
    // API publishing method
    console.log(`API Endpoint: ${endpoint}`);
    
    const requestBody = {
      npub: npub,
      content: content,
      powBits: process.env.POW_BITS ? parseInt(process.env.POW_BITS) : undefined,
      timeoutMs: process.env.TIMEOUT_MS ? parseInt(process.env.TIMEOUT_MS) : undefined
    };
    
    console.log('Request body:', JSON.stringify({
      ...requestBody,
      npub: requestBody.npub.substring(0, 20) + '...',
      content: requestBody.content.substring(0, 50) + '...'
    }, null, 2));
    
    console.log(`📤 Making POST request to: ${endpoint}`);
    
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
      } catch (e) {
        console.log('Response is not JSON, raw text:', responseText);
        result = responseText;
      }
      
      console.log('✅ Successfully published to Nostr!');
      console.log('Full response:', JSON.stringify(result, null, 2));
      console.log('================================\n');
    } catch (error) {
      console.error('❌ ERROR during API call:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
      console.log('================================\n');
      throw error;
    }
  }
}