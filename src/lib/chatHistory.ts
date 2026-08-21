import type { ConversationMemory } from './agents';
import { emptyMemory } from './agents';
import { today } from './dates';
import { newId } from './id';

/**
 * Saved conversations.
 *
 * Advice you cannot go back to is advice you have to ask for twice. A thread
 * about paying down a card is worth re-reading next month, so conversations
 * persist, are listed newest first, and reopen with their memory intact —
 * reopening a thread and finding the advisor has forgotten the account you
 * spent ten turns discussing would be worse than not saving it at all.
 *
 * Stored separately from AppState: these are a log, not part of the financial
 * record, and they should not ride along in a data backup or be lost when
 * someone resets their demo data.
 */

const STORAGE_KEY = 'cashcompass.chats.v1';

/** Beyond this, old threads are dropped oldest-first to stay inside the quota. */
const MAX_CONVERSATIONS = 40;

export interface StoredMessage {
  id: number;
  role: 'user' | 'bot';
  text: string;
  /** Specialist id, so the badge survives a reload. */
  agentId?: string;
  agentName?: string;
  agentColor?: string;
  refused?: boolean;
  fellBack?: boolean;
  unverified?: boolean;
  followUpOf?: string;
}

export interface Conversation {
  id: string;
  /** Derived from the first question — a thread's own words identify it best. */
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
  memory: ConversationMemory;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  /** The specialist that answered most recently, for the list badge. */
  agentName?: string;
  agentColor?: string;
}

function read(): Conversation[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(conversations: Conversation[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)));
  } catch {
    // Quota exceeded. Drop the oldest half and try once — losing old threads is
    // a far better outcome than the current one failing to save.
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(conversations.slice(0, Math.floor(MAX_CONVERSATIONS / 2))),
      );
    } catch {
      // Storage genuinely unavailable; the session continues in memory.
    }
  }
}

export function listConversations(): ConversationSummary[] {
  return read()
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((c) => {
      const lastBot = [...c.messages].reverse().find((m) => m.role === 'bot' && m.agentName);
      return {
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messages.filter((m) => m.id > 0).length,
        agentName: lastBot?.agentName,
        agentColor: lastBot?.agentColor,
      };
    });
}

export function loadConversation(id: string): Conversation | null {
  const found = read().find((c) => c.id === id);
  if (!found) return null;
  // A thread saved by an older build may predate the memory field entirely.
  return { ...found, memory: { ...emptyMemory(), ...(found.memory ?? {}) } };
}

export function saveConversation(conversation: Conversation): void {
  const all = read().filter((c) => c.id !== conversation.id);
  write([conversation, ...all].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
}

export function deleteConversation(id: string): void {
  write(read().filter((c) => c.id !== id));
}

export function clearConversations(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export function newConversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: newId('chat'),
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    messages: [],
    memory: emptyMemory(),
  };
}

/**
 * Names a thread from its first question.
 *
 * The user's own words beat anything generated: they searched for this thread
 * because they remember asking it, not because they remember a summary of it.
 */
export function titleFrom(question: string): string {
  const cleaned = question.replace(/\s+/g, ' ').trim().replace(/\?+$/, '');
  if (cleaned.length <= 52) return cleaned || 'New conversation';
  const cut = cleaned.slice(0, 52);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** "Today", "Yesterday", then a date — the grouping people actually scan by. */
export function relativeDay(iso: string): string {
  const date = iso.slice(0, 10);
  const now = today();
  if (date === now) return 'Today';

  const yesterday = new Date(new Date(`${now}T12:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (date === yesterday) return 'Yesterday';

  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.slice(0, 4) === now.slice(0, 4) ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}
