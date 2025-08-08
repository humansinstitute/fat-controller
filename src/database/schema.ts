export interface ScheduledPost {
  id?: number;
  content: string;
  created_at: string;
  scheduled_for: string;
  published_at?: string;
  status: 'pending' | 'published' | 'failed';
  error_message?: string;
  api_endpoint?: string;
  account_id?: number;
  publish_method?: 'api' | 'nostrmq';
}

export interface NostrAccount {
  id?: number;
  name: string;
  npub: string;
  nsec?: string; // DEPRECATED - for backward compatibility only
  keychain_ref?: string; // reference to keychain entry for secure key storage
  api_endpoint?: string;
  publish_method: 'api' | 'nostrmq' | 'direct';
  nostrmq_target?: string; // hex pubkey for NostrMQ target
  relays?: string; // comma-separated list of relay URLs for direct publishing
  is_active: boolean;
  created_at: string;
}