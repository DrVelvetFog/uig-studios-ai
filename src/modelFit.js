// ── Hardware-aware model fit ("Cookbook lite") ───────────────────────────────
// Pure module — estimates whether a local model runs well on this machine and
// the largest context window it can afford, from on-disk model size and RAM.
//
// Calibrated against measurements on the 16GB M1 (2026-06-10):
//   devstral:24b (14.3GB)            → 0.1 tok/s at any ctx   → RED
//   qwen2.5-coder:14b (9.0GB) @ 32K  → 0.5 tok/s (swap)       → must clamp
//   qwen2.5-coder:14b (9.0GB) @ 16K  → 5.5 tok/s              → GREEN
//   hermes3:8b (4.7GB) @ 32K         → fine                   → GREEN
//
// Model: memory needed ≈ weights + KV cache, where KV at 16K ≈ ⅓ of weights
// for modern GQA models, scaling linearly with context. Usable memory =
// RAM − OS/app headroom. Crude, but it reproduces every measurement above.

const OS_HEADROOM_BYTES = 3e9;          // macOS + TonyAI + WebKit working set
const KV_RATIO_AT_16K   = 1 / 3;        // KV cache ≈ weights/3 at 16K ctx
const CTX_STEPS         = [32768, 16384, 8192];

export function memoryNeeded(modelBytes, ctx) {
  return modelBytes + modelBytes * KV_RATIO_AT_16K * (ctx / 16384);
}

// Returns { level: "green"|"yellow"|"red", maxCtx: number|null, detail: string }
export function modelFit(modelBytes, ramBytes) {
  if (!modelBytes || !ramBytes) {
    return { level: "green", maxCtx: CTX_STEPS[0], detail: "size unknown — assuming it fits" };
  }
  const usable = ramBytes - OS_HEADROOM_BYTES;
  const maxCtx = CTX_STEPS.find(ctx => memoryNeeded(modelBytes, ctx) <= usable) ?? null;

  const gb = (n) => (n / 1e9).toFixed(1);
  if (maxCtx === null) {
    return {
      level: "red", maxCtx: null,
      detail: `won't run well: needs ~${gb(memoryNeeded(modelBytes, 8192))}GB at even 8K context, ~${gb(usable)}GB usable`,
    };
  }
  if (maxCtx >= 16384) {
    return {
      level: "green", maxCtx,
      detail: `fits at up to ${maxCtx / 1024}K context (~${gb(memoryNeeded(modelBytes, maxCtx))}GB of ~${gb(usable)}GB usable)`,
    };
  }
  return {
    level: "yellow", maxCtx,
    detail: `tight: only ${maxCtx / 1024}K context fits (~${gb(memoryNeeded(modelBytes, maxCtx))}GB of ~${gb(usable)}GB usable)`,
  };
}

export const FIT_DOT = { green: "🟢", yellow: "🟡", red: "🔴" };
