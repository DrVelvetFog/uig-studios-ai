/**
 * Token accounting for context-window budgeting.
 *
 * Why this exists: compaction fires at 70% / 85% of num_ctx, so an undersized token
 * estimate means we compact AFTER the context has already overflowed and Ollama has
 * silently dropped the head of the conversation. Overestimating only costs us an
 * early (cheap) compaction. The error is therefore asymmetric, and the estimator is
 * biased accordingly.
 *
 * The old estimate was a flat chars/4. Measured on this machine against real
 * prompt_eval_count (qwen2.5-coder:14b), that underestimates badly on exactly the
 * content an agent loop accumulates:
 *
 *     prose  1.12x   markdown 0.89x   jsx 0.82x
 *     rust   0.92x   json     0.59x   jsonl 0.59x     (estimate / actual)
 *
 * Fitting a smarter static heuristic was tried and abandoned — punctuation/word/
 * whitespace features could not separate Rust (overestimated) from JSON (underestimated)
 * on a real corpus, and 6 samples is not enough to fit more features without overfitting.
 *
 * So: don't guess, measure. Every Ollama response's final ndjson chunk carries
 * prompt_eval_count — the exact token count of the prompt we just sent. Feeding that
 * back gives a per-model chars-per-token ratio that self-corrects for both the model's
 * tokenizer and the user's actual content mix. Ollama has no /api/tokenize endpoint to
 * ask directly (404 on 0.32.5; proposed upstream in ollama/ollama#12030) — if that ever
 * lands, it can replace charsPerToken() outright without touching callers.
 */

/** Cold-start ratio, used until a model has been observed once. Deliberately below the
 *  ~3.3-3.7 of code/markdown so a first request errs toward compacting early. */
export const DEFAULT_CHARS_PER_TOKEN = 3.0;

/** Observed ratios outside this range are junk (a truncated response, a bad count) and
 *  would poison the average — 2.0 is denser than any measured sample, 5.0 sparser. */
const MIN_CPT = 2.0;
const MAX_CPT = 5.0;

/** Estimates come out ~10% high. See the asymmetry note above. */
const SAFETY = 0.9;

/**
 * EMA weights on the newest observation, deliberately asymmetric.
 *
 * A sample denser than our current belief (fewer chars per token) means we have been
 * UNDER-counting — the dangerous direction — so believe it almost immediately. A
 * sparser sample only means we are being over-cautious, so ease toward it. Measured
 * over a mixed markdown -> code -> jsonl session, symmetric easing still undershot by
 * 17% on the turn where content shifted; asymmetric easing removes that lag.
 */
const ALPHA_DENSER  = 0.6;
const ALPHA_SPARSER = 0.2;

const observed = new Map();

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Chars-per-token currently assumed for `model`, safety margin already applied. */
export function charsPerToken(model) {
  const cpt = observed.get(model);
  return (cpt === undefined ? DEFAULT_CHARS_PER_TOKEN : cpt) * SAFETY;
}

/** Estimated prompt tokens for the given text parts. Falsy parts count as empty. */
export function estimateTokens(model, ...textParts) {
  const chars = textParts.reduce((sum, t) => sum + (t || "").length, 0);
  return Math.ceil(chars / charsPerToken(model));
}

/**
 * Fold one ground-truth measurement into `model`'s ratio.
 * `promptChars` must be the char count of everything sent (system + history), and
 * `promptTokens` the prompt_eval_count the model reported for it.
 * Returns the new raw ratio, or null if the sample was unusable.
 */
export function observeTokenRatio(model, promptChars, promptTokens) {
  if (!model || !(promptChars > 0) || !(promptTokens > 0)) return null;
  const sample = clamp(promptChars / promptTokens, MIN_CPT, MAX_CPT);
  const prev   = observed.get(model);
  if (prev === undefined) { observed.set(model, sample); return sample; }
  const alpha = sample < prev ? ALPHA_DENSER : ALPHA_SPARSER;
  const next  = prev * (1 - alpha) + sample * alpha;
  observed.set(model, next);
  return next;
}

/** Plain object for persistence. */
export function serializeTokenRatios() {
  return Object.fromEntries(observed);
}

/** Restore persisted ratios. Ignores anything malformed or out of range. */
export function loadTokenRatios(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const [model, cpt] of Object.entries(obj)) {
    if (typeof cpt === "number" && cpt >= MIN_CPT && cpt <= MAX_CPT) observed.set(model, cpt);
  }
}

/** Test seam. */
export function resetTokenRatios() {
  observed.clear();
}
