import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "// managed by omo-herdr-usage";
const LEGACY = { file: "omo-aiusage.js", marker: "// managed by aiusage" };
const agentDir = process.env["OMO_CODING_AGENT_DIR"] ?? process.env["SENPI_CODING_AGENT_DIR"] ?? join(homedir(), ".omo", "agent");
const extDir = join(agentDir, "extensions");
const stub = join(extDir, "omo-herdr-usage.js");
const legacyStub = join(extDir, LEGACY.file);
const entry = pathToFileURL(resolve(import.meta.dir, "..", "omo", "extension.mjs")).href;
const mode = process.argv[2];

function managedBy(path: string, marker: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").startsWith(marker);
}

function removeLegacy(): void {
  if (managedBy(legacyStub, LEGACY.marker)) {
    rmSync(legacyStub);
    console.log(`이전 이름의 확장 제거함: ${legacyStub}`);
  }
}

if (mode === "install") {
  if (existsSync(stub) && !managedBy(stub, MARKER)) {
    console.error(`${stub} 가 이미 있고 omo-herdr-usage가 만든 파일이 아닙니다. 확인 후 지우고 다시 실행하세요.`);
    process.exit(1);
  }
  mkdirSync(extDir, { recursive: true });
  writeFileSync(stub, `${MARKER}\nexport { default } from ${JSON.stringify(entry)};\n`);
  removeLegacy();
  console.log(`설치함: ${stub} -> ${entry}`);
  console.log("herdr 안에서 새 omo 세션을 열거나 /reload 하면 'AI 사용량' pane이 뜹니다. 다시 열 때는 /usage-pane");
} else if (mode === "uninstall") {
  removeLegacy();
  if (!existsSync(stub)) {
    console.log("설치돼 있지 않습니다.");
  } else if (!managedBy(stub, MARKER)) {
    console.error(`${stub} 는 omo-herdr-usage가 만든 파일이 아니라서 지우지 않았습니다.`);
    process.exit(1);
  } else {
    rmSync(stub);
    console.log(`제거함: ${stub}`);
  }
} else {
  console.error("사용법: bun scripts/omo-install.ts install|uninstall");
  process.exit(2);
}
