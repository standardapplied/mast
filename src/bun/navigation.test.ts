import { describe, expect, test } from "bun:test";
import { isExternalHttpUrl, newWindowUrl } from "./navigation";

describe("isExternalHttpUrl", () => {
  test("allows http and https", () => {
    expect(isExternalHttpUrl("http://example.com")).toBe(true);
    expect(isExternalHttpUrl("https://example.com/path?q=1")).toBe(true);
  });

  test("blocks non-http(s) schemes and junk", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "views://mainview/index.html",
      "myapp://open",
      "data:text/html,<h1>x</h1>",
      "not a url",
      "",
    ]) {
      expect(isExternalHttpUrl(url)).toBe(false);
    }
  });
});

describe("newWindowUrl", () => {
  test("reads url from the parsed event detail object", () => {
    expect(newWindowUrl({ url: "https://a.com", isCmdClick: true })).toBe("https://a.com");
  });

  test("accepts a bare string detail", () => {
    expect(newWindowUrl("https://b.com")).toBe("https://b.com");
  });

  test("returns null for shapes without a url", () => {
    expect(newWindowUrl({ isCmdClick: true })).toBeNull();
    expect(newWindowUrl(null)).toBeNull();
    expect(newWindowUrl(42)).toBeNull();
  });
});
