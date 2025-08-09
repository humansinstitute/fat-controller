import * as cron from 'node-cron';
import BackgroundJobService from './background-jobs.service.js';
import PostDatabase from '../database/db.js';
import StatsCollectionService from './stats-collection.service.js';

export class StatsSchedulerService {
  private backgroundJobs: BackgroundJobService;
  private hourlyTask: cron.ScheduledTask | null = null;
  private cleanupTask: cron.ScheduledTask | null = null;
  private isRunning: boolean = false;
  
  // Configuration
  private readonly hourlySchedule: string = '0 * * * *'; // Every hour at minute 0
  private readonly cleanupSchedule: string = '0 2 * * *'; // Daily at 2 AM
  private readonly maxAgeHours: number = 48; // Only collect stats for posts published in last 48 hours
  private readonly cleanupAgeHours: number = 24; // Cleanup jobs older than 24 hours

  constructor(
    db?: PostDatabase,
    statsCollectionService?: StatsCollectionService,
    backgroundJobs?: BackgroundJobService
  ) {
    this.backgroundJobs = backgroundJobs || new BackgroundJobService(
      db || new PostDatabase(),
      statsCollectionService || new StatsCollectionService(db || new PostDatabase())
    );
  }

  start(): void {
    if (this.isRunning) {
      console.log('⚠️  Stats scheduler is already running');
      return;
    }

    console.log('🕒 Starting stats scheduler service');
    this.isRunning = true;

    // Start the background job processor
    this.backgroundJobs.start();

    // Set up hourly stats collection
    this.hourlyTask = cron.schedule(this.hourlySchedule, () => {
      this.runHourlyStatsCollection();
    }, {
      scheduled: true,
      name: 'hourly-stats-collection',
      timezone: 'UTC'
    });

    // Set up daily cleanup
    this.cleanupTask = cron.schedule(this.cleanupSchedule, () => {
      this.runDailyCleanup();
    }, {
      scheduled: true,
      name: 'daily-job-cleanup',
      timezone: 'UTC'
    });

    // Queue an immediate stats collection on startup
    console.log('🚀 Queueing initial stats collection on startup');
    this.backgroundJobs.queueHourlyStatsCollection(this.maxAgeHours);

    // Set up event listeners for job monitoring
    this.setupJobEventListeners();

    console.log(`✅ Stats scheduler started`);
    console.log(`   - Hourly stats collection: ${this.hourlySchedule}`);
    console.log(`   - Daily cleanup: ${this.cleanupSchedule}`);
    console.log(`   - Max post age for collection: ${this.maxAgeHours} hours`);
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping stats scheduler service');
    this.isRunning = false;

    // Stop cron tasks
    if (this.hourlyTask) {
      this.hourlyTask.stop();
      this.hourlyTask = null;
    }

    if (this.cleanupTask) {
      this.cleanupTask.stop();
      this.cleanupTask = null;
    }

    // Stop background job service
    this.backgroundJobs.stop();

    console.log('✅ Stats scheduler stopped');
  }

  private runHourlyStatsCollection(): void {
    try {
      console.log('⏰ Triggering hourly stats collection');
      const jobId = this.backgroundJobs.queueHourlyStatsCollection(this.maxAgeHours);
      console.log(`📋 Queued hourly stats collection job: ${jobId}`);
    } catch (error) {
      console.error('❌ Error queueing hourly stats collection:', error);
    }
  }

  private runDailyCleanup(): void {
    try {
      console.log('🧹 Running daily job cleanup');
      const cleanedCount = this.backgroundJobs.cleanupOldJobs(this.cleanupAgeHours);
      console.log(`✅ Daily cleanup completed, removed ${cleanedCount} old jobs`);
    } catch (error) {
      console.error('❌ Error during daily cleanup:', error);
    }
  }

  private setupJobEventListeners(): void {
    this.backgroundJobs.on('job_queued', (job) => {
      console.log(`📋 Job queued: ${job.id} (${job.type})`);
    });

    this.backgroundJobs.on('job_started', (job) => {
      console.log(`🔄 Job started: ${job.id} (${job.type})`);
    });

    this.backgroundJobs.on('job_completed', (job) => {
      console.log(`✅ Job completed: ${job.id} (${job.type})`);
      
      // Log summary for stats collection jobs
      if (job.result && (job.type === 'hourly_stats_collection' || job.type === 'manual_stats_refresh')) {
        const result = job.result;
        console.log(`   📊 Stats: ${result.successful_updates} success, ${result.failed_updates} failed, ${result.unknown_updates} unknown`);
        console.log(`   ⏱️  Duration: ${result.duration_ms}ms`);
        
        if (result.errors && result.errors.length > 0) {
          console.log(`   ⚠️  Errors: ${result.errors.length}`);
        }
      }
    });

    this.backgroundJobs.on('job_failed', (job) => {
      console.error(`❌ Job failed permanently: ${job.id} (${job.type})`);
      console.error(`   Error: ${job.error}`);
      console.error(`   Retries: ${job.retry_count}/${job.max_retries}`);
    });

    this.backgroundJobs.on('job_retrying', (job) => {
      console.log(`🔄 Job retrying: ${job.id} (attempt ${job.retry_count}/${job.max_retries})`);
    });
  }

  // Manual triggers for testing/admin purposes
  triggerManualStatsCollection(): string {
    console.log('👤 Manually triggering stats collection');
    return this.backgroundJobs.queueHourlyStatsCollection(this.maxAgeHours);
  }

  triggerNoteStatsRefresh(noteId: number, userId?: string): string {
    console.log(`👤 Manually triggering stats refresh for note ${noteId}`);
    return this.backgroundJobs.queueManualStatsRefresh(noteId, userId);
  }

  triggerHistoricalMigration(): string {
    console.log('👤 Manually triggering historical migration');
    return this.backgroundJobs.queueHistoricalMigration();
  }

  // Status and monitoring
  getSchedulerStatus(): {
    running: boolean;
    hourly_task_running: boolean;
    cleanup_task_running: boolean;
    next_hourly_run?: Date;
    next_cleanup_run?: Date;
    background_jobs: any;
  } {
    return {
      running: this.isRunning,
      hourly_task_running: this.hourlyTask !== null,
      cleanup_task_running: this.cleanupTask !== null,
      next_hourly_run: this.getNextRunTime(this.hourlySchedule),
      next_cleanup_run: this.getNextRunTime(this.cleanupSchedule),
      background_jobs: this.backgroundJobs.getStatus()
    };
  }

  private getNextRunTime(cronExpression: string): Date | undefined {
    try {
      const task = cron.schedule(cronExpression, () => {}, { scheduled: false });
      const nextDates = cron.getTasks();
      // This is a simplified implementation - in practice you'd use a proper cron parser
      return undefined; // TODO: Implement proper next run time calculation
    } catch (error) {
      console.error('Error calculating next run time:', error);
      return undefined;
    }
  }

  getBackgroundJobService(): BackgroundJobService {
    return this.backgroundJobs;
  }

  // Configuration getters/setters
  getMaxAgeHours(): number {
    return this.maxAgeHours;
  }

  getCleanupAgeHours(): number {
    return this.cleanupAgeHours;
  }

  getHourlySchedule(): string {
    return this.hourlySchedule;
  }

  getCleanupSchedule(): string {
    return this.cleanupSchedule;
  }

  isSchedulerRunning(): boolean {
    return this.isRunning;
  }
}

export default StatsSchedulerService;