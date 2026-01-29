#!/usr/bin/env node

/**
 * Moodle MCP Server
 *
 * A Model Context Protocol (MCP) server that provides intelligent access
 * to a local Moodle LMS codebase using ripgrep for fast, lexical searches.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";
import {
  ripgrepSearch,
  extractSymbolContext,
  readFileWithContext,
  listDirectoryStructure,
  validateRipgrepInstalled,
  type SearchMatch,
} from "./search.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Gets the Moodle source path from environment, CLI arguments, or current directory.
 * 
 * Priority:
 * 1. CLI argument: --moodle-path=<path>
 * 2. Environment variable: MOODLE_SRC_PATH
 * 3. Current working directory (if it looks like a Moodle installation)
 */
function getMoodlePath(): string {
  // Check CLI argument first
  const cliArg = process.argv.find((arg) => arg.startsWith("--moodle-path="));
  if (cliArg) {
    const argPath = cliArg.split("=")[1];
    // Support relative paths and "."
    return path.resolve(argPath);
  }

  // Check environment variable
  const envPath = process.env.MOODLE_SRC_PATH;
  if (envPath) {
    // Support relative paths and "."
    return path.resolve(envPath);
  }

  // Fall back to current working directory
  // This is useful when running from within a Moodle directory in VS Code
  const cwd = process.cwd();
  console.error(`[moodle-mcp-server] No path configured, using current directory: ${cwd}`);
  return cwd;
}

/**
 * Validates that the Moodle path exists and looks like a Moodle installation.
 */
async function validateMoodlePath(moodlePath: string): Promise<void> {
  try {
    const stat = await fs.stat(moodlePath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${moodlePath}`);
    }

    // Check for typical Moodle files/directories
    const expectedPaths = ["version.php", "config-dist.php", "lib", "mod"];
    const checks = await Promise.all(
      expectedPaths.map(async (p) => {
        try {
          await fs.access(path.join(moodlePath, p));
          return true;
        } catch {
          return false;
        }
      })
    );

    const foundCount = checks.filter(Boolean).length;
    if (foundCount < 2) {
      console.error(
        `Warning: ${moodlePath} may not be a valid Moodle installation. ` +
          `Expected files not found. Proceeding anyway...`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Moodle path does not exist: ${moodlePath}`);
    }
    throw error;
  }
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS = [
  {
    name: "search_moodle_symbol",
    description:
      "Search for PHP class definitions, function definitions, or constants in the Moodle codebase. " +
      "Returns the symbol definition along with its PHPDoc documentation block and full signature. " +
      "Use this to find and understand Moodle APIs, classes, and functions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol_name: {
          type: "string",
          description:
            "The name of the symbol to search for (class name, function name, or constant name)",
        },
        symbol_type: {
          type: "string",
          enum: ["class", "function", "constant", "any"],
          description:
            "The type of symbol to search for. Use 'any' to search all types.",
          default: "any",
        },
        search_directory: {
          type: "string",
          description:
            "Optional: Limit search to a specific directory (e.g., 'lib', 'mod/forum'). Defaults to entire codebase.",
        },
      },
      required: ["symbol_name"],
    },
  },
  {
    name: "find_moodle_usage",
    description:
      "Find examples of how a function, class, or method is used in the Moodle codebase. " +
      "This helps understand best practices and common patterns. " +
      "Searches in core directories (lib, course) by default, excluding vendor code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        search_term: {
          type: "string",
          description:
            "The function name, method call, or class usage to search for",
        },
        search_directories: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: List of directories to search in (e.g., ['lib', 'mod', 'course']). " +
            "Defaults to ['lib', 'course'].",
        },
        max_results: {
          type: "number",
          description: "Maximum number of usage examples to return (default: 5)",
          default: 5,
        },
      },
      required: ["search_term"],
    },
  },
  {
    name: "read_file_content",
    description:
      "Read the content of a specific file from the Moodle codebase. " +
      "Use this after finding a file through search to examine its full content or a specific section.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description:
            "The path to the file relative to the Moodle root (e.g., 'lib/moodlelib.php')",
        },
        start_line: {
          type: "number",
          description:
            "Optional: Start reading from this line number (1-indexed). Defaults to 1.",
        },
        end_line: {
          type: "number",
          description:
            "Optional: Stop reading at this line number. Defaults to end of file or 500 lines max.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_directory_structure",
    description:
      "List the directory structure of a path in the Moodle codebase. " +
      "Useful for understanding the layout of plugins, modules, or specific areas of the codebase. " +
      "Shows directories and PHP files up to the specified depth.",
    inputSchema: {
      type: "object" as const,
      properties: {
        directory: {
          type: "string",
          description:
            "The directory path relative to Moodle root (e.g., 'mod', 'local', 'lib/classes'). " +
            "Use '.' or empty string for root.",
          default: ".",
        },
        depth: {
          type: "number",
          description: "How many levels deep to show (1-4). Default is 2.",
          default: 2,
        },
      },
      required: [],
    },
  },
];

// ============================================================================
// Tool Implementations
// ============================================================================

/**
 * Implementation of search_moodle_symbol tool.
 */
async function searchMoodleSymbol(
  moodlePath: string,
  symbolName: string,
  symbolType: string = "any",
  searchDirectory?: string
): Promise<string> {
  // Build the search pattern based on symbol type
  let patterns: string[] = [];

  switch (symbolType) {
    case "class":
      patterns = [`class\\s+${symbolName}\\b`];
      break;
    case "function":
      patterns = [`function\\s+${symbolName}\\s*\\(`];
      break;
    case "constant":
      patterns = [
        `define\\s*\\(\\s*['\"]${symbolName}['\"]`,
        `const\\s+${symbolName}\\s*=`,
      ];
      break;
    case "any":
    default:
      patterns = [
        `class\\s+${symbolName}\\b`,
        `function\\s+${symbolName}\\s*\\(`,
        `define\\s*\\(\\s*['\"]${symbolName}['\"]`,
        `const\\s+${symbolName}\\s*=`,
      ];
  }

  const directories = searchDirectory ? [searchDirectory] : ["."];
  const allMatches: Array<{ match: SearchMatch; context: string }> = [];

  for (const pattern of patterns) {
    try {
      const matches = await ripgrepSearch(pattern, moodlePath, {
        directories,
        fileType: "php",
        maxResults: 10,
      });

      // Extract context for each match
      for (const match of matches) {
        const fullPath = path.join(moodlePath, match.file);
        try {
          const context = await extractSymbolContext(fullPath, match.line);
          allMatches.push({ match, context });
        } catch {
          // If context extraction fails, include basic info
          allMatches.push({
            match,
            context: match.matchedText,
          });
        }
      }
    } catch (error) {
      // Continue with other patterns if one fails
      console.error(`Pattern search failed: ${pattern}`, error);
    }
  }

  if (allMatches.length === 0) {
    return `No symbols found matching "${symbolName}" of type "${symbolType}"`;
  }

  // Format results
  const results = allMatches.map(({ match, context }, index) => {
    return `
### Result ${index + 1}: ${match.file}:${match.line}

\`\`\`php
${context}
\`\`\`
`;
  });

  return `Found ${allMatches.length} symbol(s) matching "${symbolName}":\n${results.join("\n---\n")}`;
}

/**
 * Implementation of find_moodle_usage tool.
 */
async function findMoodleUsage(
  moodlePath: string,
  searchTerm: string,
  searchDirectories: string[] = ["lib", "course"],
  maxResults: number = 5
): Promise<string> {
  try {
    const matches = await ripgrepSearch(searchTerm, moodlePath, {
      directories: searchDirectories,
      fileType: "php",
      maxResults: maxResults * 3, // Get more to filter
      fixedStrings: true,
      contextBefore: 3,
      contextAfter: 5,
    });

    if (matches.length === 0) {
      return `No usage examples found for "${searchTerm}" in directories: ${searchDirectories.join(", ")}`;
    }

    // Deduplicate and limit results
    const uniqueMatches = matches.slice(0, maxResults);

    // Get extended context for each match
    const results: string[] = [];
    for (const match of uniqueMatches) {
      const fullPath = path.join(moodlePath, match.file);
      try {
        const context = await readFileWithContext(
          fullPath,
          match.line,
          5,
          10
        );
        results.push(`
### ${match.file}:${match.line}

\`\`\`php
${context}
\`\`\`
`);
      } catch {
        results.push(`
### ${match.file}:${match.line}

\`\`\`php
${match.matchedText}
\`\`\`
`);
      }
    }

    return `Found ${matches.length} usage(s) of "${searchTerm}". Showing ${uniqueMatches.length} examples:\n${results.join("\n---\n")}`;
  } catch (error) {
    throw new Error(`Usage search failed: ${error}`);
  }
}

/**
 * Implementation of read_file_content tool.
 */
async function readFileContent(
  moodlePath: string,
  filePath: string,
  startLine: number = 1,
  endLine?: number
): Promise<string> {
  // Prevent directory traversal
  const normalizedPath = path.normalize(filePath);
  if (normalizedPath.startsWith("..") || path.isAbsolute(normalizedPath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Invalid file path: must be relative to Moodle root"
    );
  }

  const fullPath = path.join(moodlePath, normalizedPath);

  // Verify the file is within the Moodle directory
  const resolvedPath = path.resolve(fullPath);
  const resolvedMoodlePath = path.resolve(moodlePath);
  if (!resolvedPath.startsWith(resolvedMoodlePath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Invalid file path: path traversal detected"
    );
  }

  try {
    const content = await fs.readFile(fullPath, "utf-8");
    const lines = content.split("\n");

    // Validate line numbers
    const maxLines = 500;
    const actualStartLine = Math.max(1, startLine);
    const actualEndLine = endLine
      ? Math.min(endLine, lines.length, actualStartLine + maxLines - 1)
      : Math.min(lines.length, actualStartLine + maxLines - 1);

    if (actualStartLine > lines.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Start line ${startLine} exceeds file length of ${lines.length} lines`
      );
    }

    const selectedLines = lines.slice(actualStartLine - 1, actualEndLine);

    const formattedContent = selectedLines
      .map((line, index) => {
        const lineNum = actualStartLine + index;
        return `${String(lineNum).padStart(5, " ")} | ${line}`;
      })
      .join("\n");

    const header = `File: ${normalizedPath} (lines ${actualStartLine}-${actualEndLine} of ${lines.length})`;
    const truncationNote =
      actualEndLine < lines.length
        ? `\n\n[... ${lines.length - actualEndLine} more lines. Use start_line/end_line to read more.]`
        : "";

    return `${header}\n\n\`\`\`php\n${formattedContent}\n\`\`\`${truncationNote}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `File not found: ${normalizedPath}`
      );
    }
    throw error;
  }
}

/**
 * Implementation of list_directory_structure tool.
 */
async function listDirectoryStructureHandler(
  moodlePath: string,
  directory: string = ".",
  depth: number = 2
): Promise<string> {
  // Validate and clamp depth
  const validDepth = Math.max(1, Math.min(4, depth));

  // Prevent directory traversal
  const normalizedPath = path.normalize(directory || ".");
  if (normalizedPath.startsWith("..") || path.isAbsolute(normalizedPath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Invalid directory: must be relative to Moodle root"
    );
  }

  const fullPath = path.join(moodlePath, normalizedPath);

  // Verify the directory is within the Moodle directory
  const resolvedPath = path.resolve(fullPath);
  const resolvedMoodlePath = path.resolve(moodlePath);
  if (!resolvedPath.startsWith(resolvedMoodlePath)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Invalid directory: path traversal detected"
    );
  }

  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isDirectory()) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Not a directory: ${normalizedPath}`
      );
    }

    const tree = await listDirectoryStructure(fullPath, validDepth);
    const displayPath = normalizedPath === "." ? "(root)" : normalizedPath;

    return `Directory structure of ${displayPath} (depth: ${validDepth}):\n\n${tree || "(empty or no PHP files)"}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Directory not found: ${normalizedPath}`
      );
    }
    throw error;
  }
}

// ============================================================================
// Server Setup
// ============================================================================

async function main() {
  // Get and validate configuration
  let moodlePath: string;

  try {
    moodlePath = getMoodlePath();
    moodlePath = path.resolve(moodlePath);

    console.error(`[moodle-mcp-server] Starting...`);
    console.error(`[moodle-mcp-server] Moodle path: ${moodlePath}`);

    await validateMoodlePath(moodlePath);
    await validateRipgrepInstalled();

    console.error(`[moodle-mcp-server] Configuration validated successfully`);
  } catch (error) {
    console.error(`[moodle-mcp-server] Configuration error: ${error}`);
    process.exit(1);
  }

  // Create the MCP server
  const server = new Server(
    {
      name: "moodle-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "search_moodle_symbol": {
          const symbolName = args?.symbol_name as string;
          const symbolType = (args?.symbol_type as string) || "any";
          const searchDirectory = args?.search_directory as string | undefined;

          if (!symbolName) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "symbol_name is required"
            );
          }

          const result = await searchMoodleSymbol(
            moodlePath,
            symbolName,
            symbolType,
            searchDirectory
          );

          return {
            content: [{ type: "text", text: result }],
          };
        }

        case "find_moodle_usage": {
          const searchTerm = args?.search_term as string;
          const searchDirectories = (args?.search_directories as string[]) || [
            "lib",
            "course",
          ];
          const maxResults = (args?.max_results as number) || 5;

          if (!searchTerm) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "search_term is required"
            );
          }

          const result = await findMoodleUsage(
            moodlePath,
            searchTerm,
            searchDirectories,
            maxResults
          );

          return {
            content: [{ type: "text", text: result }],
          };
        }

        case "read_file_content": {
          const filePath = args?.file_path as string;
          const startLine = (args?.start_line as number) || 1;
          const endLine = args?.end_line as number | undefined;

          if (!filePath) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "file_path is required"
            );
          }

          const result = await readFileContent(
            moodlePath,
            filePath,
            startLine,
            endLine
          );

          return {
            content: [{ type: "text", text: result }],
          };
        }

        case "list_directory_structure": {
          const directory = (args?.directory as string) || ".";
          const depth = (args?.depth as number) || 2;

          const result = await listDirectoryStructureHandler(
            moodlePath,
            directory,
            depth
          );

          return {
            content: [{ type: "text", text: result }],
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error}`
      );
    }
  });

  // Connect to transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[moodle-mcp-server] Server running on stdio`);
}

main().catch((error) => {
  console.error(`[moodle-mcp-server] Fatal error: ${error}`);
  process.exit(1);
});
