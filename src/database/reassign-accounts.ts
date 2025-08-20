import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function reassignAccounts() {
  const dataDir = join(__dirname, '../../data');
  mkdirSync(dataDir, { recursive: true });
  
  const dbPath = join(dataDir, 'posts.db');
  const db = new sqlite3.Database(dbPath);
  
  // Get command line argument for new master npub
  const newMasterNpub = process.argv[2];
  
  if (!newMasterNpub) {
    console.log('❌ Please provide the npub you want to assign your accounts to:');
    console.log('   Usage: npx tsx src/database/reassign-accounts.ts npub1your_npub_here');
    process.exit(1);
  }
  
  console.log(`🔄 Reassigning all accounts to: ${newMasterNpub}`);
  console.log('================================\n');
  
  // Show current state
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
  
  console.log('📋 Current Signing Keys:');
  signingKeys.forEach((key, i) => {
    console.log(`   ${i + 1}. ${key.name} (${key.npub.substring(0, 16)}...)`);
  });
  
  try {
    // Create or update master account
    console.log(`\n🆕 Creating/updating master account: ${newMasterNpub.substring(0, 16)}...`);
    
    await new Promise<void>((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO master_accounts (npub, created_at, status, display_name) 
         VALUES (?, ?, 'active', ?)`,
        [newMasterNpub, new Date().toISOString(), 'Fat Controller User'],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    // Update all signing keys
    console.log('🔄 Updating signing keys...');
    
    await new Promise<void>((resolve, reject) => {
      db.run(
        'UPDATE signing_keys SET master_account_npub = ? WHERE master_account_npub IS NOT NULL',
        [newMasterNpub],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`✅ Updated ${this.changes} signing keys`);
            resolve();
          }
        }
      );
    });
    
    // Update all posts
    console.log('🔄 Updating posts...');
    
    await new Promise<void>((resolve, reject) => {
      db.run(
        'UPDATE posts SET master_account_npub = ? WHERE master_account_npub IS NOT NULL',
        [newMasterNpub],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`✅ Updated ${this.changes} posts`);
            resolve();
          }
        }
      );
    });
    
    // Update all notes
    console.log('🔄 Updating notes...');
    
    await new Promise<void>((resolve, reject) => {
      db.run(
        'UPDATE notes SET master_account_npub = ? WHERE master_account_npub IS NOT NULL',
        [newMasterNpub],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`✅ Updated ${this.changes} notes`);
            resolve();
          }
        }
      );
    });
    
    // Clean up old master accounts
    console.log('🧹 Cleaning up old master accounts...');
    
    await new Promise<void>((resolve, reject) => {
      db.run(
        'DELETE FROM master_accounts WHERE npub != ?',
        [newMasterNpub],
        function(err) {
          if (err) reject(err);
          else {
            console.log(`✅ Removed ${this.changes} old master accounts`);
            resolve();
          }
        }
      );
    });
    
    // Show final state
    console.log('\n📋 Final State:');
    
    const finalKeys = await new Promise<any[]>((resolve, reject) => {
      db.all(
        'SELECT id, name, npub, master_account_npub FROM signing_keys ORDER BY id',
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows as any[]);
        }
      );
    });
    
    finalKeys.forEach((key, i) => {
      console.log(`   ${i + 1}. ${key.name} (${key.npub.substring(0, 16)}...) → ${key.master_account_npub.substring(0, 16)}...`);
    });
    
    console.log(`\n✅ All accounts successfully reassigned to: ${newMasterNpub}`);
    console.log('\n🎉 You can now authenticate with this npub and access all your existing accounts!');
    
  } catch (error) {
    console.error('❌ Error during reassignment:', error);
  } finally {
    db.close();
  }
}

reassignAccounts().catch(console.error);