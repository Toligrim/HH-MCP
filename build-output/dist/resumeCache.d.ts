export interface CacheEnvelope {
    fetchedAt: number;
    path: string;
    resumeId: string;
    topicId?: string;
    vacancyId?: string;
    payload: unknown;
}
export declare function getCacheDir(env?: NodeJS.ProcessEnv): string | null;
export declare function cacheKey(resumeId: string, topicId?: string, vacancyId?: string): string;
export declare function readResumeCache(opts: {
    resumeId: string;
    topicId?: string;
    vacancyId?: string;
    env?: NodeJS.ProcessEnv;
}): CacheEnvelope | null;
export declare function writeResumeCache(opts: {
    resumeId: string;
    topicId?: string;
    vacancyId?: string;
    pathUsed: string;
    payload: unknown;
    env?: NodeJS.ProcessEnv;
}): void;
export declare function formatCacheNote(fetchedAt: number): string;
