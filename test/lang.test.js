import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "../src/lang.js";

test("detects English", () => {
  assert.equal(detectLanguage("Hi, I'm looking for a 2BHK in town"), "en");
});

test("detects Hinglish (Roman)", () => {
  assert.equal(detectLanguage("bhai mujhe 2bhk chahiye budget kitna"), "hinglish");
});

test("detects Gujarati script", () => {
  assert.equal(detectLanguage("મને ઘર જોઈએ છે"), "gu");
});

test("detects Devanagari Hindi", () => {
  assert.equal(detectLanguage("मुझे घर चाहिए"), "hi");
});

test("detects Roman Gujarati via hints", () => {
  assert.equal(detectLanguage("mane ghar joiye che ketlo bhav"), "gu");
});

test("empty input defaults to English", () => {
  assert.equal(detectLanguage(""), "en");
  assert.equal(detectLanguage(undefined), "en");
});
