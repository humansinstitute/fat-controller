#!/usr/bin/env node

import dotenv from 'dotenv';
import { runCLI } from './cli.js';
import { PostScheduler } from './scheduler.js';
import { WebServer } from './webserver.js';

// Load environment variables from .env file
dotenv.config();

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === 'daemon') {
  const scheduler = new PostScheduler();
  const webServer = new WebServer(3001, scheduler);
  
  await scheduler.start();
  await webServer.start();
  
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    scheduler.stop();
    webServer.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    scheduler.stop();
    webServer.stop();
    process.exit(0);
  });
} else if (args[0] === 'web') {
  const webServer = new WebServer(3001);
  await webServer.start();
  
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down web server...');
    webServer.stop();
    process.exit(0);
  });
} else {
  runCLI(process.argv);
}