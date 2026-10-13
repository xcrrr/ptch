import { z } from 'zod';

export const BRAIN_KINDS = ['knowledge', 'decision', 'note', 'change'] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];

/** Who wrote an entry: a person, a finished task, or the platform. */
export type BrainSource = 'user' | 'task' | 'system';

export interface BrainEntry {
  id: string;
  projectId: string;
  kind: BrainKind;
  title: string;
  body: string;
  tags: string[];
  source: BrainSource;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/** Only people (and later the Director) write `knowledge`, `decision` and `note` entries. */
export const CreateBrainEntrySchema = z.object({
  kind: z.enum(['knowledge', 'decision', 'note']),
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).default(''),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type CreateBrainEntryRequest = z.input<typeof CreateBrainEntrySchema>;

export const UpdateBrainEntrySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  archived: z.boolean().optional(),
});
export type UpdateBrainEntryRequest = z.input<typeof UpdateBrainEntrySchema>;
