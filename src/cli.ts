import { Command } from 'commander';
import PostDatabase from './database/db.js';

const program = new Command();

program
  .name('nostr-scheduler')
  .description('CLI to schedule and manage Nostr posts')
  .version('1.0.0');

program
  .command('add')
  .description('Add a new scheduled post')
  .argument('<content>', 'Post content')
  .option('-d, --delay <hours>', 'Hours from now to start posting', '0')
  .option('-a, --api <endpoint>', 'API endpoint for publishing')
  .option('-m, --method <method>', 'Publishing method: api or nostrmq', 'api')
  .action(async (content, options) => {
    const db = new PostDatabase();
    const delayHours = parseFloat(options.delay);
    const scheduledFor = new Date();
    scheduledFor.setHours(scheduledFor.getHours() + delayHours);
    
    // Get active account to associate with post
    const activeAccount = await db.getActiveAccount();
    const accountId = activeAccount?.id;
    
    const publishMethod = options.method === 'nostrmq' ? 'nostrmq' : 'api';
    const id = await db.addPost(content, scheduledFor, accountId, options.api, publishMethod);
    console.log(`✅ Post scheduled with ID: ${id}`);
    console.log(`📅 Will be published at: ${scheduledFor.toLocaleString()}`);
    console.log(`🔧 Publishing method: ${publishMethod}`);
    db.close();
  });

program
  .command('list')
  .description('List all scheduled posts')
  .option('-p, --pending', 'Show only pending posts')
  .action(async (options) => {
    const db = new PostDatabase();
    const posts = options.pending ? await db.getUpcomingPosts() : await db.getAllPosts();
    
    if (posts.length === 0) {
      console.log('No posts found');
    } else {
      posts.forEach(post => {
        const status = post.status === 'published' ? '✅' : 
                      post.status === 'failed' ? '❌' : '⏰';
        const method = post.publish_method ? `[${post.publish_method.toUpperCase()}]` : '[API]';
        console.log(`${status} ${method} [${post.id}] ${post.scheduled_for} - ${post.content.substring(0, 50)}...`);
        if (post.error_message) {
          console.log(`   Error: ${post.error_message}`);
        }
      });
    }
    db.close();
  });

program
  .command('delete')
  .description('Delete a scheduled post')
  .argument('<id>', 'Post ID')
  .action(async (id) => {
    const db = new PostDatabase();
    await db.deletePost(parseInt(id));
    console.log(`✅ Post ${id} deleted`);
    db.close();
  });

program
  .command('schedule-batch')
  .description('Schedule a post to be published every 3 hours for 24 hours')
  .argument('<content>', 'Post content')
  .option('-a, --api <endpoint>', 'API endpoint for publishing')
  .option('-m, --method <method>', 'Publishing method: api or nostrmq', 'api')
  .action(async (content, options) => {
    const db = new PostDatabase();
    const now = new Date();
    const times = [0, 3, 6, 9, 12, 15, 18, 21];
    
    // Get active account to associate with posts
    const activeAccount = await db.getActiveAccount();
    const accountId = activeAccount?.id;
    const publishMethod = options.method === 'nostrmq' ? 'nostrmq' : 'api';
    
    for (const hours of times) {
      const scheduledFor = new Date(now);
      scheduledFor.setHours(scheduledFor.getHours() + hours);
      const id = await db.addPost(content, scheduledFor, accountId, options.api, publishMethod);
      console.log(`✅ Post ${id} scheduled for ${scheduledFor.toLocaleString()} via ${publishMethod}`);
    }
    
    console.log(`\n📅 Created ${times.length} scheduled posts over 24 hours using ${publishMethod}`);
    db.close();
  });

export function runCLI(args: string[]) {
  program.parse(args);
}