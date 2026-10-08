import { test, expect } from "bun:test";
import { parseYaml, stringifyYaml } from "../src/utils/yaml";
import { getDockerClient, isDockerAvailable } from "../src/utils/docker";

test("Integration: YAML and Docker work together", async () => {
  // Parse a docker-compose-like YAML
  const composeYaml = `
version: '3.8'
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
`;

  const config = parseYaml(composeYaml);
  expect(config.version).toBe("3.8");
  expect(config.services.web.image).toBe("nginx:alpine");

  // Convert back to YAML
  const yamlOutput = stringifyYaml(config);
  expect(yamlOutput).toContain("version:");
  expect(yamlOutput).toContain("3.8");
  expect(yamlOutput).toContain("nginx:alpine");

  // Check Docker availability
  const dockerAvailable = await isDockerAvailable();
  expect(typeof dockerAvailable).toBe("boolean");

  if (dockerAvailable) {
    const client = getDockerClient();
    expect(client).toBeDefined();
  }
});
