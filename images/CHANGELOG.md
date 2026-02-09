# Changelog - Heretic Agent Image Builder

## Version 2.1.0 - 2026-02-04

### New Features

#### Tool Version Control
Added version control for all major tools with dedicated command-line flags:

- **Python version control**: `--python-version 3.11|3.12|3.13` (default: 3.13)
- **Node.js version control**: `--node-version 18|20|22` (default: 22)
- **Go version control**: `--go-version 1.21.5|1.22.0|1.23.4` (default: 1.23.4)
- **Java version control**: `--java-version 11|17|21` (default: 21)
- **Rust version control**: `--rust-version stable|nightly|beta|1.75` (default: stable)

**Examples:**
```bash
# Python 3.12 instead of default 3.13
./build-heretic-agent --python-version 3.12

# Multiple version overrides
./build-heretic-agent --python-version 3.11 --go-version 1.22.0 --node-version 20
```

**Key Points:**
- Version flags automatically enable the corresponding `--with-*` flag
- Each tool version is injected into the Dockerfile at build time
- Default versions chosen for stability and LTS support

#### Automatic Node.js Installation
Node.js is now **automatically installed** for non-node base images:
- Required for agent CLIs (all are npm packages)
- Uses version specified by `--node-version` (default: 22)
- For `node:*` base images, just enables corepack
- Removes the need to manually specify `--with-node` for Ubuntu/Debian base images

### Bug Fixes
- Fixed Python 3.13 `distutils` package error (package doesn't exist for Python 3.12+)
- Fixed missing Node.js error when using Ubuntu/Debian base images

### Documentation Updates
- Updated `README.md` with tool version control table and examples
- Updated `USER_GUIDE.md` with comprehensive version control section
- Added version information to "Included Tools" section
- Updated configuration display to show tool versions

### Breaking Changes
None - all version flags are optional and default to previous behavior.

---

## Version 2.0.0 - 2026-02-03

### Major Changes

#### Renamed and Refactored for Multi-Agent Support
- **BREAKING**: Renamed `build-claude-image` → `build-heretic-agent`
- **BREAKING**: Default image name changed from `claude-fat-cat` to `heretic-agent`
- Made the build system tool-agnostic to support multiple agent types

### New Features

#### 1. Multiple Agent Type Support
Added support for four agent types:
- **Claude**: `@anthropic-ai/claude-code` + `mcp-remote`
- **Copilot**: `@github/copilot`
- **OpenCode**: `opencode-ai`
- **Gemini**: `@google/gemini-cli` + `mcp-remote`

#### 2. Flexible Agent Selection
- **NEW**: `--agent TYPE` parameter (can be specified multiple times)
- Build single agent: `--agent claude`
- Build multiple agents: `--agent copilot --agent gemini`
- Build all agents: `--agent all`

#### 3. Agent-Aware Entrypoint
The entrypoint script now:
- Detects agent type via `AGENT_TYPE` environment variable
- Loads agent-specific settings from `.heretic` directory
- Executes the correct agent CLI with appropriate arguments
- Shows agent-specific tool information in interactive mode

#### 4. Automatic Duplicate Removal
When specifying multiple agents, duplicates are automatically removed:
```bash
# These produce the same result:
./build-heretic-agent --agent claude --agent claude
./build-heretic-agent --agent claude
```

#### 5. Smart "all" Expansion
The `--agent all` flag is expanded to all agent types:
```bash
# These are equivalent:
./build-heretic-agent --agent all
./build-heretic-agent --agent claude --agent copilot --agent opencode --agent gemini
```

### Image Naming Convention

| Agent Type | Image Name (default) |
|------------|---------------------|
| `claude` | `heretic-agent:latest` |
| `copilot` | `heretic-agent-copilot:latest` |
| `opencode` | `heretic-agent-opencode:latest` |
| `gemini` | `heretic-agent-gemini:latest` |

### Agent-Specific Configuration

Each agent type has its own configuration:

#### Claude
- **Settings file**: `${HERETIC_DIR}/.heretic/claude-settings.json` → `~/.claude/settings.json`
- **Environment variables**: `ANTHROPIC_API_KEY`, `GH_TOKEN`
- **Command**: `claude --print --output-format stream-json --verbose`

#### Copilot
- **Settings file**: None (token-based)
- **Environment variables**: `GITHUB_TOKEN`, `GH_TOKEN`
- **Command**: `copilot`

#### OpenCode
- **Settings file**: `${HERETIC_DIR}/.heretic/opencode.json` → `~/.config/opencode/config.json`
- **Environment variables**: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`
- **Command**: `opencode`

#### Gemini
- **Settings file**: None (uses env vars)
- **Environment variables**: `GOOGLE_API_KEY`, `GITHUB_TOKEN`
- **Command**: `gemini`

### Examples

#### Build Multiple Specific Agents
```bash
# Build just copilot and gemini
./build-heretic-agent --agent copilot --agent gemini

# Build claude and opencode with Python tools
./build-heretic-agent --agent claude --agent opencode --with-python
```

#### Build All Agents
```bash
# Build all four agent types
./build-heretic-agent --agent all

# Build all with full toolset
./build-heretic-agent --agent all --with-all
```

#### Multi-Arch Build
```bash
# Build multiple agents for ARM64
./build-heretic-agent --agent copilot --agent gemini --arch arm64

# Build all agents for multi-arch and push
./build-heretic-agent --agent all --arch both --push --registry ghcr.io/myorg
```

### Backward Compatibility

The script maintains backward compatibility:
- Default behavior (no `--agent` flag) builds Claude agent
- All existing command-line options work the same way
- Image tagging and registry push behavior unchanged
- Environment variable support preserved

### Migration Path

For users migrating from `build-claude-image`:

**Before:**
```bash
./build-claude-image --with-python --push --registry ghcr.io/myorg
```

**After:**
```bash
./build-heretic-agent --agent claude --with-python --push --registry ghcr.io/myorg
# Or just:
./build-heretic-agent --with-python --push --registry ghcr.io/myorg  # claude is default
```

### Files Changed

- **Renamed**: `build-claude-image` → `build-heretic-agent`
- **Updated**: `README.md` - Full documentation update
- **Added**: `MIGRATION.md` - Migration guide
- **Added**: `CHANGELOG.md` - This file

### Bug Fixes

- Fixed invalid `local` keyword usage outside function scope
- Fixed agent type validation to support arrays
- Fixed image naming for non-Claude agents

### Testing

All features tested with:
- Single agent builds: ✅
- Multiple agent builds: ✅
- All agent build: ✅
- Default behavior (no --agent): ✅
- Duplicate removal: ✅
- Dry-run mode: ✅

### Questions About BUILD_SIDECARS

**Q: Is it correct for BUILD_SIDECARS internal URL to be propagated at runtime?**

**A: Yes, absolutely!** The `BUILD_SIDECARS` environment variable is designed to be set at runtime, not baked into the image. This ensures:

1. **Environment portability**: Same image works in dev, staging, prod
2. **Dynamic configuration**: Different sidecar endpoints per deployment
3. **Container best practices**: Configuration via runtime env vars

The entrypoint script reads `BUILD_SIDECARS` at container start and generates tool wrappers dynamically in `/opt/sidecar/wrappers/`.

### Next Steps

Consider for future releases:
- Add agent-specific tool requirements (e.g., copilot may need different tools)
- Support custom agent CLIs via configuration
- Add validation for agent-specific environment variables
- Create pre-built multi-arch images in registry

---

For usage examples and documentation, see `README.md`.
