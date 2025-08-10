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
        console.log(`${status} ${method} [${post.id}] ${post.scheduled_for} - ${(post as any).content.substring(0, 50)}...`);
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

// Tag commands
program
  .command('tags')
  .description('List all tags with usage statistics')
  .action(async () => {
    const db = new PostDatabase();
    const tags = await db.getAllTags();
    
    if (tags.length === 0) {
      console.log('No tags found');
    } else {
      console.log('\n📌 Tags in use:');
      console.log('─'.repeat(50));
      tags.forEach(tag => {
        const lastUsed = tag.lastUsed ? new Date(tag.lastUsed).toLocaleDateString() : 'Never';
        console.log(`  ${tag.name.padEnd(20)} │ ${tag.count} notes │ Last: ${lastUsed}`);
      });
      console.log('─'.repeat(50));
      console.log(`Total: ${tags.length} tags\n`);
    }
    db.close();
  });

program
  .command('tag-note')
  .description('Add or update tags for a note')
  .argument('<noteId>', 'Note ID')
  .argument('<tags...>', 'Tags to add (space-separated)')
  .action(async (noteId, tags) => {
    const db = new PostDatabase();
    
    // Get the note to verify it exists
    const noteData = await db.getNoteWithPosts(parseInt(noteId));
    if (!noteData.note) {
      console.log(`❌ Note ${noteId} not found`);
      db.close();
      return;
    }
    
    // Update tags
    await db.updateNoteTags(parseInt(noteId), tags);
    console.log(`✅ Updated tags for note ${noteId}`);
    console.log(`📌 Tags: ${tags.join(', ')}`);
    db.close();
  });

program
  .command('notes-by-tag')
  .description('List notes with specific tags')
  .argument('<tags...>', 'Tags to filter by (space-separated)')
  .option('-l, --logic <logic>', 'Filter logic: AND or OR', 'OR')
  .action(async (tags, options) => {
    const db = new PostDatabase();
    const notes = await db.getNotesByTags(tags, options.logic);
    
    if (notes.length === 0) {
      console.log(`No notes found with tags: ${tags.join(', ')}`);
    } else {
      console.log(`\n📝 Notes with tags [${tags.join(', ')}] (${options.logic}):`);
      console.log('─'.repeat(70));
      notes.forEach(note => {
        const noteTags = note.tags ? JSON.parse(note.tags as string) : [];
        const title = note.title || 'Untitled';
        const preview = note.content.substring(0, 50) + (note.content.length > 50 ? '...' : '');
        console.log(`[${note.id}] ${title}`);
        console.log(`    ${preview}`);
        console.log(`    📌 Tags: ${noteTags.join(', ')}`);
        console.log(`    📊 Published: ${note.published_count} | Upcoming: ${note.upcoming_count}`);
        console.log('');
      });
    }
    db.close();
  });

program
  .command('untagged-notes')
  .description('List all notes without tags')
  .action(async () => {
    const db = new PostDatabase();
    const notes = await db.getUntaggedNotes();
    
    if (notes.length === 0) {
      console.log('All notes have tags! 🎉');
    } else {
      console.log(`\n📝 Untagged notes (${notes.length}):`);
      console.log('─'.repeat(70));
      notes.forEach(note => {
        const title = note.title || 'Untitled';
        const preview = note.content.substring(0, 50) + (note.content.length > 50 ? '...' : '');
        console.log(`[${note.id}] ${title}`);
        console.log(`    ${preview}`);
        console.log(`    📊 Published: ${note.published_count} | Upcoming: ${note.upcoming_count}`);
        console.log('');
      });
    }
    db.close();
  });

export function runCLI(args: string[]) {
  program.parse(args);
}