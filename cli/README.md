# heretic-cli

VibeCoder Heretic CLI - A command-line tool built with Bun for native executable compilation.

## Features

- **YAML Support**: Parse, validate, and manipulate YAML files using [js-yaml](https://github.com/nodeca/js-yaml)
- **Docker Integration**: Complete Docker client using [dockerode](https://github.com/apocas/dockerode)
- **Native Executables**: Compile to platform-specific binaries
- **Self-Updating**: Built-in safe two-phase update mechanism
- **Comprehensive Testing**: Full test coverage with Bun test runner

## Requirements

- [Bun](https://bun.sh/) >= 1.0.0
- (Optional) Docker daemon for Docker-related functionality

## Installation

```bash
cd cli
bun install
```

## Development

### Run in development mode

```bash
bun run dev
```

### Run with arguments

```bash
bun run dev -- --help
bun run dev -- --version
bun run dev -- --init
bun run dev -- --local-init
bun run dev -- --update
```

## Building

### Build for current platform

```bash
bun run build
```

Output: `dist/heretic-cli`

### Build for all platforms

```bash
bun run build:all
```

Outputs:
- `dist/heretic-cli-linux-x64`
- `dist/heretic-cli-linux-arm64`
- `dist/heretic-cli-macos-x64`
- `dist/heretic-cli-macos-arm64`
- `dist/heretic-cli-windows.exe`

### Platform-specific builds

```bash
bun run build:linux-x64
bun run build:linux-arm64
bun run build:macos-x64
bun run build:macos-arm64
bun run build:windows
```

## Testing

```bash
# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Run tests with coverage
bun run test:coverage
```

## Linting & Formatting

```bash
# Run ESLint
bun run lint

# Fix linting issues
bun run lint:fix

# Format code with Prettier
bun run format

# Check formatting
bun run format:check
```

## CLI Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `--help` | `-h` | Show help message |
| `--version` | `-v` | Show version information |
| `--init` | | Initialize a new heretic project |
| `--local-init` | | Initialize heretic for local development |
| `--update` | | Check for updates and stage update for next restart |
| `--update --check` | | Check for updates without downloading |

### Update Behavior

The `--update` command uses a **safe two-phase update process**:

1. **Download Phase**: The new version is downloaded to a temporary file (`.heretic-cli.pending`)
2. **Apply Phase**: On next startup, the CLI automatically detects and applies the pending update

This approach prevents issues with replacing a running executable.

**System Directory Handling**: If the executable is installed in a system directory like `/usr/bin` or `/usr/local/bin`, the update process will:
- Check for write permissions before downloading
- Prompt for `sudo` if elevated privileges are needed
- Suggest alternative installation locations if permission is denied

### Examples (no download)
./dist/heretic-cli --update --check

# Download and stage update
./dist/heretic-cli --update
# The update will be applied on next run

# If installed in /usr/bin with insufficient permissions
sudo heretic-cli --update
```

### Update Flow Example

```bash
# Check if update is available
$ heretic-cli --update --check
Current version: v0.1.0
Checking for updates...
New version available: v0.2.0
Run 'heretic-cli --update' to install the update.

# Stage the update
$ heretic-cli --update
Current version: v0.1.0
Checking for updates...
New version available: v0.2.0
Downloading update...
✓ Update downloaded successfully!
✓ Update staged successfully!
  The CLI will be updated to v0.2.0 on next run.
  Simply exit and restart heretic-cli to complete the update.

# Run again to apply the update
$ heretic-cli --version
Applying pending update...
✓ Update applied successfully!
  Old version backed up to: /path/to/heretic-cli.backup
heretic-cli v0.2.0

# Show version
./dist/heretic-cli --version

# Initialize project
./dist/heretic-cli --init

# Initialize for local development
./dist/heretic-cli --local-init

# Check for updates
./dist/heretic-cli --update --check

# Update CLI
./dist/heretic-cli --update
```

## Project Structure

```
cli/
├── package.json         # Project config & scripts
├── tsconfig.json        # TypeScript configuration
├── eslint.config.js     # ESLint flat config
├── YAML_DOCKER.md       # YAML & Docker usage documentation
├── src/
│   ├── index.ts         # Entry point
│   ├── cli.ts           # CLI argument parsing & routing
│   ├── logger.ts        # Pino logger configuration
│   ├── utils/
│   │   ├── index.ts     # Utils exports
│   │   ├── yaml.ts      # YAML parsing & manipulation
│   │   └── docker.ts    # Docker client utilities
│   └── commands/
│       ├── index.ts     # Command exports
│       ├── help.ts      # Help command
│       ├── init.ts      # Init command (stub)
│       ├── localInit.ts # Local init command (stub)
│       └── update.ts    # Update command with self-update
├── tests/
│   ├── cli.test.ts      # CLI & command tests
│   ├── update.test.ts   # Update command tests
│   ├── yaml.test.ts     # YAML utilities tests
│   └── docker.test.ts   # Docker utilities tests
└── dist/                # Build output (gitignored)
    └── heretic-cli      # Native executable
```

## Libraries & Standards

### YAML Processing
- **js-yaml** (v4.1.1): Industry-standard YAML 1.2 parser
- Full support for parsing, stringifying, validation
- Type-safe operations with TypeScript

### Docker Integration
- **dockerode** (v4.0.9): Official Node.js Docker client
- Complete Docker Engine API support
- Container lifecycle management
- Image operations (pull, build, list)
- Exec and logs support

See [YAML_DOCKER.md](../docs/cli/YAML_DOCKER.md) for detailed usage examples and API documentation.

## Configuration

### Update Source

The `--update` command checks GitHub releases for new versions. Update the repository path in `src/commands/update.ts`:

```typescript
const GITHUB_REPO = "your-org/heretic-cli"; // Update with actual repo
```

## License

MIT
