/**
 * Search utilities using ripgrep for fast lexical searches in the Moodle codebase.
 */

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Result of a ripgrep search match.
 */
export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  matchedText: string;
  context?: string;
}

/**
 * Options for ripgrep search.
 */
export interface SearchOptions {
  /** Directories to search in (relative to moodlePath) */
  directories?: string[];
  /** Glob patterns to exclude */
  excludePatterns?: string[];
  /** Maximum number of results */
  maxResults?: number;
  /** Include N lines of context before match */
  contextBefore?: number;
  /** Include N lines of context after match */
  contextAfter?: number;
  /** Case insensitive search */
  ignoreCase?: boolean;
  /** File type filter (e.g., 'php') */
  fileType?: string;
  /** Use fixed strings instead of regex */
  fixedStrings?: boolean;
}

/**
 * Executes a ripgrep search and returns parsed results.
 *
 * @param pattern - The search pattern (regex or fixed string)
 * @param moodlePath - The root path to the Moodle installation
 * @param options - Search options
 * @returns Array of search matches
 */
export async function ripgrepSearch(
  pattern: string,
  moodlePath: string,
  options: SearchOptions = {}
): Promise<SearchMatch[]> {
  const {
    directories = ["."],
    excludePatterns = ["vendor", "node_modules", ".git"],
    maxResults = 100,
    contextBefore = 0,
    contextAfter = 0,
    ignoreCase = false,
    fileType,
    fixedStrings = false,
  } = options;

  const args: string[] = [
    "--json",
    "--line-number",
    "--column",
  ];

  // Add context lines if requested
  if (contextBefore > 0) {
    args.push("-B", String(contextBefore));
  }
  if (contextAfter > 0) {
    args.push("-A", String(contextAfter));
  }

  // Add max count
  args.push("--max-count", String(maxResults));

  // Case sensitivity
  if (ignoreCase) {
    args.push("--ignore-case");
  }

  // Fixed strings vs regex
  if (fixedStrings) {
    args.push("--fixed-strings");
  }

  // File type filter
  if (fileType) {
    args.push("--type", fileType);
  }

  // Exclude patterns
  for (const exclude of excludePatterns) {
    args.push("--glob", `!${exclude}/**`);
  }

  // Add the pattern
  args.push(pattern);

  // Add search directories
  for (const dir of directories) {
    const fullPath = path.join(moodlePath, dir);
    args.push(fullPath);
  }

  return new Promise((resolve, reject) => {
    const matches: SearchMatch[] = [];
    const contextMap = new Map<string, string[]>();
    let stdout = "";
    let stderr = "";

    const rg = spawn("rg", args, {
      cwd: moodlePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    rg.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    rg.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    rg.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ripgrep (rg) is not installed or not in PATH. Please install ripgrep: https://github.com/BurntSushi/ripgrep#installation"
          )
        );
      } else {
        reject(error);
      }
    });

    rg.on("close", (code) => {
      // ripgrep returns 1 if no matches found, 0 on success, 2 on error
      if (code === 2) {
        reject(new Error(`ripgrep error: ${stderr}`));
        return;
      }

      try {
        const lines = stdout.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          const parsed = JSON.parse(line);

          if (parsed.type === "match") {
            const data = parsed.data;
            const relativePath = path.relative(moodlePath, data.path.text);

            matches.push({
              file: relativePath,
              line: data.line_number,
              column: data.submatches[0]?.start ?? 0,
              matchedText: data.lines.text.trim(),
            });
          } else if (parsed.type === "context") {
            // Handle context lines for building full context
            const data = parsed.data;
            const key = `${data.path.text}:${data.line_number}`;
            if (!contextMap.has(key)) {
              contextMap.set(key, []);
            }
            contextMap.get(key)!.push(data.lines.text);
          }
        }

        resolve(matches);
      } catch (error) {
        reject(new Error(`Failed to parse ripgrep output: ${error}`));
      }
    });
  });
}

/**
 * Reads a file and extracts lines with context.
 *
 * @param filePath - Absolute path to the file
 * @param lineNumber - The target line number (1-indexed)
 * @param linesBefore - Number of lines to include before
 * @param linesAfter - Number of lines to include after
 * @returns The extracted content with line numbers
 */
export async function readFileWithContext(
  filePath: string,
  lineNumber: number,
  linesBefore: number,
  linesAfter: number
): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");

  const startLine = Math.max(0, lineNumber - 1 - linesBefore);
  const endLine = Math.min(lines.length, lineNumber + linesAfter);

  const extractedLines = lines.slice(startLine, endLine);

  // Format with line numbers
  return extractedLines
    .map((line, index) => {
      const actualLineNum = startLine + index + 1;
      const marker = actualLineNum === lineNumber ? ">" : " ";
      return `${marker}${String(actualLineNum).padStart(5, " ")} | ${line}`;
    })
    .join("\n");
}

/**
 * Extracts PHPDoc block and function/class signature from a file.
 *
 * @param filePath - Absolute path to the file
 * @param lineNumber - The line number where the symbol was found
 * @returns The PHPDoc block and signature
 */
export async function extractSymbolContext(
  filePath: string,
  lineNumber: number
): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split("\n");

  // Find the start of the PHPDoc block (look backwards up to 30 lines)
  let docStart = lineNumber - 1;
  const maxLookBack = Math.max(0, lineNumber - 30);

  // Look backwards for the PHPDoc start
  for (let i = lineNumber - 2; i >= maxLookBack; i--) {
    const trimmedLine = lines[i].trim();

    // Found the start of PHPDoc
    if (trimmedLine.startsWith("/**")) {
      docStart = i;
      break;
    }

    // If we hit code (not a comment line), stop looking
    if (
      trimmedLine &&
      !trimmedLine.startsWith("*") &&
      !trimmedLine.startsWith("//")
    ) {
      docStart = i + 1;
      break;
    }
  }

  // Find where the definition block ends (look for opening brace or semicolon)
  let definitionEnd = lineNumber - 1;
  const maxLookForward = Math.min(lines.length, lineNumber + 20);

  for (let i = lineNumber - 1; i < maxLookForward; i++) {
    const line = lines[i];
    if (line.includes("{") || line.trim().endsWith(";")) {
      definitionEnd = i;
      break;
    }
  }

  // Extract the relevant portion
  const extractedLines = lines.slice(docStart, definitionEnd + 1);

  return extractedLines
    .map((line, index) => {
      const actualLineNum = docStart + index + 1;
      return `${String(actualLineNum).padStart(5, " ")} | ${line}`;
    })
    .join("\n");
}

/**
 * Lists directory structure up to a specified depth.
 *
 * @param dirPath - The directory to list
 * @param maxDepth - Maximum depth to traverse
 * @param currentDepth - Current depth (internal use)
 * @returns Formatted directory tree
 */
export async function listDirectoryStructure(
  dirPath: string,
  maxDepth: number = 2,
  currentDepth: number = 0,
  prefix: string = ""
): Promise<string> {
  if (currentDepth >= maxDepth) {
    return "";
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const lines: string[] = [];

    // Sort: directories first, then files
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    // Filter out common non-relevant entries at root level
    const filtered = sorted.filter((entry) => {
      const name = entry.name;
      // Skip hidden files and common non-code directories
      if (name.startsWith(".")) return false;
      if (["node_modules", "vendor", ".git"].includes(name)) return false;
      return true;
    });

    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);

        // Recurse into subdirectory
        const subPath = path.join(dirPath, entry.name);
        const subTree = await listDirectoryStructure(
          subPath,
          maxDepth,
          currentDepth + 1,
          prefix + childPrefix
        );
        if (subTree) {
          lines.push(subTree);
        }
      } else {
        // Only show PHP files to keep output manageable
        if (entry.name.endsWith(".php")) {
          lines.push(`${prefix}${connector}${entry.name}`);
        }
      }
    }

    return lines.join("\n");
  } catch (error) {
    throw new Error(`Failed to list directory ${dirPath}: ${error}`);
  }
}

/**
 * Validates that ripgrep is installed and accessible.
 */
export async function validateRipgrepInstalled(): Promise<void> {
  return new Promise((resolve, reject) => {
    const rg = spawn("rg", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    rg.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ripgrep (rg) is not installed or not in PATH. Please install ripgrep: https://github.com/BurntSushi/ripgrep#installation"
          )
        );
      } else {
        reject(error);
      }
    });

    rg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("ripgrep check failed with non-zero exit code"));
      }
    });
  });
}
