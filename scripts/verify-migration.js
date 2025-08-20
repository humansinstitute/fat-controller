#!/usr/bin/env node

/**
 * Migration Verification Script
 * 
 * This script verifies that the account migration completed successfully.
 */

import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function verify() {
  console.log('🔍 Fat Controller Migration Verification');
  console.log('========================================\n');
  
  const dbPath = join(__dirname, '../data/posts.db');
  if (!existsSync(dbPath)) {
    console.error('❌ Database not found at:', dbPath);
    return false;
  }
  
  const db = new sqlite3.Database(dbPath);
  
  try {
    // Check tables exist
    const tables = await new Promise((resolve, reject) => {
      db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => r.name));
      });
    });
    
    const requiredTables = ['master_accounts', 'signing_keys', 'sessions'];
    const missingTables = requiredTables.filter(t => !tables.includes(t));
    
    if (missingTables.length > 0) {
      console.log('❌ Missing required tables:', missingTables.join(', '));
      console.log('   Run the application to trigger migrations first.');
      return false;
    }
    console.log('✅ All required tables present');
    
    // Check master accounts
    const masterAccounts = await new Promise((resolve, reject) => {
      db.all('SELECT npub, display_name FROM master_accounts', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    console.log(`\\n📋 Master Accounts (${masterAccounts.length}):`);
    if (masterAccounts.length === 0) {
      console.log('   ⚠️  No master accounts found - users need to log in first');
    } else {
      masterAccounts.forEach(account => {
        console.log(`   • ${account.display_name || 'Unnamed'} (${account.npub.substring(0, 20)}...)`);
      });
    }
    
    // Check signing keys and their assignments
    const signingKeys = await new Promise((resolve, reject) => {
      db.all(`
        SELECT 
          sk.name, 
          sk.npub,
          sk.master_account_npub,
          ma.display_name as master_name
        FROM signing_keys sk
        LEFT JOIN master_accounts ma ON sk.master_account_npub = ma.npub
        ORDER BY sk.id
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    
    console.log(`\\n🔑 Signing Keys (${signingKeys.length}):`);
    let unassigned = 0;
    
    signingKeys.forEach(key => {
      if (key.master_account_npub) {
        console.log(`   ✅ ${key.name} → ${key.master_name || 'Unknown Master'}`);
      } else {
        console.log(`   ❌ ${key.name} → UNASSIGNED`);
        unassigned++;
      }
    });
    
    if (unassigned > 0) {
      console.log(`\\n⚠️  ${unassigned} signing keys are not assigned to any master account`);
      console.log('   Run: node scripts/production-migration.js [master-npub]');
      return false;
    }
    
    // Check posts and notes assignments
    const postStats = await new Promise((resolve, reject) => {
      db.get(`
        SELECT 
          COUNT(*) as total,
          COUNT(master_account_npub) as assigned
        FROM posts
      `, [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    const noteStats = await new Promise((resolve, reject) => {
      db.get(`
        SELECT 
          COUNT(*) as total,
          COUNT(master_account_npub) as assigned
        FROM notes
      `, [], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    console.log(`\\n📊 Data Assignment Status:`);
    console.log(`   Posts: ${postStats.assigned}/${postStats.total} assigned to master accounts`);
    console.log(`   Notes: ${noteStats.assigned}/${noteStats.total} assigned to master accounts`);
    
    if (postStats.assigned < postStats.total || noteStats.assigned < noteStats.total) {
      console.log(`   ⚠️  Some posts/notes are not assigned to master accounts`);
      return false;
    }
    
    // Check sessions table
    const sessionCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as count FROM sessions', [], (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
    
    console.log(`   Sessions: ${sessionCount} active sessions`);
    
    console.log('\\n🎉 Migration verification completed successfully!');
    console.log('\\n📋 System Status: ✅ READY FOR PRODUCTION');
    
    return true;
    
  } catch (error) {
    console.error('\\n❌ Verification failed:', error.message);
    return false;
  } finally {
    db.close();
  }
}

verify().then(success => {
  process.exit(success ? 0 : 1);
}).catch(console.error);