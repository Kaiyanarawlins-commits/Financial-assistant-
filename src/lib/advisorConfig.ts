import type { ClaudeConfig, ModelId } from './agents';

/**
 * Advisor backend configuration.
 *
 * Stored in its own localStorage slot rather than in AppState, for one specific
 * reason: AppState is what "Download backup" serialises. An API key living
 * there would be written into a JSON file the user might email to themselves or
 * drop in a shared folder. Keeping it separate means a backup carries finances
 * and never credentials.
 */

const STORAGE_KEY = 'cashcompass.advisor.v1';

export interface AdvisorConfig {
  backend: 'local' | 'claude';
  apiKey: string;
  proxyUrl: string;
  model: ModelId;
  effort: 'low' | 'medium' | 'high';
}

export const MODEL_OPTIONS: { id: ModelId; label: string; note: string }[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', note: 'Most capable. Best reasoning, highest cost.' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Very capable, cheaper than Fable.' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Fast and inexpensive.' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Cheapest and fastest.' },
];

export function defaultAdvisorConfig(): AdvisorConfig {
  return {
    backend: 'local',
    apiKey: '',
    proxyUrl: '',
    model: 'claude-fable-5',
    effort: 'medium',
  };
}

export function loadAdvisorConfig(): AdvisorConfig {
  if (typeof localStorage === 'undefined') return defaultAdvisorConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAdvisorConfig();
    return { ...defaultAdvisorConfig(), ...(JSON.parse(raw) as Partial<AdvisorConfig>) };
  } catch {
    return defaultAdvisorConfig();
  }
}

export function saveAdvisorConfig(config: AdvisorConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable — the session keeps working, the setting just won't persist.
  }
}

/** The shape the agent layer wants; returns undefined when the local advisor is selected. */
export function toClaudeConfig(config: AdvisorConfig): Partial<ClaudeConfig> | undefined {
  if (config.backend !== 'claude') return undefined;
  if (!config.apiKey && !config.proxyUrl) return undefined;
  return {
    apiKey: config.proxyUrl ? undefined : config.apiKey,
    proxyUrl: config.proxyUrl || undefined,
    model: config.model,
    effort: config.effort,
  };
}
