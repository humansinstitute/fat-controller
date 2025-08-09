import { EventEmitter } from 'events';
import StatsCollectionService, { CollectionJobResult } from './stats-collection.service.js';
import PostDatabase from '../database/db.js';

export type JobType = 'hourly_stats_collection' | 'manual_stats_refresh' | 'historical_migration';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  priority: number; // Higher number = higher priority
  data: any;
  result?: any;
  error?: string;
  retry_count: number;
  max_retries: number;
}

export interface HourlyStatsJobData {
  max_age_hours: number;
  batch_size?: number;
}

export interface ManualRefreshJobData {
  note_id: number;
  user_id?: string;
  requested_by?: string;
}

export interface MigrationJobData {
  batch_size: number;
  offset: number;
}

export class BackgroundJobService extends EventEmitter {
  private jobs: Map<string, Job> = new Map();
  private isRunning: boolean = false;
  private processingJob: Job | null = null;
  private processingInterval: NodeJS.Timeout | null = null;
  
  private db: PostDatabase;
  private statsCollectionService: StatsCollectionService;
  
  private readonly processingIntervalMs = 5000; // Check for jobs every 5 seconds
  private readonly maxConcurrentJobs = 1; // Process one job at a time

  constructor(db?: PostDatabase, statsCollectionService?: StatsCollectionService) {
    super();
    this.db = db || new PostDatabase();
    this.statsCollectionService = statsCollectionService || new StatsCollectionService(this.db);
  }

  start(): void {
    if (this.isRunning) {
      console.log('⚠️  Background job service is already running');
      return;
    }

    this.isRunning = true;
    console.log('🚀 Starting background job service');
    
    this.processingInterval = setInterval(() => {
      this.processNextJob().catch(error => {
        console.error('❌ Error in job processing loop:', error);
      });
    }, this.processingIntervalMs);

    this.emit('started');
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping background job service');
    this.isRunning = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    // Disconnect stats collection service
    this.statsCollectionService.disconnect();

    this.emit('stopped');
  }

  private generateJobId(type: JobType): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${type}_${timestamp}_${random}`;
  }

  queueJob(type: JobType, data: any, priority: number = 0, maxRetries: number = 3): string {
    const jobId = this.generateJobId(type);
    const job: Job = {
      id: jobId,
      type,
      status: 'queued',
      created_at: new Date().toISOString(),
      priority,
      data,
      retry_count: 0,
      max_retries: maxRetries
    };

    this.jobs.set(jobId, job);
    console.log(`📋 Queued ${type} job: ${jobId} (priority: ${priority})`);
    
    this.emit('job_queued', job);
    return jobId;
  }

  // Convenience methods for common job types
  queueHourlyStatsCollection(maxAgeHours: number = 48): string {
    const data: HourlyStatsJobData = {
      max_age_hours: maxAgeHours,
      batch_size: 50
    };
    return this.queueJob('hourly_stats_collection', data, 1); // Lower priority
  }

  queueManualStatsRefresh(noteId: number, userId?: string): string {
    const data: ManualRefreshJobData = {
      note_id: noteId,
      user_id: userId,
      requested_by: userId || 'system'
    };
    return this.queueJob('manual_stats_refresh', data, 10); // High priority
  }

  queueHistoricalMigration(batchSize: number = 100, offset: number = 0): string {
    const data: MigrationJobData = {
      batch_size: batchSize,
      offset
    };
    return this.queueJob('historical_migration', data, 5); // Medium priority
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  getJobsByStatus(status: JobStatus): Job[] {
    return Array.from(this.jobs.values()).filter(job => job.status === status);
  }

  getJobsByType(type: JobType): Job[] {
    return Array.from(this.jobs.values()).filter(job => job.type === type);
  }

  getAllJobs(): Job[] {
    return Array.from(this.jobs.values()).sort((a, b) => {
      // Sort by priority (desc), then by created_at (asc)
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }

  private getNextJob(): Job | null {
    const queuedJobs = this.getJobsByStatus('queued');
    if (queuedJobs.length === 0) {
      return null;
    }

    // Sort by priority (desc), then by created_at (asc)
    queuedJobs.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    return queuedJobs[0];
  }

  private async processNextJob(): Promise<void> {
    if (this.processingJob || !this.isRunning) {
      return; // Already processing a job or service is stopped
    }

    const nextJob = this.getNextJob();
    if (!nextJob) {
      return; // No jobs to process
    }

    this.processingJob = nextJob;
    nextJob.status = 'running';
    nextJob.started_at = new Date().toISOString();
    
    console.log(`🔄 Processing job: ${nextJob.id} (${nextJob.type})`);
    this.emit('job_started', nextJob);

    try {
      const result = await this.executeJob(nextJob);
      
      nextJob.status = 'completed';
      nextJob.completed_at = new Date().toISOString();
      nextJob.result = result;
      
      console.log(`✅ Completed job: ${nextJob.id}`);
      this.emit('job_completed', nextJob);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Job ${nextJob.id} failed:`, errorMessage);

      if (nextJob.retry_count < nextJob.max_retries) {
        nextJob.retry_count++;
        nextJob.status = 'queued';
        nextJob.started_at = undefined;
        
        console.log(`🔄 Retrying job ${nextJob.id} (attempt ${nextJob.retry_count}/${nextJob.max_retries})`);
        this.emit('job_retrying', nextJob);
      } else {
        nextJob.status = 'failed';
        nextJob.completed_at = new Date().toISOString();
        nextJob.error = errorMessage;
        
        console.error(`💀 Job ${nextJob.id} failed permanently after ${nextJob.max_retries} retries`);
        this.emit('job_failed', nextJob);
      }
    } finally {
      this.processingJob = null;
    }
  }

  private async executeJob(job: Job): Promise<any> {
    switch (job.type) {
      case 'hourly_stats_collection':
        return this.executeHourlyStatsCollection(job.data as HourlyStatsJobData);
        
      case 'manual_stats_refresh':
        return this.executeManualStatsRefresh(job.data as ManualRefreshJobData);
        
      case 'historical_migration':
        return this.executeHistoricalMigration(job.data as MigrationJobData);
        
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
  }

  private async executeHourlyStatsCollection(data: HourlyStatsJobData): Promise<CollectionJobResult> {
    console.log(`⏰ Executing hourly stats collection (max age: ${data.max_age_hours}h)`);
    return this.statsCollectionService.collectStatsForRecentPosts(data.max_age_hours);
  }

  private async executeManualStatsRefresh(data: ManualRefreshJobData): Promise<CollectionJobResult> {
    console.log(`👤 Executing manual stats refresh for note ${data.note_id} (requested by: ${data.requested_by})`);
    return this.statsCollectionService.collectStatsForNote(data.note_id);
  }

  private async executeHistoricalMigration(data: MigrationJobData): Promise<any> {
    console.log(`📜 Executing historical migration (batch: ${data.batch_size}, offset: ${data.offset})`);
    
    // This would implement the historical migration logic
    // For now, we'll just import and run the migration script
    const { PostStatsMigration } = await import('../database/migrate-post-stats.js');
    const migration = new PostStatsMigration(this.db);
    
    const result = await migration.migrateHistoricalPosts();
    return result;
  }

  // Cleanup old completed/failed jobs
  cleanupOldJobs(maxAgeHours: number = 24): number {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    let cleanedCount = 0;

    for (const [jobId, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'failed') && 
          job.completed_at && 
          new Date(job.completed_at) < cutoffTime) {
        this.jobs.delete(jobId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} old jobs`);
    }

    return cleanedCount;
  }

  getStatus(): {
    running: boolean;
    current_job: Job | null;
    queue_size: number;
    completed_jobs: number;
    failed_jobs: number;
  } {
    return {
      running: this.isRunning,
      current_job: this.processingJob,
      queue_size: this.getJobsByStatus('queued').length,
      completed_jobs: this.getJobsByStatus('completed').length,
      failed_jobs: this.getJobsByStatus('failed').length
    };
  }
}

export default BackgroundJobService;