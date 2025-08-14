#!/usr/bin/env node

import dotenv from 'dotenv';
import { runCLI } from './cli.js';
import { PostScheduler } from './scheduler.js';
import { WebServer } from './webserver.js';
import StatsSchedulerService from './services/stats-scheduler.service.js';
import SigningQueueService from './services/signing-queue.service.js';

// Load environment variables from .env file
dotenv.config();

// Debug: Log feature flag values at startup
console.log('🔧 Environment variables loaded:');
console.log('🔧 SAT_PAY:', process.env.SAT_PAY);
console.log('🔧 PORT:', process.env.PORT);

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === 'daemon') {
  const port = parseInt(process.env.PORT || '3001');
  console.log(`📍 Starting server with PORT=${port} (from ${process.env.PORT ? '.env' : 'default'})`);
  const scheduler = new PostScheduler();
  const statsScheduler = new StatsSchedulerService();
  const signingQueue = new SigningQueueService();
  const webServer = new WebServer(port, scheduler, statsScheduler, signingQueue);
  
  await scheduler.start();
  statsScheduler.start();
  signingQueue.start();
  await webServer.start();
  
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    scheduler.stop();
    statsScheduler.stop();
    signingQueue.stop();
    webServer.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    scheduler.stop();
    statsScheduler.stop();
    signingQueue.stop();
    webServer.stop();
    process.exit(0);
  });
} else if (args[0] === 'web') {
  const port = parseInt(process.env.PORT || '3001');
  console.log(`📍 Starting web server with PORT=${port} (from ${process.env.PORT ? '.env' : 'default'})`);
  const statsScheduler = new StatsSchedulerService();
  const signingQueue = new SigningQueueService();
  const webServer = new WebServer(port, undefined, statsScheduler, signingQueue);
  
  statsScheduler.start();
  signingQueue.start();
  await webServer.start();
  
  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down web server...');
    statsScheduler.stop();
    signingQueue.stop();
    webServer.stop();
    process.exit(0);
  });
} else {
  runCLI(process.argv);
}