import { ICacheService } from '../cache/cache-interface';
import { IQueueService } from '../queue/IQueueService';
import { createCache } from '../cache/cache-factory';
import {
    WorkbenchCacheService,
    WorkbenchCacheServiceType,
} from '../service/cache/workbench-cache';
import {
    createGeneratePayloadJobHandler,
    createGenerationRequestCompleteHandler,
    GENERATE_PAYLOAD_JOB,
    GenerateMockPayloadJobParams,
    generateRequestPayloadJobFailed,
} from '../service/jobs/generate-response';
import {
    MockRunnerConfigCache,
    newMockRunnerConfigCache,
} from '../service/cache/config-cache';
import {
    apiServiceRequestJobComplete,
    apiServiceRequestJobFailed,
    ApiServiceRequestJobParams,
    createApiServiceRequestJobHandler,
    SEND_TO_API_SERVICE_JOB,
} from '../service/jobs/api-service-request';

/**
 * ServiceContainer - Centralized dependency injection container
 *
 * This container manages the lifecycle of application services and provides
 * a single source of truth for dependency injection. It uses lazy initialization
 * to create services only when they're first requested.
 *
 * Benefits:
 * - Centralized service configuration and initialization
 * - Easy testing through dependency injection
 * - Explicit dependency management
 * - Ability to override services for testing or different environments
 */
class ServiceContainer {
    private static instance: ServiceContainer;

    private _cacheService0: ICacheService | null = null; // used for WorkbenchCacheService
    private _cacheService1: ICacheService | null = null; // used fo mock runner.
    private _queueService: IQueueService | null = null;
    private _workbenchCacheService: WorkbenchCacheServiceType | null = null;
    private _mockRunnerConfigCache: MockRunnerConfigCache | null = null;

    private constructor() {
        // Private constructor enforces singleton pattern
    }

    /**
     * Get the singleton instance of ServiceContainer
     */
    public static getInstance(): ServiceContainer {
        if (!ServiceContainer.instance) {
            ServiceContainer.instance = new ServiceContainer();
        }
        return ServiceContainer.instance;
    }

    /**
     * Get the cache service instance (lazy initialization)
     */
    public getCacheService0(): ICacheService {
        if (!this._cacheService0) {
            this._cacheService0 = createCache('mock');
        }
        return this._cacheService0;
    }

    /**     * Get the workbench cache service instance (lazy initialization)
     */
    public getWorkbenchCacheService(): WorkbenchCacheServiceType {
        if (!this._workbenchCacheService) {
            this._workbenchCacheService = WorkbenchCacheService(
                this.getCacheService0()
            );
        }
        return this._workbenchCacheService;
    }

    /**
     * Get the mock runner config cache instance (lazy initialization)
     */
    public getMockRunnerConfigCache(): MockRunnerConfigCache {
        if (!this._mockRunnerConfigCache) {
            if (!this._cacheService1) {
                throw new Error('CacheService1 not initialized');
            }
            this._mockRunnerConfigCache = newMockRunnerConfigCache(
                this._cacheService1
            );
        }
        return this._mockRunnerConfigCache;
    }

    /**
     * Get the queue service instance (lazy initialization)
     */
    public getQueueService(): IQueueService {
        if (!this._queueService) {
            throw new Error('QueueService not initialized');
        }
        return this._queueService;
    }

    /**
     * Override cache service (useful for testing)
     */
    public setCacheService0(service: ICacheService): void {
        this._cacheService0 = service;
        this._workbenchCacheService = WorkbenchCacheService(service);
    }

    public setCacheService1(service: ICacheService): void {
        this._cacheService1 = service;
        this._mockRunnerConfigCache = newMockRunnerConfigCache(
            this._cacheService1
        );
    }

    /**
     * Override queue service (useful for testing)
     */
    public setQueueService(service: IQueueService): void {
        this._queueService = service;
        this.initializeQueueService();
    }

    /**
     * Reset all services (useful for testing)
     */
    public reset(): void {
        this._cacheService0 = null;
        this._cacheService1 = null;
        this._queueService = null;
        this._workbenchCacheService = null;
        this._mockRunnerConfigCache = null;
    }

    /**
     * Initialize queue service with processors and event handlers
     */
    private initializeQueueService(): IQueueService {
        const queue = this._queueService;
        if (!queue) {
            throw new Error('QueueService not initialized');
        }
        if (!this._mockRunnerConfigCache) {
            throw new Error('MockRunnerConfigCache not initialized');
        }
        if (!this._workbenchCacheService) {
            throw new Error('WorkbenchCacheService not initialized');
        }

        // Register job processors
        queue.process<GenerateMockPayloadJobParams>(
            GENERATE_PAYLOAD_JOB,
            createGeneratePayloadJobHandler(
                this._workbenchCacheService,
                this._mockRunnerConfigCache
            )
        );
        queue.process<ApiServiceRequestJobParams>(
            SEND_TO_API_SERVICE_JOB,
            createApiServiceRequestJobHandler()
        );

        // ? Register event handlers
        queue.on<GenerateMockPayloadJobParams>(
            'completed',
            GENERATE_PAYLOAD_JOB,
            createGenerationRequestCompleteHandler(
                queue,
                this._workbenchCacheService!,
                this._mockRunnerConfigCache!
            )
        );
        queue.on<GenerateMockPayloadJobParams>(
            'failed',
            GENERATE_PAYLOAD_JOB,
            generateRequestPayloadJobFailed
        );
        queue.on<ApiServiceRequestJobParams>(
            'completed',
            SEND_TO_API_SERVICE_JOB,
            apiServiceRequestJobComplete
        );
        queue.on<ApiServiceRequestJobParams>(
            'failed',
            SEND_TO_API_SERVICE_JOB,
            apiServiceRequestJobFailed
        );
        return queue;
    }

    /**
     * Graceful shutdown - close all services
     */
    public async shutdown(): Promise<void> {
        if (this._queueService) {
            await this._queueService.close();
        }
    }
}

export default ServiceContainer;
