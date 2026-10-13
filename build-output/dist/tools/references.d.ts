import { z } from "zod";
export declare const getAreasSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleGetAreas(params?: z.infer<typeof getAreasSchema>): Promise<string>;
export declare const getAreasSubtreeSchema: z.ZodObject<{
    area_id: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    area_id: string;
    raw?: boolean | undefined;
}, {
    area_id: string;
    raw?: boolean | undefined;
}>;
export declare function handleGetAreasSubtree(params: z.infer<typeof getAreasSubtreeSchema>): Promise<string>;
export declare const getProfessionalRolesSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleGetProfessionalRoles(params?: z.infer<typeof getProfessionalRolesSchema>): Promise<string>;
export declare const getIndustriesSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleGetIndustries(params?: z.infer<typeof getIndustriesSchema>): Promise<string>;
export declare const getMetroSchema: z.ZodObject<{
    city_id: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    city_id?: string | undefined;
}, {
    city_id?: string | undefined;
}>;
export declare function handleGetMetro(params: z.infer<typeof getMetroSchema>): Promise<string>;
export declare function handleGetDictionaries(): Promise<string>;
export declare const validateTokenSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleValidateToken(params?: z.infer<typeof validateTokenSchema>): Promise<string>;
export declare const suggestPositionsSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
/** Autocomplete free-form position titles via /suggests/positions. */
export declare function handleSuggestPositions(params: z.infer<typeof suggestPositionsSchema>): Promise<string>;
export declare const suggestProfessionalRolesSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
/** Autocomplete professional role IDs via /suggests/professional_roles. */
export declare function handleSuggestProfessionalRoles(params: z.infer<typeof suggestProfessionalRolesSchema>): Promise<string>;
export declare const suggestCompaniesSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
export declare function handleSuggestCompanies(params: z.infer<typeof suggestCompaniesSchema>): Promise<string>;
export declare const suggestAreasSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
export declare function handleSuggestAreas(params: z.infer<typeof suggestAreasSchema>): Promise<string>;
export declare const suggestVacancySearchKeywordSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
export declare function handleSuggestVacancySearchKeyword(params: z.infer<typeof suggestVacancySearchKeywordSchema>): Promise<string>;
export declare const suggestResumeSearchKeywordSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
export declare function handleSuggestResumeSearchKeyword(params: z.infer<typeof suggestResumeSearchKeywordSchema>): Promise<string>;
export declare const suggestSkillSetSchema: z.ZodObject<{
    text: z.ZodString;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    text: string;
    raw?: boolean | undefined;
}, {
    text: string;
    raw?: boolean | undefined;
}>;
export declare function handleSuggestSkillSet(params: z.infer<typeof suggestSkillSetSchema>): Promise<string>;
export declare const getCountriesSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleGetCountries(params?: z.infer<typeof getCountriesSchema>): Promise<string>;
export declare const getLanguagesSchema: z.ZodObject<{
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
}, {
    raw?: boolean | undefined;
}>;
export declare function handleGetLanguages(params?: z.infer<typeof getLanguagesSchema>): Promise<string>;
export declare const getSkillsSchema: z.ZodObject<{
    id: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    id: string | string[];
    raw?: boolean | undefined;
}, {
    id: string | string[];
    raw?: boolean | undefined;
}>;
export declare function handleGetSkills(params: z.infer<typeof getSkillsSchema>): Promise<string>;
export declare const getDistrictsSchema: z.ZodObject<{
    area_id: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    raw?: boolean | undefined;
    area_id?: string | undefined;
}, {
    raw?: boolean | undefined;
    area_id?: string | undefined;
}>;
export declare function handleGetDistricts(params?: z.infer<typeof getDistrictsSchema>): Promise<string>;
