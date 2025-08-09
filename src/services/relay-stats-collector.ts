import NDK, { NDKEvent, NDKKind, NDKFilter } from "@nostr-dev-kit/ndk";
import { EventStats } from './primal-client.js';
import * as bolt11 from 'bolt11';

export interface RelayStatsConfig {
  relayUrls?: string[];
  timeout?: number;
  maxEvents?: number;
}

export class RelayStatsCollector {
  private ndk: NDK;
  private readonly timeout: number;
  private readonly maxEvents: number;
  
  // Default relays for stats collection (fewer, more reliable ones)
  private readonly defaultRelays = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://relay.nostr.band"
  ];

  constructor(config: RelayStatsConfig = {}) {
    this.timeout = config.timeout || 15000; // 15 seconds (increased from 10)
    this.maxEvents = config.maxEvents || 500; // Max events to fetch per type
    
    const relays = config.relayUrls || this.defaultRelays;
    this.ndk = new NDK({ 
      explicitRelayUrls: relays,
      enableOutboxModel: false, // Disable for faster connections
      autoConnectUserRelays: false,
      autoFetchUserMutelist: false
    });
  }

  async connect(): Promise<void> {
    console.log('🔗 Connecting to Nostr relays for stats collection...');
    
    // Connect with timeout
    const connectPromise = this.ndk.connect();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
    
    try {
      await Promise.race([connectPromise, timeoutPromise]);
      console.log(`✅ Connected to ${this.ndk.pool.connectedRelays().length} relays`);
    } catch (error) {
      console.log(`⚠️  Connection timeout, proceeding with ${this.ndk.pool.connectedRelays().length} connected relays`);
    }
  }

  async getEventStats(eventId: string): Promise<EventStats | null> {
    try {
      if (!this.ndk.pool.connectedRelays().length) {
        await this.connect();
      }

      console.log(`📊 Collecting stats for event: ${eventId.substring(0, 20)}...`);
      
      // Create filters for different interaction types
      const filters: NDKFilter[] = [
        // Reactions (kind 7) - likes and dislikes
        {
          kinds: [NDKKind.Reaction],
          "#e": [eventId],
          limit: this.maxEvents
        },
        // Reposts (kind 6) 
        {
          kinds: [NDKKind.Repost], 
          "#e": [eventId],
          limit: this.maxEvents
        },
        // Zaps (kind 9735)
        {
          kinds: [9735],
          "#e": [eventId], 
          limit: this.maxEvents
        },
        // Text notes that reference this event (replies, quotes)
        {
          kinds: [NDKKind.Text],
          "#e": [eventId],
          limit: this.maxEvents
        }
      ];

      // Collect events with timeout
      const events = await Promise.race([
        this.collectEvents(filters),
        this.timeoutPromise<NDKEvent[]>()
      ]);

      if (!events || events.length === 0) {
        console.log(`❓ No interaction events found for ${eventId.substring(0, 20)}`);
        // Return stats with zero values rather than null
        return {
          event_id: eventId,
          likes: 0,
          reposts: 0,
          zaps: 0,
          zap_amount_sats: 0,
          replies: 0,
          last_updated: new Date().toISOString()
        };
      }

      // Process and count the events
      const stats = this.processEvents(events, eventId);
      
      console.log(`✅ Stats collected for ${eventId.substring(0, 20)}: ${stats.likes}❤️ ${stats.reposts}🔄 ${stats.zap_amount_sats}⚡`);
      return stats;

    } catch (error) {
      console.error(`❌ Error collecting relay stats for ${eventId.substring(0, 20)}:`, error);
      throw error;
    }
  }

  private async collectEvents(filters: NDKFilter[]): Promise<NDKEvent[]> {
    const allEvents: NDKEvent[] = [];
    
    for (const filter of filters) {
      try {
        const events = await this.ndk.fetchEvents(filter);
        allEvents.push(...Array.from(events));
      } catch (error) {
        console.warn(`⚠️  Failed to fetch events for filter ${filter.kinds?.join(',')}:`, error);
      }
    }
    
    return allEvents;
  }

  private processEvents(events: NDKEvent[], targetEventId: string): EventStats {
    let likes = 0;
    let reposts = 0; 
    let zaps = 0;
    let zap_amount_sats = 0;
    let replies = 0;
    
    // Deduplicate by event ID
    const uniqueEvents = new Map<string, NDKEvent>();
    events.forEach(event => {
      uniqueEvents.set(event.id, event);
    });

    for (const event of uniqueEvents.values()) {
      try {
        switch (event.kind) {
          case NDKKind.Reaction: // kind 7
            // Count positive reactions (+, ❤️, 🤙, etc.) as likes
            const content = event.content.trim();
            if (content === '+' || content === '❤️' || content === '🤙' || 
                content === '👍' || content === '🔥' || content === '💜' ||
                content === '' || content.match(/^[\u2764\uFE0F\u2665\uFE0F\u{1F495}\u{1F496}\u{1F497}\u{1F498}\u{1F499}\u{1F49A}\u{1F49B}\u{1F49C}\u{1F49D}\u{1F49E}\u{1F49F}]+$/u)) {
              likes++;
            }
            break;
            
          case NDKKind.Repost: // kind 6
            reposts++;
            break;
            
          case 9735: // Zap receipts
            zaps++;
            // First try to get amount from 'amount' tag (millisatoshis)
            const amountTag = event.tags.find(tag => tag[0] === 'amount');
            if (amountTag && amountTag[1]) {
              const milliSats = parseInt(amountTag[1], 10);
              if (!isNaN(milliSats)) {
                zap_amount_sats += Math.floor(milliSats / 1000); // Convert millisats to sats
              }
            } else {
              // Fallback: try to extract zap amount from bolt11 invoice
              const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
              if (bolt11Tag && bolt11Tag[1]) {
                const amount = this.extractAmountFromBolt11(bolt11Tag[1]);
                if (amount > 0) {
                  zap_amount_sats += amount;
                }
              }
            }
            break;
            
          case NDKKind.Text: // kind 1 (replies/quotes)
            // Only count if it's actually referencing our event (not just mentioning)
            const eTag = event.tags.find(tag => tag[0] === 'e' && tag[1] === targetEventId);
            if (eTag) {
              replies++;
            }
            break;
        }
      } catch (error) {
        console.warn(`⚠️  Error processing event ${event.id}:`, error);
      }
    }

    return {
      event_id: targetEventId,
      likes,
      reposts,
      zaps,
      zap_amount_sats,
      replies,
      last_updated: new Date().toISOString()
    };
  }

  private extractAmountFromBolt11(bolt11Invoice: string): number {
    try {
      // Use proper BOLT11 decoder library
      const decoded = bolt11.decode(bolt11Invoice);
      
      // BOLT11 amount is in millisatoshis, convert to satoshis
      if (decoded.millisatoshis) {
        return Math.floor(parseInt(decoded.millisatoshis) / 1000);
      }
      
      return 0;
    } catch (error) {
      console.warn('⚠️  Failed to parse BOLT11 amount:', error);
      return 0;
    }
  }

  private timeoutPromise<T>(): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout collecting relay stats')), this.timeout);
    });
  }

  async disconnect(): Promise<void> {
    console.log('🔌 Disconnecting from Nostr relays...');
    // NDK doesn't have a direct disconnect method, close individual connections
    const relays = this.ndk.pool.relays.values();
    for (const relay of relays) {
      relay.disconnect();
    }
  }

  getConnectedRelayCount(): number {
    return this.ndk.pool.connectedRelays().length;
  }
}