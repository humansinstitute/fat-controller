import PostDatabase from './db.js';
import { Post } from './schema.js';

/**
 * Historical migration script to create PostStats records for all existing posts with event_id
 * Initializes all records with status='unknown' and zero values
 */
export class PostStatsMigration {
  private db: PostDatabase;

  constructor(db?: PostDatabase) {
    this.db = db || new PostDatabase();
  }

  async migrateHistoricalPosts(): Promise<{
    total_posts: number;
    posts_with_event_id: number;
    stats_created: number;
    errors: string[];
  }> {
    const result = {
      total_posts: 0,
      posts_with_event_id: 0,
      stats_created: 0,
      errors: [] as string[]
    };

    try {
      console.log('🚀 Starting PostStats historical migration...');

      // Get all posts with event_id
      const allPosts = await this.db.getAllPosts();
      result.total_posts = allPosts.length;

      const postsWithEventId = allPosts.filter(post => 
        post.status === 'published' && post.event_id
      );
      result.posts_with_event_id = postsWithEventId.length;

      console.log(`📊 Found ${result.total_posts} total posts, ${result.posts_with_event_id} published with event_id`);

      // Process each post
      for (const post of postsWithEventId) {
        try {
          // Check if stats already exist
          const existingStats = await this.db.getPostStats(post.id!);
          
          if (existingStats) {
            console.log(`⏭️  Skipping post ${post.id} - stats already exist`);
            continue;
          }

          // Create initial stats record with unknown status
          await this.db.createOrUpdatePostStats(post.id!, {
            likes: 0,
            reposts: 0,
            zap_amount: 0,
            last_updated: new Date().toISOString(),
            status: 'unknown',
            error_message: 'Awaiting initial stats collection'
          });

          result.stats_created++;
          console.log(`✅ Created stats record for post ${post.id} (event: ${post.event_id})`);

        } catch (error) {
          const errorMsg = `Failed to create stats for post ${post.id}: ${error}`;
          result.errors.push(errorMsg);
          console.error(`❌ ${errorMsg}`);
        }
      }

      console.log(`🎉 Migration completed!`);
      console.log(`   - Posts processed: ${result.posts_with_event_id}`);
      console.log(`   - Stats created: ${result.stats_created}`);
      console.log(`   - Errors: ${result.errors.length}`);

      if (result.errors.length > 0) {
        console.log('⚠️  Errors encountered:');
        result.errors.forEach(error => console.log(`   - ${error}`));
      }

    } catch (error) {
      const errorMsg = `Migration failed: ${error}`;
      result.errors.push(errorMsg);
      console.error(`💥 ${errorMsg}`);
    }

    return result;
  }

  async rollbackMigration(): Promise<{
    deleted_records: number;
    errors: string[];
  }> {
    const result = {
      deleted_records: 0,
      errors: [] as string[]
    };

    try {
      console.log('🔄 Rolling back PostStats migration...');
      
      // Drop the post_stats table
      await this.db.run('DROP TABLE IF EXISTS post_stats', []);
      console.log('✅ Dropped post_stats table');

      // Note: The table will be recreated on next database initialization
      console.log('🎉 Rollback completed successfully');
      
    } catch (error) {
      const errorMsg = `Rollback failed: ${error}`;
      result.errors.push(errorMsg);
      console.error(`💥 ${errorMsg}`);
    }

    return result;
  }

  close(): void {
    // Only close if we created our own instance
    this.db.close();
  }
}

// CLI execution when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const migration = new PostStatsMigration();
  
  const command = process.argv[2] || 'migrate';
  
  if (command === 'migrate') {
    migration.migrateHistoricalPosts()
      .then(result => {
        console.log('\n📋 Migration Summary:');
        console.log(JSON.stringify(result, null, 2));
        migration.close();
        process.exit(result.errors.length > 0 ? 1 : 0);
      })
      .catch(error => {
        console.error('💥 Migration failed:', error);
        migration.close();
        process.exit(1);
      });
      
  } else if (command === 'rollback') {
    migration.rollbackMigration()
      .then(result => {
        console.log('\n📋 Rollback Summary:');
        console.log(JSON.stringify(result, null, 2));
        migration.close();
        process.exit(result.errors.length > 0 ? 1 : 0);
      })
      .catch(error => {
        console.error('💥 Rollback failed:', error);
        migration.close();
        process.exit(1);
      });
      
  } else {
    console.log('Usage: tsx migrate-post-stats.ts [migrate|rollback]');
    migration.close();
    process.exit(1);
  }
}