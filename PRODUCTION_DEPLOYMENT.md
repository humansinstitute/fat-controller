# Production Deployment - Quick Reference

## 🚀 Quick Production Migration Steps

### 1. Deploy Code
```bash
git pull origin main
npm install
npm run build
```

### 2. Run Migration (Interactive)
```bash
npm run migrate:prod
# Or: npm run migrate:prod YOUR_MASTER_NPUB_HERE
```

### 3. Verify Migration
```bash
npm run verify:migration
```

### 4. Restart Application
```bash
pm2 restart fat-controller
# Or: npm start
```

## ⚡ One-Liner for Production

```bash
git pull && npm install && npm run build && npm run migrate:prod && npm run verify:migration && pm2 restart fat-controller
```

## 🔍 What the Migration Does

1. **Creates automatic database backup**
2. **Shows available master accounts** (users who have logged in)
3. **Reassigns all signing keys** to your specified master account
4. **Updates all posts and notes** to link to your master account
5. **Verifies the migration** completed successfully

## 📋 Expected Results

After migration:
- ✅ Authentication bypass vulnerability fixed
- ✅ All your signing keys appear when you log in
- ✅ New accounts automatically link to your master account
- ✅ Each user only sees their own data

## 🚨 If Something Goes Wrong

The migration script creates automatic backups. To rollback:

```bash
# Stop application
pm2 stop fat-controller

# Restore backup (script will show backup location)
cp data/posts.db.backup.TIMESTAMP data/posts.db

# Revert code (if needed)
git checkout previous-commit
npm run build

# Restart
pm2 start fat-controller
```

## 🔧 Database Schema Changes

| Table | Change | Purpose |
|-------|--------|---------|
| `signing_keys` | New table | Replaces `nostr_accounts` with master account linking |
| `master_accounts` | New table | Stores authenticated users (npubs) |
| `sessions` | New table | HTTP session management |
| `posts` | Added `master_account_npub` | Links posts to authenticated users |
| `notes` | Added `master_account_npub` | Links notes to authenticated users |

## 📞 Need Help?

If you encounter issues:
1. Check `npm run verify:migration` output
2. Check application logs: `pm2 logs fat-controller`
3. Verify your master account npub is correct
4. Ensure you're using the same npub to log in that you migrated to

## 🔐 Security Notes

- HTML pages now require authentication (except login page)
- Sessions use HTTP-only cookies
- Each user only sees their own signing keys and data
- Database includes audit logging for security events