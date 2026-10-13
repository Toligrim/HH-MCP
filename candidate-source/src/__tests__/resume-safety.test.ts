import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accessErrorFrom403,
  classify403,
  HhAccessError,
} from "../hhErrors.js";
import { buildResumePath, getResumeSchema } from "../tools/resumes.js";
import {
  readResumeCache,
  writeResumeCache,
  formatCacheNote,
} from "../resumeCache.js";
import { applyToolFilter, parseToolsCliArgs } from "../toolsFilter.js";
import { DEFAULT_TOOL_COUNT, DEFAULT_TOOL_NAMES } from "../index.js";
import { summarizeUsage, appendLedger } from "../requestLog.js";

const CAPTCHA_BODY = `{
  "description": "Forbidden",
  "errors": [
    {
      "value": "captcha_required",
      "fallback_url": "https://hh.ru/resume/x?captcha=true",
      "captcha_url": "https://hh.ru/account/captcha?state=1",
      "type": "employer_resume_view"
    }
  ],
  "request_id": "1790264024790e25aa9eaf6d36496003"
}`;

describe("hhErrors / captcha classification", () => {
  it("classifies the incident captcha body", () => {
    const { kind, details } = classify403(CAPTCHA_BODY);
    expect(kind).toBe("captcha");
    expect(details.requestId).toBe("1790264024790e25aa9eaf6d36496003");
    expect(details.fallbackUrl).toMatch(/captcha=true/);
    const err = accessErrorFrom403(CAPTCHA_BODY);
    expect(err).toBeInstanceOf(HhAccessError);
    expect(err.message).toMatch(/капчу/);
    expect(err.message).not.toMatch(/scope/);
    expect(err.toStructured().hh).toMatchObject({
      kind: "captcha",
      request_id: "1790264024790e25aa9eaf6d36496003",
    });
  });

  it("classifies oauth bad_authorization as auth, not scope", () => {
    const body = JSON.stringify({
      errors: [{ type: "oauth", value: "bad_authorization" }],
      request_id: "rq-oauth",
    });
    const err = accessErrorFrom403(body);
    expect(err.kind).toBe("auth");
    expect(err.message).toMatch(/токен недействителен/);
    expect(err.message).toMatch(/bad_authorization/);
    expect(err.message).not.toMatch(/scope/);
  });

  it("hedges unparseable 403 as unknown", () => {
    expect(classify403("<<<not-json").kind).toBe("unknown");
  });
});

describe("buildResumePath / getResumeSchema", () => {
  it("keeps unscoped path byte-identical when no topic", () => {
    expect(buildResumePath("abc123").path).toBe("/resumes/abc123");
  });

  it("adds topic_id and vacancy_id in order", () => {
    expect(buildResumePath("abc", "10", "20").path).toBe(
      "/resumes/abc?topic_id=10&vacancy_id=20",
    );
    expect(buildResumePath("abc", "10").path).toBe("/resumes/abc?topic_id=10");
  });

  it("warns when vacancy_id alone", () => {
    const r = buildResumePath("abc", undefined, "20");
    expect(r.path).toBe("/resumes/abc");
    expect(r.warning).toMatch(/vacancy_id ignored/);
  });

  it("rejects non-numeric topic_id", () => {
    expect(() =>
      getResumeSchema.parse({ resume_id: "abc", topic_id: "nope" }),
    ).toThrow();
  });
});

describe("resume cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-cache-"));
    process.env.HH_CACHE_DIR = dir;
    process.env.HH_CACHE_TTL_MS = "86400000";
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.HH_CACHE_DIR;
    delete process.env.HH_CACHE_TTL_MS;
  });

  it("hits after a miss and keeps scopes separate", () => {
    expect(readResumeCache({ resumeId: "r1" })).toBeNull();
    writeResumeCache({
      resumeId: "r1",
      pathUsed: "/resumes/r1",
      payload: { id: "r1" },
    });
    expect(readResumeCache({ resumeId: "r1" })?.payload).toEqual({ id: "r1" });
    writeResumeCache({
      resumeId: "r1",
      topicId: "9",
      pathUsed: "/resumes/r1?topic_id=9",
      payload: { id: "r1", scoped: true },
    });
    expect(readResumeCache({ resumeId: "r1" })?.payload).toEqual({ id: "r1" });
    expect(readResumeCache({ resumeId: "r1", topicId: "9" })?.payload).toEqual({
      id: "r1",
      scoped: true,
    });
    expect(formatCacheNote(Date.now())).toMatch(/из кэша/);
  });
});

describe("tools filter", () => {
  const sample = [
    { name: "get_resume", group: "resumes" },
    { name: "get_resumes", group: "batch", groups: ["resumes"] },
    { name: "list_applications", group: "negotiations" },
    { name: "hh_usage_report", group: "diagnostics" },
    { name: "validate_token", group: "validate_token" },
  ];

  it("allowlists groups and fails on unknown", () => {
    const r = applyToolFilter(sample, { allow: "negotiations,resumes,batch" });
    expect(r.tools.map((t) => t.name).sort()).toEqual(
      ["get_resume", "get_resumes", "list_applications"].sort(),
    );
    expect(() => applyToolFilter(sample, { allow: "nope" })).toThrow(/Unknown/);
  });

  it("parses CLI --tools", () => {
    const p = parseToolsCliArgs(["--http", "--tools", "batch,diagnostics", "x"]);
    expect(p.tools).toBe("batch,diagnostics");
    expect(p.rest).toEqual(["--http", "x"]);
  });
});

describe("default tool surface", () => {
  it("is 55 tools with stable new names", () => {
    expect(DEFAULT_TOOL_COUNT).toBe(55);
    expect(DEFAULT_TOOL_NAMES).toContain("get_resumes");
    expect(DEFAULT_TOOL_NAMES).toContain("collect_vacancy_resumes");
    expect(DEFAULT_TOOL_NAMES).toContain("hh_usage_report");
    expect(DEFAULT_TOOL_NAMES.indexOf("get_resume")).toBeLessThan(
      DEFAULT_TOOL_NAMES.indexOf("get_resumes"),
    );
  });
});

describe("ledger usage report", () => {
  let file: string;
  beforeEach(() => {
    file = path.join(os.tmpdir(), `hh-ledger-${process.pid}.jsonl`);
    process.env.HH_LEDGER_FILE = file;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  afterEach(() => {
    delete process.env.HH_LEDGER_FILE;
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  });

  it("summarizes ok/captcha from ledger fixture", () => {
    for (let i = 0; i < 85; i++) {
      appendLedger({ resume_id: `r${i}`, status: "ok" });
    }
    for (let i = 0; i < 144; i++) {
      appendLedger({ resume_id: `c${i}`, status: "captcha", kind: "captcha" });
    }
    const u = summarizeUsage();
    expect(u.okCount).toBe(85);
    expect(u.captchaCount).toBe(144);
  });
});
