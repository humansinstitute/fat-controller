# Production Migration Guide

This document outlines how to deploy the authentication and account linking changes to production.

## Summary of Changes

1. **Authentication bypass vulnerability fixed** - HTML pages now require authentication
2. **Database schema updated** - Accounts moved to `signing_keys` table with master account linking
3. **API authentication** - Endpoints now filter data by authenticated user
4. **Account reassignment needed** - Existing accounts must be linked to master accounts

## Prerequisites

- Access to production server
- Database backup completed
- `cookie-parser` dependency installed
- Production downtime window (recommended 10-15 minutes)

## Migration Steps

### Step 1: Backup Database

```bash
# Create backup of production database
cp data/posts.db data/posts.db.backup.$(date +%Y%m%d_%H%M%S)
```

### Step 2: Deploy Code Changes

```bash
# Pull latest changes
git pull origin main

# Install new dependencies
npm install

# Build the application
npm run build
```

### Step 3: Run Database Migrations

The database migrations should run automatically when the application starts, but you can run them manually:

```bash
# Check current database tables
sqlite3 data/posts.db ".tables"

# If signing_keys table doesn't exist, migrations haven't run
# Start the application briefly to trigger migrations:
npm start
# Then stop it (Ctrl+C)
```

### Step 4: Identify Master Accounts

```bash
# Check which master accounts exist
sqlite3 data/posts.db "SELECT npub, display_name FROM master_accounts;"
```

### Step 5: Reassign Accounts to Correct Master Account

Create and run this script:

```bash
# Create migration script
cat > migrate-production-accounts.js << 'EOF'
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TARGET_MASTER_NPUB = 'YOUR_MASTER_NPUB_HERE'; // Replace with your actual npub

async function migrateAccounts() {
  const dbPath = join(__dirname, 'data/posts.db');
  const db = new sqlite3.Database(dbPath);
  
  console.log('🔄 Migrating accounts to master account...');
  
  // Get all signing keys that need reassignment
  const keys = await new Promise((resolve, reject) => {
    db.all('SELECT id, name, npub FROM signing_keys', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  
  console.log(`Found ${keys.length} accounts to reassign`);
  
  // Reassign each account
  for (const key of keys) {
    console.log(`  Reassigning: ${key.name}`);
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE signing_keys SET master_account_npub = ? WHERE id = ?',
        [TARGET_MASTER_NPUB, key.id],
        (err) => err ? reject(err) : resolve()
      );
    });
  }
  
  // Update posts and notes
  await new Promise((resolve, reject) => {
    db.run(
      'UPDATE posts SET master_account_npub = ?',
      [TARGET_MASTER_NPUB],
      function(err) {
        if (err) reject(err);
        else {
          console.log(`Updated ${this.changes} posts`);
          resolve();
        }
      }
    );
  });
  
  await new Promise((resolve, reject) => {
    db.run(
      'UPDATE notes SET master_account_npub = ?',
      [TARGET_MASTER_NPUB],
      function(err) {
        if (err) reject(err);
        else {
          console.log(`Updated ${this.changes} notes`);
          resolve();
        }
      }
    );
  });
  
  console.log('✅ Migration completed!');
  db.close();
}

migrateAccounts().catch(console.error);
EOF

# Edit the script to include your actual npub
nano migrate-production-accounts.js

# Run the migration
node migrate-production-accounts.js

# Clean up
rm migrate-production-accounts.js
```

### Step 6: Start Production Application

```bash
# Using PM2 (recommended)
pm2 restart fat-controller

# Or direct start
npm start
```

### Step 7: Verify Migration

```bash
# Check that accounts are properly linked
sqlite3 data/posts.db "
SELECT 
  sk.name, 
  sk.master_account_npub,
  ma.display_name as master_name
FROM signing_keys sk 
JOIN master_accounts ma ON sk.master_account_npub = ma.npub;
"

# Test authentication by accessing the web UI
curl -I http://your-domain/notes.html
# Should return 302 redirect to login if not authenticated
```

## Environment Variables

Make sure these are set in production:

```bash
# In your .env file
NODE_ENV=production
PORT=3001
# ... other variables
```

## Rollback Plan

If something goes wrong:

1. **Stop the application**
   ```bash
   pm2 stop fat-controller
   ```

2. **Restore database backup**
   ```bash
   cp data/posts.db.backup.TIMESTAMP data/posts.db
   ```

3. **Revert to previous code version**
   ```bash
   git checkout previous-working-commit
   npm run build
   ```

4. **Restart application**
   ```bash
   pm2 start fat-controller
   ```

## Post-Migration Checklist

- [ ] Database backup created
- [ ] Code deployed and built successfully
- [ ] Database migrations completed
- [ ] Accounts reassigned to correct master account
- [ ] Application started successfully
- [ ] Authentication working (login redirects work)
- [ ] User can see their accounts after login
- [ ] New accounts get linked to authenticated user

## Troubleshooting

### "No accounts showing after login"
- Check which npub you're using to log in
- Verify accounts are linked to that npub: 
  ```sql
  SELECT * FROM signing_keys WHERE master_account_npub = 'YOUR_NPUB';
  ```

### "Authentication not working"
- Check that `cookie-parser` is installed: `npm list cookie-parser`
- Verify cookies are being set: check browser dev tools
- Ensure `NODE_ENV=production` for secure cookies

### "Database errors"
- Check if migrations ran: `sqlite3 data/posts.db ".tables"`
- Should see both `nostr_accounts` and `signing_keys` tables
- Verify master_accounts table exists and has data

## Notes

- The old `nostr_accounts` table is kept for backward compatibility but is no longer used
- New accounts created after migration will automatically link to the authenticated user
- The authentication bypass vulnerability is fixed - all HTML pages except login require authentication
- Sessions are stored as HTTP-only cookies for security