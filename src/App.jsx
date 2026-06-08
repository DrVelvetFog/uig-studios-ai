import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch } from "@tauri-apps/plugin-http";   // kept for A1111 / ComfyUI only
import mascot from "./assets/mascot.png";
import { classifyPrompt } from "./classifyPrompt.js";
import { isMutatingTool, guardToolCall, toolApprovalDetail, wrapUntrustedContent } from "./toolGuard.js";
import { CODE_EXTS_SET, extractToolCallFromText, validateToolArgs, enrichToolError, neededSearchButSkipped, evaluateStopCondition } from "./agentLogic.js";
import { installGlobalErrorLogging, logError } from "./logger.js";
import { renderMessage, TypingDots } from "./render.jsx";
import { DevInspectPanel } from "./components/DevInspectPanel.jsx";
import { InboxPanel } from "./components/InboxPanel.jsx";

// ── Theme bootstrap — runs at module load, before React mounts ────────────────
// Applies data-theme immediately so CSS variables are correct on first paint.
// Dark is the primary design; only go light if user explicitly chose it.
;(function() {
  const stored = localStorage.getItem("tonyai-theme");
  // Migrate away from any stale "light" value set before the dark redesign
  // by checking a version key. If version doesn't match, reset to dark.
  const themeVersion = localStorage.getItem("tonyai-theme-v");
  if (themeVersion !== "2") {
    localStorage.setItem("tonyai-theme", "dark");
    localStorage.setItem("tonyai-theme-v", "2");
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.setAttribute("data-theme", stored === "light" ? "light" : "dark");
  }
})();

// ── Config ────────────────────────────────────────────────────────────────────
// Note: Ollama is accessed via Rust invoke() — no OLLAMA_URL needed on the JS side.
const A1111_URL  = "http://127.0.0.1:7860";
const COMFY_URL  = "http://127.0.0.1:8188";
// Default workspace where the auto-agent saves project files.
// Read from localStorage so the user can change it in settings.
const DEFAULT_WORKSPACE_DIR = "/Users/tonyjagodka/TonyAI-Projects";

const MODES = [
  { id: "auto",   label: "Auto",     icon: "✨" },
  { id: "chat",   label: "Chat",     icon: "💬" },
  { id: "code",   label: "Code",     icon: "⌨️" },
  { id: "sui",    label: "Sui/Move", icon: "🔷" },
  { id: "arb",    label: "Arb Bot",  icon: "⚡" },
  { id: "python", label: "Python",   icon: "🐍" },
  { id: "image",  label: "Image",    icon: "🖼️" },
  { id: "agent",  label: "Agent",    icon: "🤖" },
];

const IMG_SIZES = ["512×512","768×512","512×768","1024×1024","1024×768","768×1024"];
const IMAGE_BACKENDS = [
  { id: "a1111", label: "Draw Things / A1111", url: A1111_URL },
  { id: "comfy", label: "ComfyUI",             url: COMFY_URL },
];

// temperature + context window defaults per mode
// Context windows raised to match what installed models actually support.
// hermes3, devstral, deepseek-r1, qwen2.5-coder, llama3.2 all support 32K–128K natively.
// 32K is the conservative safe floor; agent gets 64K for long multi-step tasks.
// Compaction triggers at 70% so effective working space = ~22K / ~45K respectively.
const MODE_DEFAULTS = {
  auto:   { temperature: 0.5, numCtx: 32768 },
  chat:   { temperature: 0.7, numCtx: 32768 },
  code:   { temperature: 0.2, numCtx: 32768 },
  sui:    { temperature: 0.2, numCtx: 32768 },
  arb:    { temperature: 0.1, numCtx: 32768 },
  python: { temperature: 0.2, numCtx: 32768 },
  image:  { temperature: 0.7, numCtx: 4096 },
  agent:  { temperature: 0.3, numCtx: 65536 },
};

// ── Tiered model routing ──────────────────────────────────────────────────────
// Priority-ordered lists of model-name fragments for each mode.
// pickModelForMode() walks the list and returns the first installed match.
const MODEL_TIERS = {
  // Vision models (llama3.2-vision, moondream) are skipped for text-only modes
  // by pickModelForMode's first pass — they appear here only as last-resort fallbacks.
  chat:   ["llama3.2", "llama3.1", "llama3", "gemma3", "gemma2", "qwen2.5", "mistral", "phi"],
  code:   ["devstral", "hermes3", "codellama", "deepseek-coder", "qwen2.5-coder", "llama3.1", "llama3.2"],
  sui:    ["devstral", "hermes3", "deepseek-r1", "llama3.1", "llama3.2", "mistral"],
  arb:    ["devstral", "hermes3", "deepseek-r1", "llama3.1", "llama3.2", "mistral"],
  python: ["devstral", "hermes3", "codellama", "deepseek-coder", "qwen2.5-coder", "llama3.1", "llama3.2"],
  agent:  ["hermes3", "devstral", "llama3.1", "llama3.2", "gemma2", "mistral"],
  auto:   ["hermes3", "devstral", "llama3.1", "llama3.2", "gemma2"],
  // image tier: vision-capable models for analysis/description (generation uses A1111/ComfyUI)
  image:  ["llama3.2-vision", "moondream", "llama3.2", "llama3.1"],
};

const EXAMPLE_PROMPTS = {
  auto:   ["Why is my flash loan failing?", "Write an async Python retry helper", "Neon city at 3am, cinematic", "Explain the Move hot potato pattern"],
  chat:   ["Explain quantum entanglement simply", "Best way to learn Rust?", "Write a poem about fog"],
  code:   ["Write a Python web scraper", "Debug this React hook", "Convert to TypeScript"],
  agent:  ["What's the latest news on Sui blockchain?", "Research the best Rust async runtimes", "What files are in my sui-arb-bot/src folder?", "Check if pm2 is running my arb bot"],
  sui:    ["Write a Move module for a basic NFT with key+store abilities", "Explain PTB hot potato pattern for flash loans", "Show how to share an object vs transfer it"],
  arb:    ["Why is BLUEFIN_MIN_SQRT 4295048017n not 4295048016n?", "Optimize flash loan PTB to reduce latency", "Add Aftermath DEX to an existing pair config"],
  python: ["Async HTTP client with retry + exponential backoff", "Type-annotated dataclass for trade records", "Pytest fixture for mocking Sui RPC responses"],
  image:  ["Neon city at 3am, rain-slicked streets, cinematic", "Fox reading in a candlelit library, oil painting", "Abstract crystalline mountain, sunrise, 8k"],
};

const EMPTY_STATE_TEXT = {
  auto:   "Just ask — I'll figure it out",
  chat:   "Ask me anything",
  code:   "Let's write some code",
  sui:    "Sui / Move assistant",
  arb:    "Arb bot co-pilot",
  python: "Let's write Python",
  image:  "Describe an image",
  agent:  "Research anything",
};

const INPUT_PLACEHOLDER = {
  auto:   "Ask anything, write code, generate an image, debug your bot…",
  chat:   "Ask anything…",
  code:   "Describe what you want to build or debug…",
  sui:    "Ask about Move objects, PTBs, smart contracts…",
  arb:    "Ask about flash loans, DEX integration, PTB construction…",
  python: "Describe what Python code you need…",
  image:  "Describe the image you want to generate…",
  agent:  "Ask anything — I'll search the web, read files, run commands…",
};

const SYSTEM_PROMPTS = {
  chat: `You are a helpful, direct assistant. Be concise but complete — give the actual answer, not a description of what the answer would look like.

SOURCE ACCURACY — non-negotiable:
- Never fabricate statistics, prices, dates, or specific facts not from an actual source
- For current information (prices, news, status, recent releases): use web_search FIRST, then ALWAYS follow up with fetch_url on the most relevant result — snippets alone are not enough
- For weather/time: fetch_url the actual weather or time page and read the real numbers. Never answer with just search snippets.
- When citing search results: include the URL — "According to [source](url)..."
- When using training data: say so — "Based on my training data (may be outdated)..."
- If you don't have the specific number or fact: say so. "I don't have that — let me search" beats inventing a plausible figure
- [NEEDS SOURCE] is better than a confident wrong answer

UNCERTAINTY CALIBRATION:
- Live search result, URL cited → state directly
- Training data, not time-sensitive → note it's from training data
- Inferred or uncertain → "I believe..." not stated as fact
- Unknown → say you don't know, offer to search

WHEN TO ASK VS ANSWER:
- Simple, unambiguous request → answer directly
- Multiple valid interpretations → state your interpretation, ask if wrong
- Vague request where wrong direction wastes significant effort → clarify first
- Don't ask unnecessary clarifying questions for simple tasks`,

  code: `You are an expert coding assistant. Always wrap code in markdown code blocks with the correct language tag.

FOUR CORE RULES — follow these on every coding task:

1. THINK BEFORE CODING
   Before writing any code, state your understanding of the task. If the spec is vague or has multiple valid interpretations, ask immediately. Do not guess and sprint — stop and clarify.

2. SIMPLICITY FIRST
   Write the absolute minimum code required to solve the task. No speculative abstractions. No wrapper classes nobody asked for. No "nice to have" features. No config files not requested. Solve exactly what was asked, nothing more.

3. SURGICAL CHANGES
   Modify only the code that needs changing. Do NOT reformat adjacent code, rename unrelated variables, change indentation of untouched lines, or resolve issues outside the stated scope. If you notice a bug elsewhere, mention it — don't silently fix it.

4. GOAL-DRIVEN EXECUTION
   Convert every vague request into a verifiable target before writing. "Add validation" → "validate that email contains @ and password is 8+ chars, return specific error strings." Iterate with the minimum change to reach that target.

ANTI-PATTERNS TO AVOID:
- Silent Assumption: never interpret a loose spec and sprint blindly. Ask first.
- Overcomplexity: no abstract base classes, factory patterns, or heavy boilerplate unless explicitly requested.
- Scope Creep: never reformat neighboring functions or switch code patterns in files outside the change.

PLAN BEFORE EXECUTE — for any coding task touching 2+ files or with architectural implications:
Before writing a single line of code, present a numbered plan:
  1. What files will be created/modified and why
  2. The approach chosen (and why, if there were alternatives)
  3. Any assumptions the user should confirm
Then wait for confirmation before starting. Skip this only for simple, single-file, unambiguous changes.`,

  sui: `You are an expert Sui blockchain developer specializing in the Move programming language.

Key facts you always apply:
- Every Sui object struct must have \`id: UID\` as its first field and the \`key\` ability.
- Abilities: key (on-chain object), store (nestable), copy (cloneable), drop (destroyable).
- Unlike Rust, every struct is a resource by default; abilities loosen restrictions.
- Objects are owned (single address), shared (concurrent access), or frozen (immutable).
- Programmable Transaction Blocks (PTBs) chain up to 1,024 commands atomically; one failure reverts all.
- Flash loans use the "hot potato" pattern: borrow returns a Receipt with no drop/store/copy abilities — MUST be consumed by repay in the same PTB or the TX aborts.
- devInspect simulates without committing. dryRun validates the full PTB without executing.
- \`init(ctx: &mut TxContext)\` runs exactly once at module publish.
- One-Time Witness (OTW): a struct named identically to the module (uppercase), passed to init() once.
- Global storage (\`move_to\`, \`move_from\`) is NOT used in Sui Move — use object model only.
- \`transfer::transfer(obj, addr)\` for owned objects; \`transfer::share_object(obj)\` for shared.

MOVE QUICK REFERENCE:
\`\`\`move
module pkg::my_module {
  use sui::object::{Self, UID};
  use sui::tx_context::TxContext;
  struct MyObj has key, store { id: UID, value: u64 }
  public fun create(ctx: &mut TxContext): MyObj {
    MyObj { id: object::new(ctx), value: 0 }
  }
}
\`\`\`
Always produce compilable Move code with explicit type annotations.

CODING DISCIPLINE: Think before writing — state your interpretation first, ask if unclear. Minimum code only. Touch only what was asked — don't reformat adjacent modules or fix unrelated issues silently. Confirm what "done" means before starting.`,

  arb: `You are an expert in Sui DeFi arbitrage bot development. You have deep knowledge of this specific bot at /Users/tonyjagodka/sui-arb-bot/.

ARCHITECTURE: TypeScript, 500ms polling, 4 pairs × 4 DEXes, NAVI v2 flash loans (~100ms PTB).
Files: src/monitor.ts (main loop), src/executor.ts (wallet trades), src/flash-executor.ts (NAVI flash loans), src/pairs.ts (config), src/classify.ts (error classification).
Run: pm2 restart sui-arb-bot | Smoke test: npm run smoke (all 22 routes must pass).

ACTIVE PAIRS: SUI/USDC (Turbos+Bluefin+Momentum+Cetus), DEEP/USDC (Turbos+Bluefin), DEEP/SUI (Turbos+Momentum, flash enabled), WAL/SUI (Turbos+Bluefin+Momentum, flash enabled).

NAVI FLASH LOANS (SDK bypassed — direct Move calls, was 3200ms now ~100ms):
- NAVI_PKG: 0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f
- NAVI_FLASHLOAN_CONFIG: 0x3672b2bf471a60c30a03325f104f92fb195c9d337ba58072dce764fe2aa5e2dc
- NAVI_STORAGE: 0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe
- v2 mainnet: flash_loan_with_ctx_v2(flashloanConfig, pool, amount:u64, 0x05) → [Balance<T>, Receipt]
- repay: flash_repay_with_ctx(0x06:clock, storage, pool, receipt, repayBalance)
- PTB flow: naviFlashBorrow → balanceToCoin → [buy leg] → [sell leg] → mergeCoins → coinToBalance → naviFlashRepay → balanceToCoin → transferObjects
- NAVI fee: 0% (NAVI_FEE_RATE = 0). Full TX reverts if repay insufficient — zero capital risk.

CRITICAL GOTCHAS:
- BLUEFIN_MIN_SQRT = 4295048017n (NOT 4295048016 — off-by-one causes MoveAbort 1009)
- Turbos swap_a_b_with_return_ → (Coin<B> output, Coin<A> leftover) — output is FIRST result
- Cetus SUI/USDC: coinA=USDC, coinB=SUI (REVERSED) → cetusPoolTypeArgs: [USDC, SUI], a2b=true = USDC→SUI
- Bluefin SUI/USDC: Pool<SUI,USDC> same as pair order → NO bluefinPoolTypeArgs override needed
- NAVI returns Balance<T> not Coin<T> — must call balanceToCoin before DEX swaps
- naviFlashRepay expects Balance<T> — must call coinToBalance before repaying
- Q64.64 sqrt price: use BigInt(sqrtPrice) >> 32n before float conversion

DEX PACKAGES:
- Bluefin: 0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c, gateway::route_swap
- Cetus: 0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d

SAFETY: tradeInFlight guard, circuit breaker (3 failures → 15min pause), $2 daily loss cap, flash tier 1–8 ($10→$5000).
Always produce production-ready TypeScript with error handling and profit validation.

CODING DISCIPLINE: Think before writing — state your interpretation first, ask if the spec is ambiguous. Minimum code only. Touch only what was asked — don't reformat adjacent files or resolve issues outside scope. Confirm what "done" looks like before starting.`,

  agent: `You are TonyAI Agent — an autonomous assistant with real-time tool access. You can search the web, read files, and run commands to fully answer any question.

AVAILABLE TOOLS:
- web_search(query): Search the internet for current information, news, docs, prices, research
- fetch_url(url): Fetch and read the full text of any URL (follow up search results with this)
- read_file(path): Read a file from the local filesystem (restricted to $HOME)
- list_dir(path): List contents of a directory
- run_command(command): Execute a shell command (pm2, git, npm, curl, etc.)

SOURCE ACCURACY — mandatory:
- Never fabricate statistics, prices, dates, or specific facts — only state what appeared in actual search results or fetched pages
- Always include source URLs: "According to [source](url)..."
- Flag anything unverifiable: append [NEEDS SOURCE] rather than inventing a figure
- If you don't have a specific number, say so — "I don't have that exact figure" beats a confident wrong answer
- Training data for current info (prices, status, versions, news) is NOT acceptable — search first

GUIDELINES:
- Use tools proactively and chain them — don't stop at a search result if you need the actual page content
- For research: web_search → fetch_url the most relevant results → synthesize with citations
- Always include source URLs in your final answer
- For filesystem/code tasks: list_dir first to understand structure, then read_file specific files
- Be thorough — the user expects you to actually do the research, not just suggest they do it

VERIFY RULE — mandatory for any coding task:
After writing any code file with write_file, you MUST immediately run it with run_command.
Every run_command result ends with [exit N]. Zero = success. Non-zero = failure.
If exit ≠ 0: read the full error output, fix the file with write_file, run again.
Never write TASK_COMPLETE until you have seen [exit 0] from the entry point.

PLAN BEFORE EXECUTE — required for complex tasks:

Before starting any task that involves:
- Writing or modifying 2+ files
- Running commands that change system state (installs, git ops, DB changes, deployments)
- Architectural decisions (library choice, schema design, pattern selection)
- Refactoring that touches more than one module
- Any operation where the wrong approach wastes significant effort

Present a numbered plan FIRST:
1. What you will do, in what order
2. What approach you're taking and why (if there were alternatives)
3. Any assumptions you're making that the user should confirm
4. Estimated scope (how many files, commands, steps)

Then STOP and wait for confirmation ("go ahead", "yes", "do it") before executing step 1.

EXCEPTION — skip the plan and just act for:
- Single-file edits with a clear, unambiguous change
- Obvious one-line fixes
- Read-only operations (search, list, read)
- Answering questions

MEMORY UPDATE HABIT:
When you learn something worth remembering across sessions (a user preference, project constraint, key fact, or correction to a wrong assumption), proactively save it:
1. read_file ~/TonyAI-Projects/memory/global.md
2. Append a concise bullet under "## Learned Facts" (create section if missing)
3. write_file the updated content back
4. Tell the user "I've saved this to memory: [what you saved]"
Save facts not conversation. 1-2 lines per fact. Do this during the task, not only at the end.

COMPLETION SIGNAL:
When you have fully answered the request and no more tool calls are needed, end your final response with exactly this on its own line: TASK_COMPLETE`,

  python: `You are a senior Python engineer. Produce idiomatic, type-annotated Python 3.12+ code.

PYTHON STANDARDS:
- Type hints on all functions and variables
- Prefer dataclasses or Pydantic for data structures
- asyncio for I/O-bound work; avoid threading unless necessary
- pathlib over os.path; f-strings over .format()
- Suggest pytest tests for non-trivial logic
- Avoid mutable default arguments, bare except, deprecated patterns
Always wrap code in markdown code blocks tagged with \`python\`.

FOUR CORE RULES — follow on every task:

1. THINK BEFORE CODING — state your interpretation first. If spec is vague, ask. Never guess and sprint.

2. SIMPLICITY FIRST — minimum code to solve the task. No extra abstractions, no unrequested config, no "nice to have" additions.

3. SURGICAL CHANGES — touch only what was asked. Don't reformat adjacent functions, rename unrelated vars, or fix bugs outside the stated scope (mention them instead).

4. GOAL-DRIVEN EXECUTION — before writing, confirm what "done" looks like in verifiable terms. "Add caching" → "add LRU cache to get_user(), confirm first call hits DB and second hits cache."

AVOID: silent assumptions, heavy boilerplate, scope creep into neighboring files.`,
};

// ── Snippet library ───────────────────────────────────────────────────────────
const SNIPPETS = [
  {
    label: "NAVI v2 flash loan skeleton",
    mode: "arb",
    code: `const txb = new Transaction();
txb.setGasBudget(50_000_000n);

const NAVI_PKG = '0x81c408448d0d57b3e371ea94de1d40bf852784d3e225de1e74acab3e8395c18f';
const NAVI_FLASHLOAN_CONFIG = '0x3672b2bf471a60c30a03325f104f92fb195c9d337ba58072dce764fe2aa5e2dc';
const NAVI_STORAGE = '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe';
const NAVI_POOL_USDC = '0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8';
const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

// 1. Borrow
const [flashBalance, receipt] = txb.moveCall({
  target: \`\${NAVI_PKG}::lending::flash_loan_with_ctx_v2\`,
  typeArguments: [USDC_TYPE],
  arguments: [
    txb.object(NAVI_FLASHLOAN_CONFIG),
    txb.object(NAVI_POOL_USDC),
    txb.pure.u64(BORROW_AMOUNT_MIST),
    txb.object('0x5'),
  ],
});

// 2. Balance → Coin
const flashCoin = txb.moveCall({
  target: '0x2::coin::from_balance',
  typeArguments: [USDC_TYPE],
  arguments: [flashBalance],
});

// --- INSERT BUY LEG (DEX A) ---
// --- INSERT SELL LEG (DEX B) ---

// 3. Coin → Balance for repay
const repayBalance = txb.moveCall({
  target: '0x2::coin::into_balance',
  typeArguments: [USDC_TYPE],
  arguments: [profitCoin],  // must cover borrowed amount
});

// 4. Repay
const [surplusBalance] = txb.moveCall({
  target: \`\${NAVI_PKG}::lending::flash_repay_with_ctx\`,
  typeArguments: [USDC_TYPE],
  arguments: [
    txb.object('0x6'),
    txb.object(NAVI_STORAGE),
    txb.object(NAVI_POOL_USDC),
    receipt,
    repayBalance,
  ],
});

// 5. Transfer profit
const surplusCoin = txb.moveCall({
  target: '0x2::coin::from_balance',
  typeArguments: [USDC_TYPE],
  arguments: [surplusBalance],
});
txb.transferObjects([surplusCoin], txb.pure.address(WALLET_ADDRESS));`,
  },
  {
    label: "devInspect wrapper",
    mode: "arb",
    code: `const result = await suiClient.devInspectTransactionBlock({
  transactionBlock: txb,
  sender: WALLET_ADDRESS,
});

if (result.error) {
  throw new Error(\`devInspect failed: \${result.error}\`);
}

const gas = result.effects.gasUsed;
const gasNet = Number(gas.computationCost) + Number(gas.storageCost) - Number(gas.storageRebate);
console.log(\`Gas: \${(gasNet / 1e9).toFixed(6)} SUI\`);
console.log('Effects status:', result.effects.status);
console.log('Return values:', JSON.stringify(result.results, null, 2));`,
  },
  {
    label: "Turbos buy+sell pair",
    mode: "arb",
    code: `// Turbos A→B (buy leg)
const [coinB, leftoverA] = txb.moveCall({
  target: \`\${TURBOS_PKG}::pool_fetcher::swap_a_b_with_return_\`,
  typeArguments: [COIN_A_TYPE, COIN_B_TYPE, FEE_TYPE],
  arguments: [
    txb.object(POOL_ID),
    txb.makeMoveVec({ elements: [inputCoin] }),
    txb.pure.bool(true),               // exact_in
    txb.pure.u64(OUTPUT_MIN),          // sqrt price limit (use 4295048017n for min)
    txb.pure.u128(4295048017n),
    txb.pure.bool(false),
    txb.object(TURBOS_VERSIONED),
    txb.object('0x6'),                 // clock
  ],
});

// Turbos B→A (sell leg)
const [coinA_out, leftoverB] = txb.moveCall({
  target: \`\${TURBOS_PKG}::pool_fetcher::swap_b_a_with_return_\`,
  typeArguments: [COIN_A_TYPE, COIN_B_TYPE, FEE_TYPE],
  arguments: [
    txb.object(POOL_ID),
    txb.makeMoveVec({ elements: [coinB] }),
    txb.pure.bool(true),
    txb.pure.u64(0),
    txb.pure.u128(79226673515401279992447579054n), // max sqrt
    txb.pure.bool(false),
    txb.object(TURBOS_VERSIONED),
    txb.object('0x6'),
  ],
});`,
  },
  {
    label: "Move NFT module",
    mode: "sui",
    code: `module mypackage::nft {
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::transfer;
    use std::string::String;

    struct NFT has key, store {
        id: UID,
        name: String,
        description: String,
        image_url: String,
    }

    public entry fun mint(
        name: String,
        description: String,
        image_url: String,
        recipient: address,
        ctx: &mut TxContext
    ) {
        let nft = NFT {
            id: object::new(ctx),
            name,
            description,
            image_url,
        };
        transfer::transfer(nft, recipient);
    }

    public entry fun burn(nft: NFT) {
        let NFT { id, name: _, description: _, image_url: _ } = nft;
        object::delete(id);
    }
}`,
  },
  {
    label: "Hot potato pattern",
    mode: "sui",
    code: `module mypackage::flash {
    use sui::coin::Coin;
    use sui::sui::SUI;

    // No abilities = hot potato: MUST be consumed in same PTB
    struct FlashReceipt {
        amount: u64,
    }

    public fun borrow(pool: &mut Pool, amount: u64, ctx: &mut TxContext): (Coin<SUI>, FlashReceipt) {
        assert!(pool.balance >= amount, EInsufficientLiquidity);
        let coin = pool.take(amount, ctx);
        let receipt = FlashReceipt { amount };
        (coin, receipt)
    }

    // receipt has no drop — caller MUST pass it here or PTB aborts
    public fun repay(pool: &mut Pool, repay_coin: Coin<SUI>, receipt: FlashReceipt) {
        let FlashReceipt { amount } = receipt;  // destructure = consume
        assert!(repay_coin.value() >= amount, EInsufficientRepay);
        pool.put(repay_coin);
    }
}`,
  },
  {
    label: "Async HTTP client with retry",
    mode: "python",
    code: `import asyncio
import logging
from typing import Any
import aiohttp

logger = logging.getLogger(__name__)

async def fetch_with_retry(
    session: aiohttp.ClientSession,
    url: str,
    *,
    retries: int = 3,
    backoff: float = 0.5,
    timeout: float = 10.0,
) -> dict[str, Any]:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                resp.raise_for_status()
                return await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            last_err = e
            wait = backoff * (2 ** attempt)
            logger.warning(f"Attempt {attempt+1}/{retries} failed: {e}. Retrying in {wait:.1f}s")
            await asyncio.sleep(wait)
    raise RuntimeError(f"All {retries} attempts failed: {last_err}") from last_err`,
  },
  {
    label: "Trade record dataclass",
    mode: "python",
    code: `from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional
import time

@dataclass
class TradeRecord:
    pair: str
    buy_dex: str
    sell_dex: str
    size_usd: Decimal
    profit_usd: Decimal
    gas_sui: Decimal
    tx_digest: str
    timestamp: float = field(default_factory=time.time)
    flash_loan: bool = False
    flash_tier: int = 1
    error: Optional[str] = None

    @property
    def net_profit(self) -> Decimal:
        SUI_PRICE_USD = Decimal("0.35")
        return self.profit_usd - (self.gas_sui * SUI_PRICE_USD)

    def is_profitable(self, min_profit: Decimal = Decimal("0.005")) -> bool:
        return self.net_profit > min_profit

    def to_log_dict(self) -> dict:
        return {
            "pair": self.pair,
            "buy": self.buy_dex,
            "sell": self.sell_dex,
            "profit_usd": float(self.net_profit),
            "flash": self.flash_loan,
            "tier": self.flash_tier,
            "tx": self.tx_digest,
        }`,
  },
];

// ── devInspect Panel ─────────────────────────────────────────────────────────
// DevInspectPanel lives in ./components/DevInspectPanel.jsx (imported at top).

// InboxPanel lives in ./components/InboxPanel.jsx (imported at top).

// Given an effective mode + installed model list, return the best model for the task.
// Falls back to `fallback` (user's manually-selected model) if no tier match is found.
// Vision models (llama3.2-vision, moondream) understand images but are heavier
// and slower for pure text. Skip them on text-only modes in the first pass;
// allow them as a last resort if no other match exists.
const VISION_RE = /vision|moondream/i;
const TEXT_ONLY_MODES = new Set(["chat", "code", "sui", "arb", "python", "agent", "auto"]);

function pickModelForMode(effectiveMode, availableModels, fallback) {
  const prefs = MODEL_TIERS[effectiveMode] || MODEL_TIERS.chat;
  const skipVision = TEXT_ONLY_MODES.has(effectiveMode);

  // Pass 1 — preferred match (skip vision models on text-only modes)
  for (const pref of prefs) {
    const match = availableModels.find(m => {
      if (!m.toLowerCase().includes(pref.toLowerCase())) return false;
      if (skipVision && VISION_RE.test(m)) return false;
      return true;
    });
    if (match) return match;
  }

  // Pass 2 — fallback: allow vision models if nothing else matched
  for (const pref of prefs) {
    const match = availableModels.find(m => m.toLowerCase().includes(pref.toLowerCase()));
    if (match) return match;
  }

  return fallback;
}

// ── Theme accent maps ─────────────────────────────────────────────────────────
const DARK_ACCENTS  = { auto:"#a78bfa", chat:"#60a5fa", code:"#9b7fe8", sui:"#c4b5fd", arb:"#fbbf24", python:"#4ade80", image:"#fb923c", agent:"#38bdf8" };
const LIGHT_ACCENTS = { auto:"#6b4fbf", chat:"#2563eb", code:"#6b4fbf", sui:"#7c3aed", arb:"#d97706", python:"#16a34a", image:"#ea580c", agent:"#0284c7" };

// ── Auto-router ───────────────────────────────────────────────────────────────
// classifyPrompt imported from ./classifyPrompt.js

// ── RAG ──────────────────────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function embedQuery(query) {
  const raw = await invoke("ollama_post", {
    path: "/api/embed",
    body: JSON.stringify({ model:"nomic-embed-text", input: query }),
  });
  const data = JSON.parse(raw);
  if (!data.embeddings) throw new Error(`embed failed: ${raw}`);
  return data.embeddings[0];
}

function retrieveChunks(ragIndex, queryEmbedding, topK = 4) {
  return ragIndex.chunks
    .map(c => ({ ...c, score: cosineSim(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function formatRagContext(chunks) {
  return chunks.map(c =>
    `--- ${c.file} (lines ${c.startLine}–${c.endLine}) ---\n${c.text}`
  ).join("\n\n");
}

// ── Structure-aware document chunker ─────────────────────────────────────────
// Replaces the old character-count slicer.
//
// Markdown / text (md, txt, rst, adoc, html, …):
//   • Splits at heading boundaries (# / ## / ### / ####)
//   • Each section becomes one chunk — or is split at paragraph breaks if too large
//   • Continuation chunks re-prepend the section heading so every retrieved chunk
//     is self-contained and carries its topic context
//
// Code (ts, js, py, rs, move, …):
//   • Splits at blank-line boundaries between blocks (function / class level)
//   • Avoids cutting mid-function like the old char-count approach did
function chunkDocument(content, filePath, { maxSize = 1000, minSize = 40 } = {}) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  const isDoc = ["md","txt","rst","adoc","html","csv","log","env","conf","cfg","ini","yaml","yml","toml","sql"].includes(ext);
  const lines = content.split("\n");
  const chunks = [];

  if (isDoc) {
    const HEADING_RE = /^#{1,4}\s+\S/;
    let heading = "";   // current section heading — re-prepended when a large section is split
    let buf     = "";
    let bufStart = 1;

    const flush = (endLine) => {
      const text = buf.trim();
      if (text.length < minSize) { buf = ""; bufStart = endLine + 1; return; }
      if (text.length <= maxSize) {
        chunks.push({ file: filePath, startLine: bufStart, endLine, text });
      } else {
        // Section too large — split at paragraph breaks
        const paras = text.split(/\n{2,}/);
        let pbuf = ""; let pstart = bufStart;
        for (const para of paras) {
          const candidate = pbuf ? pbuf + "\n\n" + para : para;
          if (pbuf && candidate.length > maxSize) {
            if (pbuf.trim().length >= minSize)
              chunks.push({ file: filePath, startLine: pstart, endLine, text: pbuf.trim() });
            // Re-prepend heading so the new chunk is self-contained
            pbuf  = (heading && !para.match(/^#{1,4}\s/) ? heading + "\n\n" : "") + para;
            pstart = endLine;
          } else {
            pbuf = candidate;
          }
        }
        if (pbuf.trim().length >= minSize)
          chunks.push({ file: filePath, startLine: pstart, endLine, text: pbuf.trim() });
      }
      buf = ""; bufStart = endLine + 1;
    };

    for (let i = 0; i < lines.length; i++) {
      if (HEADING_RE.test(lines[i])) {
        flush(i);                    // close previous section
        heading  = lines[i];
        buf      = lines[i] + "\n";
        bufStart = i + 1;
      } else {
        buf += lines[i] + "\n";
      }
    }
    flush(lines.length);

  } else {
    // Code: accumulate non-blank blocks, split only at blank-line boundaries
    let buf = ""; let bufStart = 1;
    let block = ""; let blockStart = 1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "" && block.trim()) {
        const next = buf + block + "\n";
        if (next.length > maxSize && buf.trim().length >= minSize) {
          chunks.push({ file: filePath, startLine: bufStart, endLine: i, text: buf.trim() });
          buf = block + "\n"; bufStart = blockStart;
        } else {
          buf = next;
        }
        block = ""; blockStart = i + 2;
      } else if (lines[i].trim() !== "") {
        if (!block) blockStart = i + 1;
        block += lines[i] + "\n";
      }
    }
    if (block) buf += block;
    if (buf.trim().length >= minSize)
      chunks.push({ file: filePath, startLine: bufStart, endLine: lines.length, text: buf.trim() });
  }

  return chunks;
}

// ── Session persistence ───────────────────────────────────────────────────────
const SESSION_KEY = "tonyai-sessions-v1";
const ACTIVE_KEY  = "tonyai-active-session";

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function persistSessions(sessions) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(sessions)); } catch {}
}
function persistActive(id) {
  try { localStorage.setItem(ACTIVE_KEY, String(id)); } catch {}
}
function loadActiveId() {
  try { return Number(localStorage.getItem(ACTIVE_KEY)) || null; } catch { return null; }
}

function makeSession(mode = "auto") {
  return { id: Date.now(), title: "New conversation", mode, messages: [], context: "" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Message rendering primitives live in ./render.jsx (imported at top).

// ── File attachment helpers ───────────────────────────────────────────────────
const ATTACH_EXTS = new Set([".ts",".tsx",".js",".jsx",".rs",".py",".move",".txt",".md",".json",".csv",".toml",".yaml",".yml",".sh",".sql"]);

function readFileAsDataURL(file) {
  return new Promise((res, rej) => { const r=new FileReader(); r.onload=e=>res(e.target.result); r.onerror=rej; r.readAsDataURL(file); });
}
function readFileAsText(file) {
  return new Promise((res, rej) => { const r=new FileReader(); r.onload=e=>res(e.target.result); r.onerror=rej; r.readAsText(file); });
}
function extOf(name) { return name.slice(name.lastIndexOf(".")).toLowerCase() || ""; }
function langOf(name) { const m={ts:"typescript",tsx:"tsx",js:"javascript",jsx:"jsx",rs:"rust",py:"python",move:"move",sh:"bash",sql:"sql",json:"json",toml:"toml",yaml:"yaml",yml:"yaml",md:"markdown"}; return m[extOf(name).slice(1)] || "text"; }

// ── Image generation ──────────────────────────────────────────────────────────
async function generateA1111(prompt, negPrompt, width, height, steps, cfg, signal) {
  const res = await fetch(`${A1111_URL}/sdapi/v1/txt2img`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    signal,
    body: JSON.stringify({ prompt, negative_prompt:negPrompt, width, height, steps, cfg_scale:cfg, sampler_name:"DPM++ 2M Karras" }),
  });
  if (!res.ok) throw new Error(`Automatic1111 error ${res.status} — make sure it's running with --api flag`);
  const data = await res.json();
  return `data:image/png;base64,${data.images[0]}`;
}

async function generateComfy(prompt, negPrompt, width, height, steps, cfg, signal, checkpoint) {
  const seed = Math.floor(Math.random()*999999999);
  if (!checkpoint) throw new Error("No ComfyUI checkpoint selected — go to Image Settings and pick a model");
  const workflow = {
    "1":{ class_type:"CheckpointLoaderSimple", inputs:{ ckpt_name: checkpoint }},
    "2":{ class_type:"CLIPTextEncode", inputs:{ text:prompt, clip:["1",1] }},
    "3":{ class_type:"CLIPTextEncode", inputs:{ text:negPrompt, clip:["1",1] }},
    "4":{ class_type:"EmptyLatentImage", inputs:{ width, height, batch_size:1 }},
    "5":{ class_type:"KSampler", inputs:{ model:["1",0], positive:["2",0], negative:["3",0], latent_image:["4",0], seed, steps, cfg, sampler_name:"dpmpp_2m", scheduler:"karras", denoise:1 }},
    "6":{ class_type:"VAEDecode", inputs:{ samples:["5",0], vae:["1",2] }},
    "7":{ class_type:"SaveImage", inputs:{ images:["6",0], filename_prefix:"tonyai" }},
  };
  const qr = await fetch(`${COMFY_URL}/prompt`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ prompt:workflow }) });
  if (!qr.ok) throw new Error(`ComfyUI error ${qr.status}`);
  const { prompt_id } = await qr.json();
  for (let i=0; i<60; i++) {
    if (signal?.aborted) throw new DOMException("Aborted","AbortError");
    await new Promise(r=>setTimeout(r,2000));
    const h = await fetch(`${COMFY_URL}/history/${prompt_id}`);
    if (!h.ok) continue;
    const hist = await h.json();
    const imgMeta = hist[prompt_id]?.outputs?.["7"]?.images?.[0];
    if (imgMeta) {
      const ir = await fetch(`${COMFY_URL}/view?filename=${imgMeta.filename}&subfolder=${imgMeta.subfolder}&type=${imgMeta.type}`);
      return URL.createObjectURL(await ir.blob());
    }
  }
  throw new Error("ComfyUI timed out after 2 minutes");
}

// ── Image message ─────────────────────────────────────────────────────────────
function ImageMessage({ msg }) {
  const [savedPath, setSavedPath] = useState(null);   // null | string path
  const [saving,    setSaving]    = useState(false);
  const [saveErr,   setSaveErr]   = useState(null);

  function browserDownload() {
    const a = document.createElement("a");
    a.href = msg.imageUrl; a.download = `tonyai-${Date.now()}.png`; a.click();
  }

  async function saveToTonyAI() {
    if (saving || savedPath) return;
    setSaving(true); setSaveErr(null);
    try {
      // Build filename stem: HHMMSS_slug-from-prompt
      const now = new Date();
      const timeStr = now.toTimeString().slice(0,8).replace(/:/g,"");
      const slug = (msg.prompt||"image").slice(0,40).toLowerCase()
        .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
      const filenameStem = `${timeStr}_${slug}`;
      const subdir = now.toISOString().slice(0,10); // "2026-05-29"

      // Get base64 — imageUrl is either a data URI or a blob URL (ComfyUI)
      let b64;
      if (msg.imageUrl.startsWith("data:")) {
        b64 = msg.imageUrl;
      } else {
        // blob URL — fetch it and convert
        const resp = await fetch(msg.imageUrl);
        const buf  = await resp.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        b64 = "data:image/png;base64," + btoa(binary);
      }

      // Build sidecar metadata
      const s = msg.settings || {};
      const metaJson = JSON.stringify({
        generated_at:    now.toISOString(),
        prompt:          msg.prompt || "",
        negative_prompt: s.negPrompt || "",
        backend:         s.backend || "a1111",
        size:            s.size || "",
        steps:           s.steps,
        cfg:             s.cfg,
        checkpoint:      s.comfyCheckpoint || "",
      }, null, 2);

      const path = await invoke("save_generated_image", {
        base64: b64, filenameStem, subdir, metaJson,
      });
      setSavedPath(path);
    } catch(e) {
      setSaveErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function openFolder() {
    if (!savedPath) return;
    const dir = savedPath.split("/").slice(0,-1).join("/");
    await invoke("open_path", { path: dir });
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {msg.generating ? (
        <div style={{ width:320, height:320, borderRadius:12, background:"var(--tny-surface)", border:"1px solid var(--tny-line)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12 }}>
          <div style={{ width:40, height:40, border:"3px solid var(--tny-line2)", borderTop:"3px solid #ea580c", borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
          <span style={{ color:"var(--tny-tx3)", fontSize:13 }}>{msg.progressText||"Generating…"}</span>
          {msg.progress > 0 && (
            <div style={{ width:160, height:3, background:"var(--tny-line2)", borderRadius:2 }}>
              <div style={{ width:`${msg.progress}%`, height:"100%", background:"#ea580c", borderRadius:2, transition:"width 0.3s" }}/>
            </div>
          )}
        </div>
      ) : msg.error ? (
        <div style={{ padding:"12px 16px", borderRadius:12, background:"var(--tny-error-bg)", border:"1px solid var(--tny-error-border)", color:"var(--tny-error-text)", fontSize:13 }}>⚠️ {msg.error}</div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          <div style={{ position:"relative", display:"inline-block" }}>
            <img src={msg.imageUrl} alt={msg.prompt} style={{ borderRadius:12, maxWidth:480, width:"100%", display:"block", border:"1px solid var(--tny-line)" }}/>
            <button onClick={browserDownload} title="Download to browser default location" style={{ position:"absolute", top:8, right:8, background:"rgba(0,0,0,0.7)", border:"1px solid #444", color:"#ccc", borderRadius:8, padding:"5px 10px", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>↓</button>
          </div>

          {/* Save to TonyAI-Images bar */}
          {!savedPath ? (
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <button
                onClick={saveToTonyAI}
                disabled={saving}
                style={{ background:saving?"transparent":"#ea580c18", border:"1px solid #ea580c66", color:saving?"var(--tny-tx5)":"#ea580c", borderRadius:7, padding:"5px 12px", fontSize:12, cursor:saving?"not-allowed":"pointer", fontFamily:"inherit", transition:"all 0.15s" }}>
                {saving ? "Saving…" : "💾 Save Image"}
              </button>
              {saveErr && <span style={{ fontSize:11, color:"#ef4444" }}>⚠ {saveErr}</span>}
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <span style={{ fontSize:11, color:"#4ade80" }}>✅ Saved</span>
              <span style={{ fontSize:10, color:"var(--tny-tx5)", fontFamily:"'JetBrains Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:320 }} title={savedPath}>
                {savedPath.replace(/.*\/TonyAI-Images\//, "~/TonyAI-Images/")}
              </span>
              <button onClick={openFolder} style={{ background:"none", border:"1px solid var(--tny-line2)", color:"var(--tny-tx4)", borderRadius:6, padding:"3px 8px", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>📂 Open</button>
            </div>
          )}
        </div>
      )}
      <span style={{ fontSize:11, color:"var(--tny-tx4)", fontStyle:"italic" }}>{msg.prompt}</span>
    </div>
  );
}

// ── Image settings panel ──────────────────────────────────────────────────────
function ImageSettings({ settings, onChange, backendStatus, checkpoints = [] }) {
  const s = settings;
  return (
    <div style={{ padding:"12px 14px", borderTop:"1px solid var(--tny-line)", background:"var(--tny-sidebar)", display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase" }}>Image Settings</div>
      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        <label style={{ fontSize:10, color:"var(--tny-tx4)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Backend</label>
        <div style={{ display:"flex", gap:6 }}>
          {IMAGE_BACKENDS.map(b => (
            <button key={b.id} onClick={()=>onChange("backend",b.id)} style={{ flex:1, padding:"6px 4px", borderRadius:6, border:`1px solid ${s.backend===b.id?"#ea580c":"var(--tny-line2)"}`, background:s.backend===b.id?"#ea580c22":"transparent", color:s.backend===b.id?"#ea580c":"var(--tny-tx4)", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
              {b.label} <span style={{ fontSize:9 }}>{backendStatus[b.id]==="online"?"🟢":"🔴"}</span>
            </button>
          ))}
        </div>
      </div>
      {/* ComfyUI checkpoint selector — only shown when ComfyUI backend is selected */}
      {s.backend === "comfy" && (
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          <label style={{ fontSize:10, color:"var(--tny-tx4)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Checkpoint</label>
          {checkpoints.length > 0 ? (
            <select
              value={s.comfyCheckpoint}
              onChange={e=>onChange("comfyCheckpoint", e.target.value)}
              style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", outline:"none" }}
            >
              {checkpoints.map(ck => <option key={ck} value={ck}>{ck}</option>)}
            </select>
          ) : (
            <input
              value={s.comfyCheckpoint}
              onChange={e=>onChange("comfyCheckpoint", e.target.value)}
              placeholder={backendStatus.comfy==="online" ? "Loading…" : "ComfyUI offline"}
              style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", outline:"none" }}
            />
          )}
        </div>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        <label style={{ fontSize:10, color:"var(--tny-tx4)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Size</label>
        <select value={s.size} onChange={e=>onChange("size",e.target.value)} style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:6, padding:"6px 8px", fontSize:12, fontFamily:"inherit", outline:"none" }}>
          {IMG_SIZES.map(sz=><option key={sz}>{sz}</option>)}
        </select>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
        <div>
          <label style={{ fontSize:10, color:"var(--tny-tx4)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Steps: {s.steps}</label>
          <input type="range" min={10} max={50} value={s.steps} onChange={e=>onChange("steps",Number(e.target.value))} style={{ width:"100%", accentColor:"#ea580c" }}/>
        </div>
        <div>
          <label style={{ fontSize:10, color:"var(--tny-tx4)", textTransform:"uppercase", letterSpacing:"0.06em" }}>CFG: {s.cfg}</label>
          <input type="range" min={1} max={20} step={0.5} value={s.cfg} onChange={e=>onChange("cfg",Number(e.target.value))} style={{ width:"100%", accentColor:"#ea580c" }}/>
        </div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        <label style={{ fontSize:10, color:"var(--tny-tx4)", textTransform:"uppercase", letterSpacing:"0.06em" }}>Negative Prompt</label>
        <input value={s.negPrompt} onChange={e=>onChange("negPrompt",e.target.value)} placeholder="blurry, deformed, ugly…" style={{ background:"var(--tny-code)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:6, padding:"6px 8px", fontSize:12, fontFamily:"inherit", outline:"none" }}/>
      </div>
    </div>
  );
}

// ── Bounded tool sets per mode ────────────────────────────────────────────────
// Each mode gets a scoped tool set. null = full AGENT_TOOLS. [] = no tools (single-shot).
// This keeps models focused, reduces token count in tool definitions, and prevents
// e.g. chat mode accidentally triggering run_command.
const MODE_TOOL_SETS = {
  // search_knowledge added to every mode that uses the agent loop
  chat:   ["web_search", "deep_search", "fetch_url", "search_knowledge"],
  code:   ["web_search", "deep_search", "fetch_url", "write_file", "read_file", "search_files", "list_dir", "run_command", "python_exec", "git_status", "git_diff", "git_log", "git_blame", "spawn_subagent", "search_knowledge"],
  python: ["web_search", "deep_search", "fetch_url", "write_file", "read_file", "search_files", "list_dir", "run_command", "python_exec", "git_status", "git_diff", "git_log", "git_blame", "spawn_subagent", "search_knowledge"],
  sui:    ["web_search", "deep_search", "fetch_url", "write_file", "read_file", "search_files", "list_dir", "run_command", "python_exec", "git_status", "git_diff", "git_log", "git_blame", "spawn_subagent", "search_knowledge"],
  arb:    ["web_search", "deep_search", "fetch_url", "write_file", "read_file", "search_files", "list_dir", "run_command", "python_exec", "git_status", "git_diff", "git_log", "git_blame", "spawn_subagent", "search_knowledge"],
  agent:  null,   // full AGENT_TOOLS — unrestricted orchestrator
  auto:   null,   // resolved at runtime to classified effectiveMode set
  image:  [],     // no text tools — handled by A1111/ComfyUI backends
};

// Returns the filtered AGENT_TOOLS array for a given mode.
// Call with effectiveMode (already classified for auto).
function getToolsForMode(effectiveMode) {
  const names = MODE_TOOL_SETS[effectiveMode];
  if (names === null || names === undefined) return AGENT_TOOLS; // full set
  if (names.length === 0) return [];
  return AGENT_TOOLS.filter(t => names.includes(t.function.name));
}

// ── Stop condition evaluator ──────────────────────────────────────────────────
// Called before accepting TASK_COMPLETE. Returns { canStop, reason }.
// Rules:
//   1. Code file written → must have a run_command with [exit 0] somewhere (direct or in subagent).
//   2. Code file written + run attempted → non-zero exit means not done yet.
//   3. No tools used at all → only block if the task appears to require code (very conservative).
// Pure agent-dispatch helpers live in ./agentLogic.js (imported at top of file).

// ── Subagent roles ────────────────────────────────────────────────────────────
// Each role has a scoped tool set — the subagent cannot call tools outside its set.
const SUBAGENT_ROLES = {
  researcher: {
    icon: "🔬", label: "Researcher",
    system: `You are a focused research subagent. Gather information on the given topic.
Use web_search to find sources, then fetch_url to read the most important ones.
Return a comprehensive structured summary — include URLs, key facts, numbers.
Do not ask questions. Deliver research. End with TASK_COMPLETE on its own line.`,
    tools: ["web_search", "fetch_url"],
  },
  coder: {
    icon: "✏️", label: "Coder",
    system: `You are a code implementation subagent. Write all required files using write_file.
Use list_dir to explore existing structure first. After writing, run the entry point with
run_command to verify it works. Report: what files you created and whether the run succeeded.
End with TASK_COMPLETE on its own line.`,
    tools: ["write_file", "read_file", "search_files", "list_dir", "run_command"],
  },
  verifier: {
    icon: "🧪", label: "Verifier",
    system: `You are a verification subagent. Run the specified code or tests with run_command.
Report: exact command, full stdout/stderr output, exit code, and pass/fail verdict.
Be precise — no paraphrasing. End with TASK_COMPLETE on its own line.`,
    tools: ["run_command", "read_file", "search_files", "list_dir"],
  },
  fixer: {
    icon: "🔧", label: "Fixer",
    system: `You are a code fixer subagent. You receive failing files and the error output from running them.
Your job: read each file, understand the error, apply the minimal fix with write_file, then run it again with run_command to confirm [exit 0].
Be surgical — change only what the error requires. Report exactly what you changed.
End with TASK_COMPLETE on its own line.`,
    tools: ["write_file", "read_file", "run_command", "list_dir", "search_files"],
  },
};

// Headless agent loop — runs in complete isolation from the parent context window.
// Returns { result: string, steps: [{name,args,status,result}] }
async function runSubagent({ role, task, model, signal, braveApiKey, onProgress }) {
  const roleDef = SUBAGENT_ROLES[role] || SUBAGENT_ROLES.researcher;
  const allowedSet = new Set(roleDef.tools);
  // scopedTools is defined after AGENT_TOOLS — forward reference resolved at call time
  const getTools = () => (typeof AGENT_TOOLS !== "undefined")
    ? AGENT_TOOLS.filter(t => allowedSet.has(t.function.name))
    : [];

  const PROMPT_FALLBACK = `\n\nTOOL USE: Respond with ONLY this JSON when you need a tool (no prose, no fences):\n{"tool":"<name>","args":{...}}\nAvailable: ${roleDef.tools.join(", ")}`;

  // Each subagent has its own isolated message history
  const subMsgs = [
    { role: "system", content: roleDef.system },
    { role: "user",   content: task },
  ];

  const steps = [];
  let loopCount = 0;
  let usePromptTools = false;
  let lastContent = "";   // most recent substantive assistant text — for max-iter salvage

  while (loopCount < 8) {
    loopCount++;
    if (signal?.aborted) throw new Error("Aborted");

    const msgs = usePromptTools
      ? [{ role:"system", content: subMsgs[0].content + PROMPT_FALLBACK }, ...subMsgs.slice(1)]
      : subMsgs;

    const body = {
      model,
      messages: msgs,
      stream: false,
      ...(usePromptTools ? {} : { tools: getTools() }),
      options: { temperature: 0.2, num_ctx: 16384 },
    };

    let raw;
    try {
      raw = await invoke("ollama_post", { path: "/api/chat", body: JSON.stringify(body) });
    } catch(e) {
      const msg = String(e);
      if (msg.toLowerCase().includes("does not support tools") && !usePromptTools) {
        usePromptTools = true; loopCount--; continue;
      }
      throw new Error(`Subagent LLM error: ${msg}`);
    }

    const resp    = JSON.parse(raw);
    const content = resp.message?.content || "";
    let toolCalls = resp.message?.tool_calls || [];
    if (content.trim()) lastContent = content;   // remember for salvage if we hit the cap

    // Empty response with no tool calls and no content → model silently rejected
    // native tool schema. Switch to prompt-fallback and retry this iteration.
    if (!content.trim() && !toolCalls.length && !usePromptTools) {
      usePromptTools = true; loopCount--; continue;
    }

    // Prompt-mode: robust tool call extraction (handles embedded JSON, multiple key names)
    if (usePromptTools && !toolCalls.length) {
      const extracted = extractToolCallFromText(content);
      if (extracted) toolCalls = extracted;
    }

    // No tool calls → final answer
    if (!toolCalls.length) {
      return { result: content.replace(/\n?TASK_COMPLETE\s*$/m,"").trim(), steps };
    }

    // Execute each tool call (only within role's allowed set)
    for (const tc of toolCalls) {
      const fnName = tc.function?.name || "";
      const fnArgs = (() => {
        const raw = tc.function?.arguments;
        if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } }
        return raw || {};
      })();

      const step = { name: fnName, args: fnArgs, status: "running", result: null };
      steps.push(step);
      onProgress?.([...steps]);

      let toolResult;
      if (!allowedSet.has(fnName)) {
        toolResult = `⛔ Tool '${fnName}' not available to ${roleDef.label} subagent. Allowed: ${[...allowedSet].join(", ")}`;
        step.status = "error";
      } else {
        // Pre-flight: validate required args before invoking
        const scopedTools = (typeof AGENT_TOOLS !== "undefined" ? AGENT_TOOLS : []).filter(t => allowedSet.has(t.function.name));
        const valid = validateToolArgs(fnName, fnArgs, scopedTools);
        if (!valid.valid) {
          toolResult = `Error: ${valid.error}`;
          step.status = "error";
        } else {
          // Hard safety denylist — non-bypassable. Subagents run autonomously with
          // no UI approval prompt, so catastrophic ops are simply refused here.
          const guard = guardToolCall(fnName, fnArgs);
          if (guard.blocked) {
            toolResult = `⛔ Blocked for safety: ${guard.reason}. This operation is not allowed.`;
            step.status = "error";
          } else
          try {
            if      (fnName === "web_search")   toolResult = await invoke("tool_web_search",   { query: fnArgs.query,   braveApiKey: braveApiKey||"" });
            else if (fnName === "fetch_url")    toolResult = wrapUntrustedContent(fnArgs.url, await invoke("tool_fetch_url", { url: fnArgs.url }));
            else if (fnName === "read_file")    toolResult = await invoke("tool_read_file",    { path: fnArgs.path });
            else if (fnName === "list_dir")     toolResult = await invoke("tool_list_dir",     { path: fnArgs.path });
            else if (fnName === "search_files") toolResult = await invoke("tool_search_files", { dir: fnArgs.dir, pattern: fnArgs.pattern, extensions: fnArgs.extensions ?? null, maxResults: fnArgs.max_results ?? null });
            else if (fnName === "run_command")  toolResult = await invoke("tool_run_command",  { command: fnArgs.command });
            else if (fnName === "write_file")   toolResult = await invoke("tool_write_file",   { path: fnArgs.path, content: fnArgs.content });
            else toolResult = `Unknown tool: ${fnName}`;
            step.status = "done";
          } catch(e) {
            toolResult = enrichToolError(fnName, e);
            step.status = "error";
          }
        }
      }
      step.result = String(toolResult);
      onProgress?.([...steps]);

      subMsgs.push({ role:"assistant", content: content||"", tool_calls: [tc] });
      subMsgs.push({ role:"tool",      content: String(toolResult), tool_call_id: tc.id||`sub_${Date.now()}` });
    }
  }
  // Max iterations reached — salvage partial work rather than discarding it, so the
  // parent agent can still use whatever the subagent gathered.
  const doneSteps = steps.filter(s => s.status === "done");
  const digest = doneSteps.slice(-6).map(s => {
    const r = String(s.result || "").replace(/\s+/g, " ").trim().slice(0, 300);
    let a = ""; try { a = JSON.stringify(s.args).slice(0, 80); } catch { a = ""; }
    return `• ${s.name}(${a}) → ${r}`;
  }).join("\n");
  const salvaged = [
    lastContent.trim() ? `Partial findings before the step limit:\n${lastContent.trim()}` : "",
    digest ? `\nTool results gathered (${doneSteps.length} successful step(s)):\n${digest}` : "",
  ].filter(Boolean).join("\n").trim();
  return {
    result: salvaged
      ? `⚠️ Subagent hit its ${loopCount}-step limit before reaching a final answer. ${salvaged}`
      : `⚠️ Subagent reached its ${loopCount}-step limit without producing usable output.`,
    steps,
    incomplete: true,
  };
}

// ── Coder pipeline: coder → verifier → fixer ─────────────────────────────────
// Wraps runSubagent to auto-chain verification and fixing.
// Returns { result, steps, pipelineStages }
// pipelineStages: [{ role, icon, label, steps, status, result }]
async function runCoderPipeline({ task, model, signal, braveApiKey, onStageUpdate }) {
  const pipelineStages = [];
  let allSteps = [];

  // ── Stage 1: Coder ───────────────────────────────────────────────────────
  pipelineStages.push({ role:"coder", icon:"✏️", label:"Coder", steps:[], status:"running", result:"" });
  onStageUpdate?.([...pipelineStages], []);

  const coderResult = await runSubagent({
    role: "coder", task, model, signal, braveApiKey,
    onProgress: (steps) => {
      pipelineStages[0] = { ...pipelineStages[0], steps };
      onStageUpdate?.([...pipelineStages], steps);
    },
  });

  pipelineStages[0] = { role:"coder", icon:"✏️", label:"Coder", steps:coderResult.steps, status:"done", result:coderResult.result };
  allSteps = [...coderResult.steps];
  onStageUpdate?.([...pipelineStages], allSteps);

  // Find code files written by the coder
  const writtenFiles = coderResult.steps
    .filter(s => s.name === "write_file")
    .map(s => s.args?.path)
    .filter(p => p && CODE_EXTS_SET.has(("." + p.split(".").pop()).toLowerCase()));

  if (writtenFiles.length === 0) {
    // No runnable code written — return coder result directly (e.g. doc task)
    return { result: coderResult.result, steps: allSteps, pipelineStages };
  }

  // ── Stage 2: Verifier ────────────────────────────────────────────────────
  const verifierTask = `Run and verify these files exit with code 0:\n${writtenFiles.map(f => `- ${f}`).join("\n")}\nRun each file and report the exact command, output, and exit code.`;

  pipelineStages.push({ role:"verifier", icon:"🧪", label:"Verifier", steps:[], status:"running", result:"" });
  onStageUpdate?.([...pipelineStages], allSteps);

  const verifierResult = await runSubagent({
    role: "verifier", task: verifierTask, model, signal, braveApiKey,
    onProgress: (steps) => {
      pipelineStages[1] = { ...pipelineStages[1], steps };
      onStageUpdate?.([...pipelineStages], [...allSteps, ...steps]);
    },
  });

  const verifierPassed =
    verifierResult.steps.some(s => s.name === "run_command" && /\[exit 0\]/.test(String(s.result||""))) &&
    !verifierResult.steps.some(s => s.name === "run_command" && /\[exit -?\d+\]/.test(String(s.result||"")) && !/\[exit 0\]/.test(String(s.result||"")));

  pipelineStages[1] = { role:"verifier", icon:"🧪", label:"Verifier", steps:verifierResult.steps, status: verifierPassed ? "done" : "error", result:verifierResult.result };
  allSteps = [...allSteps, ...verifierResult.steps];
  onStageUpdate?.([...pipelineStages], allSteps);

  if (verifierPassed) {
    return {
      result: `${coderResult.result}\n\n✅ Verifier: All checks passed.`,
      steps: allSteps,
      pipelineStages,
    };
  }

  // ── Stage 3: Fixer (up to 2 attempts) ───────────────────────────────────
  const failedOutput = verifierResult.steps
    .filter(s => s.name === "run_command" && !/\[exit 0\]/.test(String(s.result||"")))
    .map(s => `$ ${s.args?.command}\n${String(s.result||"").slice(0, 600)}`)
    .join("\n\n");

  const fixerTask = `Fix these failing files so they exit 0:\n${writtenFiles.map(f => `- ${f}`).join("\n")}\n\nError output:\n\`\`\`\n${failedOutput}\n\`\`\`\n\nRead each file, fix the error, write_file the corrected version, then run_command to verify [exit 0].`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) break;

    const stageIdx = pipelineStages.length;
    const label = attempt === 1 ? "Fixer" : "Fixer (retry)";
    pipelineStages.push({ role:"fixer", icon:"🔧", label, steps:[], status:"running", result:"" });
    onStageUpdate?.([...pipelineStages], allSteps);

    const fixerResult = await runSubagent({
      role: "fixer", task: fixerTask, model, signal, braveApiKey,
      onProgress: (steps) => {
        pipelineStages[stageIdx] = { ...pipelineStages[stageIdx], steps };
        onStageUpdate?.([...pipelineStages], [...allSteps, ...steps]);
      },
    });

    const fixerPassed = fixerResult.steps.some(s => s.name === "run_command" && /\[exit 0\]/.test(String(s.result||"")));
    pipelineStages[stageIdx] = { role:"fixer", icon:"🔧", label, steps:fixerResult.steps, status: fixerPassed ? "done" : "error", result:fixerResult.result };
    allSteps = [...allSteps, ...fixerResult.steps];
    onStageUpdate?.([...pipelineStages], allSteps);

    if (fixerPassed) {
      return {
        result: `${coderResult.result}\n\n❌ Verifier found issues. ✅ Fixer resolved them.\nFixer: ${fixerResult.result}`,
        steps: allSteps,
        pipelineStages,
      };
    }
  }

  return {
    result: `${coderResult.result}\n\n❌ Verifier found issues. 🔧 Fixer could not resolve after 2 attempts.\nLast verifier output: ${verifierResult.result}`,
    steps: allSteps,
    pipelineStages,
  };
}

// ── Agent tools definition ────────────────────────────────────────────────────
const AGENT_TOOLS = [
  { type:"function", function:{ name:"web_search",  description:"Search the internet for current information, news, research, documentation, prices. Returns titles, URLs, and snippets. Use deep_search if you need full page content.", parameters:{ type:"object", properties:{ query:{ type:"string", description:"The search query" }}, required:["query"] }}},
  { type:"function", function:{ name:"deep_search", description:"Search the internet AND automatically fetch the full content of the top results. Use this for any question needing current, detailed information — prices, news, documentation, tutorials. More thorough than web_search alone.", parameters:{ type:"object", properties:{ query:{ type:"string", description:"What to search for" }, num_results:{ type:"number", description:"How many top results to fetch in full (default 2, max 4)" }}, required:["query"] }}},
  { type:"function", function:{ name:"fetch_url",   description:"Fetch and read the full text content of a specific URL. Use after web_search to get full page details.", parameters:{ type:"object", properties:{ url:{ type:"string", description:"The URL to fetch" }}, required:["url"] }}},
  { type:"function", function:{ name:"read_file",   description:"Read the contents of a local file. Only files under $HOME are accessible.", parameters:{ type:"object", properties:{ path:{ type:"string", description:"Absolute path to the file" }}, required:["path"] }}},
  { type:"function", function:{ name:"list_dir",    description:"List files and subdirectories in a local directory.", parameters:{ type:"object", properties:{ path:{ type:"string", description:"Absolute path to the directory" }}, required:["path"] }}},
  { type:"function", function:{ name:"run_command", description:"Run a shell command and return its output. Use for pm2, git, npm, ls, curl, python3, node, etc.", parameters:{ type:"object", properties:{ command:{ type:"string", description:"Shell command to execute" }}, required:["command"] }}},
  { type:"function", function:{ name:"write_file",      description:"Write text content to a file on the local filesystem. Creates parent directories automatically. Use to create source files, configs, scripts, etc.", parameters:{ type:"object", properties:{ path:{ type:"string", description:"Absolute path to write (must be under $HOME or /tmp)" }, content:{ type:"string", description:"Full text content to write to the file" }}, required:["path","content"] }}},
  { type:"function", function:{ name:"search_files",    description:"Search file contents using a regex pattern across a directory tree (like grep -rn). Returns matching lines as 'file:line: content'. Use to find function definitions, variable usages, imports, TODO comments, or any text pattern across a codebase. Skips node_modules, .git, target, and binary files automatically.", parameters:{ type:"object", properties:{ dir:{ type:"string", description:"Absolute directory path to search under" }, pattern:{ type:"string", description:"Regex or literal string to search for" }, extensions:{ type:"string", description:"Optional comma-separated file extensions to restrict search, e.g. 'py,ts,js'. Searches all text files if omitted." }, max_results:{ type:"number", description:"Max matches to return (default 60, max 200)" }}, required:["dir","pattern"] }}},
  { type:"function", function:{ name:"spawn_subagent",  description:"Spawn an isolated subagent to handle a subtask. coder role auto-runs a verifier after writing code, then a fixer if verification fails — you get a guaranteed-working result. researcher=web search only | coder=write+verify+fix (full pipeline) | verifier=run+inspect | fixer=fix broken code.", parameters:{ type:"object", properties:{ role:{ type:"string", enum:["researcher","coder","verifier","fixer"], description:"researcher=web search only | coder=write+verify+fix pipeline | verifier=run+inspect | fixer=fix broken code" }, task:{ type:"string", description:"Complete self-contained task description with all context the subagent needs — it has no access to this conversation" }}, required:["role","task"] }}},
  { type:"function", function:{ name:"search_knowledge", description:"Search your personal knowledge base — documents, notes, specs, and files you've added to ~/TonyAI-Documents/. Returns the most relevant passages. Use this to answer questions about your own projects, decisions, preferences, or any documents you've stored.", parameters:{ type:"object", properties:{ query:{ type:"string", description:"What to search for — natural language or keywords" }}, required:["query"] }}},
  { type:"function", function:{ name:"python_exec",      description:"Execute Python code in a SANDBOXED environment (~/TonyAI-Sandbox/) — safer than run_command for testing snippets, data analysis, or experimentation. Code runs in an isolated venv, not your project tree. Supports optional pip packages. Returns stdout, stderr, and exit code. Prefer this over run_command for any standalone Python code.", parameters:{ type:"object", properties:{ code:{ type:"string", description:"Python code to execute" }, packages:{ type:"string", description:"Optional comma-separated pip packages to install before running (e.g. 'requests,pandas')" }, timeout_seconds:{ type:"number", description:"Max execution time, default 60, max 300" }}, required:["code"] }}},
  { type:"function", function:{ name:"git_status",       description:"Get a git repo's current state: branch, ahead/behind, staged + unstaged + untracked files, stash count. Use BEFORE making changes to understand the current state.", parameters:{ type:"object", properties:{ repo_path:{ type:"string", description:"Absolute path to the git repository" }}, required:["repo_path"] }}},
  { type:"function", function:{ name:"git_diff",         description:"Show git diff for working tree (default) or staged changes. Optionally limit to a single file. Use to review what changed before committing or to understand recent edits.", parameters:{ type:"object", properties:{ repo_path:{ type:"string", description:"Absolute path to the git repository" }, staged:{ type:"boolean", description:"true = show staged diff, false/omit = show working tree diff" }, file:{ type:"string", description:"Optional: limit diff to a specific file path (relative to repo)" }}, required:["repo_path"] }}},
  { type:"function", function:{ name:"git_log",          description:"Get recent commit history in one-line format with branch decorations. Optionally limit to a specific file.", parameters:{ type:"object", properties:{ repo_path:{ type:"string", description:"Absolute path to the git repository" }, max_count:{ type:"number", description:"How many commits to show (default 15, max 100)" }, file:{ type:"string", description:"Optional: show only commits touching this file" }}, required:["repo_path"] }}},
  { type:"function", function:{ name:"git_blame",        description:"Show who last modified each line of a file. Useful for understanding the history and authors of specific code.", parameters:{ type:"object", properties:{ repo_path:{ type:"string", description:"Absolute path to the git repository" }, file:{ type:"string", description:"File path relative to the repo" }, line_start:{ type:"number", description:"Optional: starting line number" }, line_end:{ type:"number", description:"Optional: ending line number — required if line_start is set" }}, required:["repo_path","file"] }}},
];

const TOOL_ICONS = { web_search:"🔍", deep_search:"🔎🌐", fetch_url:"🌐", read_file:"📄", write_file:"✍️", search_files:"🔎", list_dir:"📁", run_command:"⚡", spawn_subagent:"🤖", search_knowledge:"📚", python_exec:"🐍", git_status:"🌿", git_diff:"📝", git_log:"📜", git_blame:"👤", fixer:"🔧" };

// ── Context token estimation (chars ÷ 4 ≈ tokens) ────────────────────────────
function estimateTokens(...textParts) {
  return Math.ceil(textParts.reduce((sum, t) => sum + (t || "").length, 0) / 4);
}

// ── Tool step message component ───────────────────────────────────────────────
function ToolStepMessage({ steps, accent }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {steps.map((s, i) => {
        const isSubagent = s.name === "spawn_subagent";
        const roleDef    = isSubagent ? (SUBAGENT_ROLES[s.args?.role] || {}) : null;

        return (
          <div key={i} style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {/* Step header row */}
            <div style={{ display:"flex", alignItems:"center", gap:7, fontSize:12 }}>
              <span style={{ fontSize:13 }}>
                {s.status==="running"?"⏳":s.status==="error"?"❌":"✅"}
              </span>
              <span style={{ color: isSubagent ? (roleDef?.icon ? "var(--tny-tx2)" : accent) : accent, fontFamily:"'JetBrains Mono',monospace", fontWeight:500 }}>
                {isSubagent ? `${roleDef?.icon||"🤖"} ${roleDef?.label||s.args?.role} subagent` : `${TOOL_ICONS[s.name]||"🔧"} ${s.name}`}
              </span>
              <span style={{ color:"var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace", fontSize:11, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:isSubagent?240:360 }}>
                {isSubagent
                  ? `"${String(s.args?.task||"").slice(0,80)}${String(s.args?.task||"").length>80?"…":""}"`
                  : `(${Object.entries(s.args||{}).map(([k,v])=>`${k}: "${String(v).slice(0,60)}"`).join(", ")})`}
              </span>
            </div>

            {/* Pipeline stages (coder → verifier → fixer) or flat subSteps */}
            {isSubagent && (s.pipelineStages?.length > 0 || s.subSteps?.length > 0) && (
              <div style={{ marginLeft:22, borderLeft:"2px solid var(--tny-line2)", paddingLeft:12, display:"flex", flexDirection:"column", gap:6 }}>
                {s.pipelineStages?.length > 0
                  ? s.pipelineStages.map((stage, si) => (
                    <div key={si} style={{ display:"flex", flexDirection:"column", gap:3 }}>
                      {/* Stage header */}
                      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11 }}>
                        <span>{stage.status==="running"?"⏳":stage.status==="error"?"❌":"✅"}</span>
                        <span style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600,
                          color: stage.status==="error" ? "#ef4444" : stage.status==="running" ? "var(--tny-tx3)" : "#34d399" }}>
                          {stage.icon} {stage.label}
                        </span>
                        {stage.status==="running" && <span style={{ fontSize:9, color:"var(--tny-tx5)", animation:"pulse 1.2s ease-in-out infinite" }}>running…</span>}
                      </div>
                      {/* Stage steps */}
                      {stage.steps?.map((ss, j) => (
                        <div key={j} style={{ marginLeft:14, display:"flex", flexDirection:"column", gap:2 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:10 }}>
                            <span>{ss.status==="running"?"⏳":ss.status==="error"?"❌":"✅"}</span>
                            <span style={{ color:"var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace" }}>{TOOL_ICONS[ss.name]||"🔧"} {ss.name}</span>
                            <span style={{ color:"var(--tny-tx5)", fontFamily:"'JetBrains Mono',monospace", fontSize:9, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:220 }}>
                              ({Object.entries(ss.args||{}).map(([k,v])=>`${k}: "${String(v).slice(0,40)}"`).join(", ")})
                            </span>
                          </div>
                          {ss.result && ss.status!=="running" && (() => {
                            const rStr = String(ss.result);
                            const exM  = ss.name==="run_command" ? rStr.match(/\[exit (-?\d+)\]/) : null;
                            const exC  = exM ? parseInt(exM[1]) : null;
                            const exOk = exC === 0;
                            return (
                              <div style={{ marginLeft:16, display:"flex", flexDirection:"column", gap:2 }}>
                                {exC !== null && (
                                  <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:9, fontWeight:600, padding:"1px 5px", borderRadius:3, alignSelf:"flex-start",
                                    background: exOk?"rgba(52,211,153,0.1)":"rgba(239,68,68,0.1)",
                                    border:`1px solid ${exOk?"rgba(52,211,153,0.3)":"rgba(239,68,68,0.3)"}`,
                                    color: exOk?"#34d399":"#ef4444" }}>
                                    {exOk?"✓ exit 0":`✗ exit ${exC}`}
                                  </span>
                                )}
                                <div style={{ background:"var(--tny-code)", border:`1px solid ${exC!==null&&!exOk?"rgba(239,68,68,0.2)":"var(--tny-line)"}`, borderRadius:4, padding:"3px 7px", fontSize:10, color:"var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace", whiteSpace:"pre-wrap", maxHeight:70, overflow:"auto", lineHeight:1.4 }}>
                                  {rStr.slice(0,250)}{rStr.length>250?"…":""}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ))}
                    </div>
                  ))
                  : /* Flat subSteps for non-pipeline subagents (researcher, verifier standalone) */
                  s.subSteps.map((ss, j) => (
                    <div key={j} style={{ display:"flex", flexDirection:"column", gap:2 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11 }}>
                        <span style={{ fontSize:11 }}>{ss.status==="running"?"⏳":ss.status==="error"?"❌":"✅"}</span>
                        <span style={{ color:"var(--tny-tx3)", fontFamily:"'JetBrains Mono',monospace" }}>{TOOL_ICONS[ss.name]||"🔧"} {ss.name}</span>
                        <span style={{ color:"var(--tny-tx5)", fontFamily:"'JetBrains Mono',monospace", fontSize:10, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:260 }}>
                          ({Object.entries(ss.args||{}).map(([k,v])=>`${k}: "${String(v).slice(0,50)}"`).join(", ")})
                        </span>
                      </div>
                      {ss.result && ss.status!=="running" && (() => {
                        const rStr = String(ss.result);
                        const exM  = ss.name==="run_command" ? rStr.match(/\[exit (-?\d+)\]/) : null;
                        const exC  = exM ? parseInt(exM[1]) : null;
                        const exOk = exC === 0;
                        return (
                          <div style={{ marginLeft:18, display:"flex", flexDirection:"column", gap:2 }}>
                            {exC !== null && (
                              <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:9, fontWeight:600, padding:"1px 5px", borderRadius:3, alignSelf:"flex-start",
                                background: exOk?"rgba(52,211,153,0.1)":"rgba(239,68,68,0.1)",
                                border:`1px solid ${exOk?"rgba(52,211,153,0.3)":"rgba(239,68,68,0.3)"}`,
                                color: exOk?"#34d399":"#ef4444" }}>
                                {exOk?"✓ exit 0":`✗ exit ${exC}`}
                              </span>
                            )}
                            <div style={{ background:"var(--tny-code)", border:`1px solid ${exC!==null&&!exOk?"rgba(239,68,68,0.2)":"var(--tny-line)"}`, borderRadius:4, padding:"4px 8px", fontSize:10, color:"var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace", whiteSpace:"pre-wrap", maxHeight:80, overflow:"auto", lineHeight:1.4 }}>
                              {rStr.slice(0,300)}{rStr.length>300?"…":""}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ))
                }
              </div>
            )}

            {/* Result — for regular tools, or subagent final summary */}
            {s.result && s.status!=="running" && !isSubagent && (() => {
              const resultStr = String(s.result);
              // Parse exit code for run_command steps
              const exitMatch = s.name === "run_command" ? resultStr.match(/\[exit (\-?\d+)\]/) : null;
              const exitCode  = exitMatch ? parseInt(exitMatch[1]) : null;
              const exitPass  = exitCode === 0;
              return (
                <div style={{ marginLeft:20, display:"flex", flexDirection:"column", gap:3 }}>
                  {exitCode !== null && (
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{
                        fontFamily:"'JetBrains Mono',monospace", fontSize:10, fontWeight:600,
                        padding:"1px 7px", borderRadius:4,
                        background: exitPass ? "rgba(52,211,153,0.12)" : "rgba(239,68,68,0.12)",
                        border: `1px solid ${exitPass ? "rgba(52,211,153,0.35)" : "rgba(239,68,68,0.35)"}`,
                        color: exitPass ? "#34d399" : "#ef4444",
                      }}>
                        {exitPass ? "✓ exit 0" : `✗ exit ${exitCode}`}
                      </span>
                      {!exitPass && <span style={{ fontSize:10, color:"#f97316" }}>Fix required before completing</span>}
                    </div>
                  )}
                  <div style={{ background:"var(--tny-code)", border:`1px solid ${exitCode !== null && !exitPass ? "rgba(239,68,68,0.25)" : "var(--tny-line)"}`, borderRadius:6, padding:"6px 10px", fontSize:11, color:"var(--tny-tx3)", fontFamily:"'JetBrains Mono',monospace", whiteSpace:"pre-wrap", maxHeight:120, overflow:"auto", lineHeight:1.5 }}>
                    {resultStr.slice(0,400)}{resultStr.length>400?"…":""}
                  </div>
                </div>
              );
            })()}
            {isSubagent && s.result && s.status!=="running" && (
              <div style={{ marginLeft:22, background:"rgba(52,211,153,0.06)", border:"1px solid rgba(52,211,153,0.2)", borderRadius:6, padding:"6px 10px", fontSize:11, color:"var(--tny-tx3)", fontFamily:"'JetBrains Mono',monospace", whiteSpace:"pre-wrap", maxHeight:140, overflow:"auto", lineHeight:1.5 }}>
                <span style={{ color:"#34d399", fontWeight:600 }}>↩ Result: </span>
                {String(s.result).slice(0,500)}{String(s.result).length>500?"…":""}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  // Sessions
  const initSessions = () => {
    const stored = loadSessions();
    if (!stored) return [makeSession("auto")];
    // Migrate any sessions stuck in non-auto modes (chat, code, python, sui, arb, agent) to auto.
    // Image mode is kept since it's genuinely different (A1111/ComfyUI).
    const NON_AUTO = new Set(["chat","code","python","sui","arb","agent"]);
    const migrated = stored.map(s => NON_AUTO.has(s.mode) ? { ...s, mode:"auto" } : s);
    if (migrated.some((s,i) => s.mode !== stored[i].mode)) persistSessions(migrated);
    return migrated;
  };
  const [sessions, setSessions]       = useState(initSessions);
  const [activeId, setActiveId]       = useState(() => {
    const s = initSessions();
    const aid = loadActiveId();
    return aid && s.find(x => x.id === aid) ? aid : s[0].id;
  });

  const activeSession = sessions.find(s => s.id === activeId) || sessions[0];
  const mode      = activeSession.mode;
  const messages  = activeSession.messages;
  const context   = activeSession.context;

  function setMode(m)     { updateSession({ mode: m }); }
  function setMessages(fn){ updateSession(prev => ({ messages: typeof fn === "function" ? fn(prev.messages) : fn })); }
  function setContext(v)  { updateSession({ context: v }); }

  function updateSession(patch) {
    setSessions(prev => {
      const next = prev.map(s => s.id === activeId
        ? { ...s, ...(typeof patch === "function" ? patch(s) : patch) }
        : s
      );
      persistSessions(next);
      return next;
    });
  }

  function autoTitle(firstMessage) {
    const title = firstMessage.slice(0, 42) + (firstMessage.length > 42 ? "…" : "");
    updateSession({ title });
  }

  function newSession() {
    // Auto-save current session before leaving it
    autoSaveSession(activeSession);
    const s = makeSession("auto");
    setSessions(prev => { const next = [...prev, s]; persistSessions(next); return next; });
    setActiveId(s.id);
    persistActive(s.id);
  }

  function switchSession(id) {
    // Auto-save the session we're leaving
    autoSaveSession(activeSession);
    setActiveId(id);
    persistActive(id);
  }

  function deleteSession(id, e) {
    e.stopPropagation();
    setSessions(prev => {
      if (prev.length === 1) return prev;
      const next = prev.filter(s => s.id !== id);
      persistSessions(next);
      if (activeId === id) { setActiveId(next[next.length-1].id); persistActive(next[next.length-1].id); }
      return next;
    });
  }

  function forkSession(id, e) {
    e.stopPropagation();
    const src = sessions.find(s => s.id === id);
    if (!src) return;
    const forked = { ...src, id: Date.now(), title: `Fork of ${src.title}` };
    setSessions(prev => { const next = [...prev, forked]; persistSessions(next); return next; });
    setActiveId(forked.id);
    persistActive(forked.id);
  }

  // Model + settings
  const [models, setModels]           = useState([]);
  const [model, setModel]             = useState("");
  const [modelMeta, setModelMeta]     = useState({});   // { name: { modifiedAt: Date, size: number } }
  const [pullingModel, setPullingModel] = useState(null);
  const [pullStatus, setPullStatus]   = useState({});   // { name: "done" | "error:..." }
  const [modelSettings, setModelSettings] = useState(MODE_DEFAULTS[mode] || MODE_DEFAULTS.chat);
  const [showModelSettings, setShowModelSettings] = useState(false);

  // UI state
  const [loading, setLoading]         = useState(false);
  const [input, setInput]             = useState("");
  const [ollamaOk, setOllamaOk]       = useState(null);
  const [backendStatus, setBknd]      = useState({ a1111:"checking", comfy:"checking" });
  const [sidebarOpen, setSidebar]     = useState(true);
  const [showContext, setShowContext]  = useState(false);
  const [showSnippets, setShowSnippets]     = useState(false);
  const [showDevInspect, setShowDevInspect] = useState(false);
  const [ragIndex, setRagIndex]             = useState(null);   // null = not loaded
  const [ragStatus, setRagStatus]           = useState("idle"); // idle | loading | ready | error | indexing | stale
  const [ragMsg, setRagMsg]                 = useState("");

  // ── General Knowledge Base RAG ────────────────────────────────────────────
  const [knowledgeIndex,  setKnowledgeIndex]  = useState(null);
  const [knowledgeStatus, setKnowledgeStatus] = useState("idle"); // idle | loading | ready | indexing | stale | error
  const [knowledgeMsg,    setKnowledgeMsg]    = useState("");
  const [knowledgeDir,    setKnowledgeDir]    = useState(
    () => localStorage.getItem("tonyai-knowledge-dir") || `${DEFAULT_WORKSPACE_DIR.split("/TonyAI-Projects")[0]}/TonyAI-Documents`
  );

  // Session inline-rename
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [editingTitle, setEditingTitle]         = useState("");

  // Model search filter
  const [modelSearch, setModelSearch] = useState("");
  const [imgSettings, setImgSettings] = useState({ backend:"a1111", size:"512×512", steps:20, cfg:7, negPrompt:"blurry, deformed, ugly, bad anatomy", comfyCheckpoint:"" });
  const [comfyCheckpoints, setComfyCheckpoints] = useState([]); // populated when ComfyUI is online
  const [braveApiKey, setBraveApiKey] = useState("");   // loaded from Rust secret store on mount (see effect below)
  const secretsLoadedRef = useRef(false);
  const [smartRoute, setSmartRoute] = useState(() => localStorage.getItem("tonyai-smart-route") !== "false");
  const [showAgentPanel, setAgentPanel] = useState(false);
  const [showInbox, setShowInbox]       = useState(false);
  const [inbox, setInbox]               = useState([]);
  const [compactNotice, setCompactNotice] = useState("");
  const [confirmCmds, setConfirmCmds] = useState(() => localStorage.getItem("tonyai-confirm-cmds") !== "false");
  const [pendingCmd,  setPendingCmd]   = useState(null); // null | { name, detail } — awaiting user approval
  const pendingCmdRef = useRef(null);
  const [homeDir, setHomeDir] = useState("/Users/tonyjagodka"); // populated from Rust at bootstrap
  // MCP server configurations (persisted to localStorage)
  const [mcpServers, setMcpServers] = useState(() => {
    try { return JSON.parse(localStorage.getItem("tonyai-mcp-servers") || "[]"); } catch { return []; }
  });
  // Discovered tools from running MCP servers: { [serverId]: McpTool[] }
  const [mcpDiscoveredTools, setMcpDiscoveredTools] = useState({});
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [ragSourceDir, setRagSourceDir] = useState(() => localStorage.getItem("tonyai-rag-dir") || "/Users/tonyjagodka/sui-arb-bot/src");
  const [editingRagDir, setEditingRagDir] = useState(false);
  const [workspaceDir, setWorkspaceDir] = useState(() => localStorage.getItem("tonyai-workspace-dir") || DEFAULT_WORKSPACE_DIR);
  const [editingWorkspaceDir, setEditingWorkspaceDir] = useState(false);

  // Theme — CSS :root = dark by default, [data-theme="light"] = light override.
  // Version "dark-v1" forces a one-time reset to dark for users who had light stored.
  const [isDark, setIsDark] = useState(() => {
    const THEME_V = "dark-v1";
    if (localStorage.getItem("tonyai-theme-reset") !== THEME_V) {
      // First launch with new dark-first CSS — override any stale "light" preference
      localStorage.setItem("tonyai-theme", "dark");
      localStorage.setItem("tonyai-theme-reset", THEME_V);
      return true;
    }
    return localStorage.getItem("tonyai-theme") !== "light";
  });
  useEffect(() => {
    if (isDark) {
      document.documentElement.removeAttribute("data-theme"); // dark = no attribute (CSS :root handles it)
    } else {
      document.documentElement.setAttribute("data-theme", "light");
    }
    localStorage.setItem("tonyai-theme", isDark ? "dark" : "light");
  }, [isDark]);

  // Record uncaught errors / promise rejections to the on-disk diagnostic log.
  useEffect(() => { installGlobalErrorLogging(); }, []);

  // Load the search API key from Rust-managed secret storage (~/.tonyai/secret-brave.txt,
  // mode 0600) — kept out of localStorage so untrusted page content can't scrape it.
  // One-time migration: if a legacy localStorage key exists, move it into the store.
  useEffect(() => {
    (async () => {
      try {
        let v = await invoke("read_secret", { key: "brave" });
        if (!v) {
          const legacy = localStorage.getItem("tonyai-brave-key");
          if (legacy) { v = legacy; await invoke("save_secret", { key: "brave", value: legacy }); }
        }
        localStorage.removeItem("tonyai-brave-key");   // never keep the secret in localStorage
        if (v) setBraveApiKey(v);
      } catch (e) { logError("secret load failed", String(e)); }
      secretsLoadedRef.current = true;
    })();
  }, []);

  // Persist the key back to the Rust store on change — but only after the initial
  // load completes, so the empty starting value doesn't overwrite a stored key.
  useEffect(() => {
    if (!secretsLoadedRef.current) return;
    invoke("save_secret", { key: "brave", value: braveApiKey }).catch(e => logError("secret save failed", String(e)));
  }, [braveApiKey]);
  useEffect(() => { localStorage.setItem("tonyai-smart-route", smartRoute); }, [smartRoute]);
  useEffect(() => { localStorage.setItem("tonyai-confirm-cmds", confirmCmds); }, [confirmCmds]);
  useEffect(() => { localStorage.setItem("tonyai-rag-dir", ragSourceDir); }, [ragSourceDir]);
  useEffect(() => { localStorage.setItem("tonyai-knowledge-dir", knowledgeDir); }, [knowledgeDir]);
  useEffect(() => { localStorage.setItem("tonyai-workspace-dir", workspaceDir); }, [workspaceDir]);
  useEffect(() => { localStorage.setItem("tonyai-mcp-servers", JSON.stringify(mcpServers)); }, [mcpServers]);
  useEffect(() => {
    if (!compactNotice) return;
    const t = setTimeout(() => setCompactNotice(""), 6000);
    return () => clearTimeout(t);
  }, [compactNotice]);

  // Poll inbox every 60s so new findings appear without restart
  useEffect(() => {
    const t = setInterval(async () => {
      try { setInbox(JSON.parse(await invoke("read_inbox"))); } catch {}
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  // Attachments
  const [attachments, setAttachments] = useState([]); // [{id,type,name,content,preview?}]
  const fileInputRef = useRef(null);

  // Memory — new format: { global: {text, attachments}, modes: {[modeId]: {text}} }
  // Legacy format { text, attachments } is migrated on first load in bootstrap()
  const [memory, setMemory]           = useState({ global: { text: "", attachments: [] }, modes: {} });
  const [showMemory, setShowMemory]   = useState(false);
  const [memTab, setMemTab]           = useState("global"); // "global" | mode id
  const memSaveTimer                  = useRef(null);
  const memFileInputRef               = useRef(null);

  const bottomRef   = useRef(null);
  const textareaRef = useRef(null);
  const abortRef    = useRef(null);
  // Stable ref so keyboard handler always sees latest functions without re-registering
  const shortcutRef    = useRef({});
  // Maps sessionId → message count at last save — prevents duplicate exports
  const savedSessionMap = useRef({});

  // ── Run code block and append output as a verify message ─────────────────
  async function runCode(code, lang) {
    const L = (lang || "").toLowerCase().trim();
    const delim = `__TONYAI_${Date.now()}__`;
    let command;

    if (["python", "python3", "py"].includes(L)) {
      command = `python3 << '${delim}'\n${code}\n${delim}`;
    } else if (["javascript", "js"].includes(L)) {
      command = `node << '${delim}'\n${code}\n${delim}`;
    } else if (["typescript", "ts"].includes(L)) {
      command = `npx --yes ts-node << '${delim}'\n${code}\n${delim}`;
    } else if (["bash", "sh", "shell", "zsh"].includes(L)) {
      command = code;
    } else {
      setMessages(prev => [...prev, { role:"assistant", content:`⚠️ Can't run \`${lang}\` directly — copy it to your terminal.`, error:true }]);
      return;
    }

    try {
      const output = await invoke("tool_run_command", { command });
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `\`\`\`output\n${String(output).trim()}\n\`\`\``,
      }]);
    } catch(e) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `\`\`\`output\nError: ${String(e)}\n\`\`\``,
        error: true,
      }]);
    }
  }

  // ── Export conversation as Markdown ──────────────────────────────────────
  // ── MCP helpers ──────────────────────────────────────────────────────────

  // Convert an MCP tool definition → OpenAI-format tool (namespaced with server id)
  function mcpToolToAgent(serverId, mcpTool) {
    return {
      type: "function",
      function: {
        name: `mcp__${serverId}__${mcpTool.name}`,
        description: `[MCP:${serverId}] ${mcpTool.description || mcpTool.name}`,
        parameters: mcpTool.inputSchema || { type: "object", properties: {} },
      },
    };
  }

  // Start one MCP server and store its discovered tools.
  // Updates the server entry's status in mcpServers state.
  async function initMcpServer(srv) {
    setMcpServers(prev => prev.map(s => s.id === srv.id ? { ...s, status:"connecting", error:null } : s));
    try {
      const argsArray = Array.isArray(srv.args) ? srv.args
        : String(srv.args||"").split(/\s+/).filter(Boolean);
      const envObj = typeof srv.env === "object" ? srv.env : {};
      const toolsJson = await invoke("mcp_initialize", {
        id:      srv.id,
        command: srv.command,
        args:    argsArray,
        envVars: Object.keys(envObj).length > 0 ? envObj : null,
      });
      const tools = JSON.parse(toolsJson);
      setMcpDiscoveredTools(prev => ({ ...prev, [srv.id]: tools }));
      setMcpServers(prev => prev.map(s =>
        s.id === srv.id ? { ...s, status:"connected", toolCount: tools.length, error:null } : s
      ));
    } catch(e) {
      const errMsg = String(e);
      setMcpServers(prev => prev.map(s =>
        s.id === srv.id ? { ...s, status:"error", error:errMsg } : s
      ));
    }
  }

  async function stopMcpServer(serverId) {
    try { await invoke("mcp_stop_server", { serverId }); } catch {}
    setMcpDiscoveredTools(prev => { const n = { ...prev }; delete n[serverId]; return n; });
    setMcpServers(prev => prev.map(s =>
      s.id === serverId ? { ...s, status:"disconnected", toolCount:0 } : s
    ));
  }

  // Returns the full tool list for a mode including discovered MCP tools.
  // MCP tools are only added for agent/auto modes (full tool set).
  function getActiveToolsForMode(effectiveMode) {
    const base = getToolsForMode(effectiveMode);
    const isFullMode = MODE_TOOL_SETS[effectiveMode] === null || effectiveMode === "agent";
    if (!isFullMode) return base;
    const mcpList = Object.entries(mcpDiscoveredTools)
      .flatMap(([sid, tools]) => (tools||[]).map(t => mcpToolToAgent(sid, t)));
    return [...base, ...mcpList];
  }

  // ── Session transcript formatting ────────────────────────────────────────
  function formatSessionMarkdown(session) {
    const modeLabel = MODES.find(m => m.id === session.mode)?.label || session.mode;
    const lines = [];
    lines.push(`# ${session.title}`);
    lines.push(`**Mode:** ${modeLabel}  ·  **Date:** ${new Date(session.id).toLocaleString()}\n`);
    lines.push("---\n");

    for (const msg of (session.messages || [])) {
      if (msg.type === "image") {
        lines.push(`**[Image]** ${msg.prompt || ""}\n`);
        if (msg.savedPath) lines.push(`*Saved: ${msg.savedPath}*\n`);
        continue;
      }
      if (msg.role === "user") {
        lines.push(`**You:** ${msg.content || ""}\n`);
        continue;
      }
      if (msg.type === "tool_step") {
        // Show routing badge and tool steps summary
        const routeNote = msg.routedMode && msg.routedMode !== session.mode
          ? ` *(routed → ${msg.routedMode})*` : "";
        lines.push(`**TonyAI${routeNote}:**\n`);
        for (const s of (msg.toolSteps || [])) {
          const icon = TOOL_ICONS[s.name] || "🔧";
          const status = s.status === "error" ? "❌" : "✅";
          const argStr = Object.entries(s.args || {})
            .map(([k,v]) => `${k}: "${String(v).slice(0,80)}"`)
            .join(", ");
          lines.push(`${status} ${icon} \`${s.name}\`(${argStr})`);
          // Show exit code for run_command
          if (s.name === "run_command" && s.result) {
            const m = String(s.result).match(/\[exit (-?\d+)\]/);
            if (m) lines.push(`   → exit ${m[1]}`);
          }
          // Subagent steps
          if (s.subSteps?.length) {
            const def = SUBAGENT_ROLES[s.args?.role] || {};
            lines.push(`   ${def.icon||"🤖"} ${def.label||s.args?.role} subagent (${s.subSteps.length} steps)`);
          }
        }
        if (msg.content) lines.push(`\n${msg.content}`);
        if (msg.taskComplete) lines.push(`\n✅ **Task complete**`);
        if (msg.stopRejected) lines.push(`\n⛔ *Stop rejected: ${msg.stopReason}*`);
        lines.push("");
        continue;
      }
      // Regular assistant message
      lines.push(`**TonyAI:** ${msg.content || ""}\n`);
    }

    lines.push("---");
    lines.push(`*Auto-saved by TonyAI · ${new Date().toLocaleString()}*`);
    return lines.join("\n");
  }

  // Auto-save session transcript to ~/TonyAI-Exports/
  // Skips sessions with < 3 messages or already saved at this message count.
  async function autoSaveSession(session) {
    const msgs = session?.messages || [];
    const aiMsgs = msgs.filter(m => m.role === "assistant" && m.content?.trim());
    if (msgs.length < 3 || aiMsgs.length < 1) return; // not worth saving

    const key = session.id;
    const savedCount = savedSessionMap.current[key] || 0;
    if (savedCount >= msgs.length) return; // already saved this content

    try {
      const now = new Date();
      const dateDir  = now.toISOString().slice(0, 10);
      const timeStr  = now.toTimeString().slice(0, 8).replace(/:/g, "");
      const slug     = (session.title || "session")
        .slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const filename = `${dateDir}_${timeStr}_${slug}.md`;
      const path     = `${homeDir}/TonyAI-Exports/${filename}`;
      const content  = formatSessionMarkdown(session);
      await invoke("tool_write_file", { path, content });
      savedSessionMap.current[key] = msgs.length;
    } catch (e) {
      console.warn("[TonyAI] Auto-save failed:", e);
    }
  }

  function exportConversation() {
    if (messages.length === 0) return;
    const lines = [];
    const modeLabel = MODES.find(m => m.id === mode)?.label || mode;
    lines.push(`# ${activeSession.title}`);
    lines.push(`_${modeLabel} · ${model} · ${new Date().toLocaleString()}_\n`);
    for (const msg of messages) {
      if (msg.type === "image") {
        lines.push(`---\n**[Image generated]** ${msg.prompt}\n`);
        continue;
      }
      lines.push(`---\n**${msg.role === "user" ? "You" : "TonyAI"}**\n`);
      lines.push((msg.content || "") + "\n");
    }
    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${activeSession.title.replace(/[^a-z0-9]/gi,"_").toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Session inline rename ─────────────────────────────────────────────────
  function saveSessionTitle(id) {
    const title = editingTitle.trim() || "New conversation";
    setSessions(prev => {
      const next = prev.map(s => s.id === id ? { ...s, title } : s);
      persistSessions(next);
      return next;
    });
    setEditingSessionId(null);
  }

  useEffect(() => { bootstrap(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [messages, loading]);

  // Apply mode defaults when mode changes
  useEffect(() => {
    setModelSettings(MODE_DEFAULTS[mode] || MODE_DEFAULTS.chat);
    setShowSnippets(false);
  }, [mode]);

  // Keep shortcutRef in sync with latest functions (no re-registration needed)
  shortcutRef.current = { newSession, clearConversation, exportConversation };
  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tag = document.activeElement?.tagName;
      const inInput = tag === "TEXTAREA" || tag === "INPUT";
      if (!e.shiftKey && e.key === "k" && !inInput) {
        e.preventDefault(); shortcutRef.current.newSession();
      } else if (e.shiftKey && e.key === "X") {
        e.preventDefault(); shortcutRef.current.clearConversation();
      } else if (e.shiftKey && e.key === "E") {
        e.preventDefault(); shortcutRef.current.exportConversation();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Load RAG index when entering arb or auto mode
  useEffect(() => {
    if ((mode === "arb" || mode === "auto") && ragIndex === null && ragStatus === "idle") {
      loadRagIndex();
    }
  }, [mode]);

  // Load knowledge index on startup (all modes can use it)
  useEffect(() => {
    if (knowledgeIndex === null && knowledgeStatus === "idle") {
      loadKnowledgeIndex();
    }
  }, []);

  // ── Knowledge Base: Load ────────────────────────────────────────────────────
  async function loadKnowledgeIndex() {
    setKnowledgeStatus("loading"); setKnowledgeMsg("Loading knowledge index…");
    try {
      const raw = await invoke("read_knowledge_index");
      if (raw === "null" || !raw) {
        setKnowledgeStatus("unindexed"); setKnowledgeMsg("No index — add docs and rebuild");
        setKnowledgeIndex(null); return;
      }
      const idx = JSON.parse(raw);

      // Stale check: compare stored file sizes against current disk
      if (idx.file_sizes?.length > 0) {
        try {
          const currentStats = await invoke("stat_knowledge_files", { dir: knowledgeDir });
          const indexedMap = Object.fromEntries(idx.file_sizes);
          const changed = currentStats.length !== idx.file_sizes.length ||
            currentStats.some(([name, size]) => indexedMap[name] !== size);
          if (changed) {
            setKnowledgeIndex(idx); // still load stale index so it's usable
            setKnowledgeStatus("stale");
            setKnowledgeMsg(`Knowledge stale — ${idx.chunk_count} chunks (rebuild for latest)`);
            return;
          }
        } catch { /* can't stat — assume fresh */ }
      }
      setKnowledgeIndex(idx);
      setKnowledgeStatus("ready");
      setKnowledgeMsg(`${idx.chunk_count} chunks · ${idx.file_count || "?"} files`);
    } catch(e) {
      setKnowledgeStatus("error"); setKnowledgeMsg(e.message || "Load failed");
    }
  }

  // ── Knowledge Base: Build / Rebuild ────────────────────────────────────────
  async function buildKnowledgeIndex() {
    setKnowledgeStatus("indexing"); setKnowledgeMsg("Reading documents…");
    try {
      const files = await invoke("read_knowledge_files", { dir: knowledgeDir });
      if (!files.length) throw new Error(`No supported files found in ${knowledgeDir}`);

      // Chunk all files — structure-aware (headings → paragraphs → chars)
      const allChunks = [];
      for (const [filename, content] of files) {
        allChunks.push(...chunkDocument(content, filename, { maxSize: 1000, minSize: 40 }));
      }

      setKnowledgeMsg(`Embedding ${allChunks.length} chunks from ${files.length} files…`);

      // Verify nomic-embed-text is installed
      const embedInstalled = models.some(m => m.toLowerCase().includes("nomic-embed"));
      if (!embedInstalled) throw new Error("nomic-embed-text not installed. Run: ollama pull nomic-embed-text");

      // Embed in batches of 16
      const BATCH = 16;
      const embedded = [];
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH);
        const texts = batch.map(c => `File: ${c.file}\n\n${c.text}`);
        const raw = await invoke("ollama_post", {
          path: "/api/embed",
          body: JSON.stringify({ model: "nomic-embed-text", input: texts }),
        });
        const data = JSON.parse(raw);
        if (!data.embeddings) throw new Error(`Embed error: ${raw}`);
        for (let j = 0; j < batch.length; j++) {
          embedded.push({
            id: i + j, file: batch[j].file, startLine: batch[j].startLine,
            endLine: batch[j].endLine, text: batch[j].text,
            embedding: data.embeddings[j].map(v => Math.round(v * 10000) / 10000),
          });
        }
        setKnowledgeMsg(`Embedding… ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`);
      }

      const index = {
        version: 1, model: "nomic-embed-text",
        indexed_at: new Date().toISOString(),
        chunk_count: embedded.length,
        file_count: files.length,
        source_dir: knowledgeDir,
        file_sizes: files.map(([name, content]) => [name, new TextEncoder().encode(content).length]),
        chunks: embedded,
      };
      await invoke("save_knowledge_index", { data: JSON.stringify(index) });
      setKnowledgeIndex(index);
      setKnowledgeStatus("ready");
      setKnowledgeMsg(`${embedded.length} chunks · ${files.length} files indexed ✓`);
    } catch(e) {
      setKnowledgeStatus("error"); setKnowledgeMsg(e.message || "Indexing failed");
    }
  }

  async function loadRagIndex() {
    setRagStatus("loading"); setRagMsg("Loading index…");
    try {
      const raw = await invoke("read_rag_index");
      if (raw === "null" || !raw) {
        setRagStatus("unindexed"); setRagMsg("Not indexed yet");
        setRagIndex(null);
        return;
      }
      const idx = JSON.parse(raw);
      setRagIndex(idx);

      // Stale-detection: compare stored file sizes against current disk
      if (idx.file_sizes?.length > 0) {
        try {
          const currentStats = await invoke("stat_source_files", { dir: ragSourceDir });
          const indexedMap   = Object.fromEntries(idx.file_sizes);
          const changed =
            currentStats.length !== idx.file_sizes.length ||
            currentStats.some(([name, size]) => indexedMap[name] !== size);
          if (changed) {
            setRagStatus("stale");
            setRagMsg("Source changed — rebuild?");
            return;
          }
        } catch { /* can't stat, assume fresh */ }
      }

      setRagStatus("ready");
      setRagMsg(`${idx.chunk_count} chunks · ${idx.chunks[0]?.file?.split("/")[0] || ""}`);
    } catch(e) {
      setRagStatus("error"); setRagMsg(e.message || "Load failed");
    }
  }

  async function rebuildRagIndex() {
    setRagStatus("indexing"); setRagMsg("Reading source files…");
    try {
      const files = await invoke("read_source_files", { dir: ragSourceDir });
      if (!files.length) throw new Error("No source files found");

      // Chunk all files — structure-aware (blank-line block boundaries for code)
      const allChunks = [];
      for (const [filename, content] of files) {
        allChunks.push(...chunkDocument(content, `src/${filename}`, { maxSize: 1200, minSize: 80 }));
      }

      setRagMsg(`Embedding ${allChunks.length} chunks…`);

      // Verify nomic-embed-text is installed before attempting embedding
      const embedModel = "nomic-embed-text";
      const embedInstalled = models.some(m => m.toLowerCase().includes("nomic-embed"));
      if (!embedInstalled) {
        throw new Error(
          "nomic-embed-text not found.\n\nInstall it by running:\n  ollama pull nomic-embed-text\n\nthen rebuild the index."
        );
      }

      // Embed in batches of 16
      const BATCH = 16;
      const embedded = [];
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const batch = allChunks.slice(i, i + BATCH);
        const texts = batch.map(c => `File: ${c.file}\n\n${c.text}`);
        const raw = await invoke("ollama_post", {
          path: "/api/embed",
          body: JSON.stringify({ model: embedModel, input: texts }),
        });
        const data = JSON.parse(raw);
        if (!data.embeddings) throw new Error(`Embed API error: ${raw}`);
        for (let j = 0; j < batch.length; j++) {
          embedded.push({
            id: i + j,
            file: batch[j].file,
            startLine: batch[j].startLine,
            endLine: batch[j].endLine,
            text: batch[j].text,
            embedding: data.embeddings[j].map(v => Math.round(v * 10000) / 10000),
          });
        }
        setRagMsg(`Embedding… ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`);
      }

      const index = {
        version: 1, model: embedModel,
        indexed_at: new Date().toISOString(),
        chunk_count: embedded.length,
        // Store file sizes for stale-detection on next load
        file_sizes: files.map(([name, content]) => [name, new TextEncoder().encode(content).length]),
        chunks: embedded,
      };
      await invoke("save_rag_index", { data: JSON.stringify(index) });
      setRagIndex(index);
      setRagStatus("ready");
      setRagMsg(`${embedded.length} chunks indexed`);
    } catch(e) {
      setRagStatus("error"); setRagMsg(e.message || "Indexing failed");
    }
  }

  async function bootstrap() {
    // Fetch home directory from Rust (avoids hardcoded usernames)
    try { const h = await invoke("get_home_dir"); if (h) setHomeDir(h); } catch {}

    // Start any enabled MCP servers
    const enabledServers = mcpServers.filter(s => s.enabled && s.command?.trim());
    for (const srv of enabledServers) {
      initMcpServer(srv); // fire-and-forget; errors update server status
    }

    // Load persistent memory:
    //   Priority 1: disk .md files in ~/TonyAI-Projects/memory/ (new, human-readable)
    //   Priority 2: ~/.tonyai/memory.md JSON blob (old format — used for attachments + migration)
    let baseMemory = { global: { text: "", attachments: [] }, modes: {} };

    // Step 1 — load old format for attachments + as fallback text
    try {
      const raw = await invoke("read_memory");
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            if ("global" in parsed) {
              baseMemory = parsed;
            } else if ("text" in parsed) {
              baseMemory = { global: { text: parsed.text || "", attachments: parsed.attachments || [] }, modes: {} };
            }
          }
        } catch {
          baseMemory = { global: { text: String(raw), attachments: [] }, modes: {} };
        }
      }
    } catch {}

    // Step 2 — load disk .md files (text only — overrides old format text)
    try {
      const filesRaw = await invoke("read_memory_files");
      const files = JSON.parse(filesRaw || "{}");
      if (Object.keys(files).length > 0) {
        // Disk files exist — use their text, keep attachments from old format
        const modes = { ...baseMemory.modes };
        for (const [key, text] of Object.entries(files)) {
          if (key === "global") continue;
          modes[key] = { ...(modes[key] || {}), text };
        }
        baseMemory = {
          global: { text: files.global ?? baseMemory.global?.text ?? "", attachments: baseMemory.global?.attachments || [] },
          modes,
        };
      } else if (baseMemory.global?.text?.trim() || Object.values(baseMemory.modes || {}).some(m => m?.text?.trim())) {
        // Step 3 — no disk files yet, but old format has text → migrate to disk now
        try {
          await invoke("save_memory_file", { name: "global", content: baseMemory.global?.text || "" });
          for (const [modeId, modeData] of Object.entries(baseMemory.modes || {})) {
            if (modeData?.text?.trim()) {
              await invoke("save_memory_file", { name: modeId, content: modeData.text });
            }
          }
        } catch {}
      }
    } catch {}

    setMemory(baseMemory);

    try {
      const raw = await invoke("ollama_tags");
      const data = JSON.parse(raw);
      const names = (data.models||[]).map(m => m.name);
      // Store metadata (age, size) for all models
      const meta = {};
      (data.models||[]).forEach(m => {
        meta[m.name] = { modifiedAt: new Date(m.modified_at), size: m.size };
      });
      setModelMeta(meta);
      // Filter out embedding-only models — they don't support /api/chat
      const chatModels = names.filter(m => !/(embed|minilm|bge-|e5-|gte-)/i.test(m));
      setModels(chatModels);
      setModel(prev => {
        // Keep existing selection if it's still a valid chat model
        if (prev && chatModels.includes(prev)) return prev;
        // Prefer smaller/faster models by default (sort by param count hint in name)
        const sorted = [...chatModels].sort((a, b) => {
          const sizeOf = n => { const m = n.match(/(\d+(\.\d+)?)[bB]/); return m ? parseFloat(m[1]) : 999; };
          return sizeOf(a) - sizeOf(b);
        });
        return sorted[0] || chatModels[0] || "";
      });
      setOllamaOk(true);
    } catch { setOllamaOk(false); }
    // Load monitor inbox
    try { setInbox(JSON.parse(await invoke("read_inbox"))); } catch {}
    try { const r=await fetch(`${A1111_URL}/sdapi/v1/options`); setBknd(p=>({...p,a1111:r.ok?"online":"offline"})); } catch { setBknd(p=>({...p,a1111:"offline"})); }
    try {
      const r=await fetch(`${COMFY_URL}/system_stats`);
      setBknd(p=>({...p,comfy:r.ok?"online":"offline"}));
      if (r.ok) {
        // Fetch real checkpoint list from ComfyUI
        try {
          const cr = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`);
          if (cr.ok) {
            const cd = await cr.json();
            const ckpts = cd?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
            if (ckpts.length > 0) {
              setComfyCheckpoints(ckpts);
              // Auto-select the first checkpoint if none set
              setImgSettings(p => ({ ...p, comfyCheckpoint: p.comfyCheckpoint || ckpts[0] }));
            }
          }
        } catch {}
      }
    } catch { setBknd(p=>({...p,comfy:"offline"})); }
  }

  function updImg(k,v) { setImgSettings(p=>({...p,[k]:v})); }
  function updModelSettings(k,v) { setModelSettings(p=>({...p,[k]:v})); }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const id = Date.now() + Math.random();
      if (file.type.startsWith("image/")) {
        const dataUrl = await readFileAsDataURL(file);
        setAttachments(prev => [...prev, { id, type:"image", name:file.name, content:dataUrl.split(",")[1], preview:dataUrl }]);
      } else if (ATTACH_EXTS.has(extOf(file.name))) {
        const text = await readFileAsText(file);
        setAttachments(prev => [...prev, { id, type:"text", name:file.name, content:text }]);
      }
    }
    e.target.value = "";
  }

  function removeAttachment(id) { setAttachments(prev => prev.filter(a => a.id !== id)); }

  function updateMemory(patch) {
    setMemory(prev => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      clearTimeout(memSaveTimer.current);
      memSaveTimer.current = setTimeout(async () => {
        // Keep old format for attachments (binary data can't live in .md)
        try { await invoke("save_memory", { content: JSON.stringify(next) }); } catch {}
        // Write human-readable .md files to ~/TonyAI-Projects/memory/
        try {
          await invoke("save_memory_file", {
            name: "global",
            content: next.global?.text || "",
          });
        } catch {}
        for (const [modeId, modeData] of Object.entries(next.modes || {})) {
          if (modeData?.text !== undefined) {
            try {
              await invoke("save_memory_file", { name: modeId, content: modeData.text || "" });
            } catch {}
          }
        }
      }, 800);
      return next;
    });
  }

  async function handleMemFileSelect(e) {
    const files = Array.from(e.target.files);
    for (const file of files) {
      const id = Date.now() + Math.random();
      if (file.type.startsWith("image/")) {
        const dataUrl = await readFileAsDataURL(file);
        updateMemory(prev => ({ ...prev, attachments: [...prev.attachments, { id, type:"image", name:file.name, content:dataUrl.split(",")[1], preview:dataUrl }] }));
      } else if (ATTACH_EXTS.has(extOf(file.name))) {
        const text = await readFileAsText(file);
        updateMemory(prev => ({ ...prev, attachments: [...prev.attachments, { id, type:"text", name:file.name, content:text }] }));
      }
    }
    e.target.value = "";
  }

  function removeMemAttachment(id) {
    updateMemory(prev => ({ ...prev, attachments: prev.attachments.filter(a => a.id !== id) }));
  }

  // Click a memory image → add it to the current message's attachments
  function useMemoryImage(att) {
    setAttachments(prev => {
      if (prev.find(a => a.id === att.id)) return prev; // already queued
      return [...prev, att];
    });
  }

  function stopGeneration() {
    invoke("ollama_abort");        // stops Ollama streaming (Rust side)
    abortRef.current?.abort();    // stops in-flight image gen fetch (A1111/ComfyUI)
    setLoading(false);
  }

  // Permission gate helpers — used by agent loop before any state-changing tool
  // (run_command, write_file, python_exec, MCP). Resolves on Allow, rejects on Deny.
  function requestToolPermission(name, detail) {
    return new Promise((resolve, reject) => {
      pendingCmdRef.current = { resolve, reject };
      setPendingCmd({ name, detail: detail || "" });
    });
  }
  function allowCmd() { pendingCmdRef.current?.resolve(); setPendingCmd(null); }
  function denyCmd()  { pendingCmdRef.current?.reject(new Error("denied")); setPendingCmd(null); }

  function clearConversation() {
    if (messages.length === 0) return;
    setMessages([]);
    updateSession({ title: "New conversation" });
  }

  // Regenerate: strip last AI response(s), re-run with same user prompt
  // Passes historyOverride directly to send() to avoid React batching issues
  function regenerate() {
    if (loading || messages.length === 0) return;
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    const lastUserIdx = messages.lastIndexOf(lastUser);
    // priorHistory = everything before the last user message; send() will re-add it
    send(lastUser.content, messages.slice(0, lastUserIdx));
  }

  // ── Model update helpers ──────────────────────────────────────────────────
  function modelAgeDays(name) {
    const m = modelMeta[name];
    if (!m?.modifiedAt) return null;
    return Math.floor((Date.now() - m.modifiedAt.getTime()) / 86_400_000);
  }
  function ageColor(days) {
    if (days === null) return "var(--tny-tx5)";
    if (days < 14)    return "#22c55e";
    if (days < 30)    return "#eab308";
    return "#f97316";
  }
  async function pullModel(name) {
    setPullingModel(name);
    setPullStatus(p => ({ ...p, [name]: null }));
    try {
      await invoke("ollama_pull", { model: name });
      setPullStatus(p => ({ ...p, [name]: "done" }));
      await bootstrap(); // refresh meta + model list
    } catch(e) {
      setPullStatus(p => ({ ...p, [name]: `error: ${String(e)}` }));
    } finally {
      setPullingModel(null);
    }
  }

  // ── Inbox handlers ────────────────────────────────────────────────────────
  async function markInboxRead(id) {
    const updated = inbox.map(f => f.id === id ? { ...f, read: true } : f);
    setInbox(updated);
    try { await invoke("save_inbox", { data: JSON.stringify(updated) }); } catch {}
  }
  async function markAllInboxRead() {
    const updated = inbox.map(f => ({ ...f, read: true }));
    setInbox(updated);
    try { await invoke("save_inbox", { data: JSON.stringify(updated) }); } catch {}
  }
  function askTonyAIAbout(finding) {
    const ctx = finding.context?.trim()
      ? `\n\nRelevant log context:\n${finding.context.slice(0, 800)}`
      : "";
    setInput(`[Alert: ${finding.title}]\n${finding.body}${ctx}`);
    setShowInbox(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function send(promptOverride, historyOverride) {
    const prompt = promptOverride !== undefined ? promptOverride : input.trim();
    if (!prompt && !attachments.length) return;
    if (loading) return;
    if (promptOverride === undefined) setInput("");
    setLoading(true);

    // Auto-routing: classify the prompt, pick the best mode's behavior
    const effectiveMode = mode === "auto" ? classifyPrompt(prompt) : mode;

    // Tiered model routing: when smart-route is on, pick best installed model for this task
    const activeModel = smartRoute
      ? pickModelForMode(effectiveMode, models, model)
      : model;

    if (effectiveMode==="image") {
      const id = Date.now();
      setMessages(prev=>[...prev,
        { role:"user", content:prompt },
        { role:"assistant", type:"image", prompt, generating:true, progress:0, progressText:"Starting…", id, settings:{ ...imgSettings } },
      ]);
      const [w,h] = imgSettings.size.split("×").map(Number);
      const imgCtrl = new AbortController();
      abortRef.current = imgCtrl;
      try {
        let imageUrl;
        if (imgSettings.backend==="a1111") {
          const pi = setInterval(async()=>{
            try {
              const pr=await fetch(`${A1111_URL}/sdapi/v1/progress`);
              if(!pr.ok) return;
              const pd=await pr.json();
              const pct=Math.round((pd.progress||0)*100);
              setMessages(prev=>prev.map(m=>m.id===id?{...m,progress:pct,progressText:`${pct}% — step ${pd.state?.sampling_step||0}/${pd.state?.sampling_steps||imgSettings.steps}`}:m));
            } catch {}
          },1000);
          try {
            imageUrl = await generateA1111(prompt,imgSettings.negPrompt,w,h,imgSettings.steps,imgSettings.cfg,imgCtrl.signal);
          } finally { clearInterval(pi); }
        } else {
          setMessages(prev=>prev.map(m=>m.id===id?{...m,progressText:"Queued in ComfyUI…"}:m));
          imageUrl = await generateComfy(prompt,imgSettings.negPrompt,w,h,imgSettings.steps,imgSettings.cfg,imgCtrl.signal,imgSettings.comfyCheckpoint);
        }
        setMessages(prev=>prev.map(m=>m.id===id?{...m,generating:false,imageUrl,progress:100}:m));
      } catch(err) {
        if (err.name !== "AbortError") {
          setMessages(prev=>prev.map(m=>m.id===id?{...m,generating:false,error:err.message}:m));
        } else {
          setMessages(prev=>prev.map(m=>m.id===id?{...m,generating:false,error:"Cancelled"}:m));
        }
      }
      abortRef.current = null;
      setLoading(false);
      return;
    }

    // Capture attachments before clearing
    const currentAttachments = [...attachments];
    setAttachments([]);

    // Build display content (with text file names listed)
    const textFiles  = currentAttachments.filter(a => a.type === "text");
    const imageFiles = currentAttachments.filter(a => a.type === "image");

    const userMsg = {
      role: "user",
      content: prompt,
      attachments: currentAttachments.length ? currentAttachments.map(a => ({
        type: a.type, name: a.name, preview: a.preview ?? null
      })) : undefined,
    };
    // historyOverride lets regenerate() bypass stale React state
    const baseHistory = historyOverride !== undefined ? historyOverride : messages;
    const history = [...baseHistory, userMsg];
    setMessages(history);
    if (baseHistory.length === 0) autoTitle(prompt);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      // Build memory injection (text notes + any saved text-file attachments)
      // Per-mode memory: global notes always injected; mode-specific notes injected only for this mode
      const globalMem   = memory.global || { text: "", attachments: [] };
      const modeMem     = (memory.modes || {})[effectiveMode] || { text: "" };
      const memText     = [globalMem.text?.trim(), modeMem.text?.trim()].filter(Boolean).join("\n");
      const memFiles    = (globalMem.attachments || []).filter(a => a.type === "text");
      const memSection = (memText || memFiles.length > 0)
        ? `\n\n[PERSISTENT MEMORY — facts you always know about the user]\n${memText}${
            memFiles.length > 0
              ? "\n\n" + memFiles.map(a => `\`\`\`${langOf(a.name)}\n// Memory file: ${a.name}\n${a.content}\n\`\`\``).join("\n\n")
              : ""
          }\n[END MEMORY]`
        : "";

      // Universal knowledge-cutoff notice — prepended to every system prompt.
      // This is the single most important instruction for getting current information:
      // the model MUST use web_search rather than answering from stale training data.
      const CUTOFF_RULE = `IMPORTANT — KNOWLEDGE CUTOFF & CITATION RULES:
1. Your training data ends in late 2023. Today is ${new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}.
2. For ANY question about current events, prices, news, software versions, or anything time-sensitive — use web_search or deep_search IMMEDIATELY. Do NOT answer from training data for current-information questions.
3. CITATION REQUIRED: When your answer uses information from a web search or fetched page, you MUST include the source URL inline — format: "According to [Title](url)..." or cite the URL at the end of the relevant sentence. Never present search-sourced facts without a URL.
4. Never fabricate specific statistics, prices, dates, or quotes. If you don't have a sourced figure, say so.`;

      let sys = CUTOFF_RULE + "\n\n" +
        (SYSTEM_PROMPTS[effectiveMode] ?? SYSTEM_PROMPTS.chat) +
        memSection +
        (context.trim() ? `\n\n[CONTEXT FILES]\n${context.trim()}\n[END CONTEXT]` : "");

      // Auto mode: append agent tool awareness so the classified specialist prompt
      // knows it can use tools to complete tasks rather than just explain.
      if (mode === "auto") {
        // Scope the tool list to what this classified mode actually gets
        const scopedTools = getToolsForMode(effectiveMode);
        const toolLines   = scopedTools
          .filter(t => t.function.name !== "spawn_subagent")
          .map(t => `- ${t.function.name}: ${(t.function.description||"").split(".")[0]}`)
          .join("\n");
        const hasSubagent = scopedTools.some(t => t.function.name === "spawn_subagent");

        sys += `\n\nFILE WORKSPACES:
- Code projects:  ${workspaceDir}/<project-name>/
- Documents/reports: ~/TonyAI-Documents/
- Exports:        ~/TonyAI-Exports/
Use list_dir to check what already exists before creating something new.

TOOLS AVAILABLE FOR THIS TASK (${effectiveMode} mode):
${toolLines || "(no tools — answer from knowledge only)"}
${hasSubagent ? `- spawn_subagent(role, task): Isolated subagent — researcher | coder | verifier
  Tasks must be self-contained. For complex work: researcher → coder → verifier.` : ""}

VERIFY RULE — mandatory for coding tasks:
After writing code, run it. Check [exit N] — [exit 0] = pass. Non-zero = fix and re-run.
Never write TASK_COMPLETE until you have [exit 0].

Always complete the task fully. When done, end with TASK_COMPLETE on its own line.

MEMORY: If you learn a user preference, project constraint, correction, or recurring fact during this task — save it: read_file ~/TonyAI-Projects/memory/global.md → append bullet under "## Learned Facts" → write_file back → tell user what you saved.`;
      }

      // Arb bot RAG injection
      if (effectiveMode === "arb" && ragIndex && ragStatus === "ready") {
        try {
          const qEmbed = await embedQuery(prompt);
          const chunks = retrieveChunks(ragIndex, qEmbed, 4);
          if (chunks.length > 0) {
            sys += `\n\n[CODEBASE CONTEXT — top ${chunks.length} chunks from arb bot source]\n${formatRagContext(chunks)}\n[END CODEBASE CONTEXT]`;
          }
        } catch (e) { console.warn("Arb RAG failed:", e.message); }
      }

      // General Knowledge Base injection — ALL modes, non-fatal
      // Auto-injects the most relevant passages from ~/TonyAI-Documents/
      if (knowledgeIndex && (knowledgeStatus === "ready" || knowledgeStatus === "stale")) {
        try {
          const qEmbed = await embedQuery(prompt);
          const chunks = retrieveChunks(knowledgeIndex, qEmbed, 3);
          if (chunks.length > 0) {
            sys += `\n\n[PERSONAL KNOWLEDGE BASE — ${chunks.length} relevant passages from your documents]\n${formatRagContext(chunks)}\n[END KNOWLEDGE BASE]`;
          }
        } catch (e) { console.warn("Knowledge RAG failed:", e.message); }
      }
      // Build Ollama messages — enrich current user message with file contents + images
      let ollamaHistory = history.map((msg, idx) => {
        const isLast = idx === history.length - 1;
        const base = { role: msg.role, content: msg.content ?? "" };
        if (isLast && msg.role === "user") {
          // Append text file contents as code blocks
          if (textFiles.length) {
            base.content += "\n\n" + textFiles.map(a =>
              `\`\`\`${langOf(a.name)}\n// File: ${a.name}\n${a.content}\n\`\`\``
            ).join("\n\n");
          }
          // Attach images (vision models only — other models ignore this)
          if (imageFiles.length) base.images = imageFiles.map(a => a.content);
        }
        return base;
      });

      // ── Context compaction ─────────────────────────────────────────────────────
      // Prevents Ollama from silently truncating when message history exceeds numCtx.
      // Level 1 (≥70%): snip old messages to 200 chars each (fast, no extra call).
      // Level 2 (≥85%): LLM-summarize old messages into a dense context block.
      {
        const KEEP_RECENT = 8; // always keep the N most recent messages verbatim
        const estTokens = estimateTokens(sys, ...ollamaHistory.map(m => m.content));
        const ctxLimit  = modelSettings.numCtx;

        if (estTokens > ctxLimit * 0.70 && ollamaHistory.length > KEEP_RECENT + 2) {
          const older  = ollamaHistory.slice(0, ollamaHistory.length - KEEP_RECENT);
          const recent = ollamaHistory.slice(ollamaHistory.length - KEEP_RECENT);

          if (estTokens > ctxLimit * 0.85 && activeModel) {
            // Level 2 — LLM summary
            try {
              const summaryResp = await invoke("ollama_post", {
                path: "/api/chat",
                body: JSON.stringify({
                  model: activeModel,
                  stream: false,
                  messages: [
                    { role: "system", content: "Summarize this conversation in ≤250 words. Preserve: code snippets, addresses/numbers, key decisions, current task state. Be factual and dense." },
                    { role: "user",   content: older.map(m => `[${m.role}]: ${(m.content||"").slice(0,600)}`).join("\n---\n") },
                  ],
                  options: { temperature: 0.1, num_ctx: 16384 },
                }),
              });
              const summary = JSON.parse(summaryResp).message?.content || "";
              ollamaHistory = [
                { role: "user",      content: `[⚡ Context summary — ${older.length} earlier messages]\n${summary}` },
                { role: "assistant", content: "Understood, I have context from the earlier conversation." },
                ...recent,
              ];
              setCompactNotice(`⚡ Summarized ${older.length} older messages to free context space`);
            } catch {
              // Fallback to level 1 snip if summary call fails
              ollamaHistory = [
                ...older.map(m => ({ ...m, content: (m.content||"").slice(0,200) + ((m.content||"").length > 200 ? "…[snipped]" : "") })),
                ...recent,
              ];
              setCompactNotice(`✂ Snipped ${older.length} older messages (context ${Math.round(estTokens/ctxLimit*100)}% full)`);
            }
          } else {
            // Level 1 — snip
            ollamaHistory = [
              ...older.map(m => ({ ...m, content: (m.content||"").slice(0,200) + ((m.content||"").length > 200 ? "…[snipped]" : "") })),
              ...recent,
            ];
            setCompactNotice(`✂ Snipped ${older.length} older messages (context ${Math.round(estTokens/ctxLimit*100)}% full)`);
          }
        }
      }
      // ── End compaction ────────────────────────────────────────────────────────

      if (!activeModel) throw new Error("No model selected — pick one from the sidebar");

      // ── Agentic tool-calling loop — runs for every mode that has a non-empty tool set ──
      // chat + image stay single-shot (empty tool set). All other modes (code, python, sui,
      // arb, agent, auto) get their scoped tool set and run the full ReAct loop.
      const modeToolSet = getActiveToolsForMode(effectiveMode);

      if (modeToolSet.length > 0) {
        // Build conversation history for Ollama (reuse computed sys + ollamaHistory)
        const ollamaMsgs = [{ role:"system", content: sys }, ...ollamaHistory];

        // Tracks every completed tool step this session — used by the stop condition evaluator
        const loopToolSteps = [];

        // Prompt-injection provenance: flips true once untrusted web content (fetch_url /
        // deep_search) enters context this turn. While true, any state-changing tool must
        // be human-approved even if confirmCmds is off. Resets each send().
        let sawWebContent = false;

        // Prompt-based fallback — lists only the active mode's tools so the model
        // doesn't try to call tools outside its scope
        const activeToolNames = modeToolSet.map(t => t.function.name).join(", ");
        const PROMPT_TOOLS_SYS = `\n\nTOOL USE: When you need a tool, respond with ONLY this JSON (no prose, no fences):
{"tool":"<name>","args":{...}}
Available tools for this mode: ${activeToolNames}
After getting results, give your final answer in normal markdown. Never include the JSON in your final answer.`;

        // false = try native tools first; true = use prompt-based fallback
        let usePromptTools = false;

        // Add placeholder message — will show tool steps + eventual final answer
        // For auto mode, record the classified mode so the UI can show "routed to X"
        setMessages(prev => [...prev, { role:"assistant", type:"tool_step", toolSteps:[], content:"", isThinking: true, routedMode: effectiveMode, toolScope: modeToolSet.map(t=>t.function.name) }]);

        try {
          let loopCount = 0;
          const MAX_LOOPS = 10;

          while (loopCount < MAX_LOOPS) {
            loopCount++;
            if (ctrl.signal.aborted) break;

            // Build messages — in prompt mode, override system with tool instructions appended
            const loopMsgs = usePromptTools
              ? [{ role:"system", content: ollamaMsgs[0].content + PROMPT_TOOLS_SYS }, ...ollamaMsgs.slice(1)]
              : ollamaMsgs;

            const agentReqBody = {
              model: activeModel,
              messages: loopMsgs,
              stream: true,
              ...(usePromptTools ? {} : { tools: modeToolSet }),
              options: { temperature: modelSettings.temperature, num_ctx: modelSettings.numCtx },
            };

            const eventId = (Date.now() + loopCount).toString();
            let streamText = "";
            let toolCalls = null;
            let rafId = null;

            const unlisten = await listen(`ollama-chunk-${eventId}`, (event) => {
              for (const line of (event.payload || "").split("\n").filter(Boolean)) {
                try {
                  const j = JSON.parse(line);
                  if (j.message?.content) {
                    streamText += j.message.content;
                    if (rafId === null) {
                      rafId = requestAnimationFrame(() => {
                        setMessages(prev => {
                          const u = [...prev];
                          u[u.length-1] = { ...u[u.length-1], content: streamText, isThinking: false };
                          return u;
                        });
                        rafId = null;
                      });
                    }
                  }
                  // Native tool calls — can arrive in any chunk (done:false in llama3.2)
                  if (j.message?.tool_calls?.length) {
                    toolCalls = j.message.tool_calls;
                  }
                } catch {}
              }
            });

            let invokeErr = null;
            let toolsNotSupported = false;
            try {
              await invoke("ollama_chat", { body: JSON.stringify(agentReqBody), eventId });
            } catch(err) {
              const msg = String(err);
              if (msg.toLowerCase().includes("does not support tools")) {
                toolsNotSupported = true;
              } else if (!msg.includes("cancelled") && !msg.includes("abort")) {
                invokeErr = msg;
              }
            } finally {
              if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
              unlisten();
            }

            if (invokeErr) throw new Error(invokeErr);

            // First time: model doesn't support native tools → switch to prompt mode & retry
            if (toolsNotSupported && !usePromptTools) {
              usePromptTools = true;
              streamText = "";
              loopCount--; // don't count this failed attempt
              setMessages(prev => {
                const u = [...prev];
                u[u.length-1] = { ...u[u.length-1], content: "", isThinking: true };
                return u;
              });
              continue;
            }

            // Empty stream + no tool calls + haven't tried prompt mode yet → model silently
            // rejected the native tool schema. Switch to prompt-fallback and retry.
            if (!streamText.trim() && !toolCalls && !usePromptTools) {
              usePromptTools = true;
              loopCount--;
              setMessages(prev => {
                const u = [...prev];
                u[u.length-1] = { ...u[u.length-1], content: "", isThinking: true };
                return u;
              });
              continue;
            }

            // Flush final streamed text
            if (streamText) {
              setMessages(prev => {
                const u = [...prev];
                u[u.length-1] = { ...u[u.length-1], content: streamText };
                return u;
              });
            }

            // Prompt-based: robust tool call extraction (handles embedded JSON, multiple key conventions)
            if (usePromptTools && !toolCalls) {
              const extracted = extractToolCallFromText(streamText);
              if (extracted) toolCalls = extracted;
            }

            // No tool calls → final answer received — run stop condition evaluator
            if (!toolCalls || toolCalls.length === 0) {
              if (streamText.includes("TASK_COMPLETE")) {
                // Compound check: standard stop conditions + search-skipped guard
                let stopCheck = evaluateStopCondition(loopToolSteps);
                if (stopCheck.canStop && neededSearchButSkipped(prompt, loopToolSteps)) {
                  stopCheck = { canStop: false, reason: "Query asks for current/live information but no web_search was performed. Search first, then answer." };
                }
                if (!stopCheck.canStop) {
                  // Reject premature completion — inject correction and keep looping
                  const correction = `[STOP CONDITION NOT MET] ${stopCheck.reason}`;
                  ollamaMsgs.push({ role:"assistant", content: streamText });
                  ollamaMsgs.push({ role:"user",      content: correction });
                  // Show the correction notice in the UI
                  setMessages(prev => {
                    const u = [...prev];
                    u[u.length-1] = {
                      ...u[u.length-1],
                      content: streamText.replace(/\n?TASK_COMPLETE\s*$/m,"").trimEnd(),
                      stopRejected: true,
                      stopReason: stopCheck.reason,
                    };
                    return u;
                  });
                  // Don't break — continue the loop
                } else {
                  // Evaluator passed — accept completion
                  const clean = streamText.replace(/\n?TASK_COMPLETE\s*$/m, "").trimEnd();
                  setMessages(prev => {
                    const u = [...prev];
                    u[u.length-1] = { ...u[u.length-1], content: clean, taskComplete: true };
                    return u;
                  });
                  // Auto-save transcript now that task is confirmed complete
                  // Small delay so the final message is in state before we read it
                  setTimeout(() => autoSaveSession(activeSession), 400);
                  break;
                }
              } else {
                // No TASK_COMPLETE — model gave a final answer without the marker, accept it
                break;
              }
            }

            // Record assistant's tool-calling turn in history
            if (usePromptTools) {
              ollamaMsgs.push({ role:"assistant", content: streamText });
            } else {
              ollamaMsgs.push({ role:"assistant", content: streamText || "", tool_calls: toolCalls });
            }

            // Regular tool calls run first, spawn_subagent calls last.
            // (Ollama is single-threaded so true parallelism doesn't help; ordering ensures
            // any file/search results are available before subagents start.)
            const spawnCalls   = toolCalls.filter(tc => (tc.function?.name || tc.name) === "spawn_subagent");
            const regularCalls = toolCalls.filter(tc => (tc.function?.name || tc.name) !== "spawn_subagent");
            const orderedCalls = [...regularCalls, ...spawnCalls];

            // Execute each tool call sequentially
            for (const tc of orderedCalls) {
              if (ctrl.signal.aborted) break;

              const fnName = tc.function?.name || tc.name || "unknown";
              const rawArgs = tc.function?.arguments ?? tc.arguments ?? {};
              const parsedArgs = typeof rawArgs === "string"
                ? (() => { try { return JSON.parse(rawArgs); } catch { return {}; } })()
                : rawArgs;
              // llama3.2 wraps arg values as {type,value} objects — unwrap them
              const fnArgs = Object.fromEntries(
                Object.entries(parsedArgs).map(([k, v]) =>
                  [k, (v && typeof v === "object" && "value" in v) ? v.value : v]
                )
              );
              const tcId = tc.id || `call_${Date.now()}`;

              let toolResult;
              let toolBlocked = false;
              let capturedSubResult = null; // captured from spawn_subagent branch for loopToolSteps
              const stepId = `step_${Date.now()}_${Math.random().toString(36).slice(2)}`;

              // Mark tool running in UI
              setMessages(prev => {
                const u = [...prev];
                const last = u[u.length-1];
                u[u.length-1] = { ...last, toolSteps: [...(last.toolSteps||[]), { name:fnName, args:fnArgs, status:"running", result:null, id: stepId }] };
                return u;
              });

              // Layer 1 — hard safety denylist (non-bypassable, ignores confirmCmds).
              const safetyGuard = guardToolCall(fnName, fnArgs);
              if (safetyGuard.blocked) {
                toolBlocked = true;
                toolResult = `⛔ Blocked for safety: ${safetyGuard.reason}. This operation is not allowed.`;
              }
              // Layer 2 — interactive approval for any state-changing tool.
              // Required when confirmCmds is on, OR (regardless of that setting) once
              // untrusted web content has entered context this turn — the prompt-injection
              // guardrail: a human must sign off before web-influenced side effects run.
              else if ((confirmCmds || sawWebContent) && isMutatingTool(fnName)) {
                const detail = (sawWebContent ? "⚠ web content in context — " : "") + toolApprovalDetail(fnName, fnArgs);
                try {
                  await requestToolPermission(fnName, detail);
                } catch {
                  toolBlocked = true;
                  toolResult = "⛔ Blocked by user";
                }
              }

              if (!toolBlocked) {
                // Pre-flight: validate required args (skip for MCP namespaced + native subagent/knowledge)
                const isNamespacedOrCustom = fnName.startsWith("mcp__") || fnName === "spawn_subagent" || fnName === "search_knowledge";
                const argCheck = isNamespacedOrCustom ? { valid: true } : validateToolArgs(fnName, fnArgs, modeToolSet);
                if (!argCheck.valid) {
                  toolResult = `Error: ${argCheck.error}`;
                }
                else try {
                  if (fnName === "web_search") {
                    toolResult = await invoke("tool_web_search", { query: fnArgs.query, braveApiKey: braveApiKey || "" });
                  }
                  else if (fnName === "deep_search") {
                    // ── Smart deep_search: rank → dedupe → parallel fetch → filter junk ──
                    const searchRaw = await invoke("tool_web_search", { query: fnArgs.query, braveApiKey: braveApiKey || "" });
                    const numResults = Math.min(fnArgs.num_results || 3, 5);

                    // Filter rules
                    const SKIP_EXT_RE = /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mov|webm|mp3|wav|zip|gz|tar|exe|dmg|iso)(\?|$|#)/i;
                    const LOW_VALUE_DOMAINS = ["pinterest.", "instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com", "reddit.com/r/", "quora.com"];
                    const PREFERRED_DOMAINS = ["wikipedia.org", "github.com", "stackoverflow.com", "docs.", "developer.", "mozilla.org", "arxiv.org", "apple.com/developer", "microsoft.com/docs", "developers.google.com", "openai.com", "anthropic.com", "ycombinator.com"];

                    // Score & dedupe URLs
                    const urlRe = /https?:\/\/[^\s\)\"\'<>]+/g;
                    const allUrls = [...new Set(searchRaw.match(urlRe) || [])];
                    const seenDomain = new Set();
                    const scored = allUrls
                      .map((url, idx) => {
                        let domain;
                        try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
                        if (SKIP_EXT_RE.test(url)) return null;
                        if (LOW_VALUE_DOMAINS.some(d => domain.includes(d) || url.includes(d))) return null;
                        if (seenDomain.has(domain)) return null;
                        seenDomain.add(domain);
                        let score = Math.max(0, 5 - idx); // earlier results slightly preferred
                        if (PREFERRED_DOMAINS.some(d => domain.includes(d) || url.includes(d))) score += 10;
                        return { url, domain, score };
                      })
                      .filter(Boolean)
                      .sort((a, b) => b.score - a.score)
                      .slice(0, numResults);

                    // Parallel fetch with junk filter
                    const fetched = await Promise.all(scored.map(async ({ url, domain }) => {
                      try {
                        const content = await invoke("tool_fetch_url", { url });
                        if (!content || content.length < 200) return null; // SPA / empty
                        // Detect paywall / login walls in first 500 chars
                        if (/please (log|sign) in|subscribe to (continue|read)|paywall|register to (read|continue)|create an account to/i.test(content.slice(0, 500))) return null;
                        const truncated = content.length > 3500 ? content.slice(0, 3500) + "\n[...content truncated]" : content;
                        return { url, domain, content: truncated };
                      } catch { return null; }
                    }));
                    const successful = fetched.filter(Boolean);

                    // Compose output
                    const parts = [`# Deep Search: "${fnArgs.query}"\n`, `## Search snippets\n${searchRaw}\n`];
                    if (successful.length === 0) {
                      parts.push(`\n_⚠️ No pages could be fetched in full (paywalls, SPAs, or unreachable). Answer from snippets above and cite their URLs._`);
                    } else {
                      parts.push(`\n## Full content from ${successful.length} source${successful.length > 1 ? "s" : ""}`);
                      for (const r of successful) {
                        parts.push(`\n### ${r.domain}\n_Source: ${r.url}_\n\n${r.content}`);
                      }
                    }
                    toolResult = wrapUntrustedContent(`deep_search: ${fnArgs.query}`, parts.join("\n"));
                    sawWebContent = true;
                  }
                  else if (fnName === "fetch_url") {
                    toolResult = wrapUntrustedContent(fnArgs.url, await invoke("tool_fetch_url", { url: fnArgs.url }));
                    sawWebContent = true;
                  }
                  else if (fnName === "read_file")    toolResult = await invoke("tool_read_file",    { path: fnArgs.path });
                  else if (fnName === "list_dir")     toolResult = await invoke("tool_list_dir",     { path: fnArgs.path });
                  else if (fnName === "search_files") toolResult = await invoke("tool_search_files", { dir: fnArgs.dir, pattern: fnArgs.pattern, extensions: fnArgs.extensions ?? null, maxResults: fnArgs.max_results ?? null });
                  else if (fnName === "run_command")  toolResult = await invoke("tool_run_command",  { command: fnArgs.command });
                  else if (fnName === "python_exec")  toolResult = await invoke("tool_python_exec", { code: fnArgs.code, packages: fnArgs.packages ?? null, timeoutSeconds: fnArgs.timeout_seconds ?? null });
                  else if (fnName === "git_status")   toolResult = await invoke("tool_git_status",  { repoPath: fnArgs.repo_path });
                  else if (fnName === "git_diff")     toolResult = await invoke("tool_git_diff",    { repoPath: fnArgs.repo_path, staged: fnArgs.staged ?? null, file: fnArgs.file ?? null });
                  else if (fnName === "git_log")      toolResult = await invoke("tool_git_log",     { repoPath: fnArgs.repo_path, maxCount: fnArgs.max_count ?? null, file: fnArgs.file ?? null });
                  else if (fnName === "git_blame")    toolResult = await invoke("tool_git_blame",   { repoPath: fnArgs.repo_path, file: fnArgs.file, lineStart: fnArgs.line_start ?? null, lineEnd: fnArgs.line_end ?? null });
                  else if (fnName === "write_file") {
                    toolResult = await invoke("tool_write_file", { path: fnArgs.path, content: fnArgs.content });
                    // Verify nudge — appended for runnable code files so the model is
                    // forced to run and check [exit 0] before declaring completion.
                    const codeExts = new Set([".py",".js",".ts",".jsx",".tsx",".sh",".rb",".go",".rs",".java",".c",".cpp",".swift",".kt",".mjs",".cjs"]);
                    const ext = ("." + (fnArgs.path||"").split(".").pop()).toLowerCase();
                    if (codeExts.has(ext)) {
                      toolResult += `\n⚠️ VERIFY REQUIRED: Run this file now with run_command. Check the [exit N] at the end — fix and re-run if non-zero. Do not use TASK_COMPLETE until [exit 0].`;
                    }
                  }
                  else if (fnName.startsWith("mcp__")) {
                    // mcp__{serverId}__{toolName} — route to the correct MCP server
                    const parts      = fnName.split("__");
                    const serverId   = parts[1] || "";
                    const toolName   = parts.slice(2).join("__");
                    const argsVal    = typeof fnArgs === "string"
                      ? (() => { try { return JSON.parse(fnArgs); } catch { return {}; } })()
                      : (fnArgs || {});
                    toolResult = await invoke("mcp_call_tool", {
                      serverId,
                      toolName,
                      arguments: argsVal,
                    });
                  }
                  else if (fnName === "spawn_subagent") {
                    const subRole = fnArgs.role || "researcher";
                    const subTask = fnArgs.task || "";

                    // Initialise step
                    setMessages(prev => {
                      const u = [...prev];
                      const last = u[u.length-1];
                      const updSteps = (last.toolSteps||[]).map(s =>
                        s.id === stepId ? { ...s, subSteps: [], pipelineStages: null } : s
                      );
                      u[u.length-1] = { ...last, toolSteps: updSteps };
                      return u;
                    });

                    let finalResult;

                    if (subRole === "coder") {
                      // Full coder pipeline: coder → verifier → fixer
                      finalResult = await runCoderPipeline({
                        task: subTask,
                        model: activeModel,
                        signal: ctrl.signal,
                        braveApiKey,
                        onStageUpdate: (stages, allSteps) => {
                          setMessages(prev => {
                            const u = [...prev];
                            const last = u[u.length-1];
                            const updSteps = (last.toolSteps||[]).map(s =>
                              s.id === stepId
                                ? { ...s, pipelineStages: stages, subSteps: allSteps || [] }
                                : s
                            );
                            u[u.length-1] = { ...last, toolSteps: updSteps };
                            return u;
                          });
                        },
                      });
                    } else {
                      // Regular single-stage subagent (researcher / verifier / fixer direct)
                      const subResult = await runSubagent({
                        role: subRole, task: subTask, model: activeModel,
                        signal: ctrl.signal, braveApiKey,
                        onProgress: (subSteps) => {
                          setMessages(prev => {
                            const u = [...prev];
                            const last = u[u.length-1];
                            const updSteps = (last.toolSteps||[]).map(s =>
                              s.id === stepId ? { ...s, subSteps } : s
                            );
                            u[u.length-1] = { ...last, toolSteps: updSteps };
                            return u;
                          });
                        },
                      });
                      finalResult = { result: subResult.result, steps: subResult.steps, pipelineStages: null };
                    }

                    toolResult = finalResult.result;
                    capturedSubResult = { result: finalResult.result, steps: finalResult.steps };

                    // Persist final state to step
                    setMessages(prev => {
                      const u = [...prev];
                      const last = u[u.length-1];
                      const updSteps = (last.toolSteps||[]).map(s =>
                        s.id === stepId
                          ? { ...s, subSteps: finalResult.steps, pipelineStages: finalResult.pipelineStages }
                          : s
                      );
                      u[u.length-1] = { ...last, toolSteps: updSteps };
                      return u;
                    });
                  }
                  else if (fnName === "search_knowledge") {
                    if (knowledgeIndex && (knowledgeStatus === "ready" || knowledgeStatus === "stale")) {
                      try {
                        const qEmbed = await embedQuery(fnArgs.query);
                        const chunks = retrieveChunks(knowledgeIndex, qEmbed, 5);
                        toolResult = chunks.length
                          ? formatRagContext(chunks)
                          : "No relevant documents found in knowledge base.";
                      } catch(e) {
                        toolResult = `Knowledge search failed: ${e.message}`;
                      }
                    } else {
                      toolResult = `Knowledge base not ready (status: ${knowledgeStatus}). Add documents to ${knowledgeDir} and click Rebuild.`;
                    }
                  }
                  else toolResult = `Unknown tool: ${fnName}. Available: ${modeToolSet.map(t => t.function.name).join(", ")}`;
                } catch(e) {
                  toolResult = enrichToolError(fnName, e);
                  logError(`tool '${fnName}' failed`, String(e));
                }
              }

              const isToolErr = String(toolResult).startsWith("Error:");

              // Update step status in UI
              setMessages(prev => {
                const u = [...prev];
                const last = u[u.length-1];
                const steps = (last.toolSteps||[]).map(s =>
                  s.id === stepId
                    ? { ...s, status: isToolErr ? "error" : "done", result: String(toolResult) }
                    : s
                );
                u[u.length-1] = { ...last, toolSteps: steps };
                return u;
              });

              // Record step for stop-condition evaluation
              loopToolSteps.push({
                name:     fnName,
                args:     fnArgs,
                status:   isToolErr ? "error" : "done",
                result:   String(toolResult),
                // Preserve subSteps when the tool is spawn_subagent
                ...(fnName === "spawn_subagent" && typeof toolResult === "string" ? {} : {}),
              });
              // For spawn_subagent, attach the subagent's own steps
              if (fnName === "spawn_subagent") {
                const last = loopToolSteps[loopToolSteps.length - 1];
                if (last) last.subSteps = capturedSubResult?.steps || [];
              }

              // Feed result back into history
              if (usePromptTools) {
                // Prompt mode: inject result as a user message (no role:"tool" support needed)
                ollamaMsgs.push({ role:"user", content: `[Tool result: ${fnName}]\n${String(toolResult)}` });
              } else {
                ollamaMsgs.push({ role:"tool", content: String(toolResult), name: fnName, tool_call_id: tcId });
              }
            }

            // ── In-loop compaction ────────────────────────────────────────────
            // Tool results (web pages, file contents) can be very large.
            // After each tool round, compact ollamaMsgs before the next LLM call.
            // Rule: always preserve system (idx 0) + last KEEP_AGENT messages.
            // Older messages get their content snipped (L1) or LLM-summarized (L2).
            {
              const KEEP_AGENT = 6;
              const ctxLimit   = modelSettings.numCtx;
              const estToks    = estimateTokens(...ollamaMsgs.map(m => m.content || ""));

              if (estToks > ctxLimit * 0.70 && ollamaMsgs.length > KEEP_AGENT + 2) {
                const older  = ollamaMsgs.slice(1, ollamaMsgs.length - KEEP_AGENT);
                const recent = ollamaMsgs.slice(ollamaMsgs.length - KEEP_AGENT);

                if (estToks > ctxLimit * 0.85) {
                  // Level 2 — LLM-summarize older research steps
                  try {
                    const summaryResp = await invoke("ollama_post", {
                      path: "/api/chat",
                      body: JSON.stringify({
                        model: activeModel,
                        stream: false,
                        messages: [
                          { role: "system", content: "Summarize these agent research steps in ≤200 words. Preserve: key findings, URLs, numbers, file paths, decisions. Dense facts only." },
                          { role: "user",   content: older.map(m => `[${m.role}]: ${(m.content||"").slice(0, 600)}`).join("\n---\n") },
                        ],
                        options: { temperature: 0.1, num_ctx: 16384 },
                      }),
                    });
                    const summary = JSON.parse(summaryResp).message?.content || "";
                    // Rebuild ollamaMsgs: system + summary pair + recent
                    ollamaMsgs.length = 1;
                    ollamaMsgs.push(
                      { role: "user",      content: `[⚡ Research summary — ${older.length} earlier steps]\n${summary}` },
                      { role: "assistant", content: "Understood, I have the research context. Continuing." },
                      ...recent,
                    );
                    setCompactNotice(`⚡ Agent: summarized ${older.length} older steps to free context`);
                  } catch {
                    // Level 1 fallback: snip in-place
                    for (let i = 1; i < ollamaMsgs.length - KEEP_AGENT; i++) {
                      const c = ollamaMsgs[i].content || "";
                      if (c.length > 400) {
                        ollamaMsgs[i] = { ...ollamaMsgs[i], content: c.slice(0, 400) + "…[snipped]" };
                      }
                    }
                    setCompactNotice(`✂ Agent: snipped ${older.length} older steps (context pressure)`);
                  }
                } else {
                  // Level 1 — snip older content in-place, keep structure intact
                  for (let i = 1; i < ollamaMsgs.length - KEEP_AGENT; i++) {
                    const c = ollamaMsgs[i].content || "";
                    if (c.length > 400) {
                      ollamaMsgs[i] = { ...ollamaMsgs[i], content: c.slice(0, 400) + "…[snipped]" };
                    }
                  }
                  setCompactNotice(`✂ Agent: snipped ${older.length} older steps (${Math.round(estToks/ctxLimit*100)}% full)`);
                }
              }
            }
            // ── End in-loop compaction ─────────────────────────────────────────

            // Clear streamed content before next iteration
            setMessages(prev => {
              const u = [...prev];
              u[u.length-1] = { ...u[u.length-1], content: "", isThinking: true };
              return u;
            });
          } // end while
        } catch(agentErr) {
          setMessages(prev => {
            const u = [...prev];
            u[u.length-1] = { ...u[u.length-1], content: `⚠️ ${agentErr.message}`, error: true };
            return u;
          });
        } finally {
          setLoading(false);
          abortRef.current = null;
        }
        return; // exit send() — agent path handled
      }
      // ── End agent mode ───────────────────────────────────────────────────────

      const reqBody = {
        model: activeModel,
        messages:[{role:"system",content:sys},...ollamaHistory],
        stream:true,
        options: {
          temperature: modelSettings.temperature,
          num_ctx: modelSettings.numCtx,
        },
      };
      console.log("[TonyAI] sending to Ollama, model:", activeModel, smartRoute && activeModel !== model ? `(smart-routed from ${model})` : "", "msgs:", reqBody.messages.length);

      const eventId = Date.now().toString();
      let streamText = "";
      let rafId = null; // rAF handle — limits React re-renders to ~60fps
      setMessages(prev=>[...prev,{ role:"assistant", content:"", ...(mode==="auto" ? { routedMode: effectiveMode } : {}) }]);

      // Listen for streaming chunks emitted by the Rust ollama_chat command.
      // Each payload is one or more raw ndjson lines from Ollama.
      // rAF throttle: accumulate tokens in a local var, flush to React state at most once per frame.
      const unlisten = await listen(`ollama-chunk-${eventId}`, (event) => {
        for (const line of (event.payload || "").split("\n").filter(Boolean)) {
          try {
            const j = JSON.parse(line);
            if (j.message?.content) {
              streamText += j.message.content;
              if (rafId === null) {
                rafId = requestAnimationFrame(() => {
                  setMessages(prev => {
                    const u = [...prev];
                    u[u.length-1] = { ...u[u.length-1], content: streamText };
                    return u;
                  });
                  rafId = null;
                });
              }
            }
          } catch {}
        }
      });

      try {
        // invoke blocks until the full stream is done (or aborted via ollama_abort)
        await invoke("ollama_chat", { body: JSON.stringify(reqBody), eventId });
      } catch(err) {
        const msg = String(err);
        if (!msg.includes("cancelled") && !msg.includes("abort")) {
          setMessages(prev=>[...prev,{role:"assistant",content:`⚠️ ${msg}`,error:true}]);
        }
      } finally {
        // Cancel any pending frame and do one final flush so last tokens always appear
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        if (streamText) {
          setMessages(prev => {
            const u = [...prev];
            u[u.length-1] = { ...u[u.length-1], content: streamText };
            return u;
          });
        }
        unlisten();
        setLoading(false);
        abortRef.current = null;
      }
    } catch(err) {
      setMessages(prev=>[...prev,{role:"assistant",content:`⚠️ ${err.message}`,error:true}]);
      setLoading(false);
      abortRef.current = null;
    }
  }

  function handleKey(e) { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();} }

  const accentMap = isDark ? DARK_ACCENTS : LIGHT_ACCENTS;
  const accent = accentMap[mode] || "#78716c";

  // What model would smart-routing pick for the current mode (for display in header/sidebar)
  const displayModel = smartRoute && models.length > 0
    ? pickModelForMode(mode === "auto" ? "auto" : mode, models, model)
    : model;
  const isRouted = smartRoute && displayModel && displayModel !== model;

  const visibleSnippets = SNIPPETS.filter(s => s.mode === mode);

  return (
    <div style={{ display:"grid", gridTemplateColumns: sidebarOpen ? "240px 1fr" : "1fr", height:"100vh", width:"100vw", background:"var(--tny-bg)", color:"var(--tny-tx1)", fontFamily:"'Inter','Segoe UI',system-ui,sans-serif", overflow:"hidden" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:var(--tny-line2);border-radius:2px}
        ::-webkit-scrollbar-thumb:hover{background:var(--tny-line3)}
        @keyframes bounce{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes spin-fwd{to{transform:rotate(360deg)}}
        @keyframes spin-rev{to{transform:rotate(-360deg)}}
        @keyframes glow{0%,100%{opacity:0.4}50%{opacity:0.9}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .msg{animation:fadeUp 0.25s ease}
        textarea{resize:none}
      `}</style>

      {/* ── Sidebar ── */}
      {sidebarOpen && (
        <div style={{ width:240, background:"var(--tny-sidebar)", borderRight:"1.5px solid rgba(100,70,180,0.30)", boxShadow:"3px 0 16px rgba(0,0,0,0.18)", display:"flex", flexDirection:"column", flexShrink:0, zIndex:10, position:"relative" }}>
          {/* Logo + New Chat */}
          <div style={{ padding:"14px 12px 10px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
              <div style={{ width:27, height:27, borderRadius:8, flexShrink:0, background:"linear-gradient(145deg, #7c5cbf 0%, #4a3480 100%)", boxShadow:"0 2px 8px rgba(90,60,180,0.35), 0 1px 0 rgba(255,255,255,0.15) inset", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                  <circle cx="10" cy="10" r="7.5" stroke="rgba(255,255,255,0.75)" strokeWidth="1.2"/>
                  <circle cx="8.2" cy="9.5" r="1.1" fill="white"/>
                  <circle cx="11.8" cy="9.5" r="1.1" fill="white"/>
                  <path d="M8 12.2 Q10 14 12 12.2" stroke="white" strokeWidth="1.1" fill="none" strokeLinecap="round"/>
                </svg>
              </div>
              <span style={{ fontSize:15, fontWeight:600, letterSpacing:"-0.3px", fontFamily:"'Syne',sans-serif", flex:1, background:isDark?"linear-gradient(135deg, #c4b0ff 0%, #a78bfa 100%)":"linear-gradient(135deg, #4a3480 0%, #6b4fbf 100%)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" }}>TonyAI</span>
              <div style={{ width:7, height:7, borderRadius:"50%", background:ollamaOk?"radial-gradient(circle at 35% 35%, #6ee77a, #28b53a)":"#ef4444", boxShadow:ollamaOk?"0 0 5px rgba(40,181,58,0.4)":"none", flexShrink:0 }} title={ollamaOk?"Online":"Offline"}/>
            </div>
            <button onClick={newSession} style={{ width:"100%", padding:"6px 8px", borderRadius:7, border:"none", background:"transparent", color:"var(--tny-accent)", fontSize:13, cursor:"pointer", fontFamily:"inherit", textAlign:"left", display:"flex", alignItems:"center", gap:7, transition:"background 0.12s" }}
              onMouseEnter={e=>e.currentTarget.style.background="var(--tny-accent-lo)"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{ width:18, height:18, borderRadius:"50%", flexShrink:0, background:"linear-gradient(145deg, #9b7fe8, #6b4fbf)", boxShadow:"0 1px 4px rgba(90,60,180,0.3)", display:"flex", alignItems:"center", justifyContent:"center", color:"white", fontSize:14, fontWeight:300, lineHeight:1 }}>+</div>
              <span>New conversation</span>
            </button>
          </div>

          {/* Session history — Today / Yesterday / date grouping */}
          <div style={{ flex:1, overflowY:"auto", padding:"0 8px" }}>
            {(()=>{
              const sorted = sessions.slice().reverse();
              const now = new Date();
              const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
              const yesterdayStart = todayStart - 86400000;
              const getGroup = id => {
                const d = new Date(id).setHours(0,0,0,0);
                if (d >= todayStart) return "Today";
                if (d >= yesterdayStart) return "Yesterday";
                return new Date(id).toLocaleDateString("en-US", { month:"short", day:"numeric" });
              };
              let lastGroup = null;
              return sorted.map(sess => {
                const group = getGroup(sess.id);
                const showLabel = group !== lastGroup;
                lastGroup = group;
                const isActive = activeId === sess.id;
                return (
                  <div key={sess.id}>
                    {showLabel && (
                      <div style={{ fontSize:10, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", color:isDark?"rgba(180,155,255,0.22)":"rgba(80,60,130,0.42)", padding:"12px 10px 4px" }}>
                        {group}
                      </div>
                    )}
                    <div className={`sitem${isActive?" active":""}`} onClick={()=>{ if(editingSessionId!==sess.id) switchSession(sess.id); }}>
                      <div style={{ width:5, height:5, borderRadius:"50%", flexShrink:0, background: isActive ? (isDark?"rgba(180,160,255,0.65)":"rgba(255,255,255,0.55)") : (isDark?"rgba(160,130,255,0.22)":"rgba(100,70,180,0.3)") }}/>
                      {editingSessionId === sess.id
                        ? <input autoFocus value={editingTitle}
                            onChange={e=>setEditingTitle(e.target.value)}
                            onBlur={()=>saveSessionTitle(sess.id)}
                            onKeyDown={e=>{ if(e.key==="Enter")saveSessionTitle(sess.id); if(e.key==="Escape")setEditingSessionId(null); }}
                            onClick={e=>e.stopPropagation()}
                            style={{ flex:1, background:"transparent", border:"none", borderBottom:"1px solid var(--tny-line3)", color:"var(--tny-tx2)", fontSize:12, fontFamily:"inherit", outline:"none", padding:"0 2px", minWidth:0 }}/>
                        : <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}
                            onDoubleClick={e=>{ e.stopPropagation(); setEditingSessionId(sess.id); setEditingTitle(sess.title); }}>
                            {sess.title}
                          </span>
                      }
                      {editingSessionId !== sess.id && (
                        <div style={{ display:"flex", gap:1 }} onClick={e=>e.stopPropagation()}>
                          <button onClick={e=>forkSession(sess.id,e)} style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:12, padding:"0 3px", opacity:0, transition:"opacity 0.15s" }}
                            onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0"}>⑂</button>
                          {sessions.length > 1 && (
                            <button onClick={e=>deleteSession(sess.id,e)} style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:11, padding:"0 2px", opacity:0, transition:"opacity 0.15s" }}
                              onMouseEnter={e=>e.currentTarget.style.opacity="1"} onMouseLeave={e=>e.currentTarget.style.opacity="0"}>✕</button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>

          {/* Image settings — only when image mode */}
          {mode==="image" && (
            <ImageSettings settings={imgSettings} onChange={updImg} backendStatus={backendStatus} checkpoints={comfyCheckpoints}/>
          )}

          {/* Knowledge Base status — above the model row */}
          <div style={{ borderTop:`0.5px solid ${isDark?"rgba(130,100,220,0.10)":"rgba(120,100,180,0.12)"}`, padding:"8px 10px 6px", flexShrink:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              {/* Status dot */}
              <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
                background: knowledgeStatus==="ready" ? "#22c55e"
                  : knowledgeStatus==="stale" ? "#fb923c"
                  : knowledgeStatus==="indexing" ? "#fbbf24"
                  : knowledgeStatus==="error" ? "#ef4444"
                  : "var(--tny-tx5)",
                boxShadow: knowledgeStatus==="ready" ? "0 0 5px rgba(34,197,94,0.5)" : "none" }}/>
              <span style={{ fontSize:10, color:"var(--tny-tx4)", fontFamily:"'JetBrains Mono',monospace", flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                📚 {knowledgeStatus==="ready"||knowledgeStatus==="stale" ? knowledgeMsg
                  : knowledgeStatus==="indexing" ? knowledgeMsg
                  : knowledgeStatus==="error" ? `⚠ ${knowledgeMsg}`
                  : "Knowledge base"}
              </span>
              <button onClick={buildKnowledgeIndex}
                disabled={knowledgeStatus==="indexing"}
                title={`Index all docs in ${knowledgeDir}`}
                style={{ background:"none", border:`0.5px solid ${knowledgeStatus==="stale"?"#fb923c":"var(--tny-line2)"}`, color:knowledgeStatus==="stale"?"#fb923c":"var(--tny-tx4)", borderRadius:5, padding:"2px 6px", fontSize:10, cursor:knowledgeStatus==="indexing"?"not-allowed":"pointer", fontFamily:"inherit", flexShrink:0 }}>
                {knowledgeStatus==="indexing" ? "⏳" : knowledgeStatus==="stale" ? "↺" : "⊕"}
              </button>
            </div>
          </div>

          {/* Sidebar bottom — model row (matches design spec) */}
          <div style={{ borderTop:`0.5px solid ${isDark?"rgba(130,100,220,0.10)":"rgba(120,100,180,0.12)"}`, padding:"10px 10px 13px", flexShrink:0 }}>
            {/* Clickable model row — click to expand full selector */}
            {(() => {
              const age = modelAgeDays(model);
              const stale = age !== null && age > 30;
              const dotBg = !ollamaOk ? "#ef4444"
                : stale ? "#f97316"
                : "radial-gradient(circle at 35% 35%, #6ee77a, #28b53a)";
              const dotShadow = !ollamaOk ? "none"
                : stale ? "0 0 5px rgba(249,115,22,0.5)"
                : "0 0 5px rgba(40,181,58,0.4)";
              return (
                <div onClick={()=>setShowModelSettings(p=>!p)}
                  style={{ display:"flex", alignItems:"center", gap:7, padding:"6px 8px", borderRadius:7, cursor:"pointer", transition:"background 0.1s" }}
                  onMouseEnter={e=>e.currentTarget.style.background=isDark?"rgba(160,130,255,0.07)":"rgba(100,70,200,0.07)"}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{ width:7, height:7, borderRadius:"50%", background:dotBg, boxShadow:dotShadow, flexShrink:0 }} title={stale?`${age}d since last update — click to pull`:""}/>
                  <span style={{ fontSize:11, color:"var(--tny-tx3)", fontFamily:"'JetBrains Mono','SF Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
                    {(model||"…").split(":")[0]} · {smartRoute?"auto":"manual"}
                  </span>
                  {stale && <span style={{ fontSize:9, color:"#f97316", fontFamily:"'JetBrains Mono',monospace", flexShrink:0 }}>{age}d</span>}
                  <button onClick={e=>{e.stopPropagation();setIsDark(p=>!p);}} style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, color:"var(--tny-tx4)", padding:2, lineHeight:1 }}>{isDark?"☀":"🌙"}</button>
                </div>
              );
            })()}
            {/* Expanded model selector */}
            {showModelSettings && (
              <div style={{ marginTop:6, padding:"8px 8px 6px", background:isDark?"rgba(160,130,255,0.05)":"rgba(100,70,200,0.04)", borderRadius:8, border:`0.5px solid var(--tny-line2)` }}>
                <select value={model} onChange={e=>setModel(e.target.value)}
                  style={{ width:"100%", background:"transparent", border:"none", color:"var(--tny-tx2)", fontSize:11, fontFamily:"'JetBrains Mono',monospace", cursor:"pointer", outline:"none", marginBottom:5 }}>
                  {models.length > 0 ? models.map(m=><option key={m}>{m}</option>) : <option>No models</option>}
                </select>
                {/* Age + pull row for selected model */}
                {model && (() => {
                  const age = modelAgeDays(model);
                  const isPulling = pullingModel === model;
                  const status = pullStatus[model];
                  return (
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5 }}>
                      {age !== null && (
                        <span style={{ fontSize:10, color:ageColor(age), fontFamily:"'JetBrains Mono',monospace", flexShrink:0 }}>
                          {age}d ago
                        </span>
                      )}
                      <button
                        onClick={() => pullModel(model)}
                        disabled={!!pullingModel}
                        style={{ flex:1, background: status==="done" ? "rgba(34,197,94,0.08)" : "transparent", border:`0.5px solid ${status==="done"?"rgba(34,197,94,0.3)":isPulling?"var(--tny-line3)":"var(--tny-line2)"}`, color: status==="done" ? "#22c55e" : isPulling ? "var(--tny-tx3)" : "var(--tny-tx4)", cursor:pullingModel?"not-allowed":"pointer", borderRadius:6, padding:"3px 8px", fontSize:10, fontFamily:"inherit" }}>
                        {isPulling ? "⟳ Pulling…" : status==="done" ? "✓ Up to date" : status?.startsWith("error") ? "⚠ Retry pull" : "⬇ Pull update"}
                      </button>
                    </div>
                  );
                })()}
                <button onClick={()=>setSmartRoute(p=>!p)}
                  style={{ width:"100%", background:smartRoute?`${accent}10`:"transparent", border:`0.5px solid ${smartRoute?accent+"44":"var(--tny-line2)"}`, color:smartRoute?accent:"var(--tny-tx4)", cursor:"pointer", borderRadius:6, padding:"4px 8px", fontSize:10, fontFamily:"inherit", fontWeight:smartRoute?500:400 }}>
                  ⚡ Smart routing {smartRoute?"on":"off"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main content area ── */}
      <div className="main-col">
        {/* Header */}
        <div className="tny-header">
          <button onClick={()=>setSidebar(p=>!p)}
            style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:16, padding:"5px 7px", borderRadius:6, lineHeight:1, transition:"all 0.1s" }}
            onMouseEnter={e=>e.currentTarget.style.background="var(--tny-raised)"}
            onMouseLeave={e=>e.currentTarget.style.background="none"}>
            ☰
          </button>

          {/* Mode pill */}
          <div style={{ display:"flex", alignItems:"center", gap:5, background:"var(--tny-accent-lo)", border:"0.5px solid var(--tny-line2)", borderRadius:20, padding:"3px 12px 3px 8px", flexShrink:0 }}>
            {/* Mode dot */}
            <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0, background:isDark?`radial-gradient(circle at 35% 35%, #c4b0ff, ${accent})`:`radial-gradient(circle at 35% 35%, #a78bfa, ${accent})`, boxShadow:`0 0 6px ${accent}88` }}/>
            {/* Mode name — matches spec */}
            <span style={{ fontSize:12, fontWeight:500, letterSpacing:"-0.01em", color:isDark?"rgba(190,170,255,0.9)":"#4e35a0" }}>
              {mode==="image"
                ? (IMAGE_BACKENDS.find(b=>b.id===imgSettings.backend)?.label?.split("/")[0]?.trim()||"image").toLowerCase()
                : mode==="auto" && messages.length>0
                  ? classifyPrompt(messages[messages.length-1]?.content||"")
                  : (MODES.find(m=>m.id===mode)?.label||mode).toLowerCase()}
            </span>
          </div>

          <div style={{ flex:1 }}/>

          {/* Right actions — Memory · Context · MCP · Export · Settings · Ollama */}
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <button onClick={()=>setShowMemory(p=>!p)} className={`header-btn${showMemory?" active":""}`}>Memory</button>
            {mode!=="image" && <button onClick={()=>setShowContext(p=>!p)} className={`header-btn${showContext?" active":""}`}>Context</button>}
            <button onClick={()=>setShowMcpPanel(p=>!p)} className={`header-btn${showMcpPanel?" active":""}`}>MCP</button>
            <button onClick={exportConversation} className="header-btn">Export</button>
            <button onClick={()=>setAgentPanel(p=>!p)} className={`header-btn${showAgentPanel?" active":""}`} title="Search API key & settings">⚙ Search</button>
            {/* Alerts button with unread badge */}
            {(() => {
              const unread      = inbox.filter(f => !f.read).length;
              const hasCritical = inbox.some(f => !f.read && f.severity === "critical");
              const hasWarning  = inbox.some(f => !f.read && f.severity === "warning");
              const badgeBg     = hasCritical ? "#ef4444" : hasWarning ? "#f97316" : "#60a5fa";
              return (
                <button onClick={()=>setShowInbox(p=>!p)}
                  className={`header-btn${showInbox?" active":""}`}
                  style={{ position:"relative" }}>
                  Alerts
                  {unread > 0 && (
                    <span style={{ position:"absolute", top:-5, right:-5, background:badgeBg, color:"#fff", borderRadius:"50%", minWidth:15, height:15, fontSize:9, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", padding:"0 3px", lineHeight:1, boxShadow:"0 1px 4px rgba(0,0,0,0.3)" }}>
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </button>
              );
            })()}
            {/* Ollama status badge — green pill per spec */}
            <button onClick={bootstrap}
              style={{ display:"flex", alignItems:"center", gap:5, padding:"4px 10px", height:26,
                background: ollamaOk ? "rgba(34,192,104,0.07)" : "rgba(239,68,68,0.07)",
                border: ollamaOk ? "0.5px solid rgba(34,192,104,0.18)" : "0.5px solid rgba(239,68,68,0.18)",
                borderRadius:20, fontSize:11, fontWeight:400,
                color: ollamaOk ? "rgba(80,220,140,0.75)" : "rgba(250,120,120,0.75)",
                cursor:"pointer", fontFamily:"monospace" }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:ollamaOk?"radial-gradient(circle at 35% 35%, #5effaa, #22c068)":"#ef4444", boxShadow:ollamaOk?"0 0 5px rgba(34,192,104,0.5)":"none" }}/>
              Ollama
            </button>
          </div>
        </div>

        {/* Compaction notice */}
        {compactNotice&&(
          <div style={{ padding:"5px 18px", background:"rgba(251,146,60,0.08)", borderBottom:"1px solid rgba(251,146,60,0.18)", fontSize:11, color:"#fb923c", fontFamily:"'JetBrains Mono',monospace", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
            <span>{compactNotice}</span>
            <button onClick={()=>setCompactNotice("")} style={{ background:"none", border:"none", color:"#fb923c", cursor:"pointer", fontSize:12, padding:"0 2px", lineHeight:1 }}>✕</button>
          </div>
        )}


        {/* Inbox / Monitor alerts panel */}
        {showInbox && (
          <InboxPanel
            inbox={inbox}
            onMarkRead={markInboxRead}
            onMarkAllRead={markAllInboxRead}
            onAsk={askTonyAIAbout}
            onClose={()=>setShowInbox(false)}
            isDark={isDark}
          />
        )}

        {/* Search & Agent settings — available in all modes */}
        {showAgentPanel&&(
          <div style={{ padding:"10px 20px 12px", borderTop:"1px solid var(--tny-line)", background:"var(--tny-sidebar)", flexShrink:0 }}>
            <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>🔍 Web Search Key</div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:12, color:"var(--tny-tx3)", whiteSpace:"nowrap" }}>Search API key</span>
              <input type="password" value={braveApiKey} onChange={e=>setBraveApiKey(e.target.value)}
                placeholder="Serper key, Brave BSA… key, or type  searxng"
                style={{ flex:1, background:"var(--tny-surface)", border:"1px solid var(--tny-line2)", borderRadius:6, padding:"5px 9px", fontSize:12, color:"var(--tny-tx1)", fontFamily:"'JetBrains Mono',monospace", outline:"none" }}/>
            </div>
            <div style={{ marginTop:6, fontSize:11, color:"var(--tny-tx4)", lineHeight:1.6 }}>
              <b style={{ color:"var(--tny-tx3)" }}>Serper.dev</b> — easiest: sign in with Google at <span style={{ color:accent }}>serper.dev</span>, free 2,500 searches/month<br/>
              <b style={{ color:"var(--tny-tx3)" }}>Brave</b> — key starts with BSA, get free key at <span style={{ color:accent }}>api.search.brave.com</span><br/>
              <b style={{ color:"var(--tny-tx3)" }}>SearXNG local</b> — type <span style={{ fontFamily:"'JetBrains Mono',monospace" }}>searxng</span>, run: <span style={{ fontFamily:"'JetBrains Mono',monospace" }}>docker run -d -p 8080:8080 searxng/searxng</span><br/>
              <b style={{ color:"var(--tny-tx3)" }}>No key</b> — uses DuckDuckGo HTML scrape (works, less reliable)
            </div>
            <div style={{ marginTop:10, paddingTop:8, borderTop:"1px solid var(--tny-line)" }}>
              <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:6 }}>Permissions</div>
              <label style={{ display:"flex", alignItems:"center", gap:7, fontSize:11, color:"var(--tny-tx3)", cursor:"pointer", userSelect:"none" }}>
                <input type="checkbox" checked={confirmCmds} onChange={e=>setConfirmCmds(e.target.checked)} style={{ accentColor:accent, width:13, height:13 }}/>
                <span>Ask before running commands <span style={{ color:"var(--tny-tx5)" }}>(run_command)</span></span>
              </label>
              <div style={{ marginTop:4, fontSize:10, color:"var(--tny-tx5)", lineHeight:1.5 }}>
                read_file, list_dir, web_search, fetch_url auto-execute silently — read-only and safe
              </div>
            </div>
          </div>
        )}

        {/* MCP Servers panel */}
        {(mode==="agent"||mode==="auto")&&showMcpPanel&&(
          <div style={{ padding:"12px 20px 14px", borderTop:"1px solid var(--tny-line)", background:"var(--tny-sidebar)", flexShrink:0, maxHeight:380, overflowY:"auto" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase" }}>🔌 MCP Servers</div>
              <button onClick={()=>{
                const id = `mcp_${Date.now()}`;
                setMcpServers(prev=>[...prev,{id,name:"",command:"",args:"",env:{},enabled:false,status:"disconnected",toolCount:0}]);
              }} style={{ background:"none", border:`1px solid ${accent}`, color:accent, borderRadius:5, padding:"2px 8px", fontSize:10, cursor:"pointer", fontFamily:"inherit" }}>+ Add</button>
            </div>

            {mcpServers.length === 0 && (
              <div style={{ fontSize:11, color:"var(--tny-tx5)", lineHeight:1.7 }}>
                No MCP servers configured. Click <b>+ Add</b> to connect GitHub, Supabase, Asana, or any custom server.<br/>
                <span style={{ color:"var(--tny-tx4)" }}>Example — GitHub: command <code style={{ fontFamily:"'JetBrains Mono',monospace" }}>npx</code>, args <code style={{ fontFamily:"'JetBrains Mono',monospace" }}>-y @modelcontextprotocol/server-github</code></span>
              </div>
            )}

            {mcpServers.map((srv, idx) => (
              <div key={srv.id} style={{ marginBottom:12, padding:"10px 12px", background:"var(--tny-surface)", border:`1px solid ${srv.status==="connected"?"rgba(52,211,153,0.35)":srv.status==="error"?"rgba(239,68,68,0.35)":"var(--tny-line)"}`, borderRadius:8 }}>
                {/* Row 1: name + status + toggle + remove */}
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                  <input value={srv.name} placeholder="Server name" onChange={e=>setMcpServers(p=>p.map((s,i)=>i===idx?{...s,name:e.target.value}:s))}
                    style={{ flex:1, background:"transparent", border:"none", borderBottom:`1px solid var(--tny-line2)`, color:"var(--tny-tx2)", fontSize:12, fontFamily:"inherit", outline:"none", padding:"1px 0" }}/>
                  <span style={{ fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:srv.status==="connected"?"#34d399":srv.status==="connecting"?"#fbbf24":srv.status==="error"?"#ef4444":"var(--tny-tx5)" }}>
                    {srv.status==="connected"?`🟢 ${srv.toolCount||0} tools`:srv.status==="connecting"?"⏳":srv.status==="error"?"🔴 error":"⚪"}
                  </span>
                  <label style={{ display:"flex", alignItems:"center", gap:4, cursor:"pointer" }}>
                    <input type="checkbox" checked={!!srv.enabled} onChange={async e=>{
                      const enabled = e.target.checked;
                      setMcpServers(p=>p.map((s,i)=>i===idx?{...s,enabled}:s));
                      if (enabled) { initMcpServer({...srv,enabled:true}); }
                      else { stopMcpServer(srv.id); }
                    }} style={{ accentColor:accent }}/>
                    <span style={{ fontSize:10, color:"var(--tny-tx4)" }}>On</span>
                  </label>
                  <button onClick={async()=>{ await stopMcpServer(srv.id); setMcpServers(p=>p.filter((_,i)=>i!==idx)); }}
                    style={{ background:"none", border:"none", color:"var(--tny-tx5)", cursor:"pointer", fontSize:14, lineHeight:1, padding:"0 2px" }}>✕</button>
                </div>
                {/* Row 2: command + args */}
                <div style={{ display:"flex", gap:6 }}>
                  <input value={srv.command} placeholder="command (e.g. npx)" onChange={e=>setMcpServers(p=>p.map((s,i)=>i===idx?{...s,command:e.target.value}:s))}
                    style={{ width:100, background:"var(--tny-code)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:5, padding:"4px 7px", fontSize:11, fontFamily:"'JetBrains Mono',monospace", outline:"none" }}/>
                  <input value={Array.isArray(srv.args)?srv.args.join(" "):srv.args} placeholder="args (space-separated)" onChange={e=>setMcpServers(p=>p.map((s,i)=>i===idx?{...s,args:e.target.value}:s))}
                    style={{ flex:1, background:"var(--tny-code)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:5, padding:"4px 7px", fontSize:11, fontFamily:"'JetBrains Mono',monospace", outline:"none" }}/>
                </div>
                {/* Error detail */}
                {srv.status==="error"&&srv.error&&(
                  <div style={{ marginTop:5, fontSize:10, color:"#f87171", fontFamily:"'JetBrains Mono',monospace", whiteSpace:"pre-wrap", maxHeight:50, overflow:"auto" }}>{srv.error}</div>
                )}
                {/* Tool list preview */}
                {srv.status==="connected"&&mcpDiscoveredTools[srv.id]?.length>0&&(
                  <div style={{ marginTop:6, fontSize:10, color:"var(--tny-tx5)", lineHeight:1.6 }}>
                    Tools: {mcpDiscoveredTools[srv.id].map(t=>t.name).join(", ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* devInspect panel */}
        {showDevInspect&&(mode==="arb"||mode==="sui")&&(
          <DevInspectPanel accent={accent} onClose={()=>setShowDevInspect(false)}/>
        )}

        {/* Snippets panel */}
        {showSnippets&&mode!=="image"&&visibleSnippets.length>0&&(
          <div style={{ padding:"10px 18px 12px", borderTop:"1px solid var(--tny-line)", background:"var(--tny-sidebar)", flexShrink:0 }}>
            <div style={{ fontSize:10, color:"var(--tny-tx5)", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>Snippets — click to paste into input</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {visibleSnippets.map((s,i)=>(
                <button key={i} className="snip" onClick={()=>{ setInput(p => p ? p+"\n\n"+s.code : s.code); setShowSnippets(false); textareaRef.current?.focus(); }}
                  style={{ background:"var(--tny-surface)", border:"1px solid var(--tny-line)", color:"var(--tny-tx3)", borderRadius:8, padding:"6px 12px", fontSize:11, fontFamily:"inherit", cursor:"pointer", transition:"all 0.15s", textAlign:"left" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Memory panel */}
        {showMemory&&(()=>{
          const curMode = MODES.find(m => m.id === mode);
          const tabKey  = memTab === "global" ? "global" : mode;
          const tabData = tabKey === "global"
            ? (memory.global || { text:"", attachments:[] })
            : ((memory.modes||{})[tabKey] || { text:"" });
          const tabText = tabData.text || "";
          const tabAtts = tabData.attachments || [];
          const isGlobal = tabKey === "global";

          function saveTabText(v) {
            if (isGlobal) {
              updateMemory(prev => ({ ...prev, global: { ...(prev.global||{text:"",attachments:[]}), text: v } }));
            } else {
              updateMemory(prev => ({ ...prev, modes: { ...(prev.modes||{}), [tabKey]: { ...((prev.modes||{})[tabKey]||{text:""}), text: v } } }));
            }
          }
          function clearTab() {
            if (isGlobal) {
              updateMemory(prev => ({ ...prev, global: { text:"", attachments:[] } }));
            } else {
              updateMemory(prev => ({ ...prev, modes: { ...(prev.modes||{}), [tabKey]: { text:"" } } }));
            }
          }

          return (
            <div style={{ padding:"10px 18px 12px", borderTop:"1px solid var(--tny-line)", background:"var(--tny-sidebar)", flexShrink:0 }}>
              {/* Header row */}
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <span style={{ fontSize:10, color:"var(--tny-tx5)", textTransform:"uppercase", letterSpacing:"0.08em", flex:1 }}>🧠 Memory</span>
                {isGlobal && <button onClick={()=>memFileInputRef.current?.click()} style={{ background:"none", border:"1px solid var(--tny-line2)", color:"var(--tny-tx4)", cursor:"pointer", fontSize:10, fontFamily:"inherit", borderRadius:5, padding:"2px 7px" }}>+ Attach</button>}
                {(tabText||tabAtts.length>0) && <button onClick={clearTab} style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>✕ Clear</button>}
                <span style={{ fontSize:10, color:"var(--tny-tx5)" }}>auto-saves</span>
              </div>

              {/* Tab switcher */}
              <div style={{ display:"flex", gap:4, marginBottom:8 }}>
                <button onClick={()=>setMemTab("global")}
                  style={{ padding:"3px 10px", borderRadius:6, border:`1px solid ${memTab==="global"?accent:"var(--tny-line)"}`, background:memTab==="global"?`${accent}18`:"none", color:memTab==="global"?accent:"var(--tny-tx4)", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                  🌐 Global
                </button>
                {curMode && mode !== "image" && (
                  <button onClick={()=>setMemTab(mode)}
                    style={{ padding:"3px 10px", borderRadius:6, border:`1px solid ${memTab===mode?accent:"var(--tny-line)"}`, background:memTab===mode?`${accent}18`:"none", color:memTab===mode?accent:"var(--tny-tx4)", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                    {curMode.icon} {curMode.label}
                  </button>
                )}
              </div>

              {/* Hidden file input — global only */}
              <input ref={memFileInputRef} type="file" multiple style={{ display:"none" }}
                accept="image/*,.ts,.tsx,.js,.jsx,.rs,.py,.move,.txt,.md,.json,.csv,.toml,.yaml,.yml,.sh,.sql"
                onChange={handleMemFileSelect}/>

              {/* Text area */}
              <textarea value={tabText} onChange={e=>saveTabText(e.target.value)}
                placeholder={isGlobal
                  ? "Facts Tony always knows:\n- My Sui wallet: 0x43a5…\n- Arb bot: pm2 as 'sui-arb-bot'\n- Prefer concise answers"
                  : `Notes for ${curMode?.label||mode} mode only…`}
                style={{ width:"100%", height:90, background:"var(--tny-bg)", border:`1px solid ${tabText?"var(--tny-line3)":"var(--tny-line2)"}`, color:"var(--tny-tx3)", borderRadius:8, padding:"8px 10px", fontSize:12, fontFamily:"'JetBrains Mono',monospace", outline:"none", resize:"vertical", lineHeight:1.6 }}/>

              {/* File chips — global only */}
              {isGlobal && tabAtts.length > 0 && (
                <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:8 }}>
                  {tabAtts.map(att => att.type==="image" ? (
                    <div key={att.id} style={{ position:"relative", cursor:"pointer" }} title="Click to add to current message" onClick={()=>useMemoryImage(att)}>
                      <img src={att.preview} alt={att.name} style={{ width:48, height:48, borderRadius:6, objectFit:"cover", border:"1px solid var(--tny-line2)", opacity:0.85 }}/>
                      <button onClick={e=>{e.stopPropagation();removeMemAttachment(att.id);}}
                        style={{ position:"absolute", top:-5, right:-5, width:16, height:16, borderRadius:"50%", background:"var(--tny-error-bg)", border:"1px solid var(--tny-error-border)", color:"var(--tny-error-text)", cursor:"pointer", fontSize:9, padding:0, lineHeight:"14px", display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                      <div style={{ position:"absolute", bottom:0, left:0, right:0, background:"rgba(0,0,0,0.5)", borderRadius:"0 0 6px 6px", fontSize:8, color:"var(--tny-tx4)", textAlign:"center", padding:"1px 3px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{att.name}</div>
                    </div>
                  ) : (
                    <div key={att.id} style={{ display:"flex", alignItems:"center", gap:4, background:"var(--tny-code)", border:"1px solid var(--tny-line2)", borderRadius:6, padding:"3px 8px", fontSize:11, color:"var(--tny-tx4)" }}>
                      <span>📄</span>
                      <span style={{ maxWidth:100, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{att.name}</span>
                      <button onClick={()=>removeMemAttachment(att.id)} style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:11, padding:0, lineHeight:1 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Line count */}
              {(tabText||tabAtts.length>0) && (
                <div style={{ fontSize:10, color:"var(--tny-tx5)", marginTop:4 }}>
                  {tabText.split("\n").filter(Boolean).length} lines{tabAtts.length>0?` · ${tabAtts.length} file${tabAtts.length>1?"s":""}`:""}{isGlobal?" · global":" · mode-specific"} · auto-saved
                </div>
              )}
            </div>
          );
        })()}

        {/* Context panel */}
        {showContext&&mode!=="image"&&(
          <div style={{ padding:"10px 18px 12px", borderTop:"1px solid var(--tny-line)", background:"var(--tny-sidebar)", flexShrink:0 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
              <span style={{ fontSize:10, color:"var(--tny-tx5)", textTransform:"uppercase", letterSpacing:"0.08em" }}>
                Context — paste file contents (injected into every message)
              </span>
              <button onClick={()=>setContext("")} style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>✕ Clear</button>
            </div>
            <textarea
              value={context}
              onChange={e=>setContext(e.target.value)}
              placeholder={mode==="arb"?"Paste src/flash-executor.ts, src/pairs.ts, or any bot file here…":mode==="sui"?"Paste your Move module source here…":"Paste any file content to give the model context…"}
              style={{ width:"100%", height:90, background:"var(--tny-bg)", border:`1px solid ${context?"var(--tny-line3)":"var(--tny-line2)"}`, color:"var(--tny-tx3)", borderRadius:8, padding:"8px 10px", fontSize:12, fontFamily:"'JetBrains Mono',monospace", outline:"none", resize:"vertical", lineHeight:1.5 }}
            />
            {context&&<div style={{ fontSize:10, color:"var(--tny-tx5)", marginTop:3 }}>{context.length.toLocaleString()} chars · ~{Math.ceil(context.length/4).toLocaleString()} tokens</div>}
          </div>
        )}

        {/* Messages — viewport-width centering: explicit calc(100vw-Npx) establishes
            a concrete containing block so margin:auto works in WKWebView */}
        <div className="messages-scroll"
          style={{ width: sidebarOpen ? "calc(100vw - 240px)" : "100vw" }}>
          {/* Inner column: fixed pixel max-width + margin:auto = reliable centering */}
          <div style={{ maxWidth:680, margin:"0 auto", padding:"28px 24px 16px", display:"flex", flexDirection:"column", gap:24 }}>
          {messages.length===0 ? (
            <div className="empty-state">
              {/* Icon mark — "T" in purple gradient per design spec */}
              <div style={{ width:50, height:50, borderRadius:13, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:2, fontSize:20, fontWeight:700, color:isDark?"rgba(200,185,255,0.85)":"white", background:isDark?"linear-gradient(145deg, #3a2870 0%, #221855 100%)":"linear-gradient(145deg, #7c5cbf 0%, #4e35a0 100%)", boxShadow:isDark?"0 4px 16px rgba(40,20,100,0.5), 0 1px 0 rgba(180,160,255,0.10) inset":"0 4px 14px rgba(80,50,160,0.35), 0 1px 0 rgba(255,255,255,0.15) inset", border:isDark?"0.5px solid rgba(160,130,255,0.20)":"none" }}>T</div>
              {/* Heading — always "What can I help with?" per spec */}
              <h1>What can I help with?</h1>
              {/* Subtitle — model name + routing status */}
              <div className="sub">
                {mode==="image"
                  ? IMAGE_BACKENDS.find(b=>b.id===imgSettings.backend)?.label || "image"
                  : `${(displayModel||model||"…").split(":")[0]} · ${smartRoute?"smart routing":"manual"}`}
              </div>
              {/* Chips — generic per spec, plus mode-specific if available */}
              <div style={{ display:"flex", flexWrap:"wrap", gap:7, justifyContent:"center", maxWidth:480 }}>
                {(EXAMPLE_PROMPTS[mode]?.length
                  ? EXAMPLE_PROMPTS[mode]
                  : ["Sui contract","Debug Python","Draft a post","Generate image"]
                ).map((p,i)=>(
                  <button key={i} className="example-chip" onClick={()=>setInput(p)}>{p}</button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.length > 0 && (
            <div className="messages-inner">
              {messages.map((msg,i)=>{
                const isUser  = msg.role==="user";
                const isLastAI = !isUser && msg.type!=="image" && i===messages.length-1;
                return (
                  <div key={i} className={`msg-wrap ${isUser?"user-msg":"ai-msg"}`}>
                    {/* AI avatar — only for non-user */}
                    {!isUser && (
                      <div className="ai-avatar">T</div>
                    )}

                    {/* Message body */}
                    <div style={{ display:"flex", flexDirection:"column", gap:5, minWidth:0, flex: isUser ? "0 0 auto" : "1 1 auto" }}>

                      {/* Routing badge — only when auto classified to a specific mode */}
                      {msg.routedMode && msg.routedMode !== "auto" && (() => {
                        const rm = MODES.find(m=>m.id===msg.routedMode);
                        return rm ? (
                          <span style={{ fontSize:10, fontFamily:"'JetBrains Mono',monospace", color:"var(--tny-tx4)", letterSpacing:"0.04em", textTransform:"lowercase", marginBottom:2, display:"block" }}>
                            {rm.label}
                          </span>
                        ) : null;
                      })()}

                      {/* Bubble / content */}
                      {isUser ? (
                        /* User — dark solid bubble */
                        <div style={{ background:"linear-gradient(145deg, var(--tny-accent-hi) 0%, var(--tny-msg-user) 100%)", color:"var(--tny-msg-user-text)", borderRadius:"18px 18px 4px 18px", padding:"10px 14px", fontSize:13.5, lineHeight:1.52, maxWidth:"68%", wordBreak:"break-word", letterSpacing:"-0.01em", boxShadow:"0 2px 12px rgba(50,30,100,0.40), 0 1px 0 rgba(180,160,255,0.10) inset", border:"0.5px solid rgba(160,130,255,0.22)" }}>
                          {msg.attachments?.length > 0 && (
                            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:msg.content?8:0 }}>
                              {msg.attachments.map((a,j) => a.type==="image" ? (
                                <img key={j} src={a.preview} alt={a.name} style={{ maxWidth:160, maxHeight:120, borderRadius:8, objectFit:"cover", opacity:0.9 }}/>
                              ) : (
                                <div key={j} style={{ display:"flex", alignItems:"center", gap:4, background:"rgba(255,255,255,0.12)", borderRadius:6, padding:"3px 8px", fontSize:11 }}>
                                  <span>📄</span><span>{a.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {msg.content}
                        </div>
                      ) : (
                        /* AI — clean text, no bubble in normal state; white card only for errors */
                        <div className="ai-content"
                          style={{ color: msg.error ? "var(--tny-error-text)" : "var(--tny-tx1)", background: msg.error ? "var(--tny-error-bg)" : undefined, borderRadius: msg.error ? 10 : undefined, padding: msg.error ? "10px 14px" : undefined, border: msg.error ? "1px solid var(--tny-error-border)" : undefined }}>
                          {msg.type==="image" ? <ImageMessage msg={msg}/> :
                           msg.type==="tool_step" ? (
                             <div>
                               <ToolStepMessage steps={msg.toolSteps||[]} accent={accentMap["agent"]||accent}/>
                               {msg.isThinking && !msg.content && (
                                 <div style={{ marginTop: msg.toolSteps?.length ? 10 : 0, paddingLeft:2 }}>
                                   <TypingDots color={accentMap["agent"]||accent}/>
                                 </div>
                               )}
                               {msg.content && (
                                 <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid var(--tny-line)" }}>
                                   {renderMessage(msg.content, runCode)}
                                 </div>
                               )}
                             </div>
                           ) :
                           renderMessage(msg.content||"", runCode)}

                          {msg.taskComplete && (
                            <div style={{ marginTop:12, paddingTop:10, borderTop:"1px solid rgba(34,197,94,0.18)", display:"flex", alignItems:"center", gap:6, fontSize:11, color:"#22c55e", fontFamily:"'JetBrains Mono',monospace" }}>
                              <span>✅</span><span style={{ fontWeight:500 }}>Task complete</span>
                            </div>
                          )}
                          {msg.stopRejected && msg.stopReason && (
                            <div style={{ marginTop:8, padding:"6px 10px", borderRadius:7, background:"rgba(251,146,60,0.07)", border:"1px solid rgba(251,146,60,0.22)", display:"flex", alignItems:"flex-start", gap:7, fontSize:11, color:"#fb923c", fontFamily:"'JetBrains Mono',monospace" }}>
                              <span style={{ flexShrink:0 }}>⛔</span>
                              <span><strong>Stop rejected:</strong> {msg.stopReason}</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Action row */}
                      {!isUser && msg.type!=="image" && msg.content && (
                        <div className="msg-actions" style={{ display:"flex", gap:5, marginTop:6 }}>
                          <button onClick={()=>navigator.clipboard.writeText(msg.content)} className="msg-action-btn">Copy</button>
                          {isLastAI&&!loading&&<button onClick={regenerate} className="msg-action-btn">Regenerate</button>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {loading&&mode!=="image"&&(
                <div className="msg-wrap ai-msg">
                  <div className="ai-avatar" style={{ background:isDark?"linear-gradient(145deg,#3a2870,#221855)":"linear-gradient(145deg,#7c5cbf,#4a3480)", boxShadow:isDark?"0 2px 8px rgba(50,30,120,0.40)":"0 2px 6px rgba(80,50,160,0.25), 0 1px 0 rgba(255,255,255,0.12) inset", border:isDark?"0.5px solid rgba(160,130,255,0.20)":"none", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, color:isDark?"rgba(200,185,255,0.85)":"rgba(255,255,255,0.92)" }}>T</div>
                  <div style={{ padding:"8px 0" }}><TypingDots color="var(--tny-tx4)"/></div>
                </div>
              )}
              <div ref={bottomRef}/>
            </div>
          )}
          {messages.length === 0 && <div ref={bottomRef}/>}
          </div>{/* /inner-column */}
        </div>

        {/* tool permission gate */}
        {pendingCmd !== null && (
          <div style={{ padding:"8px 18px", background:"rgba(234,179,8,0.07)", borderTop:"1px solid rgba(234,179,8,0.22)", display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
            <span style={{ fontSize:13, flexShrink:0 }}>⚠️</span>
            <span style={{ fontSize:11, color:"var(--tny-tx3)", flexShrink:0, fontWeight:600 }}>{pendingCmd.name}</span>
            <code style={{ flex:1, fontSize:11, color:"#fbbf24", fontFamily:"'JetBrains Mono',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", minWidth:0 }}>{pendingCmd.detail}</code>
            <button onClick={allowCmd} style={{ background:"rgba(34,197,94,0.14)", border:"1px solid rgba(34,197,94,0.35)", color:"#22c55e", cursor:"pointer", borderRadius:6, padding:"4px 14px", fontSize:11, fontFamily:"inherit", fontWeight:600, flexShrink:0 }}>Allow</button>
            <button onClick={denyCmd}  style={{ background:"none", border:"1px solid var(--tny-line2)", color:"var(--tny-tx4)", cursor:"pointer", borderRadius:6, padding:"4px 10px", fontSize:11, fontFamily:"inherit", flexShrink:0 }}>Deny</button>
          </div>
        )}

        {/* Input — same viewport-width trick for consistent centering */}
        <div className="input-outer"
          style={{ width: sidebarOpen ? "calc(100vw - 240px)" : "100vw" }}>
          <div style={{ maxWidth:680, margin:"0 auto", padding:"0 24px" }}>
          {/* Attachment chips */}
          {attachments.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
              {attachments.map(a => (
                <div key={a.id} style={{ display:"flex", alignItems:"center", gap:5, background:"var(--tny-raised)", border:"1px solid var(--tny-line)", borderRadius:8, padding:"4px 8px", fontSize:11, color:"var(--tny-tx3)", maxWidth:200 }}>
                  {a.type==="image"
                    ? <img src={a.preview} style={{ width:22, height:22, borderRadius:4, objectFit:"cover" }}/>
                    : <span style={{ fontSize:12 }}>📄</span>}
                  <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:120 }}>{a.name}</span>
                  <button onClick={()=>removeAttachment(a.id)} style={{ background:"none", border:"none", color:"var(--tny-tx4)", cursor:"pointer", fontSize:12, padding:0, lineHeight:1, flexShrink:0 }}>✕</button>
                </div>
              ))}
            </div>
          )}

          <input ref={fileInputRef} type="file" multiple style={{ display:"none" }}
            accept="image/*,.ts,.tsx,.js,.jsx,.rs,.py,.move,.txt,.md,.json,.csv,.toml,.yaml,.yml,.sh,.sql"
            onChange={handleFileSelect}/>

          <div className="input-box" style={{ borderColor:(input||attachments.length)?`${accent}66`:undefined }}>
            <button onClick={()=>fileInputRef.current?.click()} title="Attach file or image"
              style={{ width:30, height:30, borderRadius:8, border:"1px solid var(--tny-line)", background:attachments.length?`${accent}18`:"none", color:attachments.length?accent:"var(--tny-tx4)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0, alignSelf:"flex-end", marginBottom:2, transition:"all 0.15s" }}>
              +
            </button>
            <textarea ref={textareaRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={handleKey} rows={1}
              placeholder={INPUT_PLACEHOLDER[mode]||"Ask anything…"}
              className="input-textarea"
              onInput={e=>{e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,140)+"px";}}/>
            {loading
              ? <button onClick={stopGeneration} className="input-send-btn" style={{ background:"#ef4444", color:"#fff", border:"none" }} title="Stop">■</button>
              : <button onClick={()=>send()} disabled={!input.trim()&&!attachments.length}
                  className="input-send-btn"
                  style={{ background:(input.trim()||attachments.length)?"linear-gradient(145deg, #9b7fe8 0%, #6b4fbf 100%)":"var(--tny-line2)", color:(input.trim()||attachments.length)?"#fff":"var(--tny-tx4)", cursor:(input.trim()||attachments.length)?"pointer":"not-allowed", boxShadow:(input.trim()||attachments.length)?"0 2px 8px rgba(100,70,200,0.38)":"none" }}>↑</button>
            }
          </div>
          <div className="input-hints">Enter to send · Shift+Enter newline · + attach · ⌘K new chat</div>
          </div>{/* /input-center */}
        </div>
      </div>
    </div>
  );
}
