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

### Running the Scheduler with Web UI
Start both the scheduler and web interface:
```bash
npm start
# or
node dist/index.js daemon
```
Then open http://localhost:3001 in your browser.

### Running Web UI Only
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

Environment variables:
- `NOSTR_NPUB`: Your Nostr public key in npub format (required)
- `NOSTR_API_ENDPOINT`: API endpoint for publishing (default: http://localhost:3000/post/note)
- `POW_BITS`: Proof of work bits (optional)
- `TIMEOUT_MS`: Publish timeout in milliseconds (optional)