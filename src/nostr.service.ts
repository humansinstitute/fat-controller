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