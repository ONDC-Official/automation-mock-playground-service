// import v8 from 'v8';
// import { mkdirSync } from 'fs';
// import { join } from 'path';
// import logger from './logger';
// import promClient from 'prom-client';

// // ── Prometheus gauges ──────────────────────────────────────────────────────────
// const heapUsedGauge = new promClient.Gauge({
//     name: 'nodejs_heap_used_bytes',
//     help: 'V8 heap used in bytes',
// });
// const heapTotalGauge = new promClient.Gauge({
//     name: 'nodejs_heap_total_bytes',
//     help: 'V8 heap total allocated in bytes',
// });
// const rssGauge = new promClient.Gauge({
//     name: 'nodejs_rss_bytes',
//     help: 'Resident Set Size in bytes',
// });
// const externalGauge = new promClient.Gauge({
//     name: 'nodejs_external_bytes',
//     help: 'Memory used by C++ objects bound to JS objects',
// });
// const arrayBuffersGauge = new promClient.Gauge({
//     name: 'nodejs_array_buffers_bytes',
//     help: 'Memory allocated for ArrayBuffers and SharedArrayBuffers',
// });
// const heapSpaceUsedGauge = new promClient.Gauge({
//     name: 'nodejs_heap_space_used_bytes',
//     help: 'V8 heap space used bytes per space',
//     labelNames: ['space'],
// });
// const heapSpaceSizeGauge = new promClient.Gauge({
//     name: 'nodejs_heap_space_size_bytes',
//     help: 'V8 heap space total size bytes per space',
//     labelNames: ['space'],
// });

// // ── Types ──────────────────────────────────────────────────────────────────────
// export interface MemorySnapshot {
//     timestamp: string;
//     uptimeSeconds: number;
//     process: {
//         rss: number;
//         heapTotal: number;
//         heapUsed: number;
//         external: number;
//         arrayBuffers: number;
//         heapUsedMB: number;
//         rssMB: number;
//     };
//     heapSpaces: Array<{
//         name: string;
//         usedMB: number;
//         totalMB: number;
//         usedPercent: number;
//     }>;
//     heapStats: {
//         totalHeapSizeBytes: number;
//         usedHeapSizeBytes: number;
//         heapSizeLimitBytes: number;
//         totalAvailableBytes: number;
//         totalPhysicalBytes: number;
//         mallocedMemoryBytes: number;
//         peakMallocedMemoryBytes: number;
//     };
// }

// // ── Core snapshot collector ────────────────────────────────────────────────────
// export function collectMemorySnapshot(): MemorySnapshot {
//     const mem = process.memoryUsage();
//     const heapStats = v8.getHeapStatistics();
//     const heapSpaces = v8.getHeapSpaceStatistics();

//     // Update prometheus gauges
//     heapUsedGauge.set(mem.heapUsed);
//     heapTotalGauge.set(mem.heapTotal);
//     rssGauge.set(mem.rss);
//     externalGauge.set(mem.external);
//     arrayBuffersGauge.set(mem.arrayBuffers ?? 0);

//     const formattedSpaces = heapSpaces.map(space => {
//         const usedMB = space.space_used_size / 1024 / 1024;
//         const totalMB = space.space_size / 1024 / 1024;
//         const usedPercent =
//             space.space_size > 0
//                 ? Math.round((space.space_used_size / space.space_size) * 100)
//                 : 0;

//         heapSpaceUsedGauge.set(
//             { space: space.space_name },
//             space.space_used_size
//         );
//         heapSpaceSizeGauge.set({ space: space.space_name }, space.space_size);

//         return {
//             name: space.space_name,
//             usedMB: parseFloat(usedMB.toFixed(2)),
//             totalMB: parseFloat(totalMB.toFixed(2)),
//             usedPercent,
//         };
//     });

//     return {
//         timestamp: new Date().toISOString(),
//         uptimeSeconds: Math.round(process.uptime()),
//         process: {
//             rss: mem.rss,
//             heapTotal: mem.heapTotal,
//             heapUsed: mem.heapUsed,
//             external: mem.external,
//             arrayBuffers: mem.arrayBuffers ?? 0,
//             heapUsedMB: parseFloat((mem.heapUsed / 1024 / 1024).toFixed(2)),
//             rssMB: parseFloat((mem.rss / 1024 / 1024).toFixed(2)),
//         },
//         heapSpaces: formattedSpaces,
//         heapStats: {
//             totalHeapSizeBytes: heapStats.total_heap_size,
//             usedHeapSizeBytes: heapStats.used_heap_size,
//             heapSizeLimitBytes: heapStats.heap_size_limit,
//             totalAvailableBytes: heapStats.total_available_size,
//             totalPhysicalBytes: heapStats.total_physical_size,
//             mallocedMemoryBytes: heapStats.malloced_memory,
//             peakMallocedMemoryBytes: heapStats.peak_malloced_memory,
//         },
//     };
// }

// // ── Periodic logger ────────────────────────────────────────────────────────────
// let _interval: NodeJS.Timeout | null = null;
// let _baseline: number | null = null;

// export function startMemoryProfiling(intervalMs = 60_000): void {
//     if (_interval) return; // already running

//     const initial = process.memoryUsage();
//     _baseline = initial.heapUsed;

//     logger.info('[MemoryProfiler] Started', {
//         intervalMs,
//         baselineHeapMB: parseFloat((_baseline / 1024 / 1024).toFixed(2)),
//     });

//     _interval = setInterval(() => {
//         const snap = collectMemorySnapshot();
//         const growthMB =
//             _baseline !== null
//                 ? parseFloat(
//                       (
//                           (snap.process.heapUsed - _baseline) /
//                           1024 /
//                           1024
//                       ).toFixed(2)
//                   )
//                 : 0;

//         logger.info('[MemoryProfiler] Snapshot', {
//             heapUsedMB: snap.process.heapUsedMB,
//             rssMB: snap.process.rssMB,
//             growthSinceStartMB: growthMB,
//             topHeapSpaces: snap.heapSpaces
//                 .sort((a, b) => b.usedMB - a.usedMB)
//                 .slice(0, 3)
//                 .map(s => `${s.name}=${s.usedMB}MB(${s.usedPercent}%)`),
//         });

//         // Warn if heap used exceeds 80 % of the V8 limit
//         const heapLimitMB = snap.heapStats.heapSizeLimitBytes / 1024 / 1024;
//         const heapUsedPercent =
//             (snap.process.heapUsed / snap.heapStats.heapSizeLimitBytes) * 100;
//         if (heapUsedPercent > 80) {
//             logger.warning('[MemoryProfiler] HIGH HEAP USAGE', {
//                 heapUsedMB: snap.process.heapUsedMB,
//                 heapLimitMB: parseFloat(heapLimitMB.toFixed(2)),
//                 usedPercent: parseFloat(heapUsedPercent.toFixed(1)),
//             });
//         }
//     }, intervalMs);

//     // Unref so it doesn't block clean shutdown
//     if (_interval.unref) _interval.unref();
// }

// export function stopMemoryProfiling(): void {
//     if (_interval) {
//         clearInterval(_interval);
//         _interval = null;
//         logger.info('[MemoryProfiler] Stopped');
//     }
// }

// // ── Heap snapshot (opens in Chrome DevTools → Memory tab) ─────────────────────
// export function takeHeapSnapshot(outputDir = 'heapdumps'): string {
//     mkdirSync(outputDir, { recursive: true });
//     const filename = `heap-${Date.now()}.heapsnapshot`;
//     const filepath = join(outputDir, filename);

//     // v8.writeHeapSnapshot writes the file and returns the path
//     const written = v8.writeHeapSnapshot(filepath);
//     logger.info('[MemoryProfiler] Heap snapshot written', { path: written });
//     return written;
// }
