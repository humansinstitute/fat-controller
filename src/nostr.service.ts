import NDK, {
  NDKPrivateKeySigner,
  NDKEvent,
  NDKKind,
} from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";
import { mineEventPow } from "./pow.service.js";

// Default relays if none are specified
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://relayable.org",
  "wss://relay.primal.net",
];

const DEFAULT_POW = 20; // Default proof-of-work difficulty
const DEFAULT_TIMEOUT = 10000; // 10 seconds

export interface NostrConnection {
  ndk: NDK;
  signer: NDKPrivateKeySigner;
  npub: string;
}

/**
 * Builds a basic Kind 1 Nostr text note event object.
 */
export function buildTextNote(content: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    kind: NDKKind.Text,
    content,
    tags: [],
    created_at: timestamp,
  };
}

/**
 * Connects to Nostr relays with NDK.
 */
export async function connectToRelays(
  nsec: string,
  relayUrls?: string[]
): Promise<NostrConnection> {
  // Decode the private key
  const { data: privhex } = nip19.decode(nsec);
  const signer = new NDKPrivateKeySigner(privhex as string);
  
  // Get the public key
  const user = await signer.user();
  const npub = user.npub;
  
  // Use provided relays or defaults
  const selectedRelays = relayUrls && relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
  
  console.log(`🔌 Connecting to ${selectedRelays.length} relays...`);
  
  const ndk = new NDK({
    explicitRelayUrls: selectedRelays,
    signer,
  });
  
  try {
    await ndk.connect(DEFAULT_TIMEOUT);
    
    const connectedRelays = Array.from(ndk.pool.relays.values()).filter(
      (r) => r.status === 1 // WebSocket.OPEN
    );
    
    if (connectedRelays.length > 0) {
      console.log(
        `✅ Connected to ${connectedRelays.length} relay(s):`,
        connectedRelays.map((r) => r.url)
      );
    } else {
      console.warn("⚠️ No relays connected, events may not publish");
    }
  } catch (error) {
    console.error("❌ Error connecting to relays:", error);
    throw new Error(`Failed to connect to Nostr relays: ${error}`);
  }
  
  return { ndk, signer, npub };
}

/**
 * Publishes a text note to Nostr relays with optional proof-of-work.
 */
export async function publishTextNote(
  content: string,
  nsec: string,
  relayUrls?: string[],
  powDifficulty: number = DEFAULT_POW
): Promise<{ id: string; relays: string[] }> {
  // Connect to relays
  const { ndk, signer } = await connectToRelays(nsec, relayUrls);
  
  // Create the event
  const event = new NDKEvent(ndk, buildTextNote(content));
  
  // Sign the event
  await event.sign(signer);
  
  // Apply proof-of-work if requested
  let finalEvent = event;
  if (powDifficulty > 0) {
    console.log(`⛏️ Mining proof-of-work with difficulty ${powDifficulty}...`);
    const minedRawEvent = await mineEventPow(event, powDifficulty);
    finalEvent = new NDKEvent(ndk, minedRawEvent);
    await finalEvent.sign(signer); // Re-sign after mining
    console.log(`✅ Proof-of-work completed`);
  }
  
  // Publish the event
  console.log(`📤 Publishing event to relays...`);
  try {
    const publishedRelays = await finalEvent.publish(undefined, DEFAULT_TIMEOUT);
    const relayUrls = Array.from(publishedRelays).map((r) => r.url);
    
    console.log(`✅ Event published to ${relayUrls.length} relay(s)`);
    return {
      id: finalEvent.id!,
      relays: relayUrls,
    };
  } catch (error) {
    console.error("❌ Error publishing event:", error);
    throw error;
  }
}

/**
 * Publishes a pre-signed event to Nostr relays.
 */
export async function publishSignedEventToRelays(
  signedEventData: any,
  relayUrls?: string[]
): Promise<{ id: string; relays: string[] }> {
  // Use provided relays or defaults
  const selectedRelays = relayUrls && relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
  
  console.log(`🔌 Connecting to ${selectedRelays.length} relays for pre-signed event...`);
  
  const ndk = new NDK({
    explicitRelayUrls: selectedRelays,
  });
  
  let publishedRelayUrls: string[] = [];
  
  try {
    // Connect with timeout
    await Promise.race([
      ndk.connect(5000), // 5 second timeout for connection
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 5000)
      )
    ]);
    
    const connectedRelays = Array.from(ndk.pool.relays.values()).filter(
      (r) => r.status === 1 // WebSocket.OPEN
    );
    
    if (connectedRelays.length > 0) {
      console.log(
        `✅ Connected to ${connectedRelays.length} relay(s):`,
        connectedRelays.map((r) => r.url)
      );
    } else {
      console.warn("⚠️ No relays connected, attempting to publish anyway");
    }
  } catch (error) {
    console.error("❌ Error connecting to relays:", error);
    console.log("🔄 Attempting to publish with partial connections...");
  }
  
  // Create NDK event from the signed data
  const event = new NDKEvent(ndk, signedEventData);
  
  // Publish the event with timeout
  console.log(`📤 Publishing pre-signed event to relays...`);
  try {
    const publishPromise = event.publish(undefined, 5000); // 5 second publish timeout
    const timeoutPromise = new Promise<Set<any>>((_, reject) => 
      setTimeout(() => reject(new Error('Publish timeout')), 8000) // 8 second overall timeout
    );
    
    const publishedRelays = await Promise.race([publishPromise, timeoutPromise]);
    publishedRelayUrls = Array.from(publishedRelays).map((r) => r.url);
    
    console.log(`✅ Pre-signed event published to ${publishedRelayUrls.length} relay(s)`);
  } catch (error) {
    console.error("❌ Error publishing pre-signed event:", error);
    // Don't throw - we'll return what we have
    console.log("⚠️ Publishing may have partially succeeded");
  } finally {
    // Ensure cleanup with timeout
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          disconnect(ndk);
          resolve();
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)) // 2 second cleanup timeout
      ]);
    } catch (cleanupError) {
      console.error("⚠️ Error during cleanup:", cleanupError);
    }
  }
  
  return {
    id: event.id || signedEventData.id,
    relays: publishedRelayUrls,
  };
}

/**
 * Disconnects from relays
 */
export function disconnect(ndk: NDK) {
  if (ndk?.pool) {
    console.log("🔌 Disconnecting from relays...");
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  }
}