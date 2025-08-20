#!/usr/bin/env node

/**
 * Production Migration Script
 * 
 * This script handles the migration of accounts to the new master account system.
 * Run this after deploying the code changes to production.
 * 
 * Usage: node scripts/production-migration.js [master-npub]
 * If no master-npub is provided, it will show available options.
 */

import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  const args = process.argv.slice(2);
  let targetMasterNpub = args[0];
  
  console.log('🚀 Fat Controller Production Migration');
  console.log('=====================================\n');
  
  // Check if database exists
  const dbPath = join(__dirname, '../data/posts.db');
  if (!existsSync(dbPath)) {
    console.error('❌ Database not found at:', dbPath);
    console.error('Make sure you\'re running this from the project root directory.');
    process.exit(1);
  }
  
  // Create backup
  const backupPath = `${dbPath}.backup.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log('📋 Creating database backup...');
  
  try {
    const { copyFileSync } = await import('fs');
    copyFileSync(dbPath, backupPath);
    console.log(`✅ Backup created: ${backupPath}\n`);
  } catch (error) {
    console.error('❌ Failed to create backup:', error.message);
    process.exit(1);
  }
  
  const db = new sqlite3.Database(dbPath);
  
  try {
    // Check database state
    console.log('🔍 Checking database state...');
    
    const tables = await new Promise((resolve, reject) => {
      db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => r.name));
      });
    });
    
    if (!tables.includes('master_accounts')) {
      console.error('❌ master_accounts table not found. Database migration not complete.');
      console.error('Start the application first to run automatic migrations.');
      process.exit(1);
    }
    
    if (!tables.includes('signing_keys')) {
      console.error('❌ signing_keys table not found. Database migration not complete.');
      console.error('Start the application first to run automatic migrations.');
      process.exit(1);
    }
    
    console.log('✅ Database tables are present\n');
    
    // Get master accounts
    const masterAccounts = await new Promise((resolve, reject) => {
      db.all('SELECT npub, display_name, created_at FROM master_accounts ORDER BY created_at', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    console.log('📋 Available master accounts:');
    if (masterAccounts.length === 0) {
      console.log('   (No master accounts found - users need to log in first)');
      process.exit(1);
    }
    
    masterAccounts.forEach((account, i) => {
      console.log(`   ${i + 1}. ${account.display_name || 'Unnamed'}`);
      console.log(`      npub: ${account.npub}`);
      console.log(`      created: ${account.created_at}\n`);
    });
    
    // Get target master account
    if (!targetMasterNpub) {
      console.log('Please specify which master account should own all the signing keys.');
      const choice = await question('Enter the full npub of the target master account: ');
      targetMasterNpub = choice.trim();
    }
    
    // Verify target exists
    const targetMaster = masterAccounts.find(m => m.npub === targetMasterNpub);
    if (!targetMaster) {
      console.error(`❌ Master account not found: ${targetMasterNpub}`);
      process.exit(1);
    }
    
    console.log(`\n🎯 Target master account: ${targetMaster.display_name || 'Unnamed'}`);
    console.log(`    npub: ${targetMasterNpub}\n`);
    
    // Get signing keys
    const signingKeys = await new Promise((resolve, reject) => {
      db.all('SELECT id, name, npub, master_account_npub FROM signing_keys', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    console.log(`📋 Found ${signingKeys.length} signing keys:`);
    signingKeys.forEach(key => {
      const status = key.master_account_npub === targetMasterNpub ? '✅' : '🔄';
      console.log(`   ${status} ${key.name} (${key.npub.substring(0, 20)}...)`);
    });
    
    const needsReassignment = signingKeys.filter(k => k.master_account_npub !== targetMasterNpub);
    
    if (needsReassignment.length === 0) {
      console.log('\\n✅ All signing keys are already assigned to the target master account. No migration needed.');
      db.close();
      rl.close();
      return;
    }
    
    console.log(`\n⚠️  ${needsReassignment.length} signing keys need to be reassigned.`);
    const confirm = await question('\\nProceed with migration? (yes/no): ');
    
    if (confirm.toLowerCase() !== 'yes') {
      console.log('Migration cancelled.');
      db.close();
      rl.close();
      return;
    }
    
    console.log('\\n🔄 Starting migration...');
    
    // Reassign signing keys
    console.log('\\n📝 Reassigning signing keys...');
    for (const key of needsReassignment) {
      console.log(`   🔄 ${key.name}...`);
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE signing_keys SET master_account_npub = ? WHERE id = ?',
          [targetMasterNpub, key.id],
          (err) => {
            if (err) {
              console.error(`      ❌ Error: ${err.message}`);
              reject(err);
            } else {
              console.log(`      ✅ Done`);
              resolve();
            }
          }
        );
      });
    }
    
    // Update posts
    console.log('\\n📝 Updating posts...');
    const postsUpdated = await new Promise((resolve, reject) => {
      db.run(
        'UPDATE posts SET master_account_npub = ? WHERE master_account_npub != ? OR master_account_npub IS NULL',
        [targetMasterNpub, targetMasterNpub],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
    console.log(`   ✅ Updated ${postsUpdated} posts`);
    
    // Update notes
    console.log('\\n📝 Updating notes...');
    const notesUpdated = await new Promise((resolve, reject) => {
      db.run(
        'UPDATE notes SET master_account_npub = ? WHERE master_account_npub != ? OR master_account_npub IS NULL',
        [targetMasterNpub, targetMasterNpub],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes);
        }
      );
    });
    console.log(`   ✅ Updated ${notesUpdated} notes`);
    
    // Verify migration
    console.log('\\n🔍 Verifying migration...');
    const verifyKeys = await new Promise((resolve, reject) => {
      db.all(
        'SELECT COUNT(*) as count FROM signing_keys WHERE master_account_npub = ?',
        [targetMasterNpub],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0].count);
        }
      );
    });
    
    console.log(`   ✅ ${verifyKeys} signing keys now linked to master account`);
    
    console.log('\\n🎉 Migration completed successfully!');
    console.log('\\n📋 Next steps:');
    console.log('   1. Restart your application: npm start or pm2 restart fat-controller');
    console.log('   2. Test login with the migrated master account');
    console.log('   3. Verify that accounts are visible after login');
    console.log(`   4. Backup is saved at: ${backupPath}`);
    
  } catch (error) {
    console.error('\\n❌ Migration failed:', error.message);
    console.error('\\n🔄 To rollback:');
    console.error(`   cp "${backupPath}" "${dbPath}"`);
    process.exit(1);
  } finally {
    db.close();
    rl.close();
  }
}

main().catch(console.error);