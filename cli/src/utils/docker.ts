import Docker from "dockerode";
import type { ContainerCreateOptions, ImageInfo, ContainerInfo } from "dockerode";
import { existsSync } from "node:fs";

/**
 * Get the Docker socket path for the current platform
 * @returns The Docker socket path appropriate for the OS
 */
export function getDockerSocketPath(): string {
  if (process.platform === "win32") {
    // Windows: Docker Desktop uses named pipe
    return "//./pipe/docker_engine";
  }

  // macOS with Docker Desktop sometimes uses a different socket location
  if (process.platform === "darwin") {
    const homeSocket = `${process.env.HOME}/.docker/run/docker.sock`;
    if (existsSync(homeSocket)) {
      return homeSocket;
    }
  }

  // Default Unix socket path
  return "/var/run/docker.sock";
}

/**
 * Create and configure Docker client
 */
export function createDockerClient(options?: Docker.DockerOptions): Docker {
  return new Docker(options);
}

/**
 * Get default Docker client instance
 */
export function getDockerClient(): Docker {
  return new Docker();
}

/**
 * Check if Docker daemon is available
 */
export async function isDockerAvailable(docker?: Docker): Promise<boolean> {
  const client = docker || getDockerClient();
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Docker version information
 */
export async function getDockerVersion(docker?: Docker): Promise<any> {
  const client = docker || getDockerClient();
  return await client.version();
}

/**
 * Get Docker system information
 */
export async function getDockerInfo(docker?: Docker): Promise<any> {
  const client = docker || getDockerClient();
  return await client.info();
}

/**
 * List all Docker images
 */
export async function listImages(docker?: Docker): Promise<ImageInfo[]> {
  const client = docker || getDockerClient();
  return await client.listImages();
}

/**
 * List Docker containers
 */
export async function listContainers(
  docker?: Docker,
  options?: { all?: boolean; limit?: number; size?: boolean }
): Promise<ContainerInfo[]> {
  const client = docker || getDockerClient();
  return await client.listContainers(options);
}

/**
 * Pull Docker image
 */
export async function pullImage(
  imageName: string,
  onProgress?: (progress: any) => void,
  docker?: Docker
): Promise<void> {
  const client = docker || getDockerClient();

  return new Promise((resolve, reject) => {
    client.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }

      client.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
        onProgress
      );
    });
  });
}

/**
 * Build Docker image from Dockerfile
 */
export async function buildImage(
  contextPath: string,
  options: {
    t?: string; // tag
    dockerfile?: string;
    buildargs?: Record<string, string>;
  },
  onProgress?: (progress: any) => void,
  docker?: Docker
): Promise<void> {
  const client = docker || getDockerClient();

  return new Promise((resolve, reject) => {
    client.buildImage(
      {
        context: contextPath,
        src: ["."],
      },
      options,
      (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }

        client.modem.followProgress(
          stream,
          (err: Error | null) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
          onProgress
        );
      }
    );
  });
}

/**
 * Create and start a container
 */
export async function runContainer(
  imageName: string,
  options?: ContainerCreateOptions,
  docker?: Docker
): Promise<Docker.Container> {
  const client = docker || getDockerClient();

  const container = await client.createContainer({
    Image: imageName,
    ...options,
  });

  await container.start();
  return container;
}

/**
 * Stop a container
 */
export async function stopContainer(
  containerId: string,
  options?: { t?: number },
  docker?: Docker
): Promise<void> {
  const client = docker || getDockerClient();
  const container = client.getContainer(containerId);
  await container.stop(options);
}

/**
 * Remove a container
 */
export async function removeContainer(
  containerId: string,
  options?: { force?: boolean; v?: boolean },
  docker?: Docker
): Promise<void> {
  const client = docker || getDockerClient();
  const container = client.getContainer(containerId);
  await container.remove(options);
}

/**
 * Execute command in a running container
 */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  docker?: Docker
): Promise<{ output: string; exitCode: number }> {
  const client = docker || getDockerClient();
  const container = client.getContainer(containerId);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  return new Promise((resolve, reject) => {
    exec.start({}, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }

      let output = "";
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });

      stream.on("end", async () => {
        const inspection = await exec.inspect();
        resolve({
          output,
          exitCode: inspection.ExitCode || 0,
        });
      });

      stream.on("error", reject);
    });
  });
}

/**
 * Get container logs
 */
export async function getContainerLogs(
  containerId: string,
  options?: {
    stdout?: boolean;
    stderr?: boolean;
    follow?: boolean;
    tail?: number;
    timestamps?: boolean;
  },
  docker?: Docker
): Promise<NodeJS.ReadableStream> {
  const client = docker || getDockerClient();
  const container = client.getContainer(containerId);

  return await container.logs({
    stdout: true,
    stderr: true,
    ...options,
  });
}
