import { describe, it, expect } from "vitest";
import { classifyPrompt } from "./classifyPrompt.js";

// ── Image: strong signals (always image regardless of context) ────────────────
describe("image — strong signals", () => {
  it("photorealistic keyword", () => expect(classifyPrompt("photorealistic portrait of a warrior")).toBe("image"));
  it("cinematic shot", () => expect(classifyPrompt("cinematic shot of a foggy city at dawn")).toBe("image"));
  it("oil painting", () => expect(classifyPrompt("oil painting of a mountain lake at sunset")).toBe("image"));
  it("watercolor", () => expect(classifyPrompt("watercolor illustration of a fox in autumn")).toBe("image"));
  it("digital art", () => expect(classifyPrompt("digital art of a cyberpunk samurai")).toBe("image"));
  it("anime style", () => expect(classifyPrompt("anime style girl in a library")).toBe("image"));
  it("neon city", () => expect(classifyPrompt("neon city at 3am, rain-slicked streets")).toBe("image"));
  it("fantasy landscape", () => expect(classifyPrompt("fantasy landscape with floating islands")).toBe("image"));
  it("8k render", () => expect(classifyPrompt("8k render of a crystalline asteroid")).toBe("image"));
  it("style of Monet", () => expect(classifyPrompt("paint this in the style of Monet")).toBe("image"));
  it("style of Ghibli", () => expect(classifyPrompt("forest scene in the style of Ghibli")).toBe("image"));
});

// ── Image: weak signals (no programming context) ──────────────────────────────
describe("image — weak signals (fires without programming context)", () => {
  it("image of a fox", () => expect(classifyPrompt("image of a red fox in snow")).toBe("image"));
  it("photo of mountains", () => expect(classifyPrompt("photo of misty mountains at sunrise")).toBe("image"));
  it("generate a portrait", () => expect(classifyPrompt("generate a portrait of an old sailor")).toBe("image"));
  it("draw a picture", () => expect(classifyPrompt("draw a picture of a lighthouse")).toBe("image"));
  it("create a wallpaper", () => expect(classifyPrompt("create a wallpaper of a galaxy")).toBe("image"));
  it("design a logo", () => expect(classifyPrompt("design a logo for a coffee shop")).toBe("image"));
  it("illustrate a scene", () => expect(classifyPrompt("illustrate a scene of kids playing in a park")).toBe("image"));
});

// ── Image: weak signals overridden by programming context ─────────────────────
describe("image — weak signals suppressed by programming context", () => {
  it("React component that renders an image", () =>
    expect(classifyPrompt("create a React component that renders an image gallery")).toBe("code"));
  it("TypeScript function to process images", () =>
    expect(classifyPrompt("write a TypeScript function to process images")).toBe("code"));
  it("Python script to download images", () =>
    expect(classifyPrompt("write a Python script to download images from a URL")).toBe("python"));
  it("build a component with a photo upload", () =>
    expect(classifyPrompt("build a component with a photo upload feature in React")).toBe("code"));
});

// ── Arb bot ───────────────────────────────────────────────────────────────────
describe("arb bot", () => {
  it("flash loan", () => expect(classifyPrompt("Why is my flash loan failing?")).toBe("arb"));
  it("flash-loan hyphen", () => expect(classifyPrompt("Optimize the flash-loan PTB latency")).toBe("arb"));
  it("arb bot", () => expect(classifyPrompt("restart the arb bot after a circuit breaker")).toBe("arb"));
  it("pairs.ts", () => expect(classifyPrompt("Add a new pair to pairs.ts")).toBe("arb"));
  it("monitor.ts", () => expect(classifyPrompt("Debug the polling loop in monitor.ts")).toBe("arb"));
  it("Turbos swap", () => expect(classifyPrompt("Why does the Turbos swap return wrong output?")).toBe("arb"));
  it("Bluefin pool", () => expect(classifyPrompt("Check the Bluefin pool liquidity")).toBe("arb"));
  it("Cetus route", () => expect(classifyPrompt("Add Cetus to the route for DEEP/SUI")).toBe("arb"));
  it("NAVI_PKG", () => expect(classifyPrompt("NAVI_PKG address changed on mainnet")).toBe("arb"));
  it("flash_loan_with_ctx", () => expect(classifyPrompt("flash_loan_with_ctx_v2 keeps reverting")).toBe("arb"));
  it("pm2 restart", () => expect(classifyPrompt("pm2 restart sui-arb-bot")).toBe("arb"));
  it("circuit breaker", () => expect(classifyPrompt("circuit breaker triggered 3 times today")).toBe("arb"));
  it("daily loss cap", () => expect(classifyPrompt("How does the daily loss cap reset?")).toBe("arb"));
});

// ── Sui / Move ────────────────────────────────────────────────────────────────
describe("sui / move", () => {
  it("Move module", () => expect(classifyPrompt("Write a Move module for an NFT")).toBe("sui"));
  it("PTB", () => expect(classifyPrompt("Explain the PTB hot potato pattern")).toBe("sui"));
  it("programmable transaction", () => expect(classifyPrompt("How do programmable transactions work on Sui?")).toBe("sui"));
  it("hot potato", () => expect(classifyPrompt("Explain the hot potato pattern for flash loans")).toBe("sui"));
  it("sui object", () => expect(classifyPrompt("How do I share a Sui object?")).toBe("sui"));
  it("has key ability", () => expect(classifyPrompt("Does my struct need has key ability?")).toBe("sui"));
  it("transfer::transfer", () => expect(classifyPrompt("Use transfer::transfer to send to address")).toBe("sui"));
  it("tx_context", () => expect(classifyPrompt("How do I get the sender from tx_context?")).toBe("sui"));
  it("one-time witness", () => expect(classifyPrompt("Explain the one-time witness pattern")).toBe("sui"));
  it("sui blockchain", () => expect(classifyPrompt("How does the Sui blockchain handle concurrency?")).toBe("sui"));
  it("sui smart contract", () => expect(classifyPrompt("Deploy a Sui smart contract")).toBe("sui"));
  it("sui coin", () => expect(classifyPrompt("How do I create a custom Sui coin?")).toBe("sui"));
});

// ── Python ────────────────────────────────────────────────────────────────────
describe("python", () => {
  it("python keyword", () => expect(classifyPrompt("write a Python web scraper")).toBe("python"));
  it("Python capitalized", () => expect(classifyPrompt("Python async HTTP client with retry")).toBe("python"));
  it("pandas", () => expect(classifyPrompt("How do I use pandas to pivot a DataFrame?")).toBe("python"));
  it("asyncio", () => expect(classifyPrompt("Best way to use asyncio for I/O concurrency?")).toBe("python"));
  it("pydantic", () => expect(classifyPrompt("Define a pydantic model for a trade record")).toBe("python"));
  it("pytest", () => expect(classifyPrompt("Write a pytest fixture for mocking RPC")).toBe("python"));
  it("dataclass", () => expect(classifyPrompt("Use a dataclass to store trade results")).toBe("python"));
  it("fastapi", () => expect(classifyPrompt("Add an endpoint to my fastapi app")).toBe("python"));
  it("type hints", () => expect(classifyPrompt("Add type hints to all my functions")).toBe("python"));
  it("f-string", () => expect(classifyPrompt("How do f-strings work in Python 3.12?")).toBe("python"));
  it("list comprehension", () => expect(classifyPrompt("Rewrite this loop as a list comprehension")).toBe("python"));
  it(".py file", () => expect(classifyPrompt("Fix the bug in utils.py")).toBe("python"));
  it("pip install", () => expect(classifyPrompt("pip install aiohttp and set up a client")).toBe("python"));
});

// ── Generic code ──────────────────────────────────────────────────────────────
describe("code", () => {
  it("TypeScript", () => expect(classifyPrompt("Write a TypeScript interface for a user")).toBe("code"));
  it("React", () => expect(classifyPrompt("Debug this React hook that fires twice")).toBe("code"));
  it("JavaScript", () => expect(classifyPrompt("Explain JavaScript closures")).toBe("code"));
  it("Rust language", () => expect(classifyPrompt("How do lifetimes work in Rust?")).toBe("code"));
  it("Docker", () => expect(classifyPrompt("Set up docker compose for a Node app")).toBe("code"));
  it("SQL query", () => expect(classifyPrompt("Optimize this sql query with an index")).toBe("code"));
  it("GitHub action", () => expect(classifyPrompt("Add a github action for CI tests")).toBe("code"));
  it("null pointer", () => expect(classifyPrompt("getting a null pointer exception on startup")).toBe("code"));
  it("type error", () => expect(classifyPrompt("type error: cannot read property of undefined")).toBe("code"));
  it("stack trace", () => expect(classifyPrompt("Here's the stack trace, what's wrong?")).toBe("code"));
  it("write a function", () => expect(classifyPrompt("write a function that debounces input")).toBe("code"));
  it("build a class", () => expect(classifyPrompt("build a class that manages a connection pool")).toBe("code"));
  it("refactor", () => expect(classifyPrompt("refactor this component to use hooks")).toBe("code"));
  it("webpack", () => expect(classifyPrompt("configure webpack for tree shaking")).toBe("code"));
  it("api endpoint", () => expect(classifyPrompt("add an api endpoint for user login")).toBe("code"));
});

// ── Chat (default) ────────────────────────────────────────────────────────────
describe("chat (default)", () => {
  it("general knowledge", () => expect(classifyPrompt("What is quantum entanglement?")).toBe("chat"));
  it("history question", () => expect(classifyPrompt("Who was Ada Lovelace?")).toBe("chat"));
  it("opinion question", () => expect(classifyPrompt("What's the best way to learn a new language?")).toBe("chat"));
  it("cooking", () => expect(classifyPrompt("How do I make sourdough bread?")).toBe("chat"));
  it("abstract", () => expect(classifyPrompt("Explain the meaning of life")).toBe("chat"));
  it("geography", () => expect(classifyPrompt("What is the capital of New Zealand?")).toBe("chat"));
  it("finance", () => expect(classifyPrompt("How does compound interest work?")).toBe("chat"));
});

// ── Edge cases ────────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("arb fires before sui even when Move keyword present", () =>
    expect(classifyPrompt("debug the flash loan Move call in flash-executor.ts")).toBe("arb"));

  it("sui fires before python for Move+Python mix", () =>
    expect(classifyPrompt("call a Sui object method from Python")).toBe("sui"));

  it("python fires before code when python + typescript both present", () =>
    expect(classifyPrompt("convert this Python script to TypeScript")).toBe("python"));

  it("image strong overrides arb context", () =>
    expect(classifyPrompt("photorealistic Turbos DEX logo neon city style")).toBe("image"));

  it("empty string → chat", () =>
    expect(classifyPrompt("")).toBe("chat"));

  it("whitespace only → chat", () =>
    expect(classifyPrompt("   ")).toBe("chat"));

  it("Turbos alone (no swap/pool context) → chat not arb", () =>
    expect(classifyPrompt("What is Turbos?")).toBe("chat"));

  it("Bluefin alone → chat not arb", () =>
    expect(classifyPrompt("Tell me about Bluefin")).toBe("chat"));

  it("Rust learning question → code (hasLang match)", () =>
    expect(classifyPrompt("best way to learn Rust as a beginner")).toBe("code"));
});
