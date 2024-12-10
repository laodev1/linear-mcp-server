import { z } from 'zod';

// Custom error types
export interface MCPError extends Error {
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

// Base schemas
export const BaseMCPToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  inputSchema: z.any(),
  outputSchema: z.any().optional(),
});

export const MCPContextSchema = z.object({
  requestId: z.string(),
  timestamp: z.number(),
  timeout: z.number().optional(),
  retryCount: z.number().optional(),
  parentContext: z.string().optional(),
});

export const MCPErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.any().optional(),
  retryable: z.boolean(),
  suggestions: z.array(z.string()).optional(),
});

// Pipeline types
export interface PipelineStep<T = any, R = any> {
  toolName: string;
  params: T;
  condition?: (prevResult: R) => boolean;
  transform?: (prevResult: R) => T;
}

export interface Pipeline {
  steps: PipelineStep[];
  context?: z.infer<typeof MCPContextSchema>;
}

export const PipelineSchema = z.object({
  steps: z.array(z.object({
    toolName: z.string(),
    params: z.any(),
    condition: z.function().optional(),
    transform: z.function().optional()
  })),
  context: MCPContextSchema.optional()
});

// Metrics types
export interface MCPMetrics {
  requestDuration: number;
  toolName: string;
  success: boolean;
  errorType?: string;
  retryCount: number;
  timestamp: number;
}

// Linear-specific types
export const ListIssuesInputSchema = z.object({
  teamId: z.string().optional(),
  first: z.number().optional().default(50),
});

export const CreateIssueInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  teamId: z.string(),
  assigneeId: z.string().optional(),
  priority: z.number().optional(),
});

export type ListIssuesInput = z.infer<typeof ListIssuesInputSchema>;
export type CreateIssueInput = z.infer<typeof CreateIssueInputSchema>;

// Type guards with Zod
export const isValidListIssuesArgs = (args: unknown): args is ListIssuesInput => {
  return ListIssuesInputSchema.safeParse(args).success;
};

export const isValidIssueCreateArgs = (args: unknown): args is CreateIssueInput => {
  return CreateIssueInputSchema.safeParse(args).success;
};