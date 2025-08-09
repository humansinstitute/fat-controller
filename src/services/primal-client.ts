import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface EventStats {
  event_id: string;
  likes: number;
  reposts: number;
  zaps: number;
  zap_amount_sats: number;
  replies: number;
  last_updated: string;
}

export interface PrimalResponse {
  success: boolean;
  data?: EventStats;
  error?: string;
}

export class PrimalClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, {
    resolve: (value: PrimalResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  
  private readonly baseUrl: string;
  private readonly timeout: number;
  private isConnecting: boolean = false;

  constructor(
    baseUrl: string = 'wss://primal-cache.mutinywallet.com/api',
    timeout: number = 30000
  ) {
    super();
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      await new Promise(resolve => {
        this.once('connected', resolve);
        this.once('error', resolve);
      });
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.baseUrl);

        const connectTimeout = setTimeout(() => {
          this.isConnecting = false;
          reject(new Error('WebSocket connection timeout'));
        }, this.timeout);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.isConnecting = false;
          console.log('🔗 Connected to Primal WebSocket');
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            console.error('❌ Error parsing Primal response:', error);
          }
        });

        this.ws.on('close', () => {
          console.log('🔌 Primal WebSocket connection closed');
          this.ws = null;
          this.isConnecting = false;
          
          // Reject all pending requests
          this.pendingRequests.forEach((req) => {
            clearTimeout(req.timeout);
            req.reject(new Error('WebSocket connection closed'));
          });
          this.pendingRequests.clear();
        });

        this.ws.on('error', (error) => {
          console.error('❌ Primal WebSocket error:', error);
          clearTimeout(connectTimeout);
          this.isConnecting = false;
          this.emit('error', error);
          reject(error);
        });

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  private handleMessage(message: any) {
    // Handle different message types from Primal
    if (Array.isArray(message) && message.length >= 3) {
      const [type, requestId, ...data] = message;
      
      if (type === 'EVENT' && requestId) {
        const pendingRequest = this.pendingRequests.get(requestId);
        if (pendingRequest) {
          clearTimeout(pendingRequest.timeout);
          this.pendingRequests.delete(requestId);
          
          try {
            const stats = this.parseEventStats(data[0]);
            pendingRequest.resolve({
              success: true,
              data: stats
            });
          } catch (error) {
            pendingRequest.reject(error as Error);
          }
        }
      } else if (type === 'EOSE' && requestId) {
        // End of stored events - if we haven't received data, return not found
        const pendingRequest = this.pendingRequests.get(requestId);
        if (pendingRequest) {
          clearTimeout(pendingRequest.timeout);
          this.pendingRequests.delete(requestId);
          pendingRequest.resolve({
            success: false,
            error: 'Event not found'
          });
        }
      }
    }
  }

  private parseEventStats(eventData: any): EventStats {
    // Parse Primal's event data format
    // This may need adjustment based on actual Primal API response format
    const stats: EventStats = {
      event_id: eventData.id || '',
      likes: 0,
      reposts: 0,
      zaps: 0,
      zap_amount_sats: 0,
      replies: 0,
      last_updated: new Date().toISOString()
    };

    // Count reactions (kind 7 events)
    if (eventData.reactions) {
      stats.likes = eventData.reactions.filter((r: any) => 
        r.content === '+' || r.content === '❤️' || r.content === '🤙'
      ).length;
    }

    // Count reposts (kind 6 and 16 events)
    if (eventData.reposts) {
      stats.reposts = eventData.reposts.length;
    }

    // Count zaps (kind 9735 events)
    if (eventData.zaps) {
      stats.zaps = eventData.zaps.length;
      stats.zap_amount_sats = eventData.zaps.reduce((total: number, zap: any) => {
        // Parse zap amount from bolt11 or amount tag
        const amount = this.parseZapAmount(zap);
        return total + amount;
      }, 0);
    }

    // Count replies (kind 1 events that reference this event)
    if (eventData.replies) {
      stats.replies = eventData.replies.length;
    }

    return stats;
  }

  private parseZapAmount(zapEvent: any): number {
    // Parse zap amount from bolt11 invoice or amount tag
    if (zapEvent.tags) {
      for (const tag of zapEvent.tags) {
        if (tag[0] === 'amount') {
          return parseInt(tag[1], 10) / 1000; // Convert millisats to sats
        }
      }
    }
    
    // Fallback: try to parse from bolt11
    if (zapEvent.bolt11) {
      // This would require a proper bolt11 decoder
      // For now, return 0 if we can't parse
      return 0;
    }
    
    return 0;
  }

  private generateRequestId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  async getEventStats(eventId: string): Promise<EventStats | null> {
    try {
      await this.connect();
      
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not connected');
      }

      const requestId = this.generateRequestId();
      
      // Request format based on Primal's API pattern
      // This may need adjustment based on actual Primal API format
      const request = [
        'REQ',
        requestId,
        {
          cache: ['event_stats', { event_id: eventId }]
        }
      ];

      return new Promise((resolve, reject) => {
        const requestTimeout = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Request timeout for event ${eventId}`));
        }, this.timeout);

        this.pendingRequests.set(requestId, {
          resolve: (response: PrimalResponse) => {
            if (response.success && response.data) {
              resolve(response.data);
            } else {
              resolve(null); // Event not found
            }
          },
          reject,
          timeout: requestTimeout
        });

        this.ws!.send(JSON.stringify(request));
      });

    } catch (error) {
      console.error(`❌ Error fetching stats for event ${eventId}:`, error);
      return null;
    }
  }

  async batchGetEventStats(eventIds: string[]): Promise<Map<string, EventStats>> {
    const results = new Map<string, EventStats>();
    
    // Process in batches to avoid overwhelming the API
    const batchSize = 10;
    for (let i = 0; i < eventIds.length; i += batchSize) {
      const batch = eventIds.slice(i, i + batchSize);
      
      const batchPromises = batch.map(eventId => 
        this.getEventStats(eventId).then(stats => ({ eventId, stats }))
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.stats) {
          results.set(result.value.eventId, result.value.stats);
        }
      });
      
      // Add delay between batches to respect rate limits
      if (i + batchSize < eventIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    // Clear all pending requests
    this.pendingRequests.forEach((req) => {
      clearTimeout(req.timeout);
      req.reject(new Error('Client disconnected'));
    });
    this.pendingRequests.clear();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// HTTP fallback client for when WebSocket is not available
export class PrimalHttpClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(
    baseUrl: string = 'https://primal.net/api',
    timeout: number = 30000
  ) {
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  async getEventStats(eventId: string): Promise<EventStats | null> {
    try {
      // This is a fallback implementation - actual HTTP API may differ
      const response = await fetch(`${this.baseUrl}/v1/events/${eventId}/stats`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'fat-controller/1.0.0'
        },
        signal: AbortSignal.timeout(this.timeout)
      });

      if (response.status === 404) {
        return null; // Event not found
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data as EventStats;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout for event ${eventId}`);
      }
      throw error;
    }
  }

  async batchGetEventStats(eventIds: string[]): Promise<Map<string, EventStats>> {
    const results = new Map<string, EventStats>();
    
    // Process individually since batch endpoint format is unknown
    for (const eventId of eventIds) {
      try {
        const stats = await this.getEventStats(eventId);
        if (stats) {
          results.set(eventId, stats);
        }
        
        // Add small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`❌ Failed to fetch stats for event ${eventId}:`, error);
      }
    }
    
    return results;
  }
}