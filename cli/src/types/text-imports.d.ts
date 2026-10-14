declare module "*.hbs" {
  const content: string;
  export default content;
}

declare module "*.sh" {
  const content: string;
  export default content;
}

// Vendored build-sidecar sources (Go exec-server) embedded via Bun text imports
// so `bun build --compile` bakes them into the binary.
declare module "*.go" {
  const content: string;
  export default content;
}

declare module "*.mod" {
  const content: string;
  export default content;
}
