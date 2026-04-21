// loadBible 파일 I/O + 캐싱 계약 테스트.
//
// - 성공 케이스: data/worldviews/ 밑의 JSON을 WorldviewBibleSchema로 파싱해 반환.
// - 실패 케이스: 존재하지 않는 ID / 스키마 위반 파일 → Error throw.
// - 캐시: 동일 ID로 두 번 호출하면 같은 참조를 반환. clearBibleCache() 후 재로딩 가능.
//
// process.chdir 전역 변경 대신 baseDir 파라미터로 임시 디렉터리를 주입한다.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearBibleCache, loadBible } from "../../../src/core/prompt/load-bible.js";

describe("loadBible", () => {
  beforeEach(() => {
    clearBibleCache();
  });

  it("kingdom_of_light 바이블을 로딩한다", () => {
    const bible = loadBible("kingdom_of_light");
    expect(bible.id).toBe("kingdom_of_light");
    expect(bible.few_shots.length).toBeGreaterThan(0);
  });

  it("starlight_magic_school 바이블을 로딩한다", () => {
    const bible = loadBible("starlight_magic_school");
    expect(bible.id).toBe("starlight_magic_school");
    expect(bible.few_shots.length).toBeGreaterThan(0);
  });

  it("존재하지 않는 worldviewId면 Error를 throw한다", () => {
    expect(() => loadBible("nonexistent_world_id")).toThrow(/세계관 바이블을 찾을 수 없습니다/);
  });

  it("동일 ID로 두 번 로딩하면 같은 참조를 반환한다 (Map 기반 캐싱)", () => {
    const first = loadBible("kingdom_of_light");
    const second = loadBible("kingdom_of_light");
    expect(first).toBe(second);
  });

  it("clearBibleCache() 이후에도 재로딩이 정상 동작한다", () => {
    const before = loadBible("kingdom_of_light");
    clearBibleCache();
    const after = loadBible("kingdom_of_light");
    expect(after.id).toBe(before.id);
    expect(after).not.toBe(before);
  });

  it("서로 다른 ID는 캐시 엔트리가 분리되어 있다", () => {
    const kingdom = loadBible("kingdom_of_light");
    const starlight = loadBible("starlight_magic_school");
    expect(kingdom).not.toBe(starlight);
    expect(kingdom.id).toBe("kingdom_of_light");
    expect(starlight.id).toBe("starlight_magic_school");
  });
});

describe("loadBible — 스키마 검증 실패 (baseDir 주입)", () => {
  let tempRoot: string;

  beforeEach(() => {
    clearBibleCache();
    tempRoot = mkdtempSync(join(tmpdir(), "bible-schema-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    clearBibleCache();
  });

  it("JSON은 유효하지만 WorldviewBibleSchema를 위반하면 Error를 throw한다", () => {
    const dir = join(tempRoot, "data", "worldviews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "broken.json"),
      JSON.stringify({ id: "broken", not_a_real: "field" }),
      "utf-8",
    );
    expect(() => loadBible("broken", tempRoot)).toThrow(/스키마 검증 실패/);
  });

  it("파일 내용이 유효한 JSON이 아니면 Error를 throw한다", () => {
    const dir = join(tempRoot, "data", "worldviews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "malformed.json"), "{ not valid json", "utf-8");
    expect(() => loadBible("malformed", tempRoot)).toThrow(/JSON 파싱 실패/);
  });
});
