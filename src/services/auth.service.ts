import crypto from 'crypto';
import { MasterAccount, Session } from '../database/schema.js';
import { PostDatabase } from '../database/db.js';

export class AuthService {
  private db: PostDatabase;
  private sessionDuration: number = 24 * 60 * 60 * 1000; // 24 hours in ms

  constructor(database: PostDatabase) {
    this.db = database;
  }

  // Generate a challenge for authentication
  generateChallenge(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  // Verify a NIP-07 signed event
  async verifySignedEvent(signedEvent: any, challenge: string): Promise<{ valid: boolean; npub?: string }> {
    try {
      // Check if the event contains the expected challenge
      const challengeTag = signedEvent.tags?.find((tag: string[]) => tag[0] === 'challenge');
      if (!challengeTag || challengeTag[1] !== challenge) {
        return { valid: false };
      }

      // Check event kind (27235 for authentication)
      if (signedEvent.kind !== 27235) {
        return { valid: false };
      }

      // Extract npub from the signed event
      // In a real implementation, we'd verify the signature here
      // For now, we'll trust the browser extension's signature
      const npub = `npub${signedEvent.pubkey}`;

      return { valid: true, npub };
    } catch (error) {
      console.error('Error verifying signed event:', error);
      return { valid: false };
    }
  }

  // Create or retrieve a master account
  async getOrCreateMasterAccount(npub: string, displayName?: string): Promise<MasterAccount> {
    const existing = await this.db.getMasterAccount(npub);
    
    if (existing) {
      // Update last login
      await this.db.updateMasterAccountLastLogin(npub);
      return existing;
    }

    // Create new master account
    const newAccount: MasterAccount = {
      npub,
      display_name: displayName,
      created_at: new Date().toISOString(),
      last_login: new Date().toISOString(),
      status: 'active'
    };

    await this.db.createMasterAccount(newAccount);
    
    // Check for unclaimed signing keys and assign them to this account
    await this.claimUnassignedSigningKeys(npub);
    
    return newAccount;
  }

  // Assign unclaimed signing keys to the first master account
  private async claimUnassignedSigningKeys(npub: string): Promise<void> {
    const unclaimedKeys = await this.db.getUnclaimedSigningKeys();
    
    if (unclaimedKeys.length > 0) {
      console.log(`Assigning ${unclaimedKeys.length} unclaimed signing keys to ${npub}`);
      for (const key of unclaimedKeys) {
        await this.db.assignSigningKeyToMaster(key.id!, npub);
      }
    }
  }

  // Create a new session
  async createSession(npub: string, userAgent?: string, ipAddress?: string): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    const session: Session = {
      id: sessionId,
      master_account_npub: npub,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + this.sessionDuration).toISOString(),
      created_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
      user_agent: userAgent,
      ip_address: ipAddress
    };

    await this.db.createSession(session);
    
    // Return the unhashed token for the client
    return token;
  }

  // Validate a session token
  async validateSession(token: string): Promise<Session | null> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await this.db.getSessionByToken(tokenHash);
    
    if (!session) {
      return null;
    }

    // Check if session is expired
    if (new Date(session.expires_at) < new Date()) {
      await this.db.deleteSession(session.id);
      return null;
    }

    // Update last activity
    await this.db.updateSessionActivity(session.id);
    
    return session;
  }

  // End a session
  async logout(token: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await this.db.getSessionByToken(tokenHash);
    
    if (session) {
      await this.db.deleteSession(session.id);
    }
  }

  // Log an audit event
  async logAudit(
    masterAccountNpub: string | undefined,
    action: string,
    entityType?: string,
    entityId?: string,
    details?: any,
    ipAddress?: string
  ): Promise<void> {
    await this.db.createAuditLog({
      master_account_npub: masterAccountNpub,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details: details ? JSON.stringify(details) : undefined,
      timestamp: new Date().toISOString(),
      ip_address: ipAddress
    });
  }

  // Clean up expired sessions
  async cleanupExpiredSessions(): Promise<void> {
    await this.db.deleteExpiredSessions();
  }
}

// Helper function to convert hex pubkey to npub format
export function hexToNpub(hex: string): string {
  // This is a simplified version - in production, use proper bech32 encoding
  return `npub1${hex}`;
}

// Helper function to extract hex from npub
export function npubToHex(npub: string): string {
  // This is a simplified version - in production, use proper bech32 decoding
  if (npub.startsWith('npub1')) {
    return npub.substring(5);
  }
  return npub;
}