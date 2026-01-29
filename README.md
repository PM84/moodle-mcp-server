# Moodle MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides intelligent access to a local Moodle LMS codebase. It uses [ripgrep](https://github.com/BurntSushi/ripgrep) for extremely fast, lexical searches to help LLMs understand and navigate Moodle's PHP codebase.

## Features

- **Fast Symbol Search**: Find class definitions, functions, and constants with their PHPDoc documentation
- **Usage Examples**: Discover how Moodle core uses specific functions (best practices)
- **File Reading**: Read specific files or sections when you need more context
- **Directory Exploration**: Navigate the codebase structure to understand plugin layouts

## Prerequisites

- **Node.js** >= 18.0.0
- **ripgrep** (`rg`) installed and available in PATH
- A local clone of the [Moodle repository](https://github.com/moodle/moodle)

### Installing ripgrep

```bash
# macOS
brew install ripgrep

# Ubuntu/Debian
sudo apt-get install ripgrep

# Arch Linux
sudo pacman -S ripgrep

# Windows (via Chocolatey)
choco install ripgrep

# Windows (via Scoop)
scoop install ripgrep
```

## Installation

### From npm (recommended)

```bash
npm install -g moodle-mcp-server
```

### From source

```bash
git clone https://github.com/yourusername/moodle-mcp-server.git
cd moodle-mcp-server
npm install
npm run build
```

## Configuration

The server needs to know where your Moodle source code is located. You can configure this in two ways:

### Option 1: Environment Variable

```bash
export MOODLE_SRC_PATH=/path/to/your/moodle
```

### Option 2: CLI Argument

```bash
moodle-mcp-server --moodle-path=/path/to/your/moodle
```

## Usage with Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "moodle": {
      "command": "npx",
      "args": ["-y", "moodle-mcp-server"],
      "env": {
        "MOODLE_SRC_PATH": "/path/to/your/moodle"
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "moodle": {
      "command": "moodle-mcp-server",
      "args": ["--moodle-path=/path/to/your/moodle"]
    }
  }
}
```

## Usage with VS Code

Add to your VS Code settings (`.vscode/settings.json` or user settings):

```json
{
  "mcp.servers": {
    "moodle": {
      "command": "npx",
      "args": ["-y", "moodle-mcp-server"],
      "env": {
        "MOODLE_SRC_PATH": "/path/to/your/moodle"
      }
    }
  }
}
```

## Available Tools

### `search_moodle_symbol`

Search for PHP class definitions, function definitions, or constants in the Moodle codebase.

**Parameters:**
- `symbol_name` (required): The name of the symbol to search for
- `symbol_type` (optional): `class`, `function`, `constant`, or `any` (default: `any`)
- `search_directory` (optional): Limit search to a specific directory (e.g., `lib`, `mod/forum`)

**Example prompts:**
- "Find the definition of the `core_renderer` class"
- "Search for the `get_string` function in Moodle"
- "Find the MOODLE_INTERNAL constant"

### `find_moodle_usage`

Find examples of how a function, class, or method is used in the Moodle codebase.

**Parameters:**
- `search_term` (required): The function name, method call, or class usage to search for
- `search_directories` (optional): List of directories to search in (default: `['lib', 'course']`)
- `max_results` (optional): Maximum number of examples to return (default: 5)

**Example prompts:**
- "Show me examples of how `$PAGE->set_context` is used"
- "Find usage examples of the `moodle_url` class"
- "How is `require_login()` typically called?"

### `read_file_content`

Read the content of a specific file from the Moodle codebase.

**Parameters:**
- `file_path` (required): Path relative to Moodle root (e.g., `lib/moodlelib.php`)
- `start_line` (optional): Start reading from this line number (default: 1)
- `end_line` (optional): Stop reading at this line number (default: end of file, max 500 lines)

**Example prompts:**
- "Read the file lib/setuplib.php"
- "Show me lines 100-200 of mod/forum/lib.php"

### `list_directory_structure`

List the directory structure of a path in the Moodle codebase.

**Parameters:**
- `directory` (optional): Directory path relative to Moodle root (default: root)
- `depth` (optional): How many levels deep to show, 1-4 (default: 2)

**Example prompts:**
- "What plugins are installed in the mod directory?"
- "Show me the structure of the lib/classes folder"
- "List the contents of local/"

## Example Conversations

### Understanding a Moodle API

> **User**: I want to understand how Moodle's grade API works. Can you help me find the main classes?

The LLM can use `search_moodle_symbol` to find grade-related classes, then `read_file_content` to examine their implementation.

### Learning Best Practices

> **User**: How should I properly create a new Moodle page in my plugin?

The LLM can use `find_moodle_usage` to search for examples of `$PAGE->set_` and `require_login` usage patterns.

### Exploring Plugin Structure

> **User**: What's the typical structure of a Moodle activity module?

The LLM can use `list_directory_structure` on `mod/forum` or `mod/assign` to show a typical activity plugin layout.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode for development
npm run dev

# Run locally
MOODLE_SRC_PATH=/path/to/moodle npm start
```

## Security Considerations

- The server only provides read access to the Moodle codebase
- Path traversal attacks are prevented by validating all paths
- The server runs locally and communicates only via stdio

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Moodle LMS](https://moodle.org/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
