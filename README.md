# The Fat Controller

**Managing your traffic on the freedom network**

A comprehensive Nostr post scheduler that automatically publishes posts to the Nostr network. Supports multiple publishing methods (API, NostrMQ, direct relay publishing), secure key management via macOS Keychain, and provides both CLI and modern web interfaces.

## Features

### 🚀 Core Functionality
- **Note Management**: Create, organize, and manage your Nostr content
- **Advanced Scheduling**: Schedule single posts or batch posts with custom intervals
- **Quick Posting**: Instant publishing with live preview
- **Multiple Publishing Methods**: API, NostrMQ, or direct relay publishing
- **Account Management**: Support for multiple Nostr accounts with secure key storage

### 🎨 Modern Web Interface
- **Notes View**: Organize content with scheduled post tracking
- **Quick Schedule**: Instant posting with live preview and media support
- **Account Management**: Add and manage multiple Nostr accounts
- **Responsive Design**: Optimized for desktop and mobile devices
- **Live Preview**: Real-time formatting with image/video previews, hashtags, and mentions

### 🔐 Security & Reliability
- **Secure Key Storage**: Private keys stored in macOS Keychain
- **Multiple Publishing Methods**: Fallback options for reliability
- **Error Tracking**: Comprehensive error handling and retry logic
- **Data Persistence**: SQLite database for reliable storage

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Build the project:**
```bash
npm run build
```

## Usage

### Web Interface (Recommended)

#### Development Environment
For development with hot-reload and file watching:
```bash
# Build and start development server
npm run build
npm run pm2:dev

# Access web UI at http://localhost:3002
```

Development PM2 commands:
```bash
npm run pm2:restart:dev  # Restart dev server
npm run pm2:stop:dev     # Stop dev server
npm run pm2:logs:dev     # View dev logs
```

#### Production Environment
For production deployment:
```bash
# Build and start production server
npm run build
npm run pm2:prod

# Access web UI at http://localhost:3001
```

Production PM2 commands:
```bash
npm run pm2:restart:prod # Restart prod server
npm run pm2:stop:prod    # Stop prod server
npm run pm2:logs:prod    # View prod logs
```

#### PM2 Management
```bash
npm run pm2:status       # Check status of all processes
npm run pm2:delete       # Delete all processes (dev & prod)
pm2 monit               # PM2 monitoring dashboard
```

### Direct Node.js Usage

#### Running the Scheduler with Web UI
Start both the scheduler and web interface:
```bash
npm start
# or
node dist/index.js daemon
```

#### Running Web UI Only
Start just the web interface without the scheduler:
```bash
node dist/index.js web
```

### CLI Commands

#### Account Management
```bash
node dist/index.js account list              # List all accounts
node dist/index.js account add               # Add a new account (interactive)
```

#### Post Management
```bash
node dist/index.js add "Your post content" --delay 2    # Schedule post 2 hours from now
node dist/index.js list                                 # List scheduled posts
node dist/index.js list --pending                       # Show only pending posts
node dist/index.js delete <post-id>                     # Delete a post
```

## Web Interface Guide

### Notes View
- **Create Notes**: Organize your content into reusable notes
- **Schedule Posts**: Schedule single or multiple posts from each note
- **Track Progress**: See published and upcoming posts for each note
- **Batch Scheduling**: Set custom intervals and repetition counts

### Quick Schedule
- **Instant Posting**: Create and publish content immediately
- **Live Preview**: See formatted output with media previews
- **Media Support**: Automatic image and video embedding
- **Smart Formatting**: Hashtag and mention highlighting

### Account Management
- **Multiple Accounts**: Manage multiple Nostr identities
- **Publishing Methods**: 
  - **Direct**: Publish directly to relays using stored keys
  - **API**: Use external API endpoints for publishing
  - **NostrMQ**: Message queue-based publishing
- **Secure Storage**: Private keys stored in macOS Keychain

## Configuration

### Publishing Methods

#### Direct to Relays
- Stores private key (nsec) securely in macOS Keychain
- Publishes directly to specified Nostr relays
- Most reliable and decentralized option

#### API Publishing
- Posts to configured HTTP endpoint
- Requires npub for remote signer integration
- Default: `http://localhost:3000/post/note`

#### NostrMQ
- Uses Nostr protocol for message queuing
- Requires npub and target NostrMQ service
- Advanced option for specialized setups

### Environment Variables
```bash
# Optional configuration
PORT=3001                                    # Web server port
NODE_ENV=production                         # Environment mode
```

### Database Schema
- **notes**: Content storage with account association
- **accounts**: Nostr account configurations and publishing methods
- **posts**: Scheduled posts linked to notes with timing and status

### PM2 Deployment Setup

**Development (`ecosystem.dev.config.cjs`)**:
- Process name: `fcdev`
- Port: `3002`
- Uses `tsx` for TypeScript hot-reload
- Watches `src/` directory for changes
- Optimized for development workflow

**Production (`ecosystem.config.cjs`)**:
- Process name: `fcprod`  
- Port: `3001`
- Uses compiled `dist/index.js`
- Stable production configuration
- Resource-optimized settings

## Architecture

### Core Components
- **PostScheduler**: Cron-based scheduler (runs every 5 minutes)
- **WebServer**: Express server with REST API and web UI
- **PostDatabase**: SQLite database wrapper for posts, notes, and accounts
- **Publisher**: Multi-method publishing system (API, NostrMQ, Direct)
- **KeychainService**: Secure key storage using macOS Keychain

### Data Flow
1. **Note Creation**: User creates note with content
2. **Post Scheduling**: One or more posts scheduled from note
3. **Publishing**: Scheduler picks up due posts and publishes via configured method
4. **Status Tracking**: Real-time status updates and error handling

The application maintains a clean separation between content (notes) and scheduling (posts), allowing for flexible reuse and management of Nostr content.