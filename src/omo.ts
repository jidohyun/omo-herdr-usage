import { homedir } from "node:os";
import { join } from "node:path";
import { isObj, num, str, type Obj } from "./http";

export const OMO_AUTH_PATH = join(
  process.env["OMO_CODING_AGENT_DIR"] ?? process.env["SENPI_CODING_AGENT_DIR"] ?? join(homedir(), ".omo", "agent"),
  "auth.json",
);

export interface OmoAccount {
  name: string;
  access: string;
  expires: number | null;
  accountId: string | null;
}

export interface OmoAccounts {
  claude: OmoAccount[];
  gpt: OmoAccount[];
}

function account(raw: Obj, fallbackName: string): OmoAccount | null {
  const access = str(raw["access"]);
  if (!access) return null;
  return { name: str(raw["name"]) ?? fallbackName, access, expires: num(raw["expires"]), accountId: str(raw["accountId"]) };
}

function accountsOf(entry: unknown): OmoAccount[] {
  if (!isObj(entry)) return [];
  const list = entry["accounts"];
  if (Array.isArray(list) && list.length > 0) {
    return list.flatMap((a, i) => {
      const parsed = isObj(a) ? account(a, `account-${i + 1}`) : null;
      return parsed ? [parsed] : [];
    });
  }
  const single = account(entry, "default");
  return single ? [single] : [];
}

export function parseOmoAuth(raw: unknown): OmoAccounts {
  if (!isObj(raw)) return { claude: [], gpt: [] };
  return { claude: accountsOf(raw["anthropic-subscription"]), gpt: accountsOf(raw["chatgpt-subscription"]) };
}

export async function readOmoAccounts(path = OMO_AUTH_PATH): Promise<OmoAccounts> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { claude: [], gpt: [] };
  try {
    return parseOmoAuth(await file.json());
  } catch {
    return { claude: [], gpt: [] };
  }
}
