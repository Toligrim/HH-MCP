import { z } from "zod";
export declare const hhUsageReportSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleHhUsageReport(params?: z.infer<typeof hhUsageReportSchema>): Promise<string>;
