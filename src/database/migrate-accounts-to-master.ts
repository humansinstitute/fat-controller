import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise(resolve => rl.question(query, resolve));
}

async function migrateAccountsToMaster() {
  const dataDir = join(__dirname, '../../data');
  mkdirSync(dataDir, { recursive: true });
  
  const dbPath = join(dataDir, 'posts.db');
  const db = new sqlite3.Database(dbPath);
  
  console.log('🔄 Master Account Migration Tool');
  console.log('================================\n');
  
  // First, show current state
  console.log('📋 Current Signing Keys:');
  
  const signingKeys = await new Promise<any[]>((resolve, reject) => {
    db.all(
      'SELECT id, name, npub, master_account_npub FROM signing_keys ORDER BY id',
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows as any[]);
      }
    );
  });
  
  const masterAccounts = await new Promise<any[]>((resolve, reject) => {
    db.all(
      'SELECT npub, display_name, created_at FROM master_accounts ORDER BY created_at',
      [],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows as any[]);
      }
    );
  });
  
  console.log('\n📋 Current Master Accounts:');
  if (masterAccounts.length === 0) {
    console.log('   (No master accounts found)');
  } else {
    masterAccounts.forEach((account, i) => {
      console.log(`   ${i + 1}. ${account.display_name || 'Unnamed'} (${account.npub.substring(0, 16)}...)`);
    });
  }
  
  console.log('\n📋 Current Signing Keys:');
  const unclaimedKeys: any[] = [];
  const claimedKeys: any[] = [];
  
  signingKeys.forEach((key, i) => {
    const status = key.master_account_npub ? 'CLAIMED' : 'UNCLAIMED';
    const masterInfo = key.master_account_npub 
      ? `by ${key.master_account_npub.substring(0, 16)}...` 
      : '';
    
    console.log(`   ${i + 1}. ${key.name} (${key.npub.substring(0, 16)}...) - ${status} ${masterInfo}`);
    
    if (key.master_account_npub) {
      claimedKeys.push(key);
    } else {
      unclaimedKeys.push(key);
    }
  });
  
  if (unclaimedKeys.length === 0 && claimedKeys.length > 0) {
    console.log('\n✅ All signing keys are already claimed by master accounts.');
    
    const reassign = await question('\nDo you want to reassign any signing keys to a different master account? (y/n): ');
    
    if (reassign.toLowerCase() === 'y') {
      await reassignSigningKeys(db, signingKeys, masterAccounts);
    }
  } else if (unclaimedKeys.length > 0) {
    console.log(`\n⚠️  Found ${unclaimedKeys.length} unclaimed signing keys.`);
    console.log('These keys need to be assigned to a master account.\n');
    
    const masterNpub = await question('Enter the npub of the master account to claim these keys: ');
    
    if (masterNpub.trim()) {
      await claimUnclaimedKeys(db, unclaimedKeys, masterNpub.trim());
    }
  }
  
  console.log('\n✅ Migration completed!');
  db.close();
  rl.close();
}

async function reassignSigningKeys(db: sqlite3.Database, signingKeys: any[], masterAccounts: any[]) {
  console.log('\n🔄 Reassign Signing Keys');
  console.log('========================\n');
  
  for (const key of signingKeys) {
    console.log(`\n📝 Signing Key: ${key.name} (${key.npub.substring(0, 16)}...)`);
    console.log(`   Currently claimed by: ${key.master_account_npub?.substring(0, 16)}...`);
    
    const reassign = await question('Reassign this key? (y/n/skip): ');
    
    if (reassign.toLowerCase() === 'y') {
      const newMasterNpub = await question('Enter new master account npub: ');
      
      if (newMasterNpub.trim()) {
        await new Promise<void>((resolve, reject) => {
          db.run(
            'UPDATE signing_keys SET master_account_npub = ? WHERE id = ?',
            [newMasterNpub.trim(), key.id],
            (err) => {
              if (err) {
                console.error(`❌ Error reassigning key: ${err.message}`);
                reject(err);
              } else {
                console.log(`✅ Reassigned ${key.name} to ${newMasterNpub.trim().substring(0, 16)}...`);
                resolve();
              }
            }
          );
        });
      }
    } else if (reassign.toLowerCase() === 'skip') {
      break;
    }
  }
}

async function claimUnclaimedKeys(db: sqlite3.Database, unclaimedKeys: any[], masterNpub: string) {
  console.log(`\n🔄 Claiming ${unclaimedKeys.length} signing keys for ${masterNpub.substring(0, 16)}...`);
  
  // First, ensure the master account exists
  const masterExists = await new Promise<boolean>((resolve, reject) => {
    db.get(
      'SELECT npub FROM master_accounts WHERE npub = ?',
      [masterNpub],
      (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      }
    );
  });
  
  if (!masterExists) {
    console.log('🆕 Creating new master account...');
    await new Promise<void>((resolve, reject) => {
      db.run(
        `INSERT INTO master_accounts (npub, created_at, status) VALUES (?, ?, 'active')`,
        [masterNpub, new Date().toISOString()],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }
  
  // Claim all unclaimed keys
  for (const key of unclaimedKeys) {
    await new Promise<void>((resolve, reject) => {
      db.run(
        'UPDATE signing_keys SET master_account_npub = ? WHERE id = ?',
        [masterNpub, key.id],
        (err) => {
          if (err) {
            console.error(`❌ Error claiming ${key.name}: ${err.message}`);
            reject(err);
          } else {
            console.log(`✅ Claimed ${key.name}`);
            resolve();
          }
        }
      );
    });
  }
  
  // Also update any posts that were created with these signing keys
  console.log('\n🔄 Updating associated posts and notes...');
  
  for (const key of unclaimedKeys) {
    // Update posts
    await new Promise<void>((resolve, reject) => {
      db.run(
        'UPDATE posts SET master_account_npub = ? WHERE account_id = ?',
        [masterNpub, key.id],
        (err) => {
          if (err) console.error(`Warning: Error updating posts for ${key.name}: ${err.message}`);
          resolve();
        }
      );
    });
    
    // Update notes  
    await new Promise<void>((resolve, reject) => {
      db.run(
        'UPDATE notes SET master_account_npub = ? WHERE account_id = ?',
        [masterNpub, key.id],
        (err) => {
          if (err) console.error(`Warning: Error updating notes for ${key.name}: ${err.message}`);
          resolve();
        }
      );
    });
  }
  
  console.log('✅ All unclaimed keys have been assigned and associated data updated!');
}

migrateAccountsToMaster().catch(console.error);