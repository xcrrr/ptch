import { z } from 'zod';
import type { BrainEntry, BrainKind, BrainSource } from './brain.js';

/**
 * The Brain as a graph. Nodes are real persisted Brain entries; edges are persisted relationships
 * that mean something. Nothing is drawn that is not stored or derivable from stored data.
 *
 * Edge types (what the relationship says, `from -> to`):
 *  - references  : the text of `from` mentions `to` ([[entry id]] or [[exact title]] in the body)
 *  - affects     : `from` (usually a decision) affects `to` (a component/knowledge entry)  [explicit]
 *  - implements  : `from` (a verified change) implements `to` (a decision/knowledge entry)  [explicit]
 *  - supersedes  : `from` replaces `to` (e.g. a new decision replaces an old one)           [explicit]
 *  - relates     : a plain explicit link between two entries                                [explicit]
 *  - touches     : both are verified changes that changed at least one of the same files   [derived,
 *                  `evidence` lists the shared paths]
 *
 * Origins: `user` = a person created it; `derived` = computed by Patch Cloud from stored data by a
 * deterministic rule (always carries `evidence`); `suggested` = proposed by a model, NOT confirmed
 * (nothing creates these today; the schema and the UI keep them visibly separate from the rest).
 */
export const BRAIN_LINK_TYPES = [
  'references',
  'affects',
  'implements',
  'supersedes',
  'relates',
  'touches',
] as const;
export type BrainLinkType = (typeof BRAIN_LINK_TYPES)[number];

export type BrainLinkOrigin = 'user' | 'derived' | 'suggested';

export interface BrainLink {
  id: string;
  projectId: string;
  from: string;
  to: string;
  type: BrainLinkType;
  origin: BrainLinkOrigin;
  /** `suggested` links are unconfirmed until a person accepts them; the others are confirmed. */
  confirmed: boolean;
  /** Why the link exists: shared file paths, the wiki-link text, or the person's note. */
  evidence: string[];
  createdAt: string;
}

export interface BrainGraphNode {
  id: string;
  projectId: string;
  kind: BrainKind;
  title: string;
  /** First ~160 characters of the body, for hover cards. */
  excerpt: string;
  tags: string[];
  source: BrainSource;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Number of links touching this node (any type). */
  degree: number;
}

/** `GET /brain/graph?project=&kinds=&q=&archived=1&limit=` (limit default 500, max 2000). */
export interface BrainGraphResponse {
  nodes: BrainGraphNode[];
  links: BrainLink[];
  /** True when more entries exist than `limit` (the newest are returned). */
  truncated: boolean;
  /** True when more links connect the returned nodes than were returned (capped at 5000). */
  linksTruncated?: boolean;
  projects: Array<{ id: string; name: string; entryCount: number }>;
  counts: Record<BrainKind, number>;
}

/** Task facts shown next to the entry that came from it (read from the real task record). */
export interface BrainSourceTask {
  id: string;
  title: string;
  status: string;
  finishedAt: string | null;
  costUsd: number;
  changedFiles: string[];
}

/** `GET /brain/entries/:id` */
export interface BrainEntryDetail {
  entry: BrainEntry;
  projectName: string;
  /** Links in both directions, with the other end's title and kind resolved. */
  links: Array<{
    link: BrainLink;
    direction: 'out' | 'in';
    other: { id: string; title: string; kind: BrainKind; archived: boolean };
  }>;
  sourceTask: BrainSourceTask | null;
}

export const CreateBrainLinkSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(['affects', 'implements', 'supersedes', 'relates', 'references']),
  note: z.string().max(500).optional(),
});
export type CreateBrainLinkRequest = z.input<typeof CreateBrainLinkSchema>;

/** `POST /brain/links/:id/remove` -> 200. Only `user` and `suggested` links can be removed (409 for derived). */
export interface RemoveBrainLinkResponse {
  removed: true;
  link: BrainLink;
}
