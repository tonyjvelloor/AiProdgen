// Gemini model ids, in one place. Google retires models on a schedule
// (https://ai.google.dev/gemini-api/docs/deprecations): gemini-2.0-flash shut
// down on 2026-06-01 and gemini-2.5-flash-image shuts down on 2026-10-02, and
// the 2.5 family is limited to existing users for new projects -- so a new
// customer's own key could not use it. Every call site reads these instead of
// hardcoding an id.
//
// Env-overridable so the image model can be switched (e.g. to the full
// gemini-3.1-flash-image) without a code change.
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-lite-image';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';

module.exports = { GEMINI_IMAGE_MODEL, GEMINI_TEXT_MODEL };
