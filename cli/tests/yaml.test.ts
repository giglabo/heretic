import { describe, it, expect, beforeEach } from "bun:test";
import {
  parseYaml,
  stringifyYaml,
  validateYaml,
  readYamlFile,
  writeYamlFile,
} from "../src/utils/yaml";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

describe("YAML Utils", () => {
  describe("parseYaml", () => {
    it("should parse valid YAML string", () => {
      const yaml = `
name: test
version: 1.0.0
features:
  - feature1
  - feature2
`;
      const result = parseYaml(yaml);
      expect(result).toEqual({
        name: "test",
        version: "1.0.0",
        features: ["feature1", "feature2"],
      });
    });

    it("should throw error for invalid YAML", () => {
      const invalidYaml = `
name: test
  invalid: indentation
`;
      expect(() => parseYaml(invalidYaml)).toThrow();
    });

    it("should parse typed YAML", () => {
      interface Config {
        name: string;
        port: number;
      }
      const yaml = "name: app\nport: 3000";
      const result = parseYaml<Config>(yaml);
      expect(result.name).toBe("app");
      expect(result.port).toBe(3000);
    });
  });

  describe("stringifyYaml", () => {
    it("should convert object to YAML string", () => {
      const data = {
        name: "test",
        version: "1.0.0",
        features: ["feature1", "feature2"],
      };
      const result = stringifyYaml(data);
      expect(result).toContain("name: test");
      expect(result).toContain("version: 1.0.0");
      expect(result).toContain("- feature1");
      expect(result).toContain("- feature2");
    });

    it("should handle nested objects", () => {
      const data = {
        server: {
          host: "localhost",
          port: 8080,
        },
      };
      const result = stringifyYaml(data);
      expect(result).toContain("server:");
      expect(result).toContain("host: localhost");
      expect(result).toContain("port: 8080");
    });

    it("should apply custom options", () => {
      const data = { items: [1, 2, 3, 4, 5] };
      const result = stringifyYaml(data, { flowLevel: 0 });
      expect(result).toContain("items:");
    });
  });

  describe("validateYaml", () => {
    it("should validate correct YAML", () => {
      const yaml = "name: test\nversion: 1.0.0";
      const result = validateYaml(yaml);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should detect invalid YAML", () => {
      const invalidYaml = "name: test\n  invalid: indentation";
      const result = validateYaml(invalidYaml);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("readYamlFile and writeYamlFile", () => {
    const testFile = join("/tmp", "test-yaml-file.yml");

    beforeEach(() => {
      // Clean up test file if it exists
      try {
        unlinkSync(testFile);
      } catch {
        // Ignore if file doesn't exist
      }
    });

    it("should write and read YAML file", () => {
      const data = {
        name: "test",
        version: "1.0.0",
        config: {
          enabled: true,
          timeout: 5000,
        },
      };

      writeYamlFile(testFile, data);
      const result = readYamlFile(testFile);

      expect(result).toEqual(data);
      unlinkSync(testFile);
    });

    it("should throw error when reading non-existent file", () => {
      expect(() => readYamlFile("/non/existent/file.yml")).toThrow();
    });

    it("should throw error when reading invalid YAML file", () => {
      writeFileSync(testFile, "invalid: [unclosed bracket", "utf-8");
      expect(() => readYamlFile(testFile)).toThrow();
      unlinkSync(testFile);
    });
  });
});
