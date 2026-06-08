/**
 * Auto-router: classify a user prompt into a TonyAI mode.
 * Pure function — no side effects, no imports.
 * Returned values: "image" | "arb" | "sui" | "python" | "code" | "chat"
 */
export function classifyPrompt(prompt) {
  const p = prompt.toLowerCase();

  const hasLang =
    /\b(?:typescript|javascript|react|next\.?js|vue|svelte|rust|golang|java\b|c\+\+|swift|kotlin|php|ruby|solidity|html|css|node\.?js)\b/i.test(p);

  const hasProgrammingObject =
    /\b(?:write|create|make|build|implement|code)\s+(?:a |an |the |my )?.{0,40}?\b(?:function|class|component|module|hook|method|algorithm|endpoint|script|program|unit test|sort|search|hash|cache|queue|stack|tree|graph|parser|data structure)\b/i.test(p);

  // ── Image — strong signals (always image) ─────────────────────────────────
  if (/\b(?:photorealistic|cinematic shot|oil painting|watercolor|digital art|concept art|anime style|hdr photo|neon city|fantasy landscape|8k render)\b/i.test(p) ||
      /\bstyle of\b.{0,30}\b(?:monet|picasso|van gogh|rembrandt|anime|pixar|ghibli)\b/i.test(p)) {
    return "image";
  }
  // ── Image — weak signals (skip when programming context present) ──────────
  if (!hasLang && !hasProgrammingObject &&
      (/\b(?:image|photo|picture)\s+of\b/i.test(p) ||
       /\b(?:generate|draw|create|make|render|paint|design|visualize|illustrate)\s.{0,50}\b(?:image|picture|photo|illustration|artwork|portrait|scene|wallpaper|logo|icon|poster)\b/i.test(p))) {
    return "image";
  }

  // ── Arb bot ───────────────────────────────────────────────────────────────
  if (/\b(?:flash.?loan|flash.?exec|arb.?bot|arbitrag|pairs\.ts|monitor\.ts|flash.?executor|navi.?flash|sui.?arb)\b/i.test(p) ||
      /\b(?:turbos|bluefin|cetus|momentum)\b.{0,40}\b(?:swap|pool|route|pair|arb|dex|liquidity)\b/i.test(p) ||
      /\bNAVI_PKG\b|\bNAVI_STORAGE\b|\bflash_loan_with_ctx|\bflash_repay\b/i.test(p) ||
      /\b(?:pm2 restart|smoke test|trade.?in.?flight|circuit breaker|daily.?loss.?cap)\b/i.test(p)) {
    return "arb";
  }

  // ── Sui / Move ────────────────────────────────────────────────────────────
  if (/\b(?:move module|sui object|ptb|programmable.?transactions?|hot potato|sui nft|move struct|tx_context|has key|has store|has copy|has drop|transfer::transfer|sui::object|object::new|init\s*\(|one.?time.?witness|otw)\b/i.test(p) ||
      /\b(?:sui blockchain|move lang(?:uage)?|sui smart contract|sui defi|sui wallet|sui token|sui coin|sui package|sui framework)\b/i.test(p)) {
    return "sui";
  }

  // ── Python ────────────────────────────────────────────────────────────────
  if (/\bpython\b/i.test(p) ||
      /\b(?:pandas|numpy|asyncio|pydantic|dataclass|pytest|django|flask|fastapi|sqlalchemy|celery|poetry|pip install|\.py\b|type hints?|f-string|list comprehension|decorator)\b/i.test(p)) {
    return "python";
  }

  // ── Generic code ──────────────────────────────────────────────────────────
  if (hasLang || hasProgrammingObject ||
      /\b(?:debug|refactor|api endpoint|webhook|sql query|docker|kubernetes|ci\/cd|github action|webpack|babel|vite|eslint|jest|npm|yarn|pnpm)\b/i.test(p) ||
      /\b(?:bug|error|exception|stack trace|null pointer|segfault|type error)\b/i.test(p)) {
    return "code";
  }

  return "chat";
}
