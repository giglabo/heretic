import { describe, expect, test } from "bun:test";
import {
  buildPortMappings,
  dropBusyOptionalPorts,
  formatPortMappings,
  parsePortSpec,
  presetPortSpecs,
  toDockerPortConfig,
  PORT_PRESETS,
} from "../src/utils/ports";

describe("parsePortSpec", () => {
  test("single port", () => {
    expect(parsePortSpec("3000")).toEqual({
      hostIp: undefined,
      hostStart: undefined,
      hostEnd: undefined,
      containerStart: 3000,
      containerEnd: 3000,
      protocol: "tcp",
    });
  });

  test("range, remapped range, bind IP, protocol", () => {
    expect(parsePortSpec("3000-3020")).toMatchObject({ containerStart: 3000, containerEnd: 3020 });
    expect(parsePortSpec("13000-13020:3000-3020")).toMatchObject({
      hostStart: 13000,
      hostEnd: 13020,
      containerStart: 3000,
      containerEnd: 3020,
    });
    expect(parsePortSpec("127.0.0.1:8080:80")).toMatchObject({
      hostIp: "127.0.0.1",
      hostStart: 8080,
      containerStart: 80,
    });
    expect(parsePortSpec("[::1]:8080:80")).toMatchObject({ hostIp: "::1", hostStart: 8080 });
    expect(parsePortSpec("5353/udp")).toMatchObject({ protocol: "udp" });
    expect(parsePortSpec("127.0.0.1::80")).toMatchObject({ hostStart: null, containerStart: 80 });
  });

  test("rejects bad specs", () => {
    expect(() => parsePortSpec("")).toThrow();
    expect(() => parsePortSpec("abc")).toThrow(/Invalid port/);
    expect(() => parsePortSpec("70000")).toThrow(/out of range/);
    expect(() => parsePortSpec("3020-3000")).toThrow(/below its start/);
    expect(() => parsePortSpec("13000-13005:3000-3020")).toThrow(/different lengths/);
    expect(() => parsePortSpec("80/http")).toThrow(/protocol/);
    expect(() => parsePortSpec("::1:80:80")).toThrow(/brackets/);
    expect(() => parsePortSpec("127.0.0.1::3000-3001")).toThrow(/random host port/);
  });
});

describe("presetPortSpecs", () => {
  test("expands groups and comma lists without duplicates", () => {
    const dev = presetPortSpecs(["dev"]);
    expect(dev).toEqual([...PORT_PRESETS.web, ...PORT_PRESETS.debug]);
    expect(presetPortSpecs(["web,debug", "dev"])).toEqual(dev);
    expect(dev).toContain("3000-3020");
  });

  test("rejects unknown presets", () => {
    expect(() => presetPortSpecs(["nope"])).toThrow(/Unknown port preset 'nope'/);
  });

  test("every preset spec parses", () => {
    for (const specs of Object.values(PORT_PRESETS)) {
      for (const spec of specs) expect(() => parsePortSpec(spec)).not.toThrow();
    }
  });
});

describe("buildPortMappings + formatPortMappings", () => {
  test("collapses consecutive ports back into ranges", () => {
    const m = buildPortMappings({ ports: ["3000-3002", "3003", "8080:80"] });
    expect(formatPortMappings(m)).toEqual(["8080:80", "3000-3003:3000-3003"]);
  });

  test("explicit specs remap a port a preset brought in", () => {
    const m = buildPortMappings({ presets: ["db"], ports: ["15432:5432"] });
    const pg = m.find((x) => x.containerPort === 5432);
    expect(pg).toMatchObject({ hostPort: 15432, optional: false });
    expect(m.find((x) => x.containerPort === 5433)).toMatchObject({
      hostPort: 5433,
      optional: true,
    });
  });

  test("offset shifts presets and same-port specs, not explicit host ports", () => {
    const m = buildPortMappings({ ports: ["3000-3001", "9999:80"], offset: 10000 });
    expect(formatPortMappings(m)).toEqual(["9999:80", "13000-13001:3000-3001"]);
    expect(() => buildPortMappings({ ports: ["60000"], offset: 10000 })).toThrow(/offset/);
  });

  test("default host IP applies only to specs without one", () => {
    const m = buildPortMappings({
      ports: ["3000", "127.0.0.1:4000:4000", "[::1]:5000:5000"],
      hostIp: "0.0.0.0",
    });
    expect(formatPortMappings(m)).toEqual([
      "0.0.0.0:3000:3000",
      "127.0.0.1:4000:4000",
      "[::1]:5000:5000",
    ]);
  });

  test("udp and random host ports", () => {
    const m = buildPortMappings({ ports: ["5353/udp", "127.0.0.1::80"] });
    expect(formatPortMappings(m)).toEqual(["127.0.0.1::80", "5353:5353/udp"]);
  });
});

describe("toDockerPortConfig", () => {
  test("exposes and binds every port of a range", () => {
    const cfg = toDockerPortConfig(["13000-13001:3000-3001", "127.0.0.1:8080:80", "5353/udp"]);
    expect(cfg.exposedPorts).toEqual({
      "3000/tcp": {},
      "3001/tcp": {},
      "80/tcp": {},
      "5353/udp": {},
    });
    expect(cfg.portBindings).toEqual({
      "3000/tcp": [{ HostPort: "13000" }],
      "3001/tcp": [{ HostPort: "13001" }],
      "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }],
      "5353/udp": [{ HostPort: "5353" }],
    });
  });
});

describe("dropBusyOptionalPorts", () => {
  test("drops busy preset ports, keeps explicit ones", async () => {
    const m = buildPortMappings({ presets: ["mail"], ports: ["8025:8025"] });
    const busy = new Set([1025, 8025]);
    const { kept, dropped } = await dropBusyOptionalPorts(m, async (port) => !busy.has(port));
    expect(formatPortMappings(dropped)).toEqual(["1025:1025"]);
    expect(formatPortMappings(kept)).toEqual(["8025:8025"]);
  });
});
