import { z } from "zod";
export declare const getSalaryStatisticsSchema: z.ZodObject<{
    professional_role_id: z.ZodNumber;
    area_id: z.ZodOptional<z.ZodNumber>;
    text: z.ZodOptional<z.ZodString>;
    speciality: z.ZodOptional<z.ZodString>;
    employee_level: z.ZodOptional<z.ZodString>;
    industry: z.ZodOptional<z.ZodString>;
    extend_sources: z.ZodOptional<z.ZodBoolean>;
    sample_pages: z.ZodDefault<z.ZodNumber>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    professional_role_id: number;
    sample_pages: number;
    text?: string | undefined;
    industry?: string | undefined;
    raw?: boolean | undefined;
    area_id?: number | undefined;
    speciality?: string | undefined;
    employee_level?: string | undefined;
    extend_sources?: boolean | undefined;
}, {
    professional_role_id: number;
    text?: string | undefined;
    industry?: string | undefined;
    raw?: boolean | undefined;
    area_id?: number | undefined;
    speciality?: string | undefined;
    employee_level?: string | undefined;
    extend_sources?: boolean | undefined;
    sample_pages?: number | undefined;
}>;
export declare function handleGetSalaryStatistics(params: z.infer<typeof getSalaryStatisticsSchema>): Promise<string>;
