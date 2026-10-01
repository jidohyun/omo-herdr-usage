export interface Pace {
  stage: string;
  expectedUsedPercent: number | null;
  deltaPercent: number | null;
  willLastToReset: boolean | null;
  etaSeconds: number | null;
  summary: string | null;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
  pace: Pace | null;
}

export interface Credits {
  remaining: number;
  unit: string;
}

export interface ProviderUsage {
  provider: string;
  displayName: string;
  plan: string | null;
  account: string | null;
  source: string | null;
  updatedAt: Date | null;
  windows: UsageWindow[];
  credits: Credits | null;
  error: string | null;
}

export interface Snapshot {
  fetchedAt: Date;
  providers: ProviderUsage[];
  error: string | null;
}

export interface RenderOptions {
  now: Date;
  width: number;
  color: boolean;
  refreshing: boolean;
  nextRefreshAt: Date | null;
  footer?: string;
}
