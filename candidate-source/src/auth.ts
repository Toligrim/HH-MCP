/** Shared auth gate for employer/ATS tools that need HH_ACCESS_TOKEN. */

export const EMPLOYER_TOKEN_NOTE =
  "Requires an EMPLOYER OAuth token (HH_ACCESS_TOKEN). Applicant/anonymous tokens get 403. Set HH_ACCESS_TOKEN and use validate_token to confirm your token's role.";

export const RESUME_ACCESS_NOTE =
  "Resume search requires an EMPLOYER OAuth token (HH_ACCESS_TOKEN) AND a paid hh.ru resume-database subscription. Applicant/anonymous tokens get 403. Set HH_ACCESS_TOKEN and use validate_token to confirm your token's role.";

/**
 * Fail fast when HH_ACCESS_TOKEN is missing.
 * Pass RESUME_ACCESS_NOTE for resume-database tools; default is the general employer note (ATS/negotiations).
 */
export function requireToken(note: string = EMPLOYER_TOKEN_NOTE): void {
  if (!process.env.HH_ACCESS_TOKEN) {
    throw new Error(`HH_ACCESS_TOKEN is not set. ${note}`);
  }
}
