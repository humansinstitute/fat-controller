// @ts-ignore - keytar types might not be fully compatible with ES modules
import keytarModule from 'keytar';
const keytar = keytarModule as any;
import crypto from 'crypto';

const SERVICE_NAME = 'NostrScheduler';
const ACCOUNT_PREFIX = 'nostr-account-';

/**
 * Generate a unique keychain account ID for a Nostr account
 */
export function getKeychainAccountId(accountId: number): string {
  return `${ACCOUNT_PREFIX}${accountId}`;
}

/**
 * Store an nsec in the macOS Keychain
 */
export async function storeNsecInKeychain(accountId: number, nsec: string): Promise<boolean> {
  try {
    const keychainAccountId = getKeychainAccountId(accountId);
    await keytar.setPassword(SERVICE_NAME, keychainAccountId, nsec);
    console.log(`🔐 Stored private key in keychain for account ${accountId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to store key in keychain:`, error);
    return false;
  }
}

/**
 * Retrieve an nsec from the macOS Keychain
 */
export async function getNsecFromKeychain(accountId: number): Promise<string | null> {
  try {
    const keychainAccountId = getKeychainAccountId(accountId);
    const nsec = await keytar.getPassword(SERVICE_NAME, keychainAccountId);
    if (nsec) {
      console.log(`🔓 Retrieved private key from keychain for account ${accountId}`);
    }
    return nsec;
  } catch (error) {
    console.error(`❌ Failed to retrieve key from keychain:`, error);
    return null;
  }
}

/**
 * Delete an nsec from the macOS Keychain
 */
export async function deleteNsecFromKeychain(accountId: number): Promise<boolean> {
  try {
    const keychainAccountId = getKeychainAccountId(accountId);
    const deleted = await keytar.deletePassword(SERVICE_NAME, keychainAccountId);
    if (deleted) {
      console.log(`🗑️ Deleted private key from keychain for account ${accountId}`);
    }
    return deleted;
  } catch (error) {
    console.error(`❌ Failed to delete key from keychain:`, error);
    return false;
  }
}

/**
 * Check if keychain is available
 */
export async function isKeychainAvailable(): Promise<boolean> {
  try {
    // Try to access keychain with a test operation
    // getPassword returns null if not found, which is fine - it means keychain works
    const result = await keytar.getPassword(SERVICE_NAME, 'test-availability-check');
    // If we get here without throwing, keychain is available
    return true;
  } catch (error) {
    console.error(`⚠️ Keychain not available:`, error);
    return false;
  }
}

/**
 * List all stored account IDs in keychain
 */
export async function listKeychainAccounts(): Promise<number[]> {
  try {
    const credentials = await keytar.findCredentials(SERVICE_NAME);
    return credentials
      .map((cred: any) => {
        const match = cred.account.match(new RegExp(`^${ACCOUNT_PREFIX}(\\d+)$`));
        return match ? parseInt(match[1]) : null;
      })
      .filter((id: any): id is number => id !== null);
  } catch (error) {
    console.error(`❌ Failed to list keychain accounts:`, error);
    return [];
  }
}

/**
 * Generate a reference token for the keychain entry
 * This is what we'll store in the database instead of the actual key
 */
export function generateKeychainReference(accountId: number): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${SERVICE_NAME}-${accountId}-${Date.now()}`);
  return `keychain:${hash.digest('hex').substring(0, 16)}`;
}