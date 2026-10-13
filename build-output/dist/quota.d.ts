export interface ResumeQuota {
    left: number;
    limit: number;
    spend: number;
}
interface MeIds {
    employerId?: string;
    managerId?: string;
}
export interface LastKnownQuota {
    quota: ResumeQuota;
    quotaPath: string;
    quotaAgeS: number;
    refreshedAt: string;
    stale: boolean;
}
/** Last successfully read quota (no network) for diagnostics. */
export declare function getLastKnownQuota(env?: NodeJS.ProcessEnv): LastKnownQuota | null;
export declare function getMeIds(_env?: NodeJS.ProcessEnv): Promise<MeIds>;
export declare function fetchResumeQuota(env?: NodeJS.ProcessEnv): Promise<ResumeQuota | null>;
export declare function formatQuotaLine(q: ResumeQuota): string;
export declare function __resetQuotaCacheForTests(): void;
export {};
