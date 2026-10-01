import { accountLabel, isHidden, providerId, type Account } from "./accounts";
import { truncate } from "./render";

export interface PickerItem {
  id: string;
  keys: string[];
  kind: "claude" | "codex";
  label: string;
  live: boolean;
  shown: boolean;
}

export function pickerItems(accounts: Account[], hide: string[]): PickerItem[] {
  return accounts.map((a) => ({
    id: providerId(a).toLowerCase(),
    keys: [providerId(a).toLowerCase(), ...(a.email ? [a.email.toLowerCase()] : [])],
    kind: a.kind,
    label: accountLabel(a),
    live: a.live,
    shown: !isHidden(a, hide),
  }));
}

export class Picker {
  cursor = 0;

  constructor(readonly items: PickerItem[]) {}

  move(delta: number): void {
    if (this.items.length === 0) return;
    this.cursor = (this.cursor + delta + this.items.length) % this.items.length;
  }

  toggle(): void {
    const item = this.items[this.cursor];
    if (item) item.shown = !item.shown;
  }

  nextHide(previous: string[]): string[] {
    const listed = new Set(this.items.flatMap((i) => i.keys));
    const kept = previous.map((h) => h.toLowerCase()).filter((h) => !listed.has(h));
    return [...kept, ...this.items.filter((i) => !i.shown).map((i) => i.id)];
  }
}

export interface PickerView {
  width: number;
  color: boolean;
  status: string | null;
}

export function renderPicker(picker: Picker | null, view: PickerView): string[] {
  const bold = (t: string) => (view.color ? `\x1b[1m${t}\x1b[0m` : t);
  const dim = (t: string) => (view.color ? `\x1b[2m${t}\x1b[0m` : t);
  const lines = [bold(" 표시할 계정 고르기"), dim(" " + "─".repeat(Math.max(0, view.width - 2)))];
  if (view.status) lines.push(` ${view.status}`);
  if (picker) {
    if (picker.items.length === 0) lines.push(" 찾은 계정이 없습니다");
    picker.items.forEach((item, i) => {
      const mark = item.shown ? "[x]" : "[ ]";
      const name = item.kind === "claude" ? "Claude" : "Codex ";
      const line = ` ${i === picker.cursor ? ">" : " "} ${mark} ${name}  ${item.label}${item.live ? "" : "  (만료)"}`;
      lines.push(i === picker.cursor ? bold(line) : item.shown ? line : dim(line));
    });
  }
  lines.push("", dim(" ↑↓ 이동 · Space 켜기/끄기 · Enter 저장 · Esc 취소"));
  return lines.map((l) => truncate(l, view.width, view.color));
}
