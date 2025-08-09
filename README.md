# Nostr Post Scheduler

A simple app to schedule and automatically publish Nostr posts using your local API.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your npub and API endpoint
```

3. Build the project:
```bash
npm run build
```

## Usage

### PM2 Process Management (Recommended)

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

#### Add a single post
```bash
node dist/index.js add "Your post content" --delay 2
# Schedules post 2 hours from now
```

#### Schedule batch posts (every 3 hours for 24 hours)
```bash
node dist/index.js schedule-batch "Your post content"
```

#### List scheduled posts
```bash
node dist/index.js list
node dist/index.js list --pending  # Show only pending posts
```

#### Delete a post
```bash
node dist/index.js delete <post-id>
```

## Features

- SQLite database for persistent storage
- Automatic scheduling every 3 hours (configurable)
- CLI for managing posts
- Integration with local Nostr API
- Retry on failure with error tracking

## Configuration

The scheduler checks for posts to publish every 5 minutes by default. Posts are published according to their scheduled time.

### Environment Variables
- `NOSTR_NPUB`: Your Nostr public key in npub format (required)
- `NOSTR_API_ENDPOINT`: API endpoint for publishing (default: http://localhost:3000/post/note)
- `POW_BITS`: Proof of work bits (optional)
- `TIMEOUT_MS`: Publish timeout in milliseconds (optional)

### PM2 Deployment Setup

This project includes separate PM2 configurations for development and production:

**Development (`ecosystem.dev.config.cjs`)**:
- Process name: `fcdev`
- Port: `3002`
- Uses `tsx` for TypeScript hot-reload
- Watches `src/` directory for changes
- Lower memory limits (512MB)
- More aggressive restart policies

**Production (`ecosystem.prod.config.cjs`)**:
- Process name: `fcprod`  
- Port: `3001`
- Uses compiled `dist/index.js`
- No file watching
- Higher memory limits (1GB)
- Conservative restart policies

This setup allows you to run both development and production versions simultaneously on the same machine without conflicts. Each environment has its own:
- Process name (fcdev/fcprod)
- Port number (3002/3001)
- Log files (`logs/out-dev.log` vs `logs/out-prod.log`)
- Memory and restart configurations