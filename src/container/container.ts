import { ICacheService } from '../cache/cache-interface';
import { IQueueService } from '../queue/IQueueService';
import { createCache } from '../cache/cache-factory';
import { createInMemoryQueue } from '../queue/InMemoryQueue';
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
     * Get the queue service instance (lazy initialization)
     */
    public getQueueService(): IQueueService {
        if (!this._queueService) {
            this._queueService = this.initializeQueueService();
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
        this._mockRunnerConfigCache = newMockRunnerConfigCache(service);
    }

    /**
     * Override queue service (useful for testing)
     */
    public setQueueService(service: IQueueService): void {
        this._queueService = service;
    }

    /**
     * Reset all services (useful for testing)
     */
    public reset(): void {
        this._cacheService0 = null;
        this._queueService = null;
        this._workbenchCacheService = null;
    }

    /**
     * Initialize queue service with processors and event handlers
     */
    private initializeQueueService(): IQueueService {
        const queue = createInMemoryQueue();
        if (!this._mockRunnerConfigCache) {
            throw new Error('MockRunnerConfigCache not initialized');
        }

        // Register job processors
        queue.process<GenerateMockPayloadJobParams>(
            GENERATE_PAYLOAD_JOB,
            createGeneratePayloadJobHandler(this._mockRunnerConfigCache)
        );
        queue.process<ApiServiceRequestJobParams>(
            'API_SERVICE_REQUEST_JOB',
            createApiServiceRequestJobHandler()
        );

        // ? Register event handlers
        queue.on<GenerateMockPayloadJobParams>(
            'completed',
            createGenerationRequestCompleteHandler(queue)
        );
        queue.on<GenerateMockPayloadJobParams>(
            'failed',
            generateRequestPayloadJobFailed
        );
        queue.on<ApiServiceRequestJobParams>(
            'completed',
            apiServiceRequestJobComplete
        );
        queue.on<ApiServiceRequestJobParams>(
            'failed',
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
