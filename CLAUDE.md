# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Fat Controller is a Nostr post scheduler that automatically publishes posts to the Nostr network. It supports multiple publishing methods (API, NostrMQ, direct relay publishing), secure key management via macOS Keychain, and provides both CLI and web interfaces.

## Commands

### Development
- `npm run dev` - Run the TypeScript application in development mode using tsx
- `npm run build` - Compile TypeScript to JavaScript (output to dist/)
- `npm start` or `node dist/index.js daemon` - Start scheduler and web UI (port 3001)
- `node dist/index.js web` - Start web UI only

### PM2 Process Management
- `pm2 start ecosystem.config.cjs` - Start the application with PM2
- `pm2 restart fat-controller` - Restart the process
- `pm2 logs fat-controller` - View logs
- `pm2 list` - List running processes

### CLI Commands (after building)
- `node dist/index.js add "content" --delay 2` - Schedule a post
- `node dist/index.js list` - List all posts
- `node dist/index.js delete <id>` - Delete a post
- `node dist/index.js account list` - List Nostr accounts
- `node dist/index.js account add` - Add a new account

## Architecture

### Core Components
- **PostScheduler** (scheduler.ts): Runs cron job every 5 minutes to check and publish posts
- **WebServer** (webserver.ts): Express server providing REST API and web UI
- **PostDatabase** (database/db.ts): SQLite database wrapper for posts and accounts
- **Publisher** (publisher.ts): Handles publishing via API, NostrMQ, or direct relay methods
- **KeychainService** (keychain.service.ts): Secure storage of nsec keys in macOS Keychain

### Database Schema
- **posts**: Scheduled posts with content, timing, status, and publishing details
- **accounts**: Nostr accounts with npub, publishing methods, and keychain references

### Publishing Methods
1. **API**: Posts to configured HTTP endpoint (default: http://localhost:3000/post/note)
2. **NostrMQ**: Uses Nostr protocol for message queuing with response monitoring
3. **Direct**: Publishes directly to Nostr relays using stored keys

### Security
- Private keys (nsec) are stored in macOS Keychain, never in the database
- Environment variables can override defaults via .env file
- Web UI uses CORS for API access control

## Key Files
- `src/index.ts` - Entry point, handles daemon/web/CLI mode selection
- `src/database/db.ts` - Database operations and migrations
- `src/publisher.ts` - Publishing logic for all methods
- `public/index.html` - Single-page web UI with account and post management