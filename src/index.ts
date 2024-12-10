#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LinearClient } from "@linear/sdk";
import { 
  isValidListIssuesArgs, 
  isValidIssueCreateArgs,
  MCPErrorSchema,
  MCPError,
  Pipeline
} from "./enhanced-types.js";
import { MetricsCollector } from "./metrics.js";
import { PipelineProcessor } from "./pipeline.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.LINEAR_API_KEY) {
  throw new Error("LINEAR_API_KEY environment variable is required");
}

class EnhancedLinearServer {
  private server: Server;
  private client: LinearClient;
  private metrics: MetricsCollector;
  private pipelineProcessor: PipelineProcessor;

  constructor() {
    this.server = new Server({
      name: "linear-mcp-server",
      version: "0.2.0"
    }, {
      capabilities: {
        tools: {}
      }
    });

    this.client = new LinearClient({
      apiKey: process.env.LINEAR_API_KEY
    });

    this.metrics = new MetricsCollector();
    this.pipelineProcessor = new PipelineProcessor(this.executeTool.bind(this));

    this.setupHandlers();
    this.setupErrorHandling();
    this.setupMetricsReporting();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error: unknown) => {
      const mcpError: MCPError = new Error('Server error');
      mcpError.code = error instanceof Error && 'code' in error 
        ? (error as any).code 
        : 'SERVER_ERROR';
      mcpError.message = error instanceof Error ? error.message : String(error);
      mcpError.retryable = true;
      console.error("[MCP Error]", mcpError);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupMetricsReporting(): void {
    setInterval(() => {
      const errorRate = this.metrics.getErrorRate();
      const avgDuration = this.metrics.getAverageRequestDuration();
      
      console.error("[MCP Metrics] Error Rate:", errorRate);
      console.error("[MCP Metrics] Avg Duration:", avgDuration + "ms");
      
      ["listIssues", "createIssue", "executePipeline"].forEach(tool => {
        const toolErrorRate = this.metrics.getErrorRate(tool);
        const toolAvgDuration = this.metrics.getAverageRequestDuration(tool);
        console.error(`[MCP Metrics] ${tool} - Error Rate:`, toolErrorRate);
        console.error(`[MCP Metrics] ${tool} - Avg Duration:`, toolAvgDuration + "ms");
      });
    }, 5 * 60 * 1000);
  }

  private async executeTool(name: string, params: any): Promise<any> {
    const startTime = Date.now();
    try {
      let result;
      switch (name) {
        case "listIssues": {
          if (!isValidListIssuesArgs(params)) {
            throw new Error("Invalid list issues arguments");
          }
          result = await this.client.issues(params);
          break;
        }
        case "createIssue": {
          if (!isValidIssueCreateArgs(params)) {
            throw new Error("Invalid issue creation arguments");
          }
          result = await this.client.createIssue(params);
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      this.metrics.record({
        toolName: name,
        requestDuration: Date.now() - startTime,
        success: true,
        retryCount: 0
      });

      return result;
    } catch (error) {
      this.metrics.record({
        toolName: name,
        requestDuration: Date.now() - startTime,
        success: false,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        retryCount: 0
      });
      throw error;
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => ({
        tools: [
          {
            name: "listIssues",
            description: "List issues from Linear",
            version: "1.0.0",
            inputSchema: {
              type: "object",
              properties: {
                teamId: {
                  type: "string",
                  description: "ID of the team to list issues from (optional)"
                },
                first: {
                  type: "number",
                  description: "Number of issues to fetch (optional, default: 50)"
                }
              }
            },
            outputSchema: {
              type: "object",
              properties: {
                nodes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      description: { type: "string" },
                      status: { type: "string" }
                    }
                  }
                }
              }
            }
          },
          {
            name: "createIssue",
            description: "Create a new issue in Linear",
            version: "1.0.0",
            inputSchema: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Title of the issue"
                },
                description: {
                  type: "string",
                  description: "Description of the issue"
                },
                teamId: {
                  type: "string",
                  description: "ID of the team"
                },
                assigneeId: {
                  type: "string",
                  description: "ID of the assignee (optional)"
                },
                priority: {
                  type: "number",
                  description: "Priority of the issue (optional)"
                }
              },
              required: ["title", "teamId"]
            },
            outputSchema: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                status: { type: "string" }
              }
            }
          },
          {
            name: "executePipeline",
            description: "Execute a pipeline of Linear operations",
            version: "1.0.0",
            inputSchema: {
              type: "object",
              properties: {
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      toolName: { type: "string" },
                      params: { type: "object" }
                    }
                  }
                }
              }
            }
          }
        ]
      })
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        try {
          let result;
          
          if (request.params.name === "executePipeline") {
            result = await this.pipelineProcessor.executePipeline(request.params.arguments);
          } else {
            result = await this.executeTool(request.params.name, request.params.arguments);
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2)
            }]
          };
        } catch (error) {
          const mcpError: MCPError = new Error(error instanceof Error ? error.message : String(error));
          mcpError.code = error instanceof Error && 'code' in error 
            ? (error as any).code 
            : 'TOOL_ERROR';
          mcpError.retryable = mcpError.code === 'RATE_LIMIT' || mcpError.code === 'NETWORK_ERROR';
          mcpError.details = error;

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                code: mcpError.code,
                message: mcpError.message,
                details: mcpError.details,
                retryable: mcpError.retryable,
                suggestions: this.getSuggestionsForError(mcpError)
              }, null, 2)
            }],
            isError: true
          };
        }
      }
    );
  }

  private getSuggestionsForError(error: MCPError): string[] {
    switch (error.code) {
      case 'RATE_LIMIT':
        return ['Wait and retry later', 'Reduce request frequency'];
      case 'AUTHENTICATION_ERROR':
        return ['Check API key', 'Verify Linear authentication'];
      case 'NETWORK_ERROR':
        return ['Check network connection', 'Verify Linear API status'];
      default:
        return ['Check input parameters', 'Consult Linear API documentation'];
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Enhanced Linear MCP server running on stdio");
    
    // Log initial metrics state
    console.error("[MCP Metrics] Server started at:", new Date().toISOString());
  }
}

const server = new EnhancedLinearServer();
server.run().catch(console.error);