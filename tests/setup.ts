/**
 * Test preload: expected tool errors and retry warnings are exercised on
 * purpose throughout the suite. Keeping the logger silent here means real
 * failures are not buried under that noise.
 */
process.env["SKILLS_LOG_LEVEL"] = "silent";
